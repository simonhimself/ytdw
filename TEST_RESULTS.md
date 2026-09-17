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

Local feature validation; this feature has not been deployed. Earlier production
results above describe the existing application, not the new sharing routes.

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
- Real YouTube extraction, live Turnstile, and Workers AI were not rerun for this
  feature. A production smoke test remains after deployment.
