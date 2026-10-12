import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHarness, summary } from './worker-harness.mjs';

let h;
before(async () => { h = await createHarness(); });
after(async () => { await h?.mf.dispose(); });
const video = n => String(n).padStart(11, '0');
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Fixture condition did not become true');
}

test('malformed input and early limits do not reach Siteverify; rejected clients do not spend shared quota', async () => {
  const count = h.verifications();
  for (const value of [null, [], { url: 'https://example.com', turnstileToken: 'x' }]) {
    const response = await h.request('/api/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 400);
  }
  assert.equal((await h.post(video(1), 'early', { 'x-test-deny': 'request' })).status, 429);
  assert.equal(h.verifications(), count);
  const before = await h.control('stats');
  assert.equal((await h.post(video(1), 'early', { 'x-test-deny': 'client' })).status, 429);
  const after = await h.control('stats');
  assert.equal(after.limits.global, before.limits.global);
});

test('coalesces duplicate jobs, bounds queue, and expires waiting work without starting it', async () => {
  const scope = 'queue';
  const id = video(2);
  await h.control('hold', id, scope);
  const first = h.post(id, scope);
  await waitFor(async () => (await h.control('stats', null, scope)).pending.includes(id));
  const duplicate = h.post(id, scope);
  const second = h.post(video(3), scope);
  const third = h.post(video(4), scope);
  // Give the two admission requests one event-loop turn to arrive before overflow.
  await new Promise(resolve => setTimeout(resolve, 100));
  const overflow = await h.post(video(5), scope);
  assert.equal(overflow.status, 503);
  assert.match((await overflow.json()).error, /queue is full/);
  assert.match((await (await second).json()).error, /queue took too long/);
  assert.equal((await third).status, 503);
  await h.control('release', id, scope);
  const a = await (await first).json();
  const b = await (await duplicate).json();
  assert.equal(a.summary, summary);
  assert.equal(b.summary, a.summary);
  assert.notEqual(a.share.url, b.share.url);
  assert.equal((await h.control('stats')).model, 1);
});

test('authoritative global rolling window limits distinct work; cached work remains reusable', async () => {
  const scope = 'budget';
  for (let n = 10; n < 15; n++) assert.equal((await h.post(video(n), scope)).status, 200);
  const sixth = await h.post(video(15), scope);
  assert.equal(sixth.status, 503);
  assert.match((await sixth.json()).error, /Too many new videos/);
  await h.control('clear-edge', video(10), scope);
  assert.equal((await h.post(video(10), scope)).status, 200);
});

test('global cache survives edge misses and runtime reload without refreshing its expiry', async () => {
  const scope = 'cache';
  const id = video(20);
  const first = await (await h.post(id, scope)).json();
  const expiry = (await h.control('stats', null, scope)).cacheExpiry;
  const count = (await h.control('stats')).model;
  await h.control('clear-edge', id, scope);
  const cached = await (await h.post(id, scope)).json();
  assert.equal(cached.summary, first.summary);
  assert.equal((await h.control('stats')).model, count);
  assert.equal((await h.control('stats', null, scope)).cacheExpiry, expiry);
  await h.reload();
  await h.control('clear-edge', id, scope);
  assert.equal((await h.post(id, scope)).status, 200);
  assert.equal((await h.control('stats')).model, 0);
  assert.equal((await h.control('stats', null, scope)).cacheExpiry, expiry);
  await h.control('expire-cache', null, scope);
  await h.control('clear-edge', id, scope);
  await h.control('cleanup', null, scope);
  assert.equal((await h.control('stats', null, scope)).cached, 0);
  assert.equal((await h.post(id, scope)).status, 200);
  assert.equal((await h.control('stats')).model, 1);
});

test('a persisted processing lease prevents overlapping new work after restart', async () => {
  await h.control('lease', null, 'restart');
  await h.reload();
  const response = await h.post(video(30), 'restart');
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /restarting/);
});

test('model deadline returns 504 and new work can resume without a stuck slot', { timeout: 15000 }, async () => {
  const id = video(40);
  await h.control('hold', id, 'timeout');
  const response = await h.post(id, 'timeout');
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /too long/);
  const next = await h.post(video(41), 'timeout');
  // Cooperative AI abort can settle first; an outer timeout instead retains
  // the short safety barrier. Either must release the slot, never hang it.
  assert.ok([200, 503].includes(next.status));
  if (next.status === 503) {
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await h.post(video(41), 'timeout')).status, 200);
  }
});

test('ambiguous Sandbox reset never immediately retries or overlaps replacement extraction', { timeout: 12000 }, async () => {
  const scope = 'transport';
  const id = video(42);
  const before = (await h.control('stats')).mediaStarts;
  await h.control('break-transport', id, scope);
  assert.equal((await h.post(id, scope)).status, 503);
  assert.equal((await h.control('stats')).mediaStarts, before + 1);
  assert.equal((await h.post(video(43), scope)).status, 503);
  assert.equal((await h.control('stats')).mediaStarts, before + 1);
  await h.reload();
  assert.equal((await h.post(video(43), scope)).status, 503);
  await new Promise(resolve => setTimeout(resolve, 7400));
  assert.equal((await h.post(video(43), scope)).status, 200);
});

test('startup delays are bounded and late commands cannot begin media extraction', { timeout: 12000 }, async () => {
  const scope = 'startup';
  const id = video(44);
  const before = (await h.control('stats')).mediaStarts;
  await h.control('slow-startup', id, scope);
  assert.equal((await h.post(id, scope)).status, 504);
  assert.equal((await h.post(video(45), scope)).status, 503);
  await new Promise(resolve => setTimeout(resolve, 250));
  await h.control('release-startup', id, scope);
  assert.equal((await h.control('stats')).mediaStarts, before);
  assert.equal((await h.post(video(45), scope)).status, 200);
});

test('the Worker fetches one vtt caption track; caption 429s retry later; foreign caption hosts are never fetched', async () => {
  const scope = 'captions';
  const ok = video(60);
  assert.equal((await h.post(ok, scope)).status, 200);
  const fetched = h.captionRequests().filter(url => url.includes(`v=${ok}`));
  assert.deepEqual(fetched, [`https://www.youtube.com/api/timedtext?v=${ok}&lang=en-orig&fmt=vtt`]);

  const throttled = video(61);
  h.failCaptions(throttled, 429);
  const limited = await h.post(throttled, scope);
  assert.equal(limited.status, 503);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.match((await limited.json()).error, /refusing caption requests/);

  const foreign = video(62);
  await h.control('foreign-caption-host', foreign, scope);
  const before = h.captionRequests().length;
  assert.equal((await h.post(foreign, scope)).status, 502);
  assert.equal(h.captionRequests().length, before);
});

test('Browser Rendering is the primary transcript source and every browser failure falls back to the Sandbox', async () => {
  const media = async () => (await h.control('stats')).mediaStarts;
  const fetchedFor = id => h.captionRequests().filter(url => url.includes(`v=${id}&`));
  const run = async (id, mode, scope) => {
    await h.control(`browser:${mode}`, id, scope);
    const before = await media();
    const response = await h.post(id, scope);
    return { response, sandboxRuns: (await media()) - before };
  };

  // Primary path: authored English beats English auto-captions; no Sandbox work.
  const ok = video(70);
  const primary = await run(ok, 'ok', 'browser-ok');
  assert.equal(primary.response.status, 200);
  assert.equal((await primary.response.json()).title, `Fixture ${ok}`);
  assert.equal(primary.sandboxRuns, 0);
  assert.deepEqual(fetchedFor(ok), [`https://www.youtube.com/api/timedtext?v=${ok}&lang=en-GB&src=browser&fmt=vtt`]);

  // Only a non-English track: use YouTube's English translation, as yt-dlp's "en" does.
  const translated = video(71);
  const translation = await run(translated, 'translate', 'browser-translate');
  assert.equal(translation.response.status, 200);
  assert.equal(translation.sandboxRuns, 0);
  assert.deepEqual(fetchedFor(translated), [`https://www.youtube.com/api/timedtext?v=${translated}&lang=ko&src=browser&tlang=en&fmt=vtt`]);

  // Definite rejections from browser metadata are final: no fallback, no download.
  const long = video(72);
  const tooLong = await run(long, 'long', 'browser-long');
  assert.equal(tooLong.response.status, 400);
  assert.match((await tooLong.response.json()).error, /six hours/);
  assert.equal(tooLong.sandboxRuns, 0);
  assert.deepEqual(fetchedFor(long), []);

  // Browser unavailable, bot-walled, no tracks, or a rejected caption download: Sandbox fallback.
  h.failBrowserCaptions(video(76), 429);
  for (const [n, mode] of [[73, 'down'], [74, 'bot-wall'], [75, 'no-tracks'], [76, 'ok']]) {
    const id = video(n);
    const fallback = await run(id, mode, `browser-fallback-${mode}-${n}`);
    assert.equal(fallback.response.status, 200, `fallback for ${mode}`);
    assert.equal(fallback.sandboxRuns, 1, `one Sandbox run for ${mode}`);
    assert.equal(fetchedFor(id).at(-1), `https://www.youtube.com/api/timedtext?v=${id}&lang=en-orig&fmt=vtt`);
  }

  // Daily source counts persist for judging the fallback rate; reads require the diagnostic token.
  const stats = (scope, authorization = 'Bearer fixture-diagnostic-token') => h.request('/stats', { headers: { authorization, 'x-test-scope': scope } });
  assert.equal((await stats('browser-ok', 'Bearer incorrect')).status, 401);
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual((await (await stats('browser-ok')).json()).transcriptSources, [{ day, source: 'browser', count: 1 }]);
  assert.deepEqual((await (await stats('browser-fallback-down-73')).json()).transcriptSources, [{ day, source: 'sandbox', count: 1 }]);
  assert.deepEqual((await (await stats('browser-long')).json()).transcriptSources, []);
});

test('diagnostics fail closed and extraction endpoints cannot bypass the queue', async () => {
  const calls = (await h.control('stats')).commands;
  for (const endpoint of ['/metadata', '/captions']) {
    const response = await h.request(`${endpoint}?url=https://youtu.be/${video(46)}`, {headers:{authorization:'Bearer fixture-diagnostic-token'}});
    assert.equal(response.status, 404);
  }
  assert.equal((await h.control('stats')).commands, calls);
  assert.equal((await h.request('/health')).status, 401);
  assert.equal((await h.request('/health', {headers:{authorization:'Bearer incorrect'}})).status, 401);
  assert.equal((await h.request('/health', {headers:{authorization:'Bearer fixture-diagnostic-token'}})).status, 200);
});

test('share reads are rate-limited before lookup and retain fixed expiry and security headers', async () => {
  const data = await (await h.post(video(50), 'shares')).json();
  const id = data.share.url.split('/').pop();
  const path = `/api/shares/${id}`;
  const first = await h.request(path);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('x-frame-options'), 'DENY');
  assert.match(first.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const scriptPolicy = first.headers.get('content-security-policy').split(';').find(p => p.includes('script-src'));
  assert.ok(!scriptPolicy.includes('unsafe-inline'));
  assert.equal((await first.json()).share.expiresAt, data.share.expiresAt);
  assert.equal((await (await h.request(path)).json()).share.expiresAt, data.share.expiresAt);
  const limited = await h.request(path, { headers: { 'x-test-deny': 'share-client' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await h.request(path, { headers: { 'x-test-deny': 'share-global' } })).status, 429);
  await h.control('share:expire', id);
  assert.equal((await h.request(path)).status, 404);
  await h.control('share:cleanup', id);
  assert.equal(await h.control('share:stored', id), null);
  const shell = await h.request(data.share.url);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get('x-frame-options'), 'DENY');
  assert.equal(shell.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('legacy homepage redirects without moving share URLs or starting generation', async () => {
  const response = await h.request('/__legacy/?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ', {redirect:'manual'});
  assert.equal(response.status,302);
  assert.equal(response.headers.get('location'),'https://ytdw.fyi/?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ');
  assert.equal(response.headers.get('cache-control'),'no-store');
  const before = h.verifications();
  const moved = await h.request('/__legacy/api/summarize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:`https://youtu.be/${video(80)}`,turnstileToken:'fixture-token'})});
  assert.equal(moved.status,409);
  assert.match((await moved.json()).error,/Reload this page/);
  assert.equal(h.verifications(),before);
  const data = await (await h.post(video(81),'legacy-share')).json();
  const id = data.share.url.split('/').pop();
  const oldShare = await h.request(`/__legacy/api/shares/${id}`);
  assert.equal(oldShare.status,200);
  assert.equal((await oldShare.json()).share.expiresAt,data.share.expiresAt);
  assert.equal((await h.request(`/__legacy/s/${id}`)).status,200);
});

// --- Accounts and library -------------------------------------------------
const json = { 'content-type': 'application/json' };
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
const call = (path, { method = 'GET', body, cookie, headers = {} } = {}) => h.request(path, {
  method, headers: { ...(body === undefined && method === 'GET' ? {} : json), ...(cookie ? { cookie } : {}), ...headers },
  body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
});
const credentials = (email, password = 'correct horse', turnstileToken = 'fixture-auth-token') => ({ email, password, turnstileToken });
async function signUp(email) {
  const response = await call('/api/auth/signup', { method: 'POST', body: credentials(email) });
  assert.equal(response.status, 201);
  return cookieOf(response);
}
async function shareOf(id, scope = 'lib') {
  const data = await (await h.post(video(id), scope)).json();
  return { data, shareId: data.share.url.split('/').pop() };
}

test('signup sets a hardened session cookie that /me and logout honor', async () => {
  assert.deepEqual(await (await call('/api/auth/me')).json(), { user: null });
  const response = await call('/api/auth/signup', { method: 'POST', body: credentials('  Reader@Example.COM ') });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { user: { email: 'reader@example.com' } });
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-ytdw_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  const cookie = cookieOf(response);
  const me = await call('/api/auth/me', { cookie });
  assert.deepEqual(await me.json(), { user: { email: 'reader@example.com' } });
  assert.equal(me.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await (await call('/api/auth/me', { cookie: '__Host-ytdw_session=forged' })).json(), { user: null });

  const out = await call('/api/auth/logout', { method: 'POST', cookie });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /^__Host-ytdw_session=; .*Max-Age=0$/);
  assert.deepEqual(await (await call('/api/auth/me', { cookie })).json(), { user: null });
  assert.equal((await call('/api/library', { cookie })).status, 401);
});

test('the database stores only hashed sessions and PBKDF2 password hashes', async () => {
  const cookie = await signUp('hashes@example.com');
  const token = cookie.split('=')[1];
  const db = await h.mf.getD1Database('DB', 'test-ytdw');
  const sessions = (await db.prepare('SELECT token_hash FROM sessions').all()).results.map(row => row.token_hash);
  assert.ok(sessions.length > 0 && sessions.every(hash => /^[0-9a-f]{64}$/.test(hash) && hash !== token));
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind('hashes@example.com').first();
  assert.equal(user.password_iterations, 100_000);
  assert.ok(!JSON.stringify(user).includes('correct horse'));
});

test('duplicate signup conflicts and login failures share one generic error', async () => {
  await signUp('dup@example.com');
  const dup = await call('/api/auth/signup', { method: 'POST', body: credentials('DUP@example.com') });
  assert.equal(dup.status, 409);
  const good = await call('/api/auth/login', { method: 'POST', body: credentials('Dup@Example.com') });
  assert.equal(good.status, 200);
  assert.ok(cookieOf(good));
  const wrong = await call('/api/auth/login', { method: 'POST', body: credentials('dup@example.com', 'wrong password') });
  const unknown = await call('/api/auth/login', { method: 'POST', body: credentials('nobody@example.com') });
  assert.equal((await call('/api/auth/login', { method: 'POST', body: credentials('dup@example.com', '') })).status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  const message = (await wrong.json()).error;
  assert.equal(message, 'Email or password is incorrect.');
  assert.equal((await unknown.json()).error, message);
  assert.equal(wrong.headers.get('set-cookie'), null);
});

test('auth validates input and requires a Turnstile token with the auth action', async () => {
  const before = h.verifications();
  for (const email of ['not-an-email', 'a@b', '', `${'a'.repeat(250)}@example.com`]) {
    assert.equal((await call('/api/auth/signup', { method: 'POST', body: credentials(email) })).status, 400, email);
  }
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: credentials('short@example.com', 'short') })).status, 400);
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: credentials('long@example.com', 'x'.repeat(257)) })).status, 400);
  assert.equal(h.verifications(), before, 'validation fails before Siteverify');
  // A summarize-action token must not authenticate account creation.
  const wrongAction = await call('/api/auth/signup', { method: 'POST', body: credentials('action@example.com', 'correct horse', 'fixture-token') });
  assert.equal(wrongAction.status, 403);
  assert.equal(wrongAction.headers.get('set-cookie'), null);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: credentials('action@example.com', 'correct horse', 'fixture-token') })).status, 403);
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { email: 'missing@example.com', password: 'correct horse' } })).status, 403);
  // An auth token must not authorize /api/summarize.
  const summarize = await h.request('/api/summarize', { method: 'POST', headers: json, body: JSON.stringify({ url: `https://youtu.be/${video(230)}`, turnstileToken: 'fixture-auth-token' }) });
  assert.equal(summarize.status, 403);
  // The account was never created.
  assert.equal((await call('/api/auth/login', { method: 'POST', body: credentials('action@example.com') })).status, 401);
});

test('auth rate limit runs before the body is read or Siteverify is called', async () => {
  const before = h.verifications();
  const limited = await call('/api/auth/login', { method: 'POST', body: credentials('limited@example.com'), headers: { 'x-test-deny': 'auth' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(h.verifications(), before);
});

test('mutations require a JSON content type and a matching Origin', async () => {
  const cookie = await signUp('csrf@example.com');
  const { shareId } = await shareOf(210);
  const plain = await h.request('/api/library', { method: 'POST', headers: { 'content-type': 'text/plain', cookie }, body: JSON.stringify({ shareId }) });
  assert.equal(plain.status, 400);
  const missing = await h.request('/api/library', { method: 'POST', headers: { cookie }, body: JSON.stringify({ shareId }) });
  assert.equal(missing.status, 400);
  const cross = await call('/api/library', { method: 'POST', body: { shareId }, cookie, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: credentials('csrf@example.com'), headers: { origin: 'null' } })).status, 403);
  assert.equal((await h.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 400);
  // Deleting also needs the JSON header, even without a body.
  const saved = await (await call('/api/library', { method: 'POST', body: { shareId }, cookie, headers: { origin: 'http://localhost' } })).json();
  assert.equal((await h.request(`/api/library/${saved.item.id}`, { method: 'DELETE', headers: { cookie } })).status, 400);
  assert.equal((await call(`/api/library/${saved.item.id}`, { method: 'DELETE', cookie, headers: { origin: 'http://localhost' } })).status, 204);
});

test('library requires a session and its own rate limit', async () => {
  for (const [path, method] of [['/api/library', 'GET'], ['/api/library', 'POST'], ['/api/library/00000000-0000-4000-8000-000000000000', 'GET'], ['/api/library/00000000-0000-4000-8000-000000000000', 'PATCH'], ['/api/library/00000000-0000-4000-8000-000000000000', 'DELETE']]) {
    const response = await call(path, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const cookie = await signUp('limit@example.com');
  const limited = await call('/api/library', { cookie, headers: { 'x-test-deny': 'library' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('saving copies the server snapshot; duplicates are idempotent; expired shares 404', async () => {
  const cookie = await signUp('save@example.com');
  const { data, shareId } = await shareOf(220);
  const save = await call('/api/library', { method: 'POST', body: { shareId, title: 'forged', summary: 'forged' }, cookie });
  assert.equal(save.status, 201);
  assert.equal(save.headers.get('cache-control'), 'no-store');
  const { item } = await save.json();
  assert.deepEqual({ ...item, id: undefined, savedAt: undefined }, { id: undefined, videoId: video(220), title: data.title, uploader: null, duration: data.duration, savedAt: undefined, readAt: null });
  assert.ok(Number.isInteger(item.savedAt));
  // Browser Rendering supplies a channel name; it is copied when present.
  await h.control('browser:ok', video(222));
  const channel = await shareOf(222);
  assert.equal(channel.data.uploader, 'Fixture channel');
  assert.equal((await (await call('/api/library', { method: 'POST', body: { shareId: channel.shareId }, cookie })).json()).item.uploader, 'Fixture channel');

  const brief = await (await call(`/api/library/${item.id}`, { cookie })).json();
  assert.deepEqual(brief.item, { ...item, summary: summary, transcriptTruncated: false });

  // A different share of the same video is the same saved item.
  const second = await shareOf(220);
  assert.notEqual(second.shareId, shareId);
  const again = await call('/api/library', { method: 'POST', body: { shareId: second.shareId }, cookie });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { item, alreadySaved: true });
  assert.equal((await (await call('/api/library', { cookie })).json()).counts.all, 2);

  const expired = await shareOf(221);
  await h.control('share:expire', expired.shareId);
  const gone = await call('/api/library', { method: 'POST', body: { shareId: expired.shareId }, cookie });
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error, 'This brief is no longer available to save. Summarize the video again.');
  for (const shareId of ['nope', 123, null, '00000000-0000-4000-8000-000000000000']) {
    const bad = await call('/api/library', { method: 'POST', body: { shareId }, cookie });
    assert.ok([400, 404].includes(bad.status), String(shareId));
  }
  assert.equal((await call('/api/library', { method: 'POST', body: {}, cookie })).status, 400);
});

test('list filters unread/all with counts, newest first; PATCH toggles read; DELETE removes', async () => {
  const cookie = await signUp('list@example.com');
  const ids = [];
  for (const n of [240, 241, 242]) {
    const { shareId } = await shareOf(n, 'lib-list');
    ids.push((await (await call('/api/library', { method: 'POST', body: { shareId }, cookie })).json()).item.id);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const all = await (await call('/api/library?filter=all', { cookie })).json();
  assert.deepEqual(all.items.map(i => i.id), [...ids].reverse());
  assert.deepEqual(all.counts, { unread: 3, all: 3 });
  assert.ok(all.items.every(i => !('summary' in i)));
  assert.deepEqual((await (await call('/api/library', { cookie })).json()).counts, { unread: 3, all: 3 });

  const read = await call(`/api/library/${ids[1]}`, { method: 'PATCH', body: { read: true }, cookie });
  assert.equal(read.status, 200);
  const readAt = (await read.json()).item.readAt;
  assert.ok(Number.isInteger(readAt));
  const reread = await (await call(`/api/library/${ids[1]}`, { method: 'PATCH', body: { read: true }, cookie })).json();
  assert.equal(reread.item.readAt, readAt);
  const unread = await (await call('/api/library?filter=unread', { cookie })).json();
  assert.deepEqual(unread.items.map(i => i.id), [ids[2], ids[0]]);
  assert.deepEqual(unread.counts, { unread: 2, all: 3 });
  const reopened = await (await call(`/api/library/${ids[1]}`, { method: 'PATCH', body: { read: false }, cookie })).json();
  assert.equal(reopened.item.readAt, null);
  assert.equal((await call(`/api/library/${ids[1]}`, { method: 'PATCH', body: { read: 'yes' }, cookie })).status, 400);
  assert.equal((await call('/api/library?filter=bogus', { cookie })).status, 400);

  assert.equal((await call(`/api/library/${ids[0]}`, { method: 'DELETE', cookie })).status, 204);
  assert.equal((await call(`/api/library/${ids[0]}`, { cookie })).status, 404);
  assert.equal((await call(`/api/library/${ids[0]}`, { method: 'DELETE', cookie })).status, 404);
  assert.deepEqual((await (await call('/api/library', { cookie })).json()).counts, { unread: 2, all: 2 });
  assert.equal((await call('/api/library/not-a-uuid', { cookie })).status, 404);
});

test('users cannot see or modify each other\'s library items', async () => {
  const alice = await signUp('alice@example.com');
  const bob = await signUp('bob@example.com');
  const { shareId } = await shareOf(250, 'lib-iso');
  const item = (await (await call('/api/library', { method: 'POST', body: { shareId }, cookie: alice })).json()).item;
  assert.equal((await call(`/api/library/${item.id}`, { cookie: bob })).status, 404);
  assert.equal((await call(`/api/library/${item.id}`, { method: 'PATCH', body: { read: true }, cookie: bob })).status, 404);
  assert.equal((await call(`/api/library/${item.id}`, { method: 'DELETE', cookie: bob })).status, 404);
  assert.deepEqual((await (await call('/api/library', { cookie: bob })).json()), { items: [], counts: { unread: 0, all: 0 } });
  // Bob can save the same video independently; Alice's copy is untouched.
  const bobSave = await call('/api/library', { method: 'POST', body: { shareId }, cookie: bob });
  assert.equal(bobSave.status, 201);
  assert.notEqual((await bobSave.json()).item.id, item.id);
  const mine = await (await call(`/api/library/${item.id}`, { cookie: alice })).json();
  assert.equal(mine.item.readAt, null);
});

test('a library holds at most 1,000 saved briefs', async () => {
  const cookie = await signUp('full@example.com');
  const db = await h.mf.getD1Database('DB', 'test-ytdw');
  const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind('full@example.com').first();
  const rows = Array.from({ length: 1000 }, (_, n) => db.prepare(
    "INSERT INTO saved_briefs(id, user_id, video_id, title, duration, summary, transcript_truncated, saved_at) VALUES (?, ?, ?, 't', 1, 's', 0, 1)",
  ).bind(crypto.randomUUID(), user.id, `filler${n}`));
  await db.batch(rows);
  const { shareId } = await shareOf(260, 'lib-full');
  const full = await call('/api/library', { method: 'POST', body: { shareId }, cookie });
  assert.equal(full.status, 422);
  assert.match((await full.json()).error, /library is full/);
  assert.equal((await (await call('/api/library', { cookie })).json()).counts.all, 1000);
});

test('/library serves the app shell with no-store and security headers', async () => {
  for (const method of ['GET', 'HEAD']) {
    const response = await h.request('/library', { method });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  }
  assert.match(await (await h.request('/library')).text(), /<html/i);
});

test('alias hosts redirect to the canonical host, keeping path and query', async () => {
  for (const host of ['www.ytdw.fyi', 'ytdw.simons.workers.dev']) {
    const page = await h.mf.dispatchFetch(`https://${host}/s/abc?x=1`, { redirect: 'manual' });
    assert.equal(page.status, 301);
    assert.equal(page.headers.get('location'), 'https://ytdw.fyi/s/abc?x=1');
    const api = await h.mf.dispatchFetch(`https://${host}/api/auth/login`, { method: 'POST', redirect: 'manual' });
    assert.equal(api.status, 308);
  }
  assert.equal((await h.request('/library')).status, 200);
});
