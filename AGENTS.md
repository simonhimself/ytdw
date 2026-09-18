# YT;DW Agent Guide

## Project

YT;DW turns captioned YouTube videos into concise reading briefs. The production
application is available at `https://ytdw.fyi/` in the `simonhimself` account.

## Architecture

- `src/index.ts` contains the Worker API, transcript processing, caching, and
  Durable Object coordination.
- `public/index.html` contains the single-page UI structure.
- `public/app.js` contains client behavior; `public/theme.js` sets the initial theme.
- `public/styles.css` contains the Kumo-based light and dark themes.
- `Dockerfile` defines the Sandbox image that runs `yt-dlp`.
- `wrangler.jsonc` is the source of truth for Cloudflare bindings and deployment.
- `wrangler.legacy.jsonc` is historical only; its deployment was retired on 2026-09-18.

The Worker uses Cloudflare Workers, Sandbox, Durable Objects, Workers AI,
Turnstile, rate limits, static assets, and the Cache API.

## Commands

```bash
npm install
npm run cf-typegen
npm run typecheck
npm test
npm run test:ui
npm run dev
```

Docker must be running for local Sandbox execution. For static UI work when
Docker is stopped, use:

```bash
npm run dev -- --enable-containers=false
```

After every code change, run:

```bash
npm run typecheck
git diff --check
```

For backend changes, run `npm test` (real local Workers/SQLite runtime, mocked
external services). For client changes, run `npm run test:ui` (Chromium desktop/
mobile widths in both themes). Neither suite needs Docker. Tests use local-only
fixture controls that must never be added to production routes.

Also verify affected behavior in a browser at desktop and mobile widths. Check
both light and dark modes for visual changes.

## Deployment

Deploy normally with `npx wrangler deploy`. If Docker is stopped and the
container image is unchanged, deploy with:

```bash
npx wrangler deploy --profile default --containers-rollout=none
```

The main config pins the `simonhimself` account and the existing image by digest.
Do not deploy `wrangler.legacy.jsonc`; the old `ssteiner` resources were deleted.
Verify `https://ytdw.fyi/` after deployment. `www.ytdw.fyi` and
`ytdw.simons.workers.dev` remain supported aliases on the same Worker.

## Conventions

- Preserve the existing minimal Kumo visual language and accessibility behavior.
- Keep the page functional with pointer, touch, and keyboard input.
- Keep secrets out of source control. Production requires `TURNSTILE_SECRET`
  and `TEST_TOKEN` as Wrangler secrets.
- Do not weaken the six-hour video limit, 400,000-character transcript limit,
  rate limits, job coalescing, or 24-hour cache without an explicit requirement.
- Update `TEST_PLAN.md` and `TEST_RESULTS.md` when validation scope changes.
- The existing Sandbox SDK/image remain at `0.12.1`; do not require a container
  rebuild or a CI pipeline for Worker/UI-only fixes.
- The legacy `ssteiner` deployment was retired with explicit authorization after
  confirming its share objects had no stored data. Do not recreate those resources.
