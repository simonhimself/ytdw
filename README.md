# YT;DW

YT;DW turns captioned YouTube videos into concise reading briefs. Paste a video URL, complete a quiet Turnstile check, and keep the useful parts without watching the whole video.

[Open YT;DW](https://ytdw.ssteiner.workers.dev/)

## Stack

- Cloudflare Workers serves the application and API.
- Cloudflare Sandbox runs `yt-dlp` to retrieve public English captions.
- Durable Objects coordinate and deduplicate summary jobs.
- Workers AI generates structured briefs with GLM 5.3 Flash.
- Turnstile and rate limits protect the public endpoint.
- Cache API reuses completed briefs for 24 hours.
- Per-link Durable Objects store shareable brief snapshots for a fixed 24 hours.

## Sharing

After generating a brief, select **Copy share link**. Anyone with the link can
read the same result, open the original YouTube video, and forward the link.
The shared view requires no verification or additional AI generation.

Links expire 24 hours after their snapshot is created, including for cached
results. Opening or forwarding a link does not extend its lifetime. Expiry is
checked on the server and a Durable Object alarm clears the snapshot. Raw
transcripts are still discarded after processing.

## Development

```bash
npm install
npm run cf-typegen
npm run typecheck
npm run dev
```

Docker must be running for local Sandbox development.

## Deployment

```bash
npx wrangler deploy
```

The production Worker also requires `TURNSTILE_SECRET` and `TEST_TOKEN` secrets. Set them with `wrangler secret put`; never commit their values.

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

See `TEST_PLAN.md` and `TEST_RESULTS.md` for validation details.
