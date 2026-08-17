// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/new_tab_page/agent_search_provider.h"

#include <string>

#include "base/json/json_reader.h"
#include "base/values.h"
#include "net/base/url_util.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace agent_search {
namespace {

constexpr char kGoogleSuccess[] = R"({
  "queries":{"request":[{"searchTerms":"Chuck Schumer"}]},
  "items":[
    {"title":"Official biography","link":"https://www.senate.gov/person",
     "snippet":"Charles Ellis Schumer is a United States senator.",
     "displayLink":"senate.gov"},
    {"title":"News profile","link":"https://www.reuters.com/profile",
     "snippet":"Coverage of Senate leader Chuck Schumer."},
    {"title":"Duplicate","link":"https://www.reuters.com/profile"},
    {"title":"Unsafe","link":"file:///tmp/result"},
    {"title":"","link":"https://example.com/empty"}
  ]
})";

TEST(AgentSearchProviderTest, GoogleConfigurationRequiresBothValues) {
  EXPECT_TRUE(HasGoogleConfiguration("key", "engine"));
  EXPECT_FALSE(HasGoogleConfiguration("", "engine"));
  EXPECT_FALSE(HasGoogleConfiguration("key", ""));
}

TEST(AgentSearchProviderTest, FallbackStartsWithBingInRequiredOrder) {
  EXPECT_THAT(SearxFallbackEngines(),
              testing::ElementsAre("bing", "brave", "yahoo", "dogpile",
                                   "fynd"));
}

TEST(AgentSearchProviderTest, GoogleUrlPreservesExactQuery) {
  const GURL url = BuildGoogleSearchUrl(
      "test-key", "test-engine", "Find C++ flights under $600");
  std::string query;
  EXPECT_TRUE(net::GetValueForKeyInQuery(url, "q", &query));
  EXPECT_EQ(query, "Find C++ flights under $600");
  EXPECT_EQ(url.host(), "customsearch.googleapis.com");
}

TEST(AgentSearchProviderTest, GoogleSuccessAcceptsPublicFigureResults) {
  NormalizedResponse response =
      NormalizeGoogleResponse(kGoogleSuccess, "Chuck Schumer");
  EXPECT_EQ(response.status, ResponseStatus::kSuccess);
  EXPECT_EQ(response.result_count, 2u);
  EXPECT_THAT(response.json, testing::HasSubstr("\"provider\":\"google\""));
  EXPECT_THAT(response.json, testing::Not(testing::HasSubstr("file:///")));
  EXPECT_THAT(response.json, testing::Not(testing::HasSubstr("api-key")));
}

TEST(AgentSearchProviderTest, GoogleRankingDoesNotRequireTitleTokenMatches) {
  constexpr char kResponse[] = R"({
    "queries":{"request":[{"searchTerms":"Sundar Pichai"}]},
    "items":[{
      "title":"Leadership",
      "link":"https://abc.xyz/investor/leadership/",
      "snippet":"Sundar Pichai is CEO of Alphabet and Google.",
      "displayLink":"abc.xyz"
    }]
  })";
  EXPECT_EQ(NormalizeGoogleResponse(kResponse, "Sundar Pichai").status,
            ResponseStatus::kSuccess);
}

TEST(AgentSearchProviderTest, GoogleRequiresExactEchoedQuery) {
  EXPECT_EQ(NormalizeGoogleResponse(kGoogleSuccess, "Chuck").status,
            ResponseStatus::kMalformed);
}

TEST(AgentSearchProviderTest, GoogleEmptyAndMalformedResponsesFail) {
  EXPECT_EQ(NormalizeGoogleResponse(
                R"({"queries":{"request":[{"searchTerms":"query"}]}})",
                "query")
                .status,
            ResponseStatus::kEmpty);
  EXPECT_EQ(NormalizeGoogleResponse("not json", "query").status,
            ResponseStatus::kMalformed);
}

TEST(AgentSearchProviderTest, GoogleAuthenticationAndQuotaErrorsFail) {
  EXPECT_EQ(NormalizeGoogleResponse(
                R"({"error":{"code":401,"message":"invalid"}})", "query")
                .status,
            ResponseStatus::kAuthenticationError);
  EXPECT_EQ(NormalizeGoogleResponse(
                R"({"error":{"code":403,"errors":[{"reason":"quotaExceeded"}]}})",
                "query")
                .status,
            ResponseStatus::kQuotaError);
}

TEST(AgentSearchProviderTest, SearxRejectsCompleteProviderFailure) {
  EXPECT_NE(NormalizeSearxResponse(
                R"({"query":"query","results":[],"unresponsive_engines":[["bing","timeout"]]})",
                "query", true)
                .status,
            ResponseStatus::kSuccess);
}

TEST(AgentSearchProviderTest, SearxCategoryPreservesGenuineEmptyResults) {
  const NormalizedResponse response = NormalizeSearxResponse(
      R"({"query":"query","results":[],"unresponsive_engines":[]})",
      "query", false);
  EXPECT_EQ(response.status, ResponseStatus::kSuccess);
  EXPECT_THAT(response.json, testing::HasSubstr("\"results\":[]"));
}

}  // namespace
}  // namespace agent_search
