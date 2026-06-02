# Agent Instructions

This repository is public. Do not add private user facts, local machine paths,
credentials, internal research notes, or non-public project state.

## Development

- Use `rg` for code search.
- Keep extension behavior configurable through settings or environment
  variables rather than hardcoded local paths.
- Keep the local companion loopback-first.
- Do not store provider API keys in Chrome extension storage.
- Run focused checks before handing off:

```bash
npm run typecheck
npm run build
npm run smoke:companion
```

## Public Release Hygiene

- Do not commit `.env`, local config files, logs, screenshots with personal
  data, or generated browser profiles.
- If a feature needs a provider URL, model name, CLI path, or port, expose it as
  user configuration.
- Document any new permission in `README.md` or `SECURITY.md`.
