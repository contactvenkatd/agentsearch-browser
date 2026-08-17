// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_NEW_TAB_PAGE_AGENT_SEARCH_PROVIDER_H_
#define CHROME_BROWSER_UI_WEBUI_NEW_TAB_PAGE_AGENT_SEARCH_PROVIDER_H_

#include <cstddef>
#include <span>
#include <string>
#include <string_view>

#include "url/gurl.h"

namespace agent_search {

enum class ResponseStatus {
  kSuccess,
  kEmpty,
  kMalformed,
  kAuthenticationError,
  kQuotaError,
  kApiError,
  kUnusable,
};

struct NormalizedResponse {
  NormalizedResponse();
  NormalizedResponse(const NormalizedResponse&);
  NormalizedResponse& operator=(const NormalizedResponse&);
  ~NormalizedResponse();

  ResponseStatus status = ResponseStatus::kMalformed;
  std::string json;
  size_t result_count = 0u;
};

bool HasGoogleConfiguration(std::string_view api_key,
                            std::string_view engine_id);
GURL BuildGoogleSearchUrl(std::string_view api_key,
                          std::string_view engine_id,
                          std::string_view query);
std::span<const std::string_view> SearxFallbackEngines();

NormalizedResponse NormalizeGoogleResponse(std::string_view body,
                                           std::string_view query);
NormalizedResponse NormalizeSearxResponse(std::string_view body,
                                          std::string_view query,
                                          bool require_relevance);

}  // namespace agent_search

#endif  // CHROME_BROWSER_UI_WEBUI_NEW_TAB_PAGE_AGENT_SEARCH_PROVIDER_H_
