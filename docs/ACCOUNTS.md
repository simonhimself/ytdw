# Accounts and library (Phase 1)

[← Project README](../README.md)

User story: "I want to summarize more videos and read them later." Anyone can
create an account, save briefs to a personal library, and mark them read.

Phase 1 (this document): email + password accounts, a library with Save,
read/unread, an Unread/All filter, and delete.
Phase 2 (later): a background queue — paste URLs, leave, and briefs land in the
library as unread. It must feed jobs through the existing `Coordinator` (never
around it) and is capped at **50 videos per user per day**.

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
- CSRF: `SameSite=Lax`, plus every mutating `/api/auth/*` and `/api/library*`
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
  to read it with the existing brief rendering, plus Mark as read / Mark unread,
  Delete (with confirmation), Copy, and Watch on YouTube. Opening an item does
  not mark it read automatically. Includes empty states.

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
