# Security Policy

## Reporting

Please open a GitHub security advisory or a private issue with enough detail to
reproduce the problem. Do not post API keys, browser profiles, cookies, or other
secrets in public issues.

## Local Companion

The companion server listens on `127.0.0.1:18791` by default. Keep it on
loopback unless you understand the risk of exposing browser-agent endpoints to a
network.

The companion accepts browser extension origins by default. To pin allowed
origins, set:

```bash
BABATA_SIDEBAR_ALLOWED_ORIGINS=chrome-extension://your-extension-id
```

Without that setting, all syntactically valid extension origins are trusted,
including other installed extensions. This is a local trust boundary, not a
network authentication mechanism; do not expose the companion to untrusted
networks. Browser client IDs route tools and history to the requesting browser
and are not secrets or authentication tokens. Tool replies must come from the
same WebSocket that received the request. Browser content scripts cannot invoke
the extension's internal chat, snapshot, or WebSocket dispatch messages.
Privileged extension GET requests may omit `Origin`; in that case the companion
accepts `X-Babata-Extension-Origin` against the same allowlist. This header never
overrides an actual browser-supplied `Origin`.

## API Keys

Translation provider keys are stored in the companion config file:

```text
~/.babata-sidebar/config.json
```

The extension options page sends keys to the local companion over loopback. The
options page can read the saved key back from `/settings` so users can review
or edit their configuration. The extension stores the companion URL in
`chrome.storage.local`, but it does not store provider API keys.

Config writes are serialized and replaced atomically with owner-only file
permissions. A corrupt existing config is reported rather than overwritten.
Changing the provider URL does not implicitly forward the previous provider's
key, and provider HTTP redirects are rejected.

Audio transcription has a separate optional provider configuration and the same
key-storage rules. It starts only through a player's explicit transcription
control. The extension captures the selected video's accessible audio tracks,
not microphone or desktop audio. Chunks are bounded to 25 seconds and 4 MiB and
forwarded in memory; the companion does not save audio recordings. The selected
audio provider receives those chunks, and the selected translation provider
receives the resulting caption text. Protected or inaccessible media is not
bypassed.

Page and caption translations use bounded in-memory caches. The companion keys
entries by source text, target, model, provider, credential identity digest, and
prompt version; client-supplied hashes are not trusted as content identity.
Translation metrics retain aggregate counts and a bounded sample of durations,
without webpage content or URLs. Cancelling a subscriber aborts shared provider
work only when no other subscriber still needs it.

Chat and debug history remains local, can contain page content, and is scoped
by browser client and conversation. Request cancellation stops the model process
tree. WebSocket payloads, model output, concurrent chat requests, and provider
response time are bounded. No new browser permissions are needed for these
controls.

Prompts are passed over stdin for Codex/Claude and through an owner-only
temporary file for Grok, avoiding command-line length limits and process-list
exposure. The Grok file is removed after completion, failure, or cancellation.

## Browser Permissions

The extension requests broad permissions because page translation, page context,
side panel workflows, and agent-style browser actions need access to page
content and browser state.

Review `src/manifest.json` before loading the extension. In particular:

- `host_permissions: <all_urls>` lets content scripts run broadly.
- `scripting` reads page context and performs explicitly enabled browser actions.
- `offscreen` keeps the connection and active chat stream alive while panels close.
- The offscreen document also owns cancellable translation/transcription HTTP
  requests, avoiding the service worker's long-fetch lifecycle limit.
- Video caption scripts run in HTTP(S) frames. They observe HTML5 text tracks
  and recognized caption responses; the network observer does not collect
  arbitrary JSON, page requests, credentials, or video files. Audio capture uses
  a video's existing media stream and requires no microphone or tab-capture
  permission.
- Unused debugger, downloads, alarms, notifications, webNavigation and contextMenus permissions are not requested.
- Page snapshots and DOM queries redact password, hidden and one-time-code input values. This does not detect all sensitive text on a page.
- `history` and `bookmarks` allow local browser state search.

## Public Repository Hygiene

Before publishing or accepting contributions:

- Search for local absolute paths and secrets.
- Do not commit `.env`, config files, logs, browser profiles, or screenshots
  containing private data.
- Keep generated `dist/` artifacts out of source commits unless a release
  process explicitly needs them.
