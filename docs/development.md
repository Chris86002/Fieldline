# Development and repository guide

[Back to README / quick start](../README.md#developers-local-browser-run) ·
[Desktop maintainer guide](desktop.md)

## Setup and checks

Use **Node.js 22.13+ (22.x) or 24+ (with npm)** and Git. Follow the README's
[clone, `npm ci`, and `npm run dev` steps](../README.md#developers-local-browser-run).
Read [AGENTS.md](../AGENTS.md) for contributor notes and safety constraints.
The supported Node versions reflect the locked dependency requirements.

Run from the repository root:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Domain/persistence changes need focused regression tests in
`src/lib/hunt/*.test.ts`; these use Node's built-in test runner. Desktop changes
also need `npm run desktop:test` (`desktop/*.test.mjs`) and appropriate
[native packaged verification](desktop.md#packaged-smoke-tests-and-manual-verification).
Keep changes focused; do not run the repository-wide `npm run format` just to
format unrelated files.

Preserve hunting-map identity and `fieldline-v1` saved-data compatibility,
provider attribution, legal/access caveats, bounded validated public requests,
provider terms, and offline limitations. No credentials, paid services, or cloud
database are needed for setup. See [desktop profile contracts](desktop.md#saved-data-profiles-and-upgrades)
before changing desktop persistence.

## Production and browser smoke checks

```sh
npm run build
npm run start
```

`start` serves `.output/server/index.mjs` at <http://localhost:3000> by default;
set `PORT` in the server environment to choose another port. Deployment uses the
same build and start commands on a Node 22.13+ (22.x) or 24+ host. No Grok/App Builder account,
credentials, database, or environment secrets are required.

For a production preview without starting that Node server, use
`npm run preview` after building and open <http://localhost:8081>.
Development and preview bind to `0.0.0.0`; do not expose development servers to
untrusted networks.

For the existing desktop/mobile **browser** smoke check, install Playwright's
Chromium with `npx playwright install --with-deps chromium`, leave
`npm run start` running in another terminal, then run `npm run smoke`.
This is not the packaged Electron test.

[`Fieldline checks`](../.github/workflows/ci.yml) runs on pushes and pull requests,
including the four checks above and browser smoke.
[`Fieldline desktop installers`](../.github/workflows/desktop.yml) runs manually;
see the desktop guide for packaging and artifact download instructions.

## Repository map

Paths below are relative to the repository root. Source and required
configuration remain in their existing locations.

| Location | Purpose |
| --- | --- |
| [`src/components/hunt/`](../src/components/hunt/) | Hunting-map UI: `HuntApp.tsx`, `MapCanvas.tsx`, and mark controls. |
| [`src/lib/hunt/`](../src/lib/hunt/) | Domain types, unit/border/land references, Zustand state and persistence, transfer/import/export, search/weather server functions, and tile caching. Unit tests are colocated as `*.test.ts`. |
| [`src/routes/`](../src/routes/) | TanStack Start page/root routes and the validated `api/dem/$z/$x/$y.ts` elevation endpoint. |
| [`src/router.tsx`](../src/router.tsx), [`src/routeTree.gen.ts`](../src/routeTree.gen.ts) | Router setup and **generated, tracked** route tree; change route source rather than hand-editing the generated tree. |
| [`src/styles.css`](../src/styles.css), [`src/lib/error-component.tsx`](../src/lib/error-component.tsx) | Shared styles and error UI. |
| [`desktop/`](../desktop/) | Electron shell, local server, lifecycle/security policy modules, colocated `*.test.mjs` tests, and desktop package metadata. |
| [`public/`](../public/) | Static assets, icons, PWA manifest, and service worker. |
| [`scripts/`](../scripts/) | `browser-smoke.mjs`, `desktop-build.mjs`, and `desktop-smoke.mjs`. |
| [`.github/workflows/`](../.github/workflows/) | Web CI (`ci.yml`) and manual desktop packaging (`desktop.yml`). |
| [`package.json`](../package.json), [`package-lock.json`](../package-lock.json) | npm scripts, dependencies, lockfile, and electron-builder configuration. |
| [`vite.config.ts`](../vite.config.ts), [`tsconfig.json`](../tsconfig.json) | Vite/TanStack/Nitro/Tailwind build and TypeScript configuration. |
| [`eslint.config.mjs`](../eslint.config.mjs), [`.prettierrc`](../.prettierrc), [`.gitignore`](../.gitignore) | Linting, formatting, and generated/local-file exclusions. |
| [`startup.sh`](../startup.sh) | Existing shell convenience launcher for the dev server on port 8080; not an installer. |
| [`README.md`](../README.md), [`AGENTS.md`](../AGENTS.md), [`docs/`](./) | User landing page, contributor constraints, and desktop/development guides. |

**Ignored generated/local output** (not source; do not commit):
`node_modules/` (installed dependencies), `.output/` (production server/public
build), `.nitro/` and `dist/` (build intermediates/output), `.desktop-output/`
(desktop server/public build), `release/` (native packages/installers), and
`screenshots/` (smoke captures). See `.gitignore` for local environment exclusions.

## Troubleshooting

- **Clone returns not found / access denied:** this repository is private.
  Authenticate Git with an account granted access, or ask a maintainer for an
  installer if you only want to use Fieldline. Do not put credentials in files.
- **`node`/`npm` missing or engine/type-stripping errors:** install Node 22.13+ (22.x) or 24+
  with npm, check `node --version` in the same terminal, then rerun `npm ci`
  from the directory containing `package.json` and `package-lock.json`.
- **Dependency download fails:** check connectivity and the npm registry error;
  installation also downloads Electron. Retry `npm ci` after resolving network
  access. Do not disable certificate validation or edit the lockfile to bypass it.
- **Port 8080/8081 already in use:** dev/preview use strict ports. Stop the
  conflicting process if safe, then retry; the server will not choose another
  port silently. Keep the terminal open while using the app.
- **Production start cannot find `.output/server/index.mjs`:** run
  `npm run build` successfully before `npm run start`.
- **Browser installation option missing:** use a supported browser on HTTPS or
  localhost; an insecure LAN HTTP address may not support service workers or
  installation. GPS also requires permission and browser/OS support.
- **Empty map or missing saved data:** check internet/provider availability.
  Storage belongs to the current browser and origin (including port); localhost
  development, production, and desktop have separate data. Export GPX backups
  before switching. Private browsing/storage limits can prevent persistence.
