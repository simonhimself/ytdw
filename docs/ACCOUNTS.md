# Accounts and library

[← Project README](../README.md)

User story: "I want to summarize more videos and read them later." Anyone can
create an account, save briefs to a personal library, and mark them read.

Phase 1: email + password accounts, a library with Save,
read/unread, an Unread/All filter, and delete.
Phase 2 (see "Background summary queue" below): paste several URLs, leave, and
briefs land in the library as unread. Jobs go through the existing `Coordinator`
(never around it); verified accounts only, **50 videos per user per day**.

Phase 1b (see "Email, recovery, and account management" below): email
verification, password reset, change password, delete account.

Deferred: OAuth, full signup-side account-existence hiding (explicitly declined:
it would remove instant signup; see Phase 1b enumeration notes).

## Storage: D1

Binding `DB`, database `ytdw`. Schema lives in `migrations/` (applied with
`wrangler d1 migrations apply`).

```sql
users(id TEXT PK /* uuid */, email TEXT UNIQUE NOT NULL /* normalized lowercase */,
      password_hash TEXT, password_salt TEXT, password_iterations INTEGER, created_at INTEGER)
sessions(token_hash TEXT PK /* SHA-256 hex of cookie token */, user_id TEXT FK, created_at INTEGER, expires_at INTEGER)
saved_briefs(id TEXT PK /* uuid */, user_id TEXT FK, video_id TEXT, title TEXT, uploader TEXT NULL,
             duration INTEGER, summary TEXT, transcript_truncated INTEGER, saved_at INTEGER,
             read_at INTEGER NULL, UNIQUE(user_id, video_id))
```

Saved briefs are full copies. The summary cache and share snapshots expire after
24 hours; library items do not.

## Security decisions

- Passwords: PBKDF2-SHA256 via Web Crypto, 16-byte random salt, 100,000
  iterations (the Workers runtime maximum); iterations are stored per user so they
  can be raised later. Length 8–256 characters. Compare with `timingSafeEqual`.
- Emails: trimmed, lowercased, max 254 chars, basic `local@domain.tld` check.
- Sessions: 32 random bytes, base64url, in cookie
  `__Host-ytdw_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days).
  Only the SHA-256 hash is stored. Expired rows are pruned opportunistically.
- CSRF: `SameSite=Lax`, plus every mutating `/api/auth/*`, `/api/library*`, and `/api/queue*`
  request must send `content-type: application/json` (DELETE included) and, when
  an `Origin` header is present, it must match the request host.
- Abuse: signup and login both require a Turnstile token whose action is
  `auth`; a per-IP `AUTH_RATE_LIMIT` (10/60s) runs before Siteverify.
  Library calls use a per-user `LIBRARY_RATE_LIMIT` (120/60s). Each user may
  store at most 1,000 saved briefs.
- Login failures always return the same message: "Email or password is incorrect."
  Signup with an existing email returns 409. Without email verification this
  reveals that an account exists; accepted for Phase 1.
- Responses on these routes use `cache-control: no-store`.

## API contract

All bodies are JSON. Errors are `{ "error": string }` with an appropriate status
(400 validation, including oversized bodies as elsewhere in the app; 401 not
signed in / bad credentials; 403 verification or origin failure; 404 not found;
409 conflict; 422 library full; 429 rate limited).

| Method & path | Body | Success |
| --- | --- | --- |
| `GET /api/auth/me` | — | `200 { user: { email } \| null }` |
| `POST /api/auth/signup` | `{ email, password, turnstileToken }` | `201 { user: { email } }` + session cookie |
| `POST /api/auth/login` | `{ email, password, turnstileToken }` | `200 { user: { email } }` + session cookie |
| `POST /api/auth/logout` | `{}` | `204`, cookie cleared, session row deleted |
| `GET /api/library?filter=unread\|all` | — | `200 { items: LibraryItem[], counts: { unread, all } }`, newest first; `filter` defaults to `all` |
| `GET /api/library/:id` | — | `200 { item: LibraryBrief }` |
| `POST /api/library` | `{ shareId }` | `201 { item: LibraryItem }`, or `200 { item, alreadySaved: true }` if this video is already saved |
| `PATCH /api/library/:id` | `{ read: boolean }` | `200 { item: LibraryItem }` |
| `DELETE /api/library/:id` | — | `204` |
| `POST /api/library/:id/share` | `{}` | `200 { share: { url: "/s/<id>", expiresAt } }` |

```ts
type LibraryItem = { id: string; videoId: string; title: string; uploader: string | null;
                     duration: number; savedAt: number; readAt: number | null };
type LibraryBrief = LibraryItem & { summary: string; transcriptTruncated: boolean };
```

`POST /api/library` takes the id from a brief's share URL (`/s/<shareId>`). The
server copies that snapshot, so users cannot store forged brief content. If the
snapshot has expired, it returns 404 "This brief is no longer available to save.
Summarize the video again." Any `/api/library*` call without a valid session
returns 401.

`POST /api/library/:id/share` exists because saved briefs outlive the 24-hour
snapshot they were saved from. It copies the saved brief into a **new**
`SharedBrief` snapshot under a fresh random id (the same code `withShare()` uses),
so each call returns a different link with a full 24-hour lifetime; reads never
renew it. It uses the same session, JSON content-type, Origin, and
`LIBRARY_RATE_LIMIT` guards as other library mutations. Another user's or a
malformed id returns 404; a Durable Object failure returns 503 `{ error }`.

## UI

- Header: signed out → "Sign in" button; signed in → "Library" link (with unread
  count) and an account menu showing the email and "Sign out".
- Auth: a modal dialog with Sign in / Create account modes (email, password,
  invisible Turnstile with action `auth`), accessible focus handling, and
  inline errors.
- Result and shared-brief views: a **Save** button beside Copy/Share. Signed
  out, it opens the auth dialog and saves after a successful sign-in. Disabled
  when the brief has no share. Once saved, it reads "Saved" and links to the
  library.
- `/library` (served as the app shell, like `/s/*`): Unread/All tabs with
  counts; a list showing title, channel, duration, and saved date; open an item
  to read it with the existing brief rendering, plus Copy, Share, Mark as read /
  Mark unread, Delete (with confirmation), and Watch on YouTube. Opening an item does
  not mark it read automatically. Includes empty states.
- Library item **Share**: same copy, clipboard fallback field, expiry note, and
  screen-reader announcements as Share on a fresh result. The link does not exist
  until the click: the client calls `POST /api/library/:id/share`, then copies it.
  A repeat click on the same open item re-checks that link and creates a new one
  only if it has expired.

## Email, recovery, and account management (Phase 1b)

All alias hosts already 301/308 to `https://ytdw.fyi`, so sessions exist on one
host only.

### Email delivery

Cloudflare Email Sending is enabled for `ytdw.fyi` (SPF/DKIM/DMARC records are in
place). Binding: `send_email: [{ name: "EMAIL", allowed_sender_addresses:
["noreply@ytdw.fyi"] }]`, sent with `env.EMAIL.send({ from: { email:
"noreply@ytdw.fyi", name: "YT;DW" }, to, subject, text, html })`. Every message has
a plain-text and a minimal HTML part, contains no user-supplied text, and builds
links from the constant origin `https://ytdw.fyi` (never the request `Host`).
Send failures are logged (`email_send_failed`, no address in logs) and never
change the API response, so they cannot reveal anything.

Per-address throttle: at most 3 emails per address per rolling hour across all
kinds; extra sends are skipped silently.

### Schema (migration `0002`)

```sql
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;  -- NULL until verified
auth_tokens(token_hash TEXT PK /* SHA-256 hex */, user_id TEXT FK ON DELETE CASCADE,
            purpose TEXT /* 'verify' | 'reset' */, created_at INTEGER, expires_at INTEGER)
email_log(email TEXT /* normalized */, kind TEXT, sent_at INTEGER)  -- throttle; prune rows > 1 day old
```

Tokens: 32 random bytes, base64url, single-use (deleted on use). Verify links
last 24 hours, reset links 1 hour. Issuing a token deletes that user's earlier
tokens of the same purpose.

### Behaviour

- **Signup** stays instant (session issued as before) and sends a verification
  email. Unverified accounts can use the library; Phase 2 queueing will require
  a verified email.
- **Duplicate signup** still returns 409, now with "An account with this email
  already exists. Sign in or reset your password.", and emails the owner a
  notice ("someone tried to create an account with your address") with a reset
  link. (Accepted enumeration trade-off: Turnstile + per-IP limits prevent bulk
  probing; login and forgot-password stay non-revealing.)
- **Forgot password** always returns the same 202, whether or not the account
  exists.
- **Reset password** sets the new password, marks the email verified (the user
  proved inbox ownership, which also resolves squatting), deletes **all**
  sessions and reset tokens for the user, then starts a fresh session.
- **Change password** requires the current password, revokes all *other*
  sessions, and keeps the current one.
- **Delete account** requires the current password, deletes the user (cascade
  removes sessions, tokens, and saved briefs), and clears the cookie.
- Pages `/verify` and `/reset-password` are app-shell routes (served like
  `/library`, `no-store`, plus `referrer-policy: no-referrer` because the token is
  in the query). The client reads the token, immediately removes it from the URL
  with `history.replaceState`, and only acts on a POST: verify posts
  automatically; reset waits for the new-password form.
- `/account` is an app-shell route for signed-in settings.

### API additions

Same conventions as above (JSON, guards, `no-store`, `{ error }`).
Turnstile-gated routes use action `auth` and run `AUTH_RATE_LIMIT` first.

| Method & path | Auth | Body | Success |
| --- | --- | --- | --- |
| `GET /api/auth/me` | — | — | `200 { user: { email, emailVerified: boolean } \| null }` (adds `emailVerified`) |
| `POST /api/auth/verify` | — | `{ token }` | `200 { user }`; invalid/expired/used → 400 "This link is invalid or has expired." |
| `POST /api/auth/verify/resend` | session | `{}` | `202 {}` (throttled silently; already verified → `200 { user }`) |
| `POST /api/auth/password/forgot` | Turnstile | `{ email, turnstileToken }` | always `202 { message: "If that address has an account, we've sent a link to reset the password." }` |
| `POST /api/auth/password/reset` | — | `{ token, password }` | `200 { user }` + new session cookie; bad token → 400 as above; password rules as signup |
| `POST /api/auth/password/change` | session | `{ currentPassword, newPassword }` | `200 { user }`; wrong current → 403 "Current password is incorrect." |
| `POST /api/account/delete` | session | `{ password }` | `204`, cookie cleared; wrong password → 403 "Password is incorrect." |

`/api/account/*` must also be routed; `/api/*` already runs the Worker first.

### UI additions

- **Verify banner** (signed in, unverified): "Verify your email to keep your
  account recoverable." with **Resend email** (shows "Sent — check your inbox").
  Shown on the main, library, and account views; not dismissable permanently.
- **Auth dialog**: "Forgot password?" link in sign-in mode opens a forgot mode
  (email + Turnstile) that always ends with the generic confirmation. The 409
  duplicate-signup error offers inline **Sign in** and **Reset password** actions.
- **/verify**: shows progress, then success ("Email verified" + continue to
  library) or the invalid-link message with a resend option if signed in.
- **/reset-password**: new-password form (with `autocomplete="new-password"`);
  on success the user is signed in and taken to the library. An invalid link
  offers to request a new one.
- **/account** (account menu → "Account"): email + verification status, Change
  password form (current + new), and a Delete account section (danger styling,
  password required, plus a confirmation dialog explaining all saved briefs are
  removed). Signed out → prompt to sign in.

## Background summary queue (Phase 2)

User story: "I want to summarize more videos and read them later." A signed-in,
verified user pastes several YouTube URLs, leaves, and the briefs appear in their
library as Unread.

### Decisions

- Verified email required to add to the queue (`users.email_verified_at`).
  Unverified and signed-in users can still read their queue (`GET`).
- **50 videos per user per rolling 24 hours**, counting every accepted URL
  whatever happens to it later (removing or failing does not refund it; Retry
  costs nothing).
- **At most 10 URLs per paste.**
- **No email** when work finishes; the library's Unread count is the signal.
- Every job goes through the `Coordinator`. Coalescing, the 24-hour result cache,
  the global admission window, the six-hour and 400,000-character limits, and the
  single-Sandbox constraint therefore apply unchanged.
- Durable Object alarms drive the work (not Queues or Cron, which Workers
  Previews cannot run).

### Fairness to the website

The Coordinator runs one job and holds at most two waiting jobs, and admits at
most five new jobs per rolling 10 seconds. Only the Coordinator knows its own
state, so fairness is enforced there by a separate entry point,
`Coordinator.summarizeBackground(videoUrl)`. `summarize()` (the website path) is
unchanged. A background call:

- returns a cached result or joins an in-flight job for the same video exactly
  like `summarize()` (neither starts new work);
- otherwise is admitted only when the Coordinator is **completely idle** (nothing
  running, nothing waiting), **no website job was admitted in the last 30
  seconds**, and admitting it still leaves **at least two of the five admission
  places free** (fewer than three admissions in the last 10 seconds). Otherwise it returns a `busy`
  failure immediately, without waiting or counting an admission;
- once admitted, it is an ordinary job: it counts in the window, takes the
  processing slot, and has the same deadlines.

So background work never occupies a waiting place, and a website request that
arrives while a background job runs is first in line behind it, as it would be
behind another visitor's job today. That one in-flight job is the only wait
background work can add; the 30-second quiet period and a 5-second gap between
background jobs leave room for visitors during busy periods.

Background jobs do not consume the per-IP and edge `GLOBAL_RATE_LIMIT`
buckets: those protect the public `/api/summarize` route (which also requires
Turnstile), and charging them would take capacity from visitors. The
Coordinator's authoritative window above, the per-user daily quota, the per-paste
cap, and `LIBRARY_RATE_LIMIT` bound background work instead.

### Runner: one global Durable Object

`QueueRunner` (binding `QUEUE_RUNNER`, migration tag `v4`), addressed as
`idFromName("global")`. One runner rather than one per user because the real
constraint is global (one Sandbox, one processing slot): per-user runners would
each poll a busy Coordinator, multiplying wasted calls, and nothing would decide
fairly between users. A single runner processes **one item at a time** (so each
user also has concurrency 1) and chooses fairly between users.

D1 `queue_items` is the source of truth; the runner keeps no state of its own
besides its alarm.

- `POST /api/queue` and Retry call `runner.kick()`, which sets an alarm for now
  unless an earlier one is already set.
- Each `alarm()`:
  1. Deletes `done`/`removed` rows older than 24 hours (they no longer count
     towards the quota).
  2. Requeues `processing` rows whose `started_at` is older than the lease
     (processing deadline + 2 minutes), counting an attempt. This recovers from a
     runner restart mid-job; if the job did finish, the retry hits the
     Coordinator's cache.
  3. Picks the next due `queued` item, preferring the user served least recently,
     then the oldest item; marks it `processing` with `started_at`.
  4. Calls `summarizeBackground()` and applies the outcome (below).
  5. Sets the next alarm: 5 seconds after a finished job, at the deferral time
     after `busy`, or at the earliest `next_attempt_at` when nothing is due. No
     alarm when the queue is empty.

Outcomes:

| Coordinator result | Queue item |
| --- | --- |
| Success | Brief copied into `saved_briefs` (unread) and item `done`, in one D1 batch, only if the item is still `processing` (Remove during processing discards the result). Already saved: `done`. Library full (1,000): `failed`, not retryable. |
| `busy` (Coordinator not idle, quiet period, window, recovering) | Back to `queued`, `next_attempt_at` = now + 15 s, no attempt counted. |
| 400 (no English captions, empty captions, longer than six hours) | `failed`, not retryable, with the Coordinator's message. |
| 503 YouTube refusing captions, 504 timeout | `queued` with backoff 1, 5, 15, 60 minutes; `failed` (retryable) after 5 attempts. |
| 502 other processing failure | Same backoff; `failed` (retryable) after 3 attempts. |

Over-long transcripts are truncated as on the website, not failed.

### Schema (migration `0003`)

```sql
queue_items(id TEXT PK /* uuid */, user_id TEXT FK ON DELETE CASCADE, video_id TEXT,
            status TEXT /* queued | processing | done | failed | removed */,
            attempts INTEGER, error TEXT NULL, retryable INTEGER,
            created_at INTEGER, updated_at INTEGER, next_attempt_at INTEGER,
            started_at INTEGER NULL)
-- indexes: (user_id, created_at) for quota and listing; (status, next_attempt_at) for the runner;
-- UNIQUE(user_id, video_id) WHERE status IN ('queued', 'processing', 'failed')
```

Rows are never deleted by users: Remove sets `removed`, so the rolling quota is a
`COUNT(*)` over the user's rows from the last 24 hours. Each URL is inserted
with one `INSERT ... SELECT ... WHERE` that checks, in the same statement, that the
video is not in the library, not already active in the queue, and that the user
is under 50 for the window; the statements for one paste run as one D1 batch, so
concurrent pastes cannot overshoot. The partial unique index backs up the
duplicate check.

### API

Same conventions as `/api/library`: JSON bodies, `{ error }` errors, session
required (401), `guardMutation` (JSON content type, matching Origin), per-user
`LIBRARY_RATE_LIMIT`, `cache-control: no-store`. Every query is scoped to the
session's user; other users' ids look absent (404).

| Method & path | Body | Success |
| --- | --- | --- |
| `GET /api/queue` | — | `200 { items: QueueItem[], quota }`; active and failed items, oldest first |
| `POST /api/queue` | `{ urls: string[] }` | `200 { results: QueueResult[], items, quota }` |
| `POST /api/queue/:id/retry` | `{}` | `200 { item }`; only `failed` items with `retryable`, else 409 |
| `DELETE /api/queue/:id` | — | `204`; `queued`, `processing`, or `failed` items |

```ts
type QueueItem = { id: string; videoId: string; status: "queued" | "processing" | "failed";
                   error: string | null; retryable: boolean; attempts: number; createdAt: number };
type QueueResult = { url: string; videoId: string | null;
                     status: "queued" | "duplicate" | "alreadyQueued" | "alreadySaved" | "invalid" | "overQuota";
                     error?: string };
type Quota = { used: number; limit: 50; remaining: number };
```

`POST /api/queue` errors: 403 "Verify your email to queue videos." for
unverified accounts; 400 when `urls` is not an array of 1–10 strings ("Paste
between 1 and 10 YouTube URLs."). Otherwise every URL gets its own result, in
input order: `invalid` uses the same URL check as the website (`https`,
YouTube hosts, an 11-character id), and `duplicate` marks a later line for a
video already in the same paste. The response is 200 even when nothing was
queued.

### UI

Agreed with the owner after mockups: nothing new is visible on the page until
it is used, and the library stays a place for finished briefs only.

- **Home page:** the single-video flow is unchanged. Signed-in users also see
  "Got several? **Queue several videos**" under the URL field. It opens a box
  (one URL per line, up to 10) with "N of 50 left today", **Cancel**, and
  **Add N to queue**; Escape closes it and Cmd/Ctrl+Enter submits. If every line
  is queued the box closes and a status message confirms it. Otherwise it stays
  open, lists each line that was not queued (already in library, already queued,
  listed twice, not a YouTube link, over today's limit), and keeps only the lines
  worth fixing. Unverified accounts see the box disabled with "Verify your email
  to queue videos." alongside the existing verify banner.
- **Header menu:** a spinner with a count appears next to Library only while
  something is queued, processing, or failed (the ring turns red and stops when
  only failures remain). It opens a dropdown, like the account menu, listing each
  item as `youtu.be/<id>` (titles are unknown before processing, and the CSP does
  not allow YouTube thumbnails) with its state: Queued, Waiting to try again,
  Summarizing…, or the failure reason. Failed items offer **Retry** when retryable
  and **Remove**; active items offer **Remove**. On phones the dropdown spans the
  width of the screen.
- **Finishing:** while anything is queued or processing, the client re-checks
  `GET /api/queue` every 10 seconds when the tab is visible (and immediately when
  it becomes visible). When items finish it announces "N briefs are ready in your
  library", refreshes the Library badge, and reloads the library list if it is
  open.
