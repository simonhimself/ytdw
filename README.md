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

## Limits

- English-captioned YouTube videos only
- Maximum video duration of six hours
- Maximum transcript input of 400,000 characters
- One Sandbox container with globally coordinated work

See `TEST_PLAN.md` and `TEST_RESULTS.md` for validation details.
