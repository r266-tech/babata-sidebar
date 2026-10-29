# Contributing

Thanks for improving babata-sidebar.

## Setup

```bash
npm ci
npm run build
npm run companion
```

Load `dist/` as an unpacked extension from `chrome://extensions` or
`edge://extensions`.

## Checks

Run these before opening a pull request:

```bash
npm run typecheck
npm run build
npm run smoke:companion
npm test
npx playwright install chromium
npm run test:browser
```

The automated regressions use temporary configuration and browser profiles with
fake local CLIs/providers. The older `smoke:sidebar`, `smoke:rich-card`, and other
CDP smoke scripts target a running developer browser and are optional manual
checks; they are not prerequisites for the isolated test suite.
Set `BABATA_EXTENSION_ID` to the ID shown in your browser's extension manager
before running those manual scripts. They can reload that extension and briefly
change translation settings; `smoke:llm` also calls your configured models.

## Guidelines

- Keep provider URLs, API keys, model ids, CLI paths, and ports configurable.
- Keep local companion APIs loopback-first.
- Do not commit secrets or private local paths.
- Document new extension permissions and companion endpoints.
- Keep UI text concise and avoid adding setup instructions inside the product
  surface when README documentation is enough.
