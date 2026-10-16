# babata-sidebar

Local-first AI browser sidebar for Chromium browsers. It pairs a Manifest V3
extension with a loopback companion server so users can bring their own:

- Codex CLI, Claude Code, or Grok for sidebar chat.
- Any OpenAI-compatible translation provider by entering `base_url`, `api_key`,
  and a selectable or manually entered `model`.

> If this project helps your agent workflow, star the repo so other agents and users can find it faster — part of [babata](https://github.com/r266-tech).

## Features

- Browser side panel chat backed by local Codex, Claude Code, or Grok.
- Multi-turn sidebar context: the companion sends a bounded recent chat window,
  current page metadata, selected text, and metadata-only attachments to the
  local model.
- Read-only browser tool bridge: the extension forwards page/browser primitives
  and shows traces; the selected local CPU runtime decides when and how often to
  use them.
- Optional prompt debug mode that shows the exact assembled chat prompt before
  each local model invocation.
- Inline page and selection translation, with near-viewport scheduling, shared
  request deduplication, and bounded translation caches.
- Paragraph formatting, links, and protected inline code stay attached to the
  original page structure. Dynamic and virtualized pages reuse completed work.
- Video subtitles from HTML5 text tracks, WebVTT/SRT files, and YouTube caption
  responses, with original, bilingual, and translation-only display modes.
- Optional, explicitly started audio transcription for uncaptioned videos whose
  audio the browser can capture.
- Dynamic local companion URL in the extension options page.
- Dynamic translation provider settings: fetch model list, select a model, type
  a custom model, test, and save.
- API keys stay in the local companion config file, not in extension storage;
  the options page reads them back so users can review or edit saved settings.
- Companion listens on loopback by default: `http://127.0.0.1:18791`.

## Requirements

- Node.js 20 or newer.
- Chrome, Edge, Brave, or another Chromium browser with Manifest V3 side panel
  support.
- At least one local coding assistant:
  - Codex CLI available as `codex`, or
  - Claude Code available as `claude`, or
  - Grok Build CLI available as `grok` (run `grok login` locally first).
- An OpenAI-compatible translation endpoint, for example OpenRouter, OpenAI, or
  a compatible self-hosted gateway.

## Quick Start

If you use Codex, Claude Code, or Grok, you can hand the repository URL to your
agent and ask it to run the local setup:

```text
Clone https://github.com/r266-tech/babata-sidebar, run `npm run setup:local`,
start `npm run companion`, then help me load the built `dist/` extension in my
Chromium browser. Do not ask for my provider API key in chat; I will enter it in
the extension options page.
```

The setup script installs dependencies, typechecks, builds the unpacked
extension, and smoke-tests the local companion.

```bash
git clone https://github.com/r266-tech/babata-sidebar.git
cd babata-sidebar
npm run setup:local
npm run companion
```

Then load the extension:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the `dist/` directory created by `npm run build`.
5. Open the extension options page from the browser extension details page or
   the extension menu.
6. Keep the companion URL as `http://127.0.0.1:18791` unless you changed the
   port.
7. Enter your translation provider `base_url` and `api_key`.
8. Click `Fetch Models` or manually type a model id.
9. Click `Test`, then `Save Provider`.

After that, open the browser side panel and use babata on any page.

## Companion Configuration

Run the companion with:

```bash
npm run companion
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BABATA_SIDEBAR_HOST` | `127.0.0.1` | HTTP bind host. Keep loopback unless you know what you are doing. |
| `BABATA_SIDEBAR_PORT` | `18791` | HTTP port. |
| `BABATA_SIDEBAR_DATA_DIR` | `~/.babata-sidebar` | Directory for local config. |
| `BABATA_SIDEBAR_CONFIG` | `~/.babata-sidebar/config.json` | Exact config file path. |
| `BABATA_CODEX_CLI_PATH` | `codex` | Codex CLI path override. |
| `CLAUDE_CLI_PATH` | `claude` | Claude Code CLI path override. |
| `BABATA_GROK_CLI_PATH` | `grok` | Grok Build CLI path override. |
| `OPENROUTER_API_KEY` | empty | Optional default provider key. |
| `OPENAI_API_KEY` | empty | Optional default provider key. |
| `BABATA_TRANSLATION_MODEL` | empty | Optional default translation model. |
| `BABATA_CHAT_TOOL_ACTIONS` | read-only page/browser tools | Comma-separated browser actions the chat model may request. |
| `BABATA_CHAT_TOOL_LOOP_MAX` | `4` | Node companion runaway guard for browser-tool round trips; loop policy belongs to the local model runtime. |
| `BABATA_CHAT_DEBUG_PROMPT` | empty | Set to `1` or `true` to emit assembled chat prompts for every turn. |
| `BABATA_CHAT_MAX_CONCURRENT` | `4` | Maximum simultaneous model turns. Additional requests receive HTTP 429. |
| `BABATA_CHAT_TIMEOUT_MS` | `600000` | Per-model-invocation deadline; cancellation also terminates descendant processes. |
| `BABATA_PROVIDER_TIMEOUT_MS` | `60000` | Translation-provider deadline, including response-body download. |
| `BABATA_PROVIDER_MAX_CONCURRENT` | `8` | Concurrent provider operations (1–64); excess work enters a bounded priority queue. |
| `BABATA_SIDEBAR_ALLOWED_ORIGINS` | extension origins | Comma-separated extension origins trusted by the companion. Pin your extension ID to narrow access. |

The extension options page can change the companion URL and translation
provider without rebuilding the extension.

Chat requests bind the selected CPU, page target, and browser connection for the
turn. The Stop button cancels the local model process as well as the browser
request. Clearing a conversation persists an empty history so it stays cleared
after reopening the panel. Attachments currently send only their name, MIME
type, and size; the model does not receive their binary contents.

Grok runs in single-turn, read-only mode with its built-in tools, web search,
cross-session memory, and subagents disabled. Grok authentication stays in the
Grok CLI; the extension and companion do not store Grok credentials.

The side panel also has a prompt debug toggle. When enabled, each assistant turn
stores collapsible `LLM prompt` blocks containing the prompt assembled
immediately before the local model call. Debug prompts may include recent chat
context, page metadata, selected text, and browser tool results.

The default browser bridge exposes read-only actions: `tab_metadata`,
`page_snapshot`, `article_extract`, `dom_query`, `tabs_query`,
`history_search`, `bookmarks_search`, and `bookmarks_tree`. Write actions should
only be enabled when you trust the local model runtime and understand the
browser-permission impact.

## Translation Provider API

The companion expects an OpenAI-compatible API:

- `GET /models`
- `POST /chat/completions`

`base_url` should normally look like:

```text
https://openrouter.ai/api/v1
https://api.openai.com/v1
http://127.0.0.1:1234/v1
```

If your gateway already gives you a full `/chat/completions` URL, the companion
also derives the matching `/models` URL. Keyless local providers are supported.
Provider redirects are rejected; configure the final API URL directly. A saved
key is not reused for a different provider URL unless explicitly supplied.

### Reading and video translation

Translation starts with the visible content and a small area ahead of the
viewport. Scrolling away does not discard successful translations. A page-local
cache restores remounted content immediately; the companion reuses matching
translations across pages and merges concurrent requests for the same text.
Cache identity includes the provider, model, credential identity, target, source
text, and prompt version. Changing a provider in settings invalidates page
caches. Cached translations live in memory, not in a permanent browsing log.

Caching is per text item, so identical text can be reused on different pages
while new or edited comments still get translated. A cache hit in the page
avoids even a companion request. After a page reload or a second visit, the
companion may receive a lookup request but does not call the translation model
again while its matching entry is available.

| Cache | Default bound | Lifetime |
| --- | --- | --- |
| Page text | 5,000 items / 8 MiB | Current document; least recently used entries are evicted first. |
| Video captions | 2,500 items per player | Current player; completed matching captions survive seeking and replay. |
| Shared companion | 5,000 items / 16 MiB | 30 minutes from insertion; restarting the companion clears it. |

These bounds mean a second visit usually reuses translation, but expiry,
eviction, a companion restart, or changes to source/model/provider can require
a new model call. The shared lifetime and capacity are configurable below.

Brief viewport or tab changes keep in-flight page work reusable instead of
cancelling and immediately resending it. Background pages do not start new
translation requests. The companion also gives a shared request a bounded
400 ms cancellation window for a returning reader; queued provider work does
not start while it has no subscribers. Successful results from an already
needed batch remain cacheable even if one reader has left.

Source paragraphs stay readable while a translation is pending. Completed
paragraphs replace their previous rendering together; intermediate model tokens
are not inserted into the page. Links and emphasis use validated structural
markers, and protected inline code is restored from the source DOM.

Extension updates reconnect page and caption translation in already-open HTTP(S) tabs.
Recovery checks the current document before injecting missing code; it preserves
the page, scroll position, and unsent inputs without reloading the website.
Video scripts loaded before version 0.1.2 need a one-time page refresh to replace
their legacy handlers safely. Such players are not given a second overlapping
subtitle engine during automatic recovery.

Video controls appear over supported HTML5 players. Choose a caption track, use
the display-mode control, or import a local `.vtt`/`.srt` subtitle file. Current
captions have priority over prefetch. Only players visible in a foreground tab
start caption translation; paused players request only the current cue. Playing
resumes bounded look-ahead. Seeking keeps useful in-flight cues and cancels
batches outside the new playback window. Display mode can be changed per player;
font size is saved as a shared subtitle preference. Captions already in the
target language do not make translation requests.

Caption coverage depends on the player exposing a text track or an accessible
subtitle response. Generic support is not a claim that every site's proprietary
player is supported. Encrypted subtitles, closed player internals, and browser
restrictions can require a site adapter or an imported subtitle file.

For a video without captions, configure **Audio Base URL**, **Audio API key**,
and **Audio Model** in extension settings. This service must accept an
OpenAI-compatible `POST /audio/transcriptions` multipart request; it can be
different from the text translation provider. Configuration can also use
`BABATA_TRANSCRIPTION_BASE_URL`, `BABATA_TRANSCRIPTION_API_KEY`, and
`BABATA_TRANSCRIPTION_MODEL`. It is disabled when no audio provider is configured.

Click the player's transcription control to start recording accessible audio
from that video. Audio is sent in short independent chunks; silence is skipped,
and capture stops when disabled or the video is removed. Transcription has
inherent recognition and translation latency, which the player indicates. The
feature does not record the microphone or desktop audio. Protected media and
some cross-origin streams cannot be captured; the player reports this instead
of claiming to have generated subtitles.

### Translation resource controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `BABATA_TRANSLATE_BATCH_MAX` | `48` | Maximum items accepted in one batch; oversized batches fail explicitly. |
| `BABATA_TRANSLATE_ITEM_MAX_CHARS` | `16000` | Maximum source characters in one submitted item. |
| `BABATA_TRANSLATE_BATCH_MAX_CHARS` | `24000` | Total source character budget per request. |
| `BABATA_TRANSLATE_CACHE_MAX_ENTRIES` | `5000` | Companion cache entry limit; `0` disables caching. |
| `BABATA_TRANSLATE_CACHE_MAX_BYTES` | `16777216` | Companion cache memory budget. |
| `BABATA_TRANSLATE_CACHE_TTL_MS` | `1800000` | Translation lifetime in the companion cache. |
| `BABATA_TRANSLATE_CANCEL_GRACE_MS` | `400` | Last-subscriber cancellation window, 0–2,000 ms; `0` cancels immediately. |
| `BABATA_TRANSLATE_PENDING_MAX_ITEMS` | `4096` | Bound on unfinished shared translation items. |
| `BABATA_PROVIDER_QUEUE_MAX` | `128` | Maximum provider operations waiting for a worker or rate budget. |
| `BABATA_PROVIDER_QUEUE_TIMEOUT_MS` | `30000` | Maximum time an operation may wait in the queue. |
| `BABATA_PROVIDER_REQUESTS_PER_SECOND` | `4` | Sustained request budget per provider identity; fractional values are supported. |
| `BABATA_PROVIDER_BURST` | `8` | Short burst allowance per provider identity. |
| `BABATA_PROVIDER_MAX_RETRIES` | `1` | Additional attempts for transient provider failures. |
| `BABATA_PROVIDER_RETRY_BASE_MS` | `400` | Base delay for bounded jittered retries. |
| `BABATA_PROVIDER_RETRY_MAX_WAIT_MS` | `10000` | Maximum delay retried inside one request; longer cooldowns are returned to the caller. |
| `BABATA_TRANSCRIPTION_RESPONSE_FORMAT` | `json` | Use `verbose_json` only when the audio provider supports timed segments. |

The extension-origin-restricted loopback endpoint `GET /translate/stats` reports counts,
cache hits, coalesced requests, queue waits, and bounded latency samples. It
contains no source text, URLs, provider credentials, or translated text.
`GET /health` includes the version and a startup source digest so a running
companion can be distinguished from a newer checkout.

## Development

```bash
npm run typecheck
npm run build
npm run smoke:companion
npm test
npx playwright install chromium
npm run test:browser
```

`npm test` runs isolated companion and transport regressions with fake local
models and providers. `npm run test:browser` builds and tests the actual
extension in a temporary browser profile, without using your everyday browser
profile or paid model calls. Set `BABATA_TEST_BROWSER_PATH` to use another
Chromium executable, and optionally `BABATA_TEST_SCREENSHOTS` to save UI captures.
`npm run check` runs typechecking, unit/integration tests, and the build.
`npm run check:all` also runs browser acceptance, including dynamic-page,
format-preservation, cancellation, caption-timing, and audio-container checks.

After source changes, restart the companion and reload the unpacked `dist/`
extension to apply them to an existing installation.

The extension source lives in `src/`. The local companion lives in
`companion/server.mjs`.

## Security Model

- The extension can read page content because translation and page context need
  it.
- The extension requests browser permissions such as `tabs`, `history`,
  `bookmarks`, and `scripting` for agent-style workflows. Review the manifest
  before installing.
- The companion binds to loopback by default and only accepts browser extension
  origins unless configured otherwise.
- API keys are stored only in the local companion config file.
- Do not commit generated config files, logs, API keys, or local personal data.

See [SECURITY.md](SECURITY.md) for details.

## License

MIT
