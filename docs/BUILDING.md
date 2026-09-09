# Building AgentSearch

AgentSearch is a Chromium fork distributed as a **patch series** applied on top of
a pinned upstream Chromium revision. There are no binary releases; you build from
source.

Target platform: **macOS on Apple Silicon (arm64)**. Other platforms are untested.

---

## Pinned upstream revision

Every patch in `patches/` is generated against exactly one Chromium commit:

```
ec30f8fc9df262875881af5a4f217ad6ef2171a0
```

| | |
|---|---|
| Upstream | `https://chromium.googlesource.com/chromium/src.git` |
| Commit | `ec30f8fc9df262875881af5a4f217ad6ef2171a0` |
| Date | 2026-07-29 |
| Subject | Deflake GlicInstanceCoordinatorUnbindOnCloseTest on Windows |

The patches are **not** rebased onto upstream `main`. Applying them to any other
revision will almost certainly conflict. Check out this exact commit.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **depot_tools** | Chromium's build tooling. Must be on your `PATH`. |
| **Xcode** + command-line tools | Full Xcode, not just the CLI tools. Run it once to accept the license. |
| **Python 3** | Required by `gclient` and the build scripts. |
| **Node.js 18+** | Used by `build.sh` and required by `agent-bridge`. Node 20+ recommended. |
| **Git** | 2.30 or newer. |

Install depot_tools and put it on your `PATH`:

```sh
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH="$PWD/depot_tools:$PATH"
```

Add that `export` line to your shell profile so it persists.

If Xcode or your SDK needs extra setup, follow Chromium's current
[macOS build prerequisites](https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md).

---

## Step 1 — Fetch Chromium at the pinned revision

Clone this repository first. It ships the `.gclient` solution file, the patch
series, and the `agent-bridge` companion service:

```sh
git clone https://github.com/contactvenkatd/agentsearch-browser.git
cd agentsearch-browser
```

Now sync Chromium into `src/`, pinned to the exact revision above:

```sh
gclient sync --with_branch_heads --revision src@ec30f8fc9df262875881af5a4f217ad6ef2171a0
```

This creates `src/` at the pinned commit and downloads every DEPS-managed
dependency. It is the longest step in the process — see
[Time and disk space](#time-and-disk-space).

> **Note — why not `fetch chromium`?**
> `fetch chromium` creates its own `.gclient` file and refuses to run when one
> already exists. Because this repository commits a `.gclient` that already
> points at upstream Chromium, `gclient sync` above is the correct entry point.
>
> If you prefer to start from a bare directory instead, this is equivalent:
>
> ```sh
> mkdir agentsearch && cd agentsearch
> fetch chromium
> cd src && git checkout ec30f8fc9df262875881af5a4f217ad6ef2171a0
> gclient sync --with_branch_heads
> ```
>
> You will then need to copy `patches/` and `agent-bridge/` from this
> repository next to `src/` yourself.

Confirm you are on the right commit before continuing:

```sh
cd src
git rev-parse HEAD
# => ec30f8fc9df262875881af5a4f217ad6ef2171a0
```

---

## Step 2 — Apply the patch series

From inside `src/`, apply all five patches **in order**:

```sh
git am ../patches/0001-new-tab-page-override.patch
git am ../patches/0002-oauth-client-wiring.patch
git am ../patches/0003-browser-identity-rebrand.patch
git am ../patches/0004-agent-sidebar-surface.patch
git am ../patches/0005-build-tooling-and-config.patch
```

Or all at once:

```sh
git am ../patches/*.patch
```

What each patch contains:

| Patch | Files | Contents |
|---|---:|---|
| `0001-new-tab-page-override` | 20 | AgentSearch new tab page, results UI, `agent_search_provider`, omnibox/startup/session routing |
| `0002-oauth-client-wiring` | 14 | Google OAuth sign-in, first-run gating, password-manager/autofill integration |
| `0003-browser-identity-rebrand` | 30 | Product rename to AgentSearch, strings, `Info.plist`, build config, icon assets (binary) |
| `0004-agent-sidebar-surface` | 21 | Agent Search side panel, side panel entry + action id, toolbar affordances, history WebUI |
| `0005-build-tooling-and-config` | 3 | `build.sh`, `config.example.json`, and the `.gitignore` rule that keeps secrets out of Git |

Patch `0003` contains binary icon data. Apply it with `git am` as shown — do not
use `git apply --3way`, which does not handle the embedded binary hunks.

**If a patch fails to apply,** you are almost certainly not on the pinned
revision. Run `git am --abort`, re-check `git rev-parse HEAD` against the hash
above, and try again.

---

## Step 3 — Configure local credentials

`0005` added `config.example.json`. Copy it and fill in your own values:

```sh
cp config.example.json config.local.json
```

```json
{
  "google_oauth_client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID",
  "google_oauth_client_secret": "YOUR_GOOGLE_OAUTH_CLIENT_SECRET",
  "xai_api_key": "xai-YOUR_KEY_HERE"
}
```

- **`google_oauth_client_id` / `google_oauth_client_secret`** — you must register
  your own client. See [Google OAuth setup](#google-oauth-setup) below.
- **`xai_api_key`** — an [xAI](https://x.ai) API key. Required by the agent
  sidebar.

`config.local.json` is ignored by Git (that rule ships in patch `0005`). It holds
real secrets — never commit it.

---

## Step 4 — Build

```sh
./build.sh
```

`build.sh` reads `config.local.json`, injects `google_default_client_id` and
`google_default_client_secret` into `out/Default/args.gn`, then runs `gn gen
out/Default` followed by `autoninja -C out/Default chrome`.

The resulting app bundle is `out/Default/AgentSearch.app`.

To rebuild after editing C++ or WebUI code, run `./build.sh` again — `autoninja`
rebuilds incrementally and is far faster than the first build.

---

## Step 5 — Start the agent bridge

The agent sidebar does not work on its own; it talks to a local Node service.

```sh
cd ../agent-bridge
cp .env.example .env
```

Set your xAI key in `.env`:

```dotenv
XAI_API_KEY=xai-YOUR_KEY_HERE
```

Then:

```sh
npm install
npm start
```

The bridge listens on **port 9333** (override with `PORT`) and drives the browser
over the Chrome DevTools Protocol on **port 9222**. The side panel calls it at
`http://127.0.0.1:9333`.

Keep this process running the whole time you use the agent sidebar.

---

## Step 6 — Launch AgentSearch

The bridge needs a CDP endpoint, so start the browser with remote debugging
enabled:

```sh
out/Default/AgentSearch.app/Contents/MacOS/AgentSearch \
  --remote-debugging-port=9222
```

To keep your everyday browser profile untouched while developing, use a
throwaway profile:

```sh
out/Default/AgentSearch.app/Contents/MacOS/AgentSearch \
  --remote-debugging-port=9222 \
  --user-data-dir="$TMPDIR/agentsearch-profile"
```

You can also launch the bundle directly with `open out/Default/AgentSearch.app`,
but then it starts without `--remote-debugging-port` and the agent sidebar will
not be able to reach the page.

---

## Google OAuth setup

Google Chrome's built-in OAuth client is not available to third-party Chromium
forks. Sign-in will fail until you register your own client.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   (or select) a project.
2. Go to **APIs & Services → OAuth consent screen** and configure it. While your
   app is in *Testing*, add your own Google account under **Test users**.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
4. Choose application type **Desktop app**.
5. Create the client and copy the **client ID** and **client secret** into
   `config.local.json` (Step 3).

**Redirect URI.** AgentSearch uses a loopback redirect. Desktop-app clients
accept `http://127.0.0.1` (and `http://localhost`) on any port automatically, so
there is usually nothing to add. If your console UI does ask for a redirect URI,
register a loopback one — `http://127.0.0.1` / `http://localhost`. Do not use a
public URL.

Anything you enable in the consent screen only affects your own client — you are
not sharing credentials with anyone else who builds this fork.

---

## Time and disk space

> **Warning — this build is large and slow.** Budget most of a day for a first
> build, and make sure you have the space before you start.

| Stage | Time (Apple Silicon) | Disk |
|---|---|---|
| `gclient sync` | 30–90 min, network-bound | ~30 GB |
| First `./build.sh` | 1.5–4 hours, all cores pegged | ~13 GB (`out/Default`) |
| Incremental rebuild | 1–15 min depending on what changed | — |

**Total: roughly 45 GB.** Have at least **100 GB free** — the build fails in
confusing ways when it runs out of space, and `gclient sync` needs headroom
above the final figure.

A measured checkout of this fork occupies 43 GB (30 GB source and DEPS, 13 GB
build output). Times vary considerably with core count, RAM, and network speed;
an M1 with 16 GB will sit at the slow end of the ranges above.
