# Architecture

babata-sidebar has two local pieces:

1. A Manifest V3 browser extension in `src/`.
2. A loopback companion server in `companion/server.mjs`.

## Extension

- `src/sidepanel.tsx` renders the side panel chat UI.
- `src/content/babata-translate.ts` handles page and selection translation.
- `src/content/babata-widget.ts` handles the page widget.
- `src/service-worker.ts` dispatches browser APIs and forwards HTTP requests.
- `src/offscreen.ts` keeps long-lived chat fetches and the WebSocket bridge out
  of the MV3 service worker idle lifecycle.
- `src/options.tsx` stores the local companion URL and configures translation
  provider settings.

## Companion

The companion exposes:

- `GET /health`
- `GET /settings`
- `POST /settings`
- `POST /cpu`
- `POST /chat`
- `GET /history`
- `POST /translate`
- `POST /translate/models`
- `POST /translate/test`
- `POST /attention`
- `POST /translate_trace`
- `POST /proactive`
- `POST /clean_read`
- `GET /ws` via WebSocket upgrade

The public companion keeps the common path self-contained: Codex, Claude Code,
or Grok for chat, and an OpenAI-compatible provider for translation.

## Chat Context Contract

Each chat turn is sent to the companion as a bounded context envelope:

- recent `user` / `assistant` messages, trimmed before they reach the model
- current page URL/title/tab/window metadata
- selected text when available
- attachment metadata only; binary contents are not passed to the model
- browser tool results returned through the WebSocket bridge

The local model is run without hidden session persistence, so the envelope is
the complete context for the turn.

Page URL/title are included on every turn, including same-page follow-ups.
The selected CPU is part of the request rather than an implicit lookup of a
mutable global setting. Attachments do not transfer base64 payloads. An aborted
HTTP response cancels both model execution and pending browser-tool waits.

The offscreen document owns active chat snapshots. A new run waits for the
previous run's final writes; clearing a chat leaves an empty snapshot. Restored
streaming flags are reconciled against the live offscreen run. Companion history
uses the browser client ID plus a conversation ID and is only exposed by GET.
Snapshot writes are serialized per conversation; panels use version/turn checks
so stale restores cannot overwrite a newer run or an explicit clear. Window
targets stay bound to the window hosting each panel.

When prompt debug mode is enabled from the side panel, or
`BABATA_CHAT_DEBUG_PROMPT=1` is set on the companion, `POST /chat` emits a
`debug_prompt` stream event immediately before each local model invocation. A
single user turn can have multiple debug prompts when the companion or local CPU
runtime decides to call browser tools and rerun with their results. Persisted
debug prompts share a one-million-character budget with visible truncation
markers; ordinary conversation text is unaffected. Failed persistence shows an
unsaved-history warning while the live answer and Stop state continue updating.

## Browser Tool Bridge

The offscreen document keeps a persistent `/ws` connection to the companion. The
extension is a transport and permission boundary: it forwards browser
primitives, returns results, and records traces for the side panel. It does not
decide whether to call tools, how many calls are enough, or how to compose them;
that loop belongs to the companion and the selected local CPU runtime. Grok is
started as a single-turn, read-only process with its built-in tools, web search,
cross-session memory, and subagents disabled.

Each browser session shares a routing ID through `chrome.storage.session`.
HTTP requests carry it in `X-Babata-Client-Id` and `/ws` carries it as `client_id`.
Chat pins a single matching socket, validates response ownership, and defaults
page tools to the turn's tab rather than whichever tab later becomes active.
Replies from an old connection are discarded after a companion change.
Clean-read results are returned directly over HTTP for current clients; legacy
clients without a routing ID retain their WebSocket notification path. Clean-read
requests are cancelled on navigation and delivered only to the originating
document, including across reloads of the same URL.

The default browser bridge allow-list is read-only:

- `tab_metadata`
- `page_snapshot`
- `article_extract`
- `dom_query`
- `tabs_query`
- `history_search`
- `bookmarks_search`
- `bookmarks_tree`

Set `BABATA_CHAT_TOOL_ACTIONS` to change the companion-side allow-list. Write
actions should be enabled only with an explicit trust boundary. This allow-list
controls the browser bridge; local CLI permissions are a separate boundary.
Password, hidden and one-time-code input values are redacted from snapshots and
DOM queries. Other page text may still contain sensitive information.

## Translation lifecycle

The page queue coalesces identical text while retaining all waiting DOM nodes.
Its cache is document-local and bounded; the Node companion has no persistent
translation cache. Disabling a site stops new batches, and late responses cannot
reinject content after teardown. Back/forward restoration restarts observers.
YouTube subtitles use the same site switch, reset on video navigation, and
replay the latest captured response if the isolated content script loads late.
Clean-read restoration reuses original DOM nodes to preserve event listeners.

Provider requests are cancelled when their caller disconnects. Upstream responses
are limited to 16 MiB, and `BABATA_PROVIDER_MAX_CONCURRENT` limits simultaneous
provider calls (default 8, configurable from 1 to 64). Both CPU and provider work
are cancelled during companion shutdown.
