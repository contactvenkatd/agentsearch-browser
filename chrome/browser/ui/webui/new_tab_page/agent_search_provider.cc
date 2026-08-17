// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/new_tab_page/agent_search_provider.h"

#include <algorithm>
#include <array>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/values.h"
#include "net/base/url_util.h"
#include "url/gurl.h"

namespace agent_search {
namespace {

constexpr std::array<std::string_view, 5> kSearxFallbackEngines = {
    "bing", "brave", "yahoo", "dogpile", "fynd"};
constexpr char kGoogleSearchEndpoint[] =
    "https://customsearch.googleapis.com/customsearch/v1";

bool IsStopWord(std::string_view term) {
  return term == "a" || term == "an" || term == "and" || term == "find" ||
         term == "for" || term == "in" || term == "of" || term == "or" ||
         term == "the" || term == "to" || term == "under";
}

std::vector<std::string> SearchTerms(std::string_view query) {
  std::string normalized;
  normalized.reserve(query.size());
  for (unsigned char character : query) {
    normalized.push_back(base::IsAsciiAlphaNumeric(character)
                             ? base::ToLowerASCII(character)
                             : ' ');
  }
  std::vector<std::string> terms;
  for (std::string term :
       base::SplitString(normalized, " ", base::TRIM_WHITESPACE,
                         base::SPLIT_WANT_NONEMPTY)) {
    const bool numeric = std::ranges::all_of(
        term, [](char character) { return base::IsAsciiDigit(character); });
    if (term.size() >= 2u && !numeric && !IsStopWord(term)) {
      terms.push_back(std::move(term));
    }
  }
  return terms;
}

bool IsHttpUrl(const std::string& value) {
  const GURL url(value);
  return url.is_valid() && url.SchemeIsHTTPOrHTTPS();
}

std::string Serialize(std::string_view query, base::ListValue results) {
  base::DictValue response;
  response.Set("query", query);
  response.Set("number_of_results", static_cast<int>(results.size()));
  response.Set("results", std::move(results));
  std::string json;
  CHECK(base::JSONWriter::Write(response, &json));
  return json;
}

ResponseStatus GoogleErrorStatus(const base::DictValue& error) {
  const std::optional<int> code = error.FindInt("code");
  if (code == 401) {
    return ResponseStatus::kAuthenticationError;
  }
  if (const base::ListValue* errors = error.FindList("errors")) {
    for (const base::Value& value : *errors) {
      const base::DictValue* detail = value.GetIfDict();
      const std::string* reason = detail ? detail->FindString("reason") : nullptr;
      if (!reason) {
        continue;
      }
      if (*reason == "dailyLimitExceeded" || *reason == "quotaExceeded" ||
          *reason == "rateLimitExceeded") {
        return ResponseStatus::kQuotaError;
      }
      if (*reason == "keyInvalid" || *reason == "authError") {
        return ResponseStatus::kAuthenticationError;
      }
    }
  }
  return code == 403 ? ResponseStatus::kAuthenticationError
                     : ResponseStatus::kApiError;
}

}  // namespace

NormalizedResponse::NormalizedResponse() = default;
NormalizedResponse::NormalizedResponse(const NormalizedResponse&) = default;
NormalizedResponse& NormalizedResponse::operator=(const NormalizedResponse&) =
    default;
NormalizedResponse::~NormalizedResponse() = default;

bool HasGoogleConfiguration(std::string_view api_key,
                            std::string_view engine_id) {
  return !api_key.empty() && !engine_id.empty();
}

GURL BuildGoogleSearchUrl(std::string_view api_key,
                          std::string_view engine_id,
                          std::string_view query) {
  GURL url(kGoogleSearchEndpoint);
  url = net::AppendQueryParameter(url, "key", api_key);
  url = net::AppendQueryParameter(url, "cx", engine_id);
  url = net::AppendQueryParameter(url, "q", query);
  url = net::AppendQueryParameter(url, "safe", "active");
  url = net::AppendQueryParameter(url, "lr", "lang_en");
  return net::AppendQueryParameter(url, "num", "10");
}

std::span<const std::string_view> SearxFallbackEngines() {
  return kSearxFallbackEngines;
}

NormalizedResponse NormalizeGoogleResponse(std::string_view body,
                                           std::string_view query) {
  NormalizedResponse normalized;
  std::optional<base::Value> parsed =
      base::JSONReader::Read(body, base::JSON_PARSE_RFC);
  const base::DictValue* response = parsed ? parsed->GetIfDict() : nullptr;
  if (!response) {
    return normalized;
  }
  if (const base::DictValue* error = response->FindDict("error")) {
    normalized.status = GoogleErrorStatus(*error);
    return normalized;
  }
  const base::ListValue* requests = response->FindListByDottedPath(
      "queries.request");
  const base::DictValue* request =
      requests && !requests->empty() ? requests->front().GetIfDict() : nullptr;
  const std::string* echoed_query =
      request ? request->FindString("searchTerms") : nullptr;
  if (!echoed_query || *echoed_query != query) {
    return normalized;
  }

  base::ListValue results;
  std::set<std::string> seen_urls;
  if (const base::ListValue* items = response->FindList("items")) {
    for (const base::Value& value : *items) {
      const base::DictValue* item = value.GetIfDict();
      const std::string* title = item ? item->FindString("title") : nullptr;
      const std::string* link = item ? item->FindString("link") : nullptr;
      if (!title || title->empty() || !link || !IsHttpUrl(*link) ||
          !seen_urls.insert(*link).second) {
        continue;
      }
      base::DictValue result;
      result.Set("title", *title);
      result.Set("url", *link);
      result.Set("snippet", item->FindString("snippet")
                                ? *item->FindString("snippet")
                                : std::string());
      result.Set("displayUrl", item->FindString("displayLink")
                                   ? *item->FindString("displayLink")
                                   : GURL(*link).host());
      result.Set("provider", "google");
      if (const base::DictValue* pagemap = item->FindDict("pagemap")) {
        const base::ListValue* thumbnails = pagemap->FindList("cse_thumbnail");
        const base::DictValue* thumbnail =
            thumbnails && !thumbnails->empty()
                ? thumbnails->front().GetIfDict()
                : nullptr;
        const std::string* source =
            thumbnail ? thumbnail->FindString("src") : nullptr;
        if (source && IsHttpUrl(*source)) {
          result.Set("thumbnail", *source);
        }
        const base::ListValue* metadata = pagemap->FindList("metatags");
        const base::DictValue* tags = metadata && !metadata->empty()
                                          ? metadata->front().GetIfDict()
                                          : nullptr;
        const std::string* published =
            tags ? tags->FindString("article:published_time") : nullptr;
        if (published) {
          result.Set("publishedDate", *published);
        }
      }
      results.Append(std::move(result));
    }
  }
  normalized.result_count = results.size();
  normalized.status = results.empty() ? ResponseStatus::kEmpty
                                      : ResponseStatus::kSuccess;
  normalized.json = Serialize(query, std::move(results));
  return normalized;
}

NormalizedResponse NormalizeSearxResponse(std::string_view body,
                                          std::string_view query,
                                          bool require_relevance) {
  NormalizedResponse normalized;
  std::optional<base::Value> parsed =
      base::JSONReader::Read(body, base::JSON_PARSE_RFC);
  const base::DictValue* response = parsed ? parsed->GetIfDict() : nullptr;
  const std::string* echoed_query =
      response ? response->FindString("query") : nullptr;
  if (!echoed_query || *echoed_query != query) {
    return normalized;
  }
  const base::ListValue* failures = response->FindList("unresponsive_engines");
  if (require_relevance && failures && !failures->empty()) {
    normalized.status = ResponseStatus::kApiError;
    return normalized;
  }
  const base::ListValue* items = response->FindList("results");
  if (!items) {
    return normalized;
  }

  const std::vector<std::string> terms = SearchTerms(query);
  const size_t required_matches = std::min<size_t>(2u, terms.size());
  base::ListValue results;
  std::set<std::string> seen_urls;
  for (const base::Value& value : *items) {
    const base::DictValue* item = value.GetIfDict();
    const std::string* title = item ? item->FindString("title") : nullptr;
    const std::string* link = item ? item->FindString("url") : nullptr;
    if (!title || title->empty() || !link || !IsHttpUrl(*link) ||
        !seen_urls.insert(*link).second) {
      continue;
    }
    const std::string snippet = item->FindString("content")
                                    ? *item->FindString("content")
                                    : std::string();
    std::string searchable = base::ToLowerASCII(*title + " " + *link + " " +
                                                 snippet);
    size_t matches = 0u;
    for (const std::string& term : terms) {
      matches += searchable.find(term) != std::string::npos;
    }
    if (require_relevance && matches < required_matches) {
      continue;
    }
    base::DictValue result;
    result.Set("title", *title);
    result.Set("url", *link);
    result.Set("snippet", snippet);
    result.Set("displayUrl", GURL(*link).host());
    result.Set("provider", item->FindString("engine")
                               ? *item->FindString("engine")
                               : "searxng");
    results.Append(std::move(result));
  }
  normalized.result_count = results.size();
  if (results.empty()) {
    if (failures && !failures->empty()) {
      normalized.status = ResponseStatus::kApiError;
    } else if (require_relevance) {
      normalized.status = ResponseStatus::kEmpty;
    } else {
      normalized.status = ResponseStatus::kSuccess;
      normalized.json = Serialize(query, std::move(results));
    }
  } else if (require_relevance && results.size() < 5u) {
    normalized.status = ResponseStatus::kUnusable;
  } else {
    normalized.status = ResponseStatus::kSuccess;
    normalized.json = Serialize(query, std::move(results));
  }
  return normalized;
}

}  // namespace agent_search
