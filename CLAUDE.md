# Claude Code Instructions

This is the public contributor guide for Claude Code sessions in this repo.

- Keep changes source-grounded: inspect the relevant files before editing.
- Preserve local-first behavior. The extension should talk only to user
  configured loopback companion URLs by default.
- Keep provider credentials in the companion config file, never in extension
  storage or committed files.
- Prefer dynamic configuration over hardcoded paths, ports, keys, or model ids.
- When a user gives you this GitHub repo and asks to set it up, run
  `npm run setup:local`, then start `npm run companion` if they want to use it
  immediately.
- Guide the user to load the generated `dist/` directory as an unpacked
  Chromium extension and enter provider API keys in the extension options page.
  Do not ask for provider API keys in chat.
- Before finishing code changes, run:

```bash
npm run typecheck
npm run build
npm run smoke:companion
```

Do not add private user facts, local private paths, credentials, or internal
research notes to this public repository.
