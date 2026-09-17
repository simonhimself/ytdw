# YT;DW Test Results

Status: Passed

| ID | Status | Evidence |
| --- | --- | --- |
| T1 | Passed | Docker client `29.1.3`, Docker server `29.7.2`, Node `v22.18.0`, and Wrangler `4.127.0` are available. |
| T2 | Passed | `npm install`, `npm run cf-typegen`, and `npm run typecheck` completed successfully. npm reported zero vulnerabilities. |
| T3 | Passed | The Sandbox image built successfully. The amd64-on-arm64 warning is expected for the current Cloudflare base image. |
| T4 | Passed | Python `3.10.12`, `yt-dlp` `2026.08.19`, Node `22.22.3`, and FFmpeg `4.4.2` executed inside the image. |
| T5 | Not rerun | Wrangler previously started locally, but the final Node and certificate changes were not retested end to end before staging. |
| T6 | Not rerun | The final certificate configuration was not retested locally before staging. |
| T7 | Not rerun | The final certificate configuration was not retested locally before staging. |
| T8 | Passed | A non-YouTube URL returned `400`; static review confirmed validation runs before `sandbox.exec()`. |

## Production

- Worker URL: `https://ytdw.ssteiner.workers.dev`
- Container application: `ytdw-sandbox`
- Container image digest: `sha256:dc66600b6b8c57db2861d769cf48fb5b9424642479f740883f55ac718cf721a5`
- Authentication: `TEST_TOKEN` secret configured; an unauthenticated request returned `401`.
- Remote `/health`: returned `200` with Python `3.10.12`, `yt-dlp` `2026.08.19`, Node `22.22.3`, and FFmpeg `4.4.2`.
- Remote `/metadata`: returned `200` with the expected video ID, title, and 213-second duration.
- Remote `/captions`: returned `200` with a `WEBVTT` body.
- Remote invalid URL: returned `400` before container execution.
- Cold start: the first health request returned a transient `502`; retry succeeded.
- YouTube access: no bot challenge, IP block, or TLS error was observed.

## Conclusion

The tests confirm that YT;DW can orchestrate a Sandbox container running
`yt-dlp`, retrieve YouTube captions from Cloudflare's production network, and
produce a complete summary through Workers AI. Cold-start retries, durable job
coordination, rate limiting, and summary caching are enabled in production.

## Summarizer UI

- Public page: returned `200` with the Kumo-styled YT;DW interface.
- Static assets: CSS and security headers, including CSP, returned correctly.
- Turnstile: production widget created for the Worker hostname and local test hosts; secret stored as `TURNSTILE_SECRET`.
- Protection: tokenless summary requests returned `403`; diagnostic requests without their bearer token returned `401`.
- Bindings: Workers AI, per-client/global rate limiting, and the Coordinator Durable Object deployed successfully.
- Container: one healthy instance, zero failed instances, and no reported errors.
- End-to-end: Turnstile completed in a browser and a cached 5h 15m video returned its full 16-point summary.
- Responsive UI: desktop light and dark modes and the mobile result layout passed visual checks without horizontal overflow.
- Accessibility: Lighthouse scored 100 for accessibility, best practices, SEO, and agentic browsing.

## Brief sharing — September 17, 2026

Local feature validation is recorded below. Deployment details and production
checks for this release follow the table.

| ID | Status | Evidence |
| --- | --- | --- |
| S1 | Passed locally | Isolated Miniflare fixture exercised the production handler with a stubbed completed result on cache-miss and cache-hit paths. Both returned readable snapshots; repeated cached requests generated distinct links with 86,400,000 ms lifetimes. |
| S2 | Passed locally | Repeated public reads and repeated internal create calls preserved the original expiry. The shared page exposes the same share URL to recipients. |
| S3 | Passed locally | Replaced the fixture Worker module with a simulated deployment through `setOptions`; the existing stored brief and expiry survived runtime reload. |
| S4 | Passed locally | Forced the stored expiry into the past while retaining the record: public reads returned 404. Calling the production alarm handler then emptied storage. |
| S5 | Passed locally | Malformed and unknown UUIDs returned 404. Browser showed “This link has expired or is unavailable” and the home link. |
| S6 | Passed locally | Injected a namespace failure; the summary remained intact and `share` was null. |
| S7 | Passed locally | Browser checks at 1440×900 and 390×844 in light and dark modes; result actions fit, theme toggles worked, video metadata and YouTube link were visible. Inspected mobile-light and desktop-dark screenshots. |
| S8 | Partial | Browser clipboard permission was denied; the fallback correctly revealed and selected the URL. Native controls and explicit label verified in source. Successful system clipboard writes and keyboard-only navigation were not exercised. Removed the client-clock expiry gate after review. |
| S9 | Passed locally | Actual static-asset routing served the share shell with no-store/noindex; API reads worked without a diagnostic token. Shared UI skips Turnstile initialization. |

- `npm run cf-typegen`, `npm run typecheck`, and `git diff --check` passed.
- Two-axis source review completed: no blocking standards findings; client-clock
  forwarding issue corrected and sharing documentation added.
- Local fixture: `/var/folders/bv/9bz6lr4s1sd9hvy1r1q4vlz40000gn/T/opencode/ytdw-share-check.mjs`.
  This temporary harness uses the installed Miniflare/esbuild packages and does
  not add fixture routes to production source.
- Live generation was subsequently exercised after deployment; see below.

### Production deployment

- Account verified: `Simon Steiner (CF)` (`224ecf06b47e8b9e86863aca7726c5eb`),
  authenticated as `ssteiner@cloudflare.com` through the local `ssteiner` profile.
  This profile is bound to the project directory; the default login remains separate.
- Release commit: `43e4d2b` on `main`.
- Previous version: `ad5ac8dd-25ee-49ff-ae7b-049f1971bf87`.
- Deployed version: `8ad2a468-0667-44f1-a40f-ef9074691c4f`.
- Deployed using `wrangler deploy --profile ssteiner --containers-rollout=none`,
  explicitly targeting the verified account. The existing Sandbox image was reused.
- Verified the new `SHARED_BRIEFS` binding and existing secrets in the deployed version.
- Production HTTP checks: `/` returns 200; `/s/not-a-link` returns the UI shell
  with no-store/noindex; `/api/shares/not-a-link` returns 404 and the expected
  unavailable message with no-store/noindex.
- Live Turnstile verification and generation succeeded for `dQw4w9WgXcQ`,
  returning the Rick Astley brief, video link, enabled Copy share link button,
  and expiration on September 18. Generation took several minutes.
- Clicking Copy share link revealed the selectable URL fallback because the
  embedded browser denied clipboard access. The browser tool does not expose
  input values; the initial recipient test was completed subsequently using a
  share URL supplied by the user.
- Production recipient verification passed for share ID
  `75aad086-16f5-47f3-a449-9a3fd1d2e878`: the browser displayed the All-In Podcast
  brief “Brad Gerstner: No AI Bubble, Semis Eat the Nasdaq & AI's Take Off Problem,”
  channel, duration, YouTube link, and Copy share link action without verification.
- Independent unauthenticated HTTP reads returned 200, no-store/noindex, identical
  summary content, the same forwarding URL, and unchanged expiry
  `2026-09-18T09:15:49.295Z`. The source video ID was `PJrntzMA4iQ`.

### Share notice interaction refinement — local validation

- Renamed the share action to **Share**; **Copy** remains unchanged.
- The expiry notice starts hidden and is revealed only by Share. Each newly
  displayed result resets the notice; link creation and expiration are unchanged.
- Verified hidden-before/click-to-reveal behavior and clipboard fallback using
  the local browser fixture in desktop/light and mobile/dark configurations.
  Computed display changed from `none` to `block` as expected. The embedded browser
  reported a zero-width document during these checks, so this validates behavior,
  not a fresh responsive layout review.
- Deployed as version `757d1252-5967-4fb4-87dc-ad3d0d3ce259` using the `ssteiner`
  profile and `--containers-rollout=none`. Production browser verification on the
  existing All-In share link confirmed the **Copy**/**Share** labels and the expiry
  notice changing from `display: none` before Share to `display: block` afterward.

### Result header and concise share feedback — local validation

- Successful sharing now shows only the expiry notice visually; the copy-success
  confirmation stays in the screen-reader live region. Clipboard failures still
  show the selectable URL and instructions.
- The generation page retains the centered hero logo at its landing-page size
  after a result appears, rather than shrinking and left-aligning it.
- Used a local UI fixture with simulated clipboard success/failure. Confirmed
  success feedback uses the clipped 1px `sr-only` style and failure instructions
  remain visible. No production clipboard permissions were changed.
- Browser computed-style checks confirmed the logo centered at 64px on desktop
  (1440px viewport) and 48px on mobile (390px viewport); checked light/dark themes.
- Deployed as version `fcbd8120-75a1-4865-a688-9902c871455d` with the `ssteiner`
  profile and the existing container image. Production HTML/CSS checks confirmed
  the screen-reader-only success status and removal of result-state logo shrinking
  and left alignment. The existing production share page still loaded its brief
  and the Copy/Share actions. Clipboard success was tested with the local fixture,
  since the embedded production browser denies clipboard access.

### Video-specific caption failure — September 17, 2026

- Reproduced failure for `38vwjWpHFes` on production. Metadata retrieval succeeded;
  the caption subprocess failed with `Unable to download video subtitles for
  'en-en-US': HTTP Error 429: Too Many Requests`. This preceded AI summarization.
  The user confirmed other videos continued to work.
- Prepared a local change to select one English caption track from metadata
  instead of downloading every `en.*` variant. HTTP 429 now maps to an explicit
  YouTube retry-later response instead of a generic processing failure.
- C1–C4 passed in the isolated fixture
  `/var/folders/bv/9bz6lr4s1sd9hvy1r1q4vlz40000gn/T/opencode/ytdw-captions-check.mjs`:
  authored/automatic/regional selection, malformed and empty tracks, one exact
  download target, early no-English rejection, summary result shape, and metadata/
  caption rate-limit handling. Existing unrelated 502 and timeout 504 responses
  were also verified. Sandbox and AI calls were mocked for these checks.
- `npm run typecheck` and `git diff --check` passed. This backend fix is not yet
  deployed; successful extraction of the affected video remains unverified.
