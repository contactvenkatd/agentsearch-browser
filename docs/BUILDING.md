# Building AgentSearch

AgentSearch is currently a build-from-source project targeting ARM64 Macs. There are no supported binary releases.

## Prerequisites

- An ARM64 Mac running a current version of macOS
- Xcode and the Xcode command-line tools
- Python 3
- Node.js 20 or newer
- Chromium's `depot_tools`, available on your `PATH`
- Git

Follow Chromium's current macOS build prerequisites if your Xcode or SDK setup needs additional configuration.

## Clone the source

Chromium expects its source checkout to live in a directory named `src` beneath a gclient workspace:

```sh
mkdir agentsearch-browser
cd agentsearch-browser
git clone https://github.com/contactvenkatd/agentsearch-browser.git src
```

Create `agentsearch-browser/.gclient` with:

```python
solutions = [
  {
    "name": "src",
    "url": "https://github.com/contactvenkatd/agentsearch-browser.git",
    "managed": False,
    "custom_deps": {},
    "custom_vars": {},
  },
]
```

Then enter the source directory:

```sh
cd src
```

## Configure local credentials

```sh
cp config.example.json config.local.json
```

Edit `config.local.json` and supply your own values:

```json
{
  "google_oauth_client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID",
  "google_oauth_client_secret": "YOUR_GOOGLE_OAUTH_CLIENT_SECRET",
  "xai_api_key": "xai-YOUR_KEY_HERE"
}
```

`config.local.json` is ignored by Git. Never commit it.

Google OAuth requires a client that you register in Google Cloud Platform. Third-party Chromium forks cannot use Google Chrome's internal OAuth client. Configure the redirect URI expected by AgentSearch and place your client ID and client secret in the local configuration.

An xAI API key is required for the AI agent sidebar.

## Synchronize Chromium dependencies

```sh
gclient sync
```

This download is large and can take significant time and disk space.

## Build AgentSearch

```sh
./build.sh
```

The script reads `config.local.json`, writes the OAuth values into `out/Default/args.gn`, generates the build, and runs `autoninja -C out/Default chrome`. The browser executable is produced beneath `out/Default`.

## Run the browser

```sh
out/Default/Chromium.app/Contents/MacOS/Chromium \
  --remote-debugging-port=9222
```

Use a separate test profile while developing if you do not want the build to touch your normal browser state:

```sh
out/Default/Chromium.app/Contents/MacOS/Chromium \
  --remote-debugging-port=9222 \
  --user-data-dir="$TMPDIR/agentsearch-profile"
```

## Run the agent bridge

Place the companion `agent-bridge` checkout next to the Chromium `src` directory, then install its dependencies:

```sh
cd ../agent-bridge
cp .env.example .env
npm install
```

Set your xAI key in `.env`:

```dotenv
XAI_API_KEY=xai-YOUR_KEY_HERE
```

With AgentSearch running on port `9222`, start the bridge:

```sh
npm start
```

By default, the bridge listens locally on port `9333` and connects to Chromium over the Chrome DevTools Protocol. Keep both processes running while using the agent sidebar.

## Rebuilding

After changing C++ or WebUI code, rerun `./build.sh`. `autoninja` performs an incremental rebuild, so subsequent builds are normally faster than the first.
