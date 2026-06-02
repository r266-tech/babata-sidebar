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

## API Keys

Translation provider keys are stored in the companion config file:

```text
~/.babata-sidebar/config.json
```

The extension options page sends keys to the local companion over loopback. The
options page can read the saved key back from `/settings` so users can review
or edit their configuration. The extension stores the companion URL in
`chrome.storage.local`, but it does not store provider API keys.

## Browser Permissions

The extension requests broad permissions because page translation, page context,
side panel workflows, and agent-style browser actions need access to page
content and browser state.

Review `src/manifest.json` before loading the extension. In particular:

- `host_permissions: <all_urls>` lets content scripts run broadly.
- `debugger` is powerful and should be granted only to code you trust.
- `history` and `bookmarks` allow local browser state search.

## Public Repository Hygiene

Before publishing or accepting contributions:

- Search for local absolute paths and secrets.
- Do not commit `.env`, config files, logs, browser profiles, or screenshots
  containing private data.
- Keep generated `dist/` artifacts out of source commits unless a release
  process explicitly needs them.
