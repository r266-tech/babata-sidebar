# Claude Code Instructions

This is the public contributor guide for Claude Code sessions in this repo.

- Keep changes source-grounded: inspect the relevant files before editing.
- Preserve local-first behavior. The extension should talk only to user
  configured loopback companion URLs by default.
- Keep provider credentials in the companion config file, never in extension
  storage or committed files.
- Prefer dynamic configuration over hardcoded paths, ports, keys, or model ids.
- Before finishing code changes, run:

```bash
npm run typecheck
npm run build
npm run smoke:companion
```

Do not add private user facts, local private paths, credentials, or internal
research notes to this public repository.
