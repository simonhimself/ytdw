# YT;DW Test Results

Status: production migrated to `ytdw.simons.workers.dev`; live generation and
legacy-link preservation verified. The existing image was copied without a rebuild.
Live failed-replacement and native assistive-technology checks remain manual follow-ups.

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
- `npm run typecheck` and `git diff --check` passed.
- Caption fix committed as `507a8f9`, pushed on `fix/english-caption-rate-limits`,
  and fast-forward merged into `main`. The previously deployed UI refinements
  were also committed as `8ec4c63`.
- Deployed to production as version `c27bfaba-5aca-4bcc-98b3-c769a312fc92` using
  the `ssteiner` profile and `--containers-rollout=none`.
- Retried `38vwjWpHFes` through the production browser form. Logs confirmed
  metadata extraction and caption download both exited with code 0, the
  coordinator completed successfully, `/api/summarize` returned 200 in 42.34
  seconds, and `SharedBrief.create` completed successfully. This is a successful
  live retry of the affected video, not just a mocked selection test.
- A Sandbox alarm logged a deployment-related Durable Object reset; it did not
  prevent the successful summary request.

### Compact centered result logo — local validation

- Restored the result-state logo to 28px while retaining center alignment. The
  larger landing-page logo rules are unchanged.
- Local browser computed styles confirmed 28px and centered alignment in desktop/
  light and mobile/dark configurations. The browser reported a zero-width page,
  so this was a computed-style check rather than a full layout review.
- `npm run typecheck` and `git diff --check` passed. Deployed as version
  `482e2b98-db03-49ae-88b7-017203862c7c` using the `ssteiner` profile and
  `--containers-rollout=none`. Verified production CSS contains the 28px
  result-state rule and retains the larger responsive landing-page rule.

## Reliability and hardening

### Scope

- Fixes apply to UI behavior, Worker coordination/cache/limits, browser headers,
  and development-tool dependencies. The Sandbox SDK remains pinned to `0.12.1`
  and `Dockerfile` is identical to the previously deployed version. No new image,
  GitHub workflow, or account migration was performed. Worker/UI deployment is
  recorded below.
- The draft container upgrade/build workflow was set aside outside the repository
  after the user chose to keep the existing image. Container scans and package
  refreshes are not claimed as part of this release.

### Results

- `npm run typecheck` and `git diff --check`: passed.
- `npm test`: **10 passed**, exercising production routes and real SQLite Durable
  Objects in local workerd, with mocked upstream services and shortened test timers.
  Covered early limits/validation, client/shared limiter order, queue capacity and
  waiter expiry, duplicate coalescing, global admissions, completed-cache expiry
  and persistence, model timeouts, ambiguous reset recovery, uncooperative startup,
  disabled extraction diagnostics, health authentication, share throttling and headers.
- `npm run test:ui`: **48 passed** in Chromium at 1440×900 and 390×844, light and
  dark. Covered Markdown copying, manual fallbacks, previous-result preservation,
  verification state and captured URL, expiry/regeneration, keyboard focus, stale
  callback isolation, malformed response preservation, and the requested logo sizes.
  Upstream API/Turnstile responses and clipboard success/denial were simulated.
- Inspected generated desktop-light and mobile-dark screenshots. These are real
  browser layouts, unlike the earlier embedded browser's zero-width captures.
- `npm audit`: **zero advisories** after updating Wrangler/its development tooling.
  This does not scan the existing Linux container or prove third-party security.
- Review identified timeout/reset cleanup and keyboard-focus gaps; fixes and
  regression coverage were added. Both follow-up reviews found no remaining
  blockers in those changes.
- Wrangler's local `deploy --dry-run --profile ssteiner --containers-rollout=none`
  bundle/configuration check passed. This did not upload or deploy a version.
- Production YouTube/AI, native iOS clipboard,
  and real assistive-technology speech were not exercised in this local pass.

### Production release and smoke checks

- Release commit `522e6de` was fast-forward merged and pushed to `main`.
- Deployed version `00cc9a57-623b-4b9a-ba21-8b86401f7e9e` to the existing
  `ssteiner` account using `--containers-rollout=none`; the new request/share
  limit bindings and external browser scripts are present.
- A standalone real Chromium browser, with clipboard permissions granted and
  **no mocked APIs or clipboard**, opened the existing All-In shared brief.
  Copy matched the server's Markdown byte-for-byte. Share copied the unchanged
  URL, and that URL loaded in a fresh recipient context at mobile width.
- Verified unchanged share expiry, no recipient Turnstile requests, no page JS
  errors, no horizontal overflow, no-store, anti-framing headers, and CSP without
  inline-script permission. `/api/config` exposed only the public sitekey;
  retired extraction routes returned 404, tokenless health returned 401, and
  a null summary request returned 400.
- The first live generation attempt passed Turnstile and began extraction, but
  the shared browser panel navigated elsewhere and its request was canceled.
  Separate automated-browser attempts remained at interactive verification and
  submitted no generation request. A normal-browser generation and subsequent
  failed-replacement check are still needed; they are not counted as passed.
- Local-only smoke script:
  `/var/folders/bv/9bz6lr4s1sd9hvy1r1q4vlz40000gn/T/opencode/ytdw-live-hardening-check.mjs`.

### Migration planning status at the hardening release

At that release, the destination subdomain had only been read-only verified and
production still used `ytdw.ssteiner.workers.dev`. The completed migration is
recorded below.

### Centered Turnstile widget — local validation

- Centered the widget container with flex layout. Browser geometry checks using
  a normal-size widget fixture passed at 1440px and 390px in light and dark modes.
- All 48 browser tests, type checking, and `git diff --check` passed.
- Deployed as version `d99e08b1-5516-4e00-b859-64f9fe08a0d0` using the existing
  container. Production homepage returned 200 and the served stylesheet contained
  the centered Turnstile rule.

## Migration to simonhimself — September 17, 2026

- New production URL: `https://ytdw.simons.workers.dev/`.
- Destination account: `2423947c3898625c52d1d37070dffd03` (`simonhimself`).
  The project's local Wrangler profile now resolves to the default login,
  `simonhimself@gmail.com`; `ssteiner` remains available for legacy maintenance.
- Main config pins the destination account; `wrangler.legacy.jsonc` pins the
  source account and retains its original Durable Object namespaces.
- **M1 passed:** copied OCI layers directly between account registries. Both
  manifests match `sha256:dc66600b6b8c57db2861d769cf48fb5b9424642479f740883f55ac718cf721a5`.
  No Docker installation, image rebuild, SDK change, or CI workflow was needed.
- **M2 passed:** created destination Worker/bindings and container application
  `a031ba34-c4e2-40a9-a863-9144cebf1f0e`. Stored `TURNSTILE_SECRET` and a fresh
  diagnostic `TEST_TOKEN` directly in the Worker without printing their values.
  Authenticated health returned 200 with Python 3.10.12, yt-dlp 2026.08.19,
  Node 22.22.3, and FFmpeg 4.4.2.
- **M3 passed for configured integration:** created Managed widget
  `0x4AAAAAAE64yf1Lv7dzlttY` for the new hostname and local development hosts.
  Production hostname validation accepts only `ytdw.simons.workers.dev`.
  The widget-secret probe passed, invalid application tokens returned 403,
  tokenless health returned 401, and a real browser verification reached generation.
  Workers AI also completed a small direct model availability probe. Token replay
  rejection was not separately exercised during the live migration.
- **M5 generation and share-read checks passed:** after a setup-time Durable Object reset/cooldown, a retry for
  `dQw4w9WgXcQ` produced a full brief on the new account. Share successfully checked
  the new snapshot and displayed its expiry and manual URL-copy fallback. A real
  new-account summary, not a fixture, was displayed in the browser. Opening that
  particular new share in a separate recipient context was not exercised.
- Destination deployment: `4a9dc4af-7f3f-48aa-bbcc-1ae3a20fb6c0`.
- **M4 passed:** source deployment `6872e885-e348-4a89-bbfa-7f80280507d0` now
  redirects the old homepage with HTTP 302 and preserves video query parameters.
  Old generation requests return 409 with reload guidance instead of starting work.
  Existing share HTML and read API remain HTTP 200 on the source account. The
  known All-In share retained its exact expiry `2026-09-18T09:15:49.295Z`.
- `npm test`: **11 passed**, including migration routing, preserved share access,
  and rejection before upstream work. Type checking and diff checks passed.
- The source Worker, its share storage, secrets, and widget remain available for
  the transition. Nothing was deleted or scheduled for automatic deletion.
  Completed-result caches and share records were not copied into the destination.
