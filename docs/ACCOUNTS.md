# Accounts and library (Phase 1)

[← Project README](../README.md)

User story: "I want to summarize more videos and read them later." Anyone can
create an account, save briefs to a personal library, and mark them read.

Phase 1 (this document): email + password accounts, a library with Save,
read/unread, an Unread/All filter, and delete.
Phase 2 (later): a background queue — paste URLs, leave, and briefs land in the
library as unread. It must feed jobs through the existing `Coordinator` (never
around it) and is capped at **50 videos per user per day**.

Deferred: email verification and password reset (they need Cloudflare Email
Sending on `ytdw.fyi`), account deletion, OAuth.

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
