# Contributing

Thanks for improving babata-sidebar.

## Setup

```bash
npm install
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
```

## Guidelines

- Keep provider URLs, API keys, model ids, CLI paths, and ports configurable.
- Keep local companion APIs loopback-first.
- Do not commit secrets or private local paths.
- Document new extension permissions and companion endpoints.
- Keep UI text concise and avoid adding setup instructions inside the product
  surface when README documentation is enough.
