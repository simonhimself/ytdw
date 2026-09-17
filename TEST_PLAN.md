# YT;DW Local Test Plan

## Goal

Confirm that a Cloudflare Worker can invoke `yt-dlp` inside a Sandbox container
during `wrangler dev`, retrieve public YouTube metadata, and extract English
captions without downloading video.

## Preconditions

- Node.js and npm are installed.
- Docker is installed and the Docker daemon is running.
- The test URL is a public YouTube video that does not require authentication.

## Tests

Set a public captioned test video before T6 and T7:

```bash
export TEST_VIDEO_URL="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
export TEST_TOKEN="local-test-token"
```

| ID | Test | Command or action | Pass condition |
| --- | --- | --- | --- |
| T1 | Toolchain | `docker info`, `node --version`, `npx wrangler --version` | All commands exit successfully. |
| T2 | Static validation | `npm install`, `npm run cf-typegen`, `npm run typecheck` | Dependencies install and TypeScript compiles. |
| T3 | Container build | `docker build -t ytdw .` | The image builds with Python, `yt-dlp`, Node.js, and FFmpeg. |
| T4 | Binary smoke test | Run `docker run --rm --entrypoint bash ytdw -lc 'python3 --version && yt-dlp --version && node --version && ffmpeg -version \| head -n 1'`. | Each required binary is present. |
| T5 | Wrangler health | Start `npm run dev -- --var TEST_TOKEN:local-test-token` in a separate terminal, then run `curl -fsS -H "Authorization: Bearer $TEST_TOKEN" http://127.0.0.1:8787/health`. | Response is `200` and lists all tool versions. |
| T6 | Metadata extraction | Run `curl -fsS -H "Authorization: Bearer $TEST_TOKEN" --get --data-urlencode "url=$TEST_VIDEO_URL" http://127.0.0.1:8787/metadata`. | Response is `200` with video ID, title, and duration. |
| T7 | Caption extraction | Run `curl -sS -D /tmp/yt-caption-headers.txt -H "Authorization: Bearer $TEST_TOKEN" --get --data-urlencode "url=$TEST_VIDEO_URL" http://127.0.0.1:8787/captions`. | Response is `200`, has `Content-Type: text/vtt`, and begins with `WEBVTT`. |
| T8 | Input rejection | Run `curl -sS -o /tmp/yt-rejection.json -w '%{http_code}' -H "Authorization: Bearer $TEST_TOKEN" --get --data-urlencode 'url=https://example.com/video' http://127.0.0.1:8787/metadata`. | Response is `400`; code inspection confirms validation precedes `sandbox.exec()`. |

## Production Follow-up

Local success does not validate YouTube access from Cloudflare data-center IPs.
After local tests pass, protect a staging Worker with Cloudflare Access before
repeating T5-T7. These endpoints can start expensive, long-running work and must
not be public. Do not add account cookies unless their storage, rotation, and
account-risk implications have been reviewed.

## Results

Results are recorded in `TEST_RESULTS.md` after execution.

## Brief sharing

For local storage validation, use an isolated Miniflare fixture that imports the
production Worker and `SharedBrief` class. Stub verification and the coordinator's
completed result; keep the real share routes, SQLite storage, and static assets.
Do not expose fixture seed/expiry endpoints in the production Worker.

| ID | Test | Pass condition |
| --- | --- | --- |
| S1 | Fresh result and cache hit | Both return the displayed brief and a working UUID share URL. Separate successful requests get separate links with a full 24-hour lifetime. Share metadata is not cached with the summary. |
| S2 | Open and forward repeatedly | Public reads return identical content and expiry without verification or generation. Copy share link forwards the existing URL. |
| S3 | Persistence | Reload the Worker runtime and confirm the same link, content, and expiry survive. |
| S4 | Expiration and cleanup | Set fixture expiry in the past without cleaning storage: reads return 404. Invoke the alarm handler and confirm storage is empty. |
| S5 | Invalid links | Malformed and unknown IDs return 404 with an unavailable message, no-store, and noindex. The page offers a link home. |
| S6 | Optional sharing failure | Reject snapshot creation: the summary still returns successfully with `share: null`. |
| S7 | Shared UI | Desktop and mobile, light and dark: title/channel/duration, formatted brief, YouTube link, Copy, and Share are readable without clipped controls. The expiry notice is hidden initially, appears on Share (including clipboard fallback), and resets when a new result is displayed. Successful copying adds no second visible status line, but remains announced to screen readers. On the generation page, the result-state hero logo stays centered at 28px; the landing-page logo retains its larger responsive size. |
| S8 | Clipboard and accessibility | Copy succeeds where clipboard permission is granted; when blocked, a labeled, selected, read-only URL is available. Native buttons/links support keyboard input. Incorrect client time does not block forwarding. |
| S9 | Routing and response headers | `/s/:id` serves the UI shell and `/api/shares/:id` serves JSON without `TEST_TOKEN`. Shared responses use no-store/noindex; shared views do not load Turnstile. |

Run `npm run cf-typegen`, `npm run typecheck`, and `git diff --check`.
After deployment, repeat a real generation and share-link open in a second browser.

## Caption selection and upstream throttling

| ID | Test | Pass condition |
| --- | --- | --- |
| C1 | English caption selection | Prefer authored English captions over automatic tracks, original English automatic captions over translated variants, and accept regional English variants. Ignore malformed/empty/non-English tracks. |
| C2 | Single-track extraction | Request exactly the selected English language with an anchored expression. No wildcard English downloads; no extraction command when no English track exists. |
| C3 | YouTube rate limit | A yt-dlp HTTP 429 from metadata or caption extraction yields 503, a retry-later explanation, Retry-After, and no-store. Other failures and timeouts retain their existing responses. |
| C4 | Result compatibility | Caption-selection metadata does not leak into summary results. Video/transcript size limits, sharing, and caching remain intact. |
