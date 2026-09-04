# AgentSearch

AgentSearch is an experimental Chromium fork built from source for ARM64 Macs. It combines a custom new-tab dashboard, self-hosted search, Google account sign-in, and a native AI agent sidebar backed by a local Node.js bridge. It is a browser with its own Chromium-level identity—not Electron and not a wrapper around an installed browser.

> Screenshot placeholder — add an AgentSearch new-tab screenshot here.

## Quick links

- [Build AgentSearch](docs/BUILDING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Project site](docs/site/index.html)

## Features

- Custom new-tab dashboard implemented with Chromium WebUI
- Self-hosted SearXNG search backend
- Native AI agent sidebar powered by xAI Grok
- CDP-based autonomous navigation, form filling, and checkout workflows
- Google account sign-in using OAuth credentials registered by the builder
- Chromium source build rather than Electron or a browser wrapper

## Status

AgentSearch is early, experimental software and currently supports ARM64 Macs only. Expect incomplete features, breaking changes, long build times, and rough edges. It is a solo developer portfolio project rather than a production browser distribution.

No prebuilt binaries are currently provided. See [BUILDING.md](docs/BUILDING.md) to compile it locally.

## License

Original AgentSearch modifications are available under the MIT License. AgentSearch incorporates Chromium and other third-party projects that retain their respective licenses. See [LICENSE](LICENSE) and applicable third-party license files.
