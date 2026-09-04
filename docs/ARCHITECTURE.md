# AgentSearch Architecture

AgentSearch is a Chromium fork with browser-native UI changes and a local Node.js service for agent execution. It is not an Electron application or an external shell around a stock browser.

## System overview

```text
+------------------------------------------+
| AgentSearch browser                      |
|                                          |
|  Chromium UI and rendering               |
|  Custom new-tab WebUI                    |
|  Search and agent sidebar                |
+--------------------+---------------------+
                     |
                     | localhost / Chrome DevTools Protocol
                     v
+------------------------------------------+
| agent-bridge                             |
|                                          |
|  Page observation and target selection   |
|  Action validation and task state        |
|  Navigation, form-fill, checkout gates   |
+--------------------+---------------------+
                     |
                     | HTTPS API requests
                     v
+------------------------------------------+
| xAI Grok                                 |
|  Next-action decisions and summaries     |
+------------------------------------------+

Custom new-tab search ---- HTTPS ----> Self-hosted SearXNG
```

## Chromium fork

The repository contains Chromium source plus focused AgentSearch modifications. The fork keeps Chromium's browser process, renderer architecture, WebUI system, network stack, profile model, and build tooling.

AgentSearch-specific changes include browser branding, a custom new-tab experience, OAuth-backed account state, search routing, the agent sidebar, and the local bridge integration. Keeping these changes inside Chromium allows the project to behave as a browser rather than a wrapped web application.

## New-tab WebUI override

AgentSearch customizes Chromium's new-tab page through the existing WebUI architecture. C++ handlers expose browser capabilities and state to the new-tab frontend, while WebUI resources render the dashboard and send validated messages back to the browser process.

The new-tab page acts as the main product surface: it owns search entry, account state, history-oriented features, and the controls used to start or monitor an agent task.

## Google OAuth

Google Chrome's internal OAuth credentials are not available to third-party Chromium forks. Each person building AgentSearch must register an OAuth client in Google Cloud Platform and provide that client's ID and secret locally.

`build.sh` reads `config.local.json` and injects `google_default_client_id` and `google_default_client_secret` into GN arguments before generating the build. Chromium exposes those generated values through its Google API key helpers.

The new-tab OAuth flow opens Google's authorization endpoint, receives the configured localhost redirect, validates the OAuth state value, exchanges the authorization code for tokens, and requests profile identity. Credentials stay in ignored local configuration and must not be committed.

## Agent bridge

`agent-bridge` is a local Node.js process. It connects to the running browser's remote-debugging endpoint with the Chrome DevTools Protocol through Playwright.

For each task, the bridge selects the requested browser target, reads a bounded page observation, sends grounded context to the model, validates the returned action, and performs the action through CDP. It maintains task state and emits events to the browser sidebar over a local HTTP interface.

Sensitive or irreversible actions require explicit handling. Checkout flows pause at the configured confirmation gate rather than silently authorizing a purchase.

## SearXNG integration

The new-tab search experience routes queries to a self-hosted SearXNG instance. SearXNG provides a private metasearch layer and avoids coupling the custom dashboard to one commercial search frontend.

The SearXNG deployment is separate from the Chromium build. Its endpoint must be configured for the environment where AgentSearch runs.

## xAI Grok integration

The browser does not call xAI directly. `agent-bridge` loads `XAI_API_KEY` from its process environment, constructs grounded messages from current browser observations, and calls the xAI Grok API.

Model responses are treated as proposed actions, not trusted commands. The bridge validates action names and targets against the current observation before interacting with the page. This separation keeps API credentials out of the browser UI and centralizes automation policy in the local service.
