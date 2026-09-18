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
- One Sandbox container with globally coordinated work.
- One active processing job and at most two waiting jobs.
- Waiting jobs expire after 90 seconds.
- At most five new generation jobs admitted globally per rolling 10 seconds.
- Six-minute processing deadline; individual command deadlines are at most two minutes.
- Ambiguous extraction failures retain a short recovery barrier instead of
  immediately retrying a potentially running subprocess.
- Per-client submission and share-read limits reject excess traffic before upstream work.

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
