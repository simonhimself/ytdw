# YT;DW Agent Guide

## Project

YT;DW turns captioned YouTube videos into concise reading briefs. The production
application is available at `https://ytdw.ssteiner.workers.dev/`.

## Architecture

- `src/index.ts` contains the Worker API, transcript processing, caching, and
  Durable Object coordination.
- `public/index.html` contains the single-page UI and client-side behavior.
- `public/styles.css` contains the Kumo-based light and dark themes.
- `Dockerfile` defines the Sandbox image that runs `yt-dlp`.
- `wrangler.jsonc` is the source of truth for Cloudflare bindings and deployment.

The Worker uses Cloudflare Workers, Sandbox, Durable Objects, Workers AI,
Turnstile, rate limits, static assets, and the Cache API.

## Commands

```bash
npm install
npm run cf-typegen
npm run typecheck
npm run dev
```

Docker must be running for local Sandbox execution. For static UI work when
Docker is stopped, use:

```bash
npm run dev -- --enable-containers=false
```

There is no automated test suite. After every code change, run:

```bash
npm run typecheck
git diff --check
```

Also verify affected behavior in a browser at desktop and mobile widths. Check
both light and dark modes for visual changes.

## Deployment

Deploy normally with `npx wrangler deploy`. If Docker is stopped and the
container image is unchanged, deploy with:

```bash
npx wrangler deploy --containers-rollout=none
```

Verify `https://ytdw.ssteiner.workers.dev/` after deployment.

## Conventions

- Preserve the existing minimal Kumo visual language and accessibility behavior.
- Keep the page functional with pointer, touch, and keyboard input.
- Keep secrets out of source control. Production requires `TURNSTILE_SECRET`
  and `TEST_TOKEN` as Wrangler secrets.
- Do not weaken the six-hour video limit, 400,000-character transcript limit,
  rate limits, job coalescing, or 24-hour cache without an explicit requirement.
- Update `TEST_PLAN.md` and `TEST_RESULTS.md` when validation scope changes.
