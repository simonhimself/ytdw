# YT;DW Local Test Plan

## Goal

Validate the Worker/SQLite coordination and UI locally without live upstream
calls, then smoke-test generation and sharing after an explicitly approved deploy.
The original optional container checks are retained below for image maintenance.

## Preconditions

- Node.js and npm are installed.
- Docker is only required for the optional real-container checks, not `npm test`
  or `npm run test:ui`.
- The test URL is a public YouTube video that does not require authentication.

## Tests

For the optional real-container health check:

```bash
export TEST_VIDEO_URL="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
export TEST_TOKEN="local-test-token"
```

| ID | Test | Command or action | Pass condition |
| --- | --- | --- | --- |
| T1 | Toolchain | `node --version`, `npx wrangler --version`; `docker info` only for image work | Required tools for the chosen checks are available. |
| T2 | Static validation | `npm install`, `npm run cf-typegen`, `npm run typecheck` | Dependencies install and TypeScript compiles. |
| T3 | Optional container build | `docker build -t ytdw .` | The image builds with Python, `yt-dlp`, Node.js, and FFmpeg. Not required for this Worker/UI-only release. |
| T4 | Optional binary smoke test | Run `docker run --rm --entrypoint bash ytdw -lc 'python3 --version && yt-dlp --version && node --version && ffmpeg -version \| head -n 1'`. | Each required binary is present. |
| T5 | Wrangler health | Start `npm run dev -- --var TEST_TOKEN:local-test-token` in a separate terminal, then run `curl -fsS -H "Authorization: Bearer $TEST_TOKEN" http://127.0.0.1:8787/health`. | Response is `200` and lists all tool versions. |
| T6 | Retired metadata endpoint | Request `/metadata` even with a valid diagnostic token. | 404; no extraction outside the global queue. |
| T7 | Retired caption endpoint | Request `/captions` even with a valid diagnostic token. | 404; no extraction outside the global queue. |
| T8 | Input rejection | Send null/array JSON bodies or a non-YouTube URL to `/api/summarize`. | 400 before Siteverify or Sandbox execution. |

## Production Follow-up

Local tests do not validate YouTube access from Cloudflare data-center IPs.
After an explicitly approved deployment, use the normal app to generate one
captioned video and open its share URL. Confirm tokenless `/health` is rejected,
shared reads need no verification, and the public errors remain helpful.

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

## Reliability and hardening suite

Run `npm test` and `npm run test:ui`. The backend fixture runs production code and
SQLite in workerd, with fake YouTube/AI/Turnstile and deterministic edge-limit
decisions. Queue, processing, and recovery timers are shortened only in the test
bundle. The browser suite serves the actual assets/CSP and simulates API/clipboard
outcomes across desktop/mobile widths and light/dark themes.

| ID | Check | Pass condition |
| --- | --- | --- |
| R1 | Early request guards | Invalid JSON/URLs and pre-limit rejections cause no Siteverify calls. Client-rejected requests do not consume the shared edge limit. |
| R2 | Bounded queue and coalescing | Three distinct pending jobs maximum, duplicate jobs coalesce, overflow and stale waiters receive retry guidance without extra extraction. |
| R3 | Authoritative admissions | At most five distinct generation jobs per rolling ten seconds in the coordinator; cached results remain readable. |
| R4 | Global completed cache | Edge misses and runtime reload reuse the same stored result/expiry without more AI calls; expired records are not reused and alarms remove them. |
| R5 | Deadlines and ambiguous execution | Non-cooperative startup is bounded; late commands check absolute deadlines before starting media work. RPC/reset failures retain a persisted barrier and do not start an immediate retry. |
| R6 | Endpoint and header hardening | Share reads are limited before lookup, fixed expiry is preserved, diagnostic extraction is unavailable, authenticated health still works, and no-store/CSP/anti-framing headers cover API and share pages. |
| U1 | Copy and fallback | Exact Markdown survives copying; denial shows selected text; success remains accessible without an extra visible line. |
| U2 | Replacement and verification | Old brief remains usable on failure; malformed success cannot partially replace it; duplicate verification is blocked and the submitted URL is preserved. |
| U3 | Async feedback and focus | Late callbacks cannot modify a replacement brief; successful actions retain keyboard focus and expired sharing focuses the recovery link. |
| U4 | Share recovery | Server-confirmed expiry offers regeneration without auto-submission; recipients get actionable recovery instructions without loading Turnstile. |
| U5 | Responsive preferences | Large landing logo, centered 28px result logo, 16px mobile inputs, and no horizontal overflow in both themes. |
| U6 | Turnstile placement | When visible, the normal-size widget is horizontally centered beneath the form on desktop and mobile. |

Npm audit covers the JavaScript dependency tree, not the existing container image.
Native iOS behavior and real screen-reader speech remain manual follow-up checks.
