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

When prompt debug mode is enabled from the side panel, or
`BABATA_CHAT_DEBUG_PROMPT=1` is set on the companion, `POST /chat` emits a
`debug_prompt` stream event immediately before each local model invocation. A
single user turn can have multiple debug prompts when the companion or local CPU
runtime decides to call browser tools and rerun with their results.

## Browser Tool Bridge

The offscreen document keeps a persistent `/ws` connection to the companion. The
extension is a transport and permission boundary: it forwards browser
primitives, returns results, and records traces for the side panel. It does not
decide whether to call tools, how many calls are enough, or how to compose them;
that loop belongs to the companion and the selected local CPU runtime. Grok is
started as a single-turn, read-only process with its built-in tools, web search,
cross-session memory, and subagents disabled.

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
actions should be enabled only with an explicit trust boundary.
