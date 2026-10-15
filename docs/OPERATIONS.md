# YT;DW operations

[← Project README](../README.md)

## Production deployment

The production application is **https://ytdw.fyi/** in the `simonhimself` account.
`www.ytdw.fyi` and `ytdw.simons.workers.dev` serve the same Worker. Cloudflare manages
the custom domains' DNS and HTTPS certificates. Turnstile and the server's hostname
allowlist cover all three production hostnames; production Siteverify validation
does not accept local hosts.

`wrangler.jsonc` is the source of truth. It pins the production account and an
immutable container image digest. It is not a generic deployment configuration:
deploying your own instance requires your own account, domains, Turnstile widget,
secrets, and container image configuration.

For Worker/UI changes against the existing production deployment:

```bash
npx wrangler deploy --profile default --containers-rollout=none
```

This reuses the deployed container image without a Docker build or container
rollout. The Sandbox SDK and image remain at `0.12.1`. Docker is required to run
the actual Sandbox locally or rebuild its image. Container upgrades and image
scans are separate maintenance work from Worker/UI-only changes.

Production requires `TURNSTILE_SECRET` and `TEST_TOKEN` as Wrangler secrets.
Set them with `wrangler secret put`; never commit their values. The UI loads its
public sitekey from `/api/config`. Browser behavior lives in `public/app.js`;
`public/theme.js` initializes the theme before first paint.

Verify the primary hostname after deployment. `/health` is protected by
`TEST_TOKEN`. The former `/metadata` and `/captions` execution endpoints are
retired so extraction cannot bypass the coordinated queue.

## Accounts database (D1)

Accounts, sessions, and saved briefs live in the D1 database `ytdw` (binding
`DB`, schema in `migrations/`, spec in [`ACCOUNTS.md`](ACCOUNTS.md)). First-time
setup, in this order — deploying before the remote migration makes signup fail
until the tables exist:

```bash
npx wrangler d1 create ytdw            # put the returned id in wrangler.jsonc (replaces the placeholder)
npx wrangler d1 migrations apply ytdw --remote
npx wrangler deploy --profile default --containers-rollout=none
```

Apply new files in `migrations/` with the same `--remote` command before
deploying code that depends on them. The `__Host-ytdw_session` cookie is
host-only, so a session on `ytdw.fyi` does not carry over to `www.ytdw.fyi` or
`ytdw.simons.workers.dev`. After the first deployment, check sign-up in a real
browser first: local tests mock the Turnstile widget for the `auth` action.

## Workers Previews

Workers Previews give a branch its own URL, database, and Durable Objects without
touching production. Wrangler 4.149 or newer is required. The `previews` block in
`wrangler.jsonc` mirrors every binding the code reads from `env`, pointed at
preview-safe resources (Previews inherit nothing from the top level).

Deploy or update a Preview from any branch checkout, with no per-branch config. The
name defaults to the git branch with `/` turned into `-` (`feat/x` becomes `feat-x`):

```bash
npx wrangler preview
```

- **Hostname.** `https://<name>.previews.ytdw.fyi` is the only supported Preview host
  (custom domain; `previews.ytdw.fyi` is a Preview-only domain with `enabled: false`,
  so it never serves production). Do not use `workers.dev` Preview URLs: they are not
  accepted by the Turnstile check and email links will not point at them. Each
  deployment also gets a unique `<id>.previews.ytdw.fyi` URL; it works too, but the
  session cookie is host-only, so stay on one host while testing. The Preview URL is
  public.
- **Why any name works.** `previews.vars.TURNSTILE_HOSTNAMES` is `*.previews.ytdw.fyi`,
  which the Worker matches as exactly one `[a-z0-9-]` label before the suffix (not
  `previews.ytdw.fyi` itself, not `a.b.previews.ytdw.fyi`, not lookalikes). The Turnstile
  widget lists `ytdw.fyi`, and Cloudflare authorizes a listed hostname's subdomains
  (<https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/>),
  so the widget needs no change per Preview. `previews.vars.PREVIEW_HOST_SUFFIX`
  (`previews.ytdw.fyi`) makes account emails link to the request host when it matches
  that rule. `APP_ORIGIN` is deliberately unset in Previews: a request whose host does
  not match sends no email instead of linking somewhere else. Production leaves
  `PREVIEW_HOST_SUFFIX` unset, so it ignores the Host header and always uses
  `APP_ORIGIN`.
- **Database.** D1 `ytdw-preview` (id in `previews.d1_databases` and
  `wrangler.preview-migrations.jsonc`), separate from production but shared by every
  Preview. Apply new migrations before previewing code that needs them:

  ```bash
  npx wrangler d1 migrations apply PREVIEW_DB --remote --config wrangler.preview-migrations.jsonc
  ```

- **Secrets.** `TURNSTILE_SECRET` and `TEST_TOKEN` are set once in the Preview base
  config and copied into each *new* Preview only; changing the base config later does
  not reach existing Previews (use `wrangler preview secret put NAME --name <preview>`
  for those). Pipe values through stdin and never commit them:

  ```bash
  npx wrangler preview base-config secret put TURNSTILE_SECRET
  ```

- **Other resources.** Rate-limit namespaces use ids `71001`–`71007` (production:
  `1001`, `1002`, `61003`–`61007`). Email is sent from `noreply@ytdw.fyi` for real, so
  only use addresses you control. Each Preview gets its own Durable Object
  namespaces and Sandbox container app (`ytdw_<name>_Sandbox`); container support
  in Previews is partial, and Browser Rendering is the primary transcript path.
- **Cleanup.** After the branch is merged, remove its Preview and the container app
  it can leave behind:

  ```bash
  npx wrangler preview delete --name <name> --skip-confirmation
  npx wrangler containers list
  ```

  Find the app named exactly `ytdw_<name>_Sandbox` in the list and delete it by its
  id (`npx wrangler containers delete <id>`). Never delete a container app whose name
  differs, since the production Sandbox and other Previews have their own.

## Sharing and retention

After generating a brief, **Share** checks that its snapshot is still available,
copies the link, and reveals its expiry. Recipients can read the saved result,
open the original YouTube video, and forward the link without verification or
additional AI generation.

Links expire 24 hours after their snapshot is created, including for cached
results. Reading or forwarding does not renew them. Expiry is checked server-side,
and a Durable Object alarm clears the snapshot. Raw transcripts are discarded
after processing.

**Copy** preserves Markdown headings, paragraphs, and numbering. Both copy actions
offer manual selection when clipboard access is unavailable. Expired links offer
a way to prefill the original video URL and generate another brief.

## Service limits

- Public English-captioned videos only, up to six hours long.
- Maximum transcript input: 400,000 characters.
- Transcript source: Browser Rendering first (one fresh browser per new video,
  30-second budget), then the single Sandbox container as fallback. Each success
  logs `transcript_source` (`browser` or `sandbox`) and each browser failure logs
  `browser_transcript_failed`. Logs are retained only ~3 days, so daily counts
  are also stored in the Coordinator: `GET /stats` with
  `Authorization: Bearer $TEST_TOKEN` returns them. Use these counts to judge
  whether the Sandbox can be retired.
- Browser Rendering limits: 10 concurrent browsers and 10 new browsers per minute
  per account; Workers Paid includes 10 browser-hours per month.
- One Sandbox container with globally coordinated work.
- One active processing job and at most two waiting jobs.
- Waiting jobs expire after 90 seconds.
- At most five new generation jobs admitted globally per rolling 10 seconds.
- Six-minute processing deadline; individual command deadlines are at most two minutes.
- Ambiguous extraction failures retain a short recovery barrier instead of
  immediately retrying a potentially running subprocess.
- Per-client submission and share-read limits reject excess traffic before upstream work.
- Background queue (signed-in, verified accounts): up to 10 URLs per paste and 50 per
  user per rolling 24 hours. One `QueueRunner` Durable Object (migration `v4`) feeds
  them one at a time through the Coordinator, and only when no website job is running
  or waiting and none started in the last 30 seconds. See `docs/ACCOUNTS.md`.

## Funnel measurement

Two sources, neither of which stores who did what:

- **Cloudflare Web Analytics** (visits, referrers, countries; no cookies, so no
  consent banner). Turn it on once in the Cloudflare dashboard under Analytics & Logs →
  Web Analytics → add `ytdw.fyi` with automatic setup; Cloudflare then injects its
  beacon into HTML pages. The CSP allows `https://static.cloudflareinsights.com`
  (script) and `https://cloudflareinsights.com` (beacon) for this.
- **Daily event counts** in the D1 table `daily_events` (migration `0004`): one row per
  UTC day and event with a count, nothing else. The Worker counts after the response
  is sent, so a counting failure only logs `funnel_count_failed`. `GET /stats` with
  `Authorization: Bearer $TEST_TOKEN` returns them as `funnel` (newest day first, up to
  400 rows) next to `transcriptSources`.

| Event | Counted when |
| --- | --- |
| `brief_signed_out`, `brief_signed_in` | `POST /api/summarize` returns a brief (cached or new) |
| `signup` | an account is created (201) |
| `email_verified` | a verification link succeeds (a repeat click counts again) |
| `brief_saved` | a brief is newly saved to a library (201) |
| `queue_paste`, `queue_added` | a queue paste succeeds; `queue_added` adds the number of videos actually queued |
| `account_deleted` | an account is deleted |
| `share_view` | a shared brief page loads a brief (reported by the page) |
| `share_visit` | someone follows the "Summarized by YT;DW" link from a shared brief to `/?ref=share` (reported by the page) |

The page reports the last two through `POST /api/events`, which accepts only those
names, needs a JSON content type and a matching Origin, and shares the per-IP
`SHARE_READ_RATE_LIMIT` budget (over the limit it answers 204 without counting).
These are aggregate counts for spotting trends, not exact numbers: anyone can post a
`share_*` event within that limit.

## Maintenance and validation

Run `npm audit` when updating development tools and keep `package-lock.json` in
sync. Test runtime and browser behavior before deploying a toolchain update.
External scripts allow a stricter CSP without inline JavaScript; static and
Worker-generated responses both deny framing.

See [TEST_PLAN.md](../TEST_PLAN.md) for checks and [TEST_RESULTS.md](../TEST_RESULTS.md)
for recorded evidence. The automated backend and browser suites require neither
Docker nor production credentials.

## Retired legacy deployment

The `ssteiner` deployment was removed on September 18, 2026, at the owner's
request. Before deletion, all 18 legacy share objects reported no stored data,
and the known legacy share returned expired. The old Worker, its three Durable
Object namespaces, container application, registry image, and Turnstile widget
were removed. The old hostname returns 404 and no longer provides a homepage redirect.

`wrangler.legacy.jsonc` is retained solely as historical configuration; **do not
deploy it**. All production deployments use `wrangler.jsonc` in `simonhimself`.
Cached results and share snapshots were not bulk-copied between accounts. The
container image was transferred byte-for-byte between registries without a rebuild.

## Recovery for the sharing release

The sharing release added the `SharedBrief` Durable Object in migration `v3`.
A normal version rollback cannot cross that class migration. To restore the
pre-sharing behavior, deploy the application logic and UI from commit `f40cb11`
while retaining the `SharedBrief` export, binding, and migration history. Keep its
alarm handler so existing snapshots are cleaned up. Do not remove or reverse the
migration. If the Sandbox image is unchanged, this recovery can reuse the existing
production image with `--containers-rollout=none`.
