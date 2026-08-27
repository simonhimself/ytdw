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
