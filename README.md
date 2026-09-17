# YT;DW

YT;DW turns captioned YouTube videos into concise reading briefs. Paste a video URL, complete a quiet Turnstile check, and keep the useful parts without watching the whole video.

[Open YT;DW](https://ytdw.ssteiner.workers.dev/)

## Stack

- Cloudflare Workers serves the application and API.
- Cloudflare Sandbox runs `yt-dlp` to retrieve public English captions.
- Durable Objects bound the global queue, deduplicate jobs, and retain completed briefs.
- Workers AI generates structured briefs with GLM 5.3 Flash.
- Turnstile and rate limits protect the public endpoint.
- A global 24-hour summary cache is accelerated by the edge Cache API.
- Per-link Durable Objects store shareable brief snapshots for a fixed 24 hours.

## Sharing

After generating a brief, select **Share** to copy its link and reveal the expiry
notice. Anyone with the link can read the same result, open the original YouTube
video, and forward the link.
The shared view requires no verification or additional AI generation.

Links expire 24 hours after their snapshot is created, including for cached
results. Opening or forwarding a link does not extend its lifetime. Expiry is
checked on the server and a Durable Object alarm clears the snapshot. Raw
transcripts are still discarded after processing.

**Copy** preserves the brief's Markdown headings, paragraphs, and numbering.
Both copy actions offer manual selection if clipboard access is unavailable.
Share checks whether the link still exists before copying it; expired links offer
a way to prefill the original video URL and generate another brief.

## Development

```bash
npm install
npm run cf-typegen
npm run typecheck
npm test
npm run test:ui
npm run dev
```

The tests use a local Workers runtime with simulated YouTube/AI responses and a
real Chromium browser. They do not require Docker or production credentials.
The browser tests use installed Google Chrome on macOS, or Playwright Chromium
(`npx playwright install chromium`). Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to
use another local Chromium binary.

Docker is only needed to run the actual Sandbox locally or rebuild its image.
The existing Sandbox SDK and image remain at `0.12.1`.

Browser behavior lives in `public/app.js`; `public/theme.js` initializes the theme
before first paint. The UI gets its public Turnstile sitekey from `/api/config`.

## Deployment

```bash
npx wrangler deploy --profile ssteiner --containers-rollout=none
```

The production Worker also requires `TURNSTILE_SECRET` and `TEST_TOKEN` secrets. Set them with `wrangler secret put`; never commit their values.

This command reuses the deployed container image. No Docker build or GitHub
workflow is needed for the current Worker/UI changes. `/health` remains protected
by `TEST_TOKEN`; the old `/metadata` and `/captions` execution endpoints are
retired so extraction cannot bypass the coordinated queue.

The requested move to the `simonhimself` account is a separate next step after
validation. Its Workers subdomain is `simons.workers.dev`; do not change the
active account or the live `ssteiner` app during this fix release. Existing share
URLs must remain readable on their original hostname until they expire.

### Recovery for the sharing release

The sharing release adds the `SharedBrief` Durable Object in migration `v3`.
Cloudflare does not allow a normal version rollback across this class migration.
To restore the pre-sharing behavior, deploy the application logic and UI from
commit `f40cb11`, while retaining the new `SharedBrief` export, its binding, and
the migration history. Keep its alarm handler so existing snapshots are cleaned
up. Do not remove or reverse the migration. Since the Sandbox image is unchanged,
this recovery can use `npx wrangler deploy --containers-rollout=none` against the
existing production Worker.

## Limits

- English-captioned YouTube videos only
- Maximum video duration of six hours
- Maximum transcript input of 400,000 characters
- One Sandbox container with globally coordinated work
- At most one processing job plus two waiting jobs; waiting jobs expire after 90 seconds
- At most five new generation jobs admitted globally per rolling 10 seconds
- Six-minute processing deadline, with per-command deadlines of at most two minutes
- Ambiguous extraction failures retain a short recovery barrier rather than immediately retrying a potentially running subprocess
- Per-client submission and share-read limits reject excess traffic before upstream work

## Maintenance

Run `npm audit` when updating development tools and keep `package-lock.json` in
sync. Test runtime and browser behavior before deploying a toolchain update.
External scripts allow a stricter CSP without inline JavaScript; static and
Worker-generated responses both deny framing. Container upgrades and image scans
are separate maintenance work requiring an actual image build, and are not part
of this release.

See `TEST_PLAN.md` and `TEST_RESULTS.md` for validation details.
