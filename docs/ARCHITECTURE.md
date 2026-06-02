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
- `POST /history`
- `POST /translate`
- `POST /translate/models`
- `POST /translate/test`
- `POST /attention`
- `POST /translate_trace`
- `POST /proactive`
- `POST /clean_read`
- `GET /ws` via WebSocket upgrade

The public companion keeps the common path self-contained: Codex or Claude Code
for chat, and an OpenAI-compatible provider for translation. Advanced agent
tool loops can build on the existing WebSocket request/response bridge.
