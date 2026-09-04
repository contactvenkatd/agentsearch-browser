# Contributing to AgentSearch

AgentSearch is an early-stage solo project, but focused bug reports and well-scoped contributions are welcome.

## Filing issues

Before opening an issue:

1. Search existing issues for the same behavior.
2. Confirm the problem occurs in an AgentSearch build rather than stock Chromium when practical.
3. Include your macOS version, Mac model, commit SHA, build configuration, and clear reproduction steps.
4. Include relevant logs after removing account data, API keys, OAuth tokens, browsing history, and other private information.

Use issues for reproducible bugs, narrowly defined enhancements, and technical questions about AgentSearch-specific code. Upstream Chromium bugs should be reported to the Chromium project.

## Pull requests

1. Fork the repository and create a focused branch.
2. Keep changes limited to one coherent fix or feature.
3. Rebase on the current default branch before submitting.
4. Build the affected target and run relevant tests.
5. Explain what changed, why it changed, and how you verified it.
6. Link the related issue when one exists.

Small, reviewable commits are preferred. Pull requests may be revised or closed when they expand beyond the project's current scope.

## Code style

- C++ changes should match the Chromium C++ style guide and surrounding code.
- WebUI code should follow the conventions already used in the relevant Chromium component.
- `agent-bridge` JavaScript should follow standard Node.js style and the formatting of adjacent files.
- Avoid unrelated formatting changes in upstream Chromium files.

## Credentials and private data

Never commit API keys, OAuth client IDs, OAuth client secrets, `.env` files, or downloaded client-secret JSON files.

Copy `config.example.json` to `config.local.json` for browser build credentials. For the bridge, copy `.env.example` to `.env`. Both local files are excluded from version control.

Before submitting a pull request, inspect your diff and search it for secrets.

## Contributor license agreement

No contributor license agreement is currently required. AgentSearch is maintained as a solo portfolio project, and this policy may be revisited if the project grows.
