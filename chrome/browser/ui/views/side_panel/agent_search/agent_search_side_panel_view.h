// Copyright 2026 The AgentSearch Authors

#ifndef CHROME_BROWSER_UI_VIEWS_SIDE_PANEL_AGENT_SEARCH_AGENT_SEARCH_SIDE_PANEL_VIEW_H_
#define CHROME_BROWSER_UI_VIEWS_SIDE_PANEL_AGENT_SEARCH_AGENT_SEARCH_SIDE_PANEL_VIEW_H_

#include <memory>

#include "chrome/browser/ui/side_panel/side_panel_native_view.h"

class SidePanelEntryScope;

SidePanelNativeView CreateAgentSearchSidePanelView(
    SidePanelEntryScope& scope);

#endif  // CHROME_BROWSER_UI_VIEWS_SIDE_PANEL_AGENT_SEARCH_AGENT_SEARCH_SIDE_PANEL_VIEW_H_
