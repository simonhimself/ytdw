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

Loading feedback: verify “Opening the video” → “Reading the captions” →
“Finding the signal” at 4.5-second intervals, including each supporting line.
During verification, only the button shows “Verifying”; the loading block stays
hidden and the logo does not pulse. Screen readers receive a verification announcement.
Verify the status and screen-reader announcement clear when a request ends.
Run in desktop/mobile Chromium with both light and dark themes.

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
| C2 | Single-track download | The Sandbox runs only the metadata command. The Worker fetches exactly one `vtt` URL for the selected English track, only from `https://www.youtube.com/api/timedtext`; any other caption URL is rejected without a request. No caption request when no English track exists. Caption bodies are capped at 2 MiB and bounded by the processing deadline. |
| C3 | YouTube rate limit | An HTTP 429 from metadata extraction or the Worker caption fetch yields 503, a retry-later explanation, Retry-After, and no-store. Other failures and timeouts retain their existing responses. Metadata uses `--extractor-args "youtube:player_client=android_vr"`; verify in production that a previously throttled video such as `aUrSDMtzsEc` summarizes successfully. |
| C5 | Browser-first transcript source | Browser Rendering metadata is tried first; success runs no Sandbox command. Authored English beats English auto-captions; with no English track, YouTube's English translation (`tlang=en`) is used. A browser-reported over-six-hour video is rejected with 400 and no fallback. Browser launch failure, non-OK playability (e.g. bot wall), an empty track list, or a failed browser-derived caption download each fall back to exactly one Sandbox metadata run. `src/youtube-browser.ts` is mocked in `npm test`; verify it live against real YouTube (probe via `wrangler dev --remote`) before deploying changes to it. |
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

## Accounts and library (Phase 1)

Spec: `docs/ACCOUNTS.md`. Three layers, none needing Docker or live services.
`npm test` covers the API against the real Worker, SQLite DOs, and a local D1
database with the real migrations. `npm run test:ui` covers the client against a
stateful fake account API at desktop/mobile widths in both themes.
`npm run test:integration` runs the real frontend against the real Worker and D1
in Chromium (desktop 1440x900 and mobile 390x844) with real cookies. It mocks only
the Turnstile browser script (and Siteverify inside the harness); no `/api` route
is mocked. It is the only layer that proves the two sides agree.

| ID | Check | Pass condition |
| --- | --- | --- |
| A1 | Credentials and sessions | Signup/login set an `HttpOnly; Secure; SameSite=Lax` `__Host-ytdw_session` cookie; the database holds only hashed sessions and PBKDF2 password hashes. Duplicate signup returns 409; every login failure shares one generic message; logout deletes the session. |
| A2 | Request guards | Auth requires a Turnstile token with action `auth`; the auth rate limit runs before the body is read or Siteverify is called. Mutations need a JSON content type and a matching `Origin`. |
| A3 | Library API | Save copies the server share snapshot; repeats are idempotent; expired shares return 404. List filters unread/all with counts, newest first; PATCH toggles read; DELETE removes. Users cannot see or modify each other's items; the cap is 1,000 briefs; `/library` serves the app shell with security headers. |
| A4 | Account UI | Auth dialog focus handling, validation, inline errors, Save (signed out/in, already saved, expired share, expired session), library tabs/counts/empty states, item view, mark read/unread, confirmed delete, sign out, and deep links. |
| A5 | Integration flow | Summarize, Save while signed out, create account in the dialog, auto-save, header Library badge 1, Unread tab, open item, Mark as read, All tab, reload and `/library?item=` deep link with the persisted session, Delete, empty state, Sign out, signed-out `/library`, wrong password (generic error), sign in again. Also opening `/s/<id>`, Save, idempotent re-save, and duplicate-signup 409. Each step asserts no page errors and no unexpected same-origin 4xx/5xx. |
| A6 | Cookie on loopback | Chromium accepts the Secure `__Host-` cookie over `http://localhost` and `http://127.0.0.1` (`INTEGRATION_HOST=127.0.0.1 npm run test:integration`) without weakening production cookie attributes. |
| A7 | Verification flow (integration) | Signup shows the unverified banner; Resend emails a second link that invalidates the first (stale link: "This link didn't work", 400). Opening the latest emailed link verifies, strips the token from the URL, and the banner is gone on `/` before and after a reload. `/verify` and `/reset-password` responses carry `referrer-policy: no-referrer`. Emails are captured by the harness's mocked EMAIL binding; links are rewritten from `https://ytdw.fyi` to the harness origin. |
| A8 | Password reset flow (integration) | Forgot password from the sign-in dialog shows the generic confirmation and sends one reset email. The link strips its token, sets the new password, and lands signed in on `/library`; reusing it fails. A second context signed in before the reset is signed out; the old password gets the generic 401, the new one works. |
| A9 | Duplicate-signup notice (integration) | Duplicate signup returns 409 with inline Sign in / Reset password actions (Reset keeps the typed email). The notice email contains no token; its `/?auth=forgot` link opens the dialog in forgot mode, drops the param, and a reload does not reopen it. The original password still works. |
| A10 | Change password (integration) | On `/account`, a wrong current password shows the error (403); success keeps this session across a reload and signs out another context; old password then fails, new works. |
| A11 | Delete account (integration) | A wrong password is refused (403); Cancel keeps the account; Confirm signs out on `/`, deletes every session of the account, sign-in fails, and the same email can sign up again with an empty library. Every A7–A11 step asserts no page errors and no unexpected same-origin 4xx/5xx. |
| A12 | Share a saved brief | `POST /api/library/:id/share` returns a new `/s/` link whose `/api/shares/:id` serves the saved copy after the original share was expired; reads do not renew it and each call mints a different link. Other users' or malformed ids 404; no session 401; non-JSON 400; cross-origin 403; rate limit 429. UI (desktop/mobile, both themes): library item buttons read Copy, Share, Mark as read, Delete; Share creates the link on click, copies it, shows the expiry note and announcement, uses the selectable fallback when copying is blocked, and reports 503/404/401. Integration: Share in a real saved item, then the copied `/s/` link opens the brief in the same context. |

The email throttle (3 per address per hour, all kinds) bounds A7–A11: each test uses its
own address and stays within it. Desktop and mobile projects use different addresses.

After an approved deployment: create the D1 database, replace the placeholder
`database_id` in `wrangler.jsonc`, run `wrangler d1 migrations apply ytdw --remote`,
then repeat A5 by hand on `https://ytdw.fyi/`. Local tests cannot validate real
Turnstile widgets for the `auth` action or the production cookie over HTTPS.

## Background summary queue (Phase 2)

| ID | Check | Pass condition |
| --- | --- | --- |
| Q1 | API guards | `/api/queue*` needs a session (401, `no-store`); adding needs a verified email (403); JSON content type, matching Origin, and `LIBRARY_RATE_LIMIT` apply; bodies other than 1–10 strings are 400; unknown methods 405; malformed ids 404. |
| Q2 | Per-URL results and dedupe | Each URL is reported in order: queued, duplicate (same paste), alreadyQueued (queued or processing), alreadySaved (in the library), invalid (same URL check as the website), libraryFull (1,000 saved briefs), overQuota. Pasting a failed video again replaces the failed item. |
| Q3 | Quota | 50 per user per rolling 24 hours, counting removed and failed items; rows older than 24 hours stop counting; two concurrent pastes cannot exceed 50. |
| Q4 | Runner | One item at a time through `Coordinator.summarizeBackground`; finished briefs are saved unread with the snapshot's title and channel; nothing remains in the queue. |
| Q5 | Failures | 400s (over six hours, no captions) fail at once without Retry; 503/504 back off and fail as retryable after 5 attempts, other failures after 3; Retry resets attempts without spending quota; a library that fills while an item waits fails it without Retry. |
| Q6 | Fairness | While a website job runs, queued work stays queued with no attempt counted and both waiting places stay available to visitors; background work never leaves fewer than two of the five admission places; cached results are served immediately. |
| Q7 | Remove and recovery | Remove during processing discards the result; a row left processing past its lease is retried; while a row is processing (including one orphaned by a killed run, with nothing else queued) the runner's alarm is set for its lease; with nothing to do the runner sets no alarm. |
| Q8 | Isolation | Another user's items look absent for list, Retry, and Remove; both users can queue the same video. |
| Q8b | Turn-taking | With one user's paste in progress, another user's item runs next, before the first user's remaining items; items in one paste run in pasted order. |
| Q9 | UI (desktop/mobile, both themes) | Link and box only for signed-in users on the home page; box opens on demand, counts lines, closes with Cancel/Escape and restores focus; per-line problems keep only fixable lines; more than 10 lines is refused client-side; unverified users see the disabled box; header menu appears only while items exist, lists states, Retry/Remove work and keep focus (after Retry on the same row, after Remove on a neighboring video link, never another Remove), polling leaves an unchanged list and its focus alone and returns focus to the same control when rows change, finished briefs are announced and update the badge, the menu fits the viewport and closes on outside click, Escape, and sign-out. |
| Q9b | Single bar and the queue (UI) | A signed-in single-bar summary appears in the header menu as "Summarizing on this page…" with no actions and leaves when the brief arrives; a brief that returns within a second never shows the menu; with nothing queued the heading is just "In progress" and the quota is hidden; signed-out visitors never see the menu; several links in the bar keep Summarize disabled and offer "Queue them instead" (moves them into the box) or "Sign up to queue them", or for unverified accounts "Verify your email to queue them" (links stay, focus goes to Resend email). A failed Add returns focus to the box; a "Library is full" line is listed; signing out clears the box. Signed out, "Queue several videos" opens Create account with the queue lede and continues into the (unverified, disabled) box; a finished brief shows the "Keep this brief" card, whose "Sign in to save" signs in and saves. |
| Q10 | Integration | Real Worker, runner alarms, and D1: sign up, see the disabled box, verify via the emailed link, queue two videos plus an invalid line, watch the header menu disappear, and find both briefs unread in the library. |

Backend checks Q1–Q8 run in `npm test` with the runner's waits shortened by the harness;
Q9 in `npm run test:ui`; Q10 in `npm run test:integration`. On a Workers Preview, apply
`0003_summary_queue.sql` to the preview database first, then check Q10 by hand with a real
browser (Turnstile blocks automated sign-in).

## Account migration

| ID | Check | Pass condition |
| --- | --- | --- |
| M1 | Image transfer | Source and destination manifests have the same SHA-256 digest; no rebuild or SDK change. |
| M2 | Destination setup | Correct account, public hostname/sitekey, all bindings, and both secret names. Authenticated health executes tools from the copied image. |
| M3 | Turnstile and AI | New widget secret validates; production backend rejects invalid tokens; a real browser challenge reaches the backend; Workers AI works in the destination account. |
| M4 | Legacy transition | Old `/` redirects to the new origin and preserves query parameters. Old generation requests do no upstream work. Existing share reads still use old storage and expiry. |
| M5 | Fresh generation/sharing | A new-account video produces a brief and a new-host share link, readable without verification in another context. |

## Custom domain

- `https://ytdw.fyi/` and `https://www.ytdw.fyi/` serve the app with valid TLS.
- `/api/config` returns the current sitekey on both hosts and the workers.dev alias.
- Widget domains and production hostname validation include the custom hosts.
- During the completed migration, the legacy homepage redirected to `https://ytdw.fyi/`
  and old share reads remained on their original storage until expiry.

## Legacy retirement

- Before deleting legacy share storage, enumerate all share objects and confirm
  none retain stored data.
- Verify the retired Worker's settings return 404 and its Durable Object,
  container, registry image, and Turnstile resources are absent.
- Verify all three destination homepages and public configuration endpoints still
  return 200, and the destination container remains ready.
