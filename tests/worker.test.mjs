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
  assert.deepEqual(await response.json(), { user: { email: 'reader@example.com', emailVerified: false } });
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-ytdw_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  const cookie = cookieOf(response);
  const me = await call('/api/auth/me', { cookie });
  assert.deepEqual(await me.json(), { user: { email: 'reader@example.com', emailVerified: false } });
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
  assert.equal((await dup.json()).error, 'An account with this email already exists. Sign in or reset your password.');
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

test('sharing a saved brief mints a new 24-hour snapshot that outlives the original link', async () => {
  const alice = await signUp('sharer@example.com');
  const bob = await signUp('not-sharer@example.com');
  await h.control('browser:ok', video(270));
  const original = await shareOf(270, 'lib-share');
  const item = (await (await call('/api/library', { method: 'POST', body: { shareId: original.shareId }, cookie: alice })).json()).item;
  await h.control('share:expire', original.shareId);
  assert.equal((await h.request(`/api/shares/${original.shareId}`)).status, 404);

  const before = Date.now();
  const response = await call(`/api/library/${item.id}/share`, { method: 'POST', cookie: alice });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { share } = await response.json();
  assert.match(share.url, /^\/s\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(share.url, original.data.share.url);
  assert.ok(share.expiresAt >= before + 24 * 60 * 60 * 1000 - 1000 && share.expiresAt <= Date.now() + 24 * 60 * 60 * 1000);

  const shared = await h.request(`/api${share.url.replace('/s/', '/shares/')}`);
  assert.equal(shared.status, 200);
  assert.deepEqual(await shared.json(), {
    id: video(270), title: original.data.title, uploader: 'Fixture channel', duration: original.data.duration,
    summary: original.data.summary, transcriptTruncated: false, share,
  });
  // Reads never renew the lifetime, and every click mints a separate link.
  assert.equal((await (await h.request(`/api${share.url.replace('/s/', '/shares/')}`)).json()).share.expiresAt, share.expiresAt);
  const second = (await (await call(`/api/library/${item.id}/share`, { method: 'POST', cookie: alice })).json()).share;
  assert.notEqual(second.url, share.url);
  await h.control('share:expire', share.url.split('/').pop());
  assert.equal((await h.request(`/api${share.url.replace('/s/', '/shares/')}`)).status, 404);

  // Other users' items, malformed ids, and unknown actions all look absent.
  assert.equal((await call(`/api/library/${item.id}/share`, { method: 'POST', cookie: bob })).status, 404);
  assert.equal((await call('/api/library/not-a-uuid/share', { method: 'POST', cookie: alice })).status, 404);
  assert.equal((await call(`/api/library/${item.id}/other`, { method: 'POST', cookie: alice })).status, 404);
  assert.equal((await call(`/api/library/${item.id}/share/extra`, { method: 'POST', cookie: alice })).status, 404);
  assert.equal((await call(`/api/library/${item.id}/share`, { cookie: alice })).status, 405);
  // The session, JSON content type, Origin check, and rate limit apply like every other mutation.
  const anonymous = await call(`/api/library/${item.id}/share`, { method: 'POST' });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.equal((await h.request(`/api/library/${item.id}/share`, { method: 'POST', headers: { 'content-type': 'text/plain', cookie: alice }, body: '{}' })).status, 400);
  assert.equal((await call(`/api/library/${item.id}/share`, { method: 'POST', cookie: alice, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(`/api/library/${item.id}/share`, { method: 'POST', cookie: alice, headers: { 'x-test-deny': 'library' } })).status, 429);
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

// --- Email, recovery, and account management (Phase 1b) -------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emailsTo = async address => (await h.emails()).filter(message => message.to === address);
// Email is sent after the response, so tests wait for the Nth message to an address.
async function emailTo(address, n = 1) {
  await waitFor(async () => (await emailsTo(address)).length >= n);
  return (await emailsTo(address))[n - 1];
}
// Negative assertions have no completion signal; give background work time to run.
const settle = () => sleep(300);
const tokenOf = message => message.text.match(/token=([A-Za-z0-9_-]{43})/)[1];
const postJson = (path, body, cookie, headers) => call(path, { method: 'POST', body, cookie, headers });
const forgot = (email, turnstileToken = 'fixture-auth-token') => postJson('/api/auth/password/forgot', { email, turnstileToken });
const emailDb = () => h.mf.getD1Database('DB', 'test-ytdw');
const FORGOT_MESSAGE = "If that address has an account, we've sent a link to reset the password.";
const INVALID_LINK = 'This link is invalid or has expired.';
const meOf = async cookie => (await (await call('/api/auth/me', { cookie })).json()).user;

test('signup emails a verification link; the token verifies once and is stored hashed', async () => {
  const email = 'verify@example.com';
  const cookie = await signUp(email);
  const message = await emailTo(email);
  assert.deepEqual(message.from, { email: 'noreply@ytdw.fyi', name: 'YT;DW' });
  assert.equal(message.subject, 'Verify your email for YT;DW');
  const token = tokenOf(message);
  assert.ok(message.text.includes(`https://ytdw.fyi/verify?token=${token}`));
  assert.ok(message.html.includes(`href="https://ytdw.fyi/verify?token=${token}"`));
  assert.deepEqual(await meOf(cookie), { email, emailVerified: false });

  const db = await emailDb();
  const rows = (await db.prepare('SELECT t.* FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ?').bind(email).all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].purpose, 'verify');
  assert.notEqual(rows[0].token_hash, token);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  assert.equal(rows[0].expires_at - rows[0].created_at, 24 * 60 * 60 * 1000);

  // Works without a session, so the link can be opened on another device.
  const verified = await postJson('/api/auth/verify', { token });
  assert.equal(verified.status, 200);
  assert.equal(verified.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await verified.json(), { user: { email, emailVerified: true } });
  assert.deepEqual(await meOf(cookie), { email, emailVerified: true });
  const login = await postJson('/api/auth/login', credentials(email));
  assert.deepEqual((await login.json()).user, { email, emailVerified: true });

  const reuse = await postJson('/api/auth/verify', { token });
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, INVALID_LINK);
  for (const bad of [{}, { token: 5 }, { token: 'short' }, { token: 'x'.repeat(43) }, { token: null }]) {
    assert.equal((await postJson('/api/auth/verify', bad)).status, 400, JSON.stringify(bad));
  }
});

test('expired verification links are rejected; a newer link replaces the older one', async () => {
  const email = 'expired-verify@example.com';
  const cookie = await signUp(email);
  const first = tokenOf(await emailTo(email, 1));
  assert.equal((await postJson('/api/auth/verify/resend', {}, cookie)).status, 202);
  const second = tokenOf(await emailTo(email, 2));
  assert.notEqual(first, second);
  assert.equal((await postJson('/api/auth/verify', { token: first })).status, 400, 'replaced by the newer token');

  const db = await emailDb();
  await db.prepare('UPDATE auth_tokens SET expires_at = ? WHERE purpose = ? AND user_id = (SELECT id FROM users WHERE email = ?)').bind(Date.now() - 1, 'verify', email).run();
  assert.equal((await postJson('/api/auth/verify', { token: second })).status, 400);
  assert.deepEqual(await meOf(cookie), { email, emailVerified: false });
});

test('resend requires a session, is a no-op once verified, and never exceeds the throttle in its response', async () => {
  const email = 'resend@example.com';
  assert.equal((await postJson('/api/auth/verify/resend', {})).status, 401);
  const cookie = await signUp(email);
  await emailTo(email, 1);
  const resent = await postJson('/api/auth/verify/resend', {}, cookie);
  assert.equal(resent.status, 202);
  assert.deepEqual(await resent.json(), {});
  const token = tokenOf(await emailTo(email, 2));
  assert.equal((await postJson('/api/auth/verify', { token })).status, 200);

  const already = await postJson('/api/auth/verify/resend', {}, cookie);
  assert.equal(already.status, 200);
  assert.deepEqual(await already.json(), { user: { email, emailVerified: true } });
  await settle();
  assert.equal((await emailsTo(email)).length, 2, 'verified accounts get no further verification email');
});

test('duplicate signup returns 409 and emails the owner a tokenless notice that cannot invalidate a pending reset link', async () => {
  const email = 'owner@example.com';
  await signUp(email);
  await emailTo(email, 1);
  assert.equal((await forgot(email)).status, 202);
  const resetToken = tokenOf(await emailTo(email, 2));
  const db = await emailDb();
  const tokenRows = () => db.prepare('SELECT t.token_hash, t.purpose FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? ORDER BY t.purpose').bind(email).all().then(r => r.results);
  const before = await tokenRows();

  const dup = await postJson('/api/auth/signup', credentials(email, 'another password'));
  assert.equal(dup.status, 409);
  assert.equal(dup.headers.get('set-cookie'), null);
  const notice = await emailTo(email, 3);
  assert.equal(notice.subject, 'Someone tried to create a YT;DW account with your address');
  assert.ok(notice.text.includes('https://ytdw.fyi/?auth=forgot'));
  assert.ok(notice.html.includes('href="https://ytdw.fyi/?auth=forgot"'));
  assert.ok(!/token=/.test(notice.text + notice.html), 'the notice carries no token');

  // No auth_tokens row was created or replaced, so the earlier reset link still works.
  assert.deepEqual(await tokenRows(), before);
  const reset = await postJson('/api/auth/password/reset', { token: resetToken, password: 'brand new password' });
  assert.equal(reset.status, 200);
  assert.equal((await postJson('/api/auth/login', credentials(email, 'brand new password'))).status, 200);
});

test('duplicate notices share the per-address email throttle', async () => {
  const email = 'noticed@example.com';
  await signUp(email); // verification email = 1 of 3
  for (let i = 0; i < 4; i++) assert.equal((await postJson('/api/auth/signup', credentials(email))).status, 409);
  await emailTo(email, 3);
  await settle();
  assert.equal((await emailsTo(email)).length, 3);
});

test('an invalid APP_ORIGIN sends nothing and creates no tokens; the request Host is never used', async () => {
  for (const bad of ['http://ytdw.fyi', 'not a url', 'https://ytdw.fyi/path', 'ftp://ytdw.fyi']) {
    const email = `badorigin${Math.abs([...bad].reduce((a, c) => a * 31 + c.charCodeAt(0), 7))}@example.com`;
    const response = await postJson('/api/auth/signup', credentials(email), undefined, { 'x-test-app-origin': bad });
    assert.equal(response.status, 201, bad);
    await settle();
    assert.equal((await emailsTo(email)).length, 0, `no email for APP_ORIGIN=${JSON.stringify(bad)}`);
    const db = await emailDb();
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ?').bind(email).first()).n, 0);
  }
  // A configured Previews-style origin is used verbatim.
  const email = 'preview@example.com';
  await postJson('/api/auth/signup', credentials(email), undefined, { 'x-test-app-origin': 'https://pr-1-ytdw.simons.workers.dev' });
  assert.ok((await emailTo(email)).text.includes('https://pr-1-ytdw.simons.workers.dev/verify?token='));
});

// --- Workers Previews: any <name>.previews.ytdw.fyi, nothing else --------------
const PREVIEW_SUFFIX = 'previews.ytdw.fyi';
const previewHeaders = (extra = {}) => ({ ...json, 'x-test-preview-suffix': PREVIEW_SUFFIX, ...extra });
const atHost = (host, path, body, headers) => h.requestAt(host, path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
let previewUser = 0;
const previewEmail = () => `preview-host-${++previewUser}@example.com`;

test('Turnstile hostname allowlist: "*.previews.ytdw.fyi" matches exactly one extra label; exact entries behave as before', async () => {
  const allowed = {
    '*.previews.ytdw.fyi': [
      ['feat-preview-any-branch.previews.ytdw.fyi', true], ['a.previews.ytdw.fyi', true], ['0-9-z.previews.ytdw.fyi', true],
      ['previews.ytdw.fyi', false], ['a.b.previews.ytdw.fyi', false], ['x.previews.ytdw.fyi.evil.com', false],
      ['evilpreviews.ytdw.fyi', false], ['.previews.ytdw.fyi', false], ['a.previews.ytdw.fyi.', false],
      ['A.previews.ytdw.fyi', false], ['a_b.previews.ytdw.fyi', false], ['a b.previews.ytdw.fyi', false],
      ['a.previews.ytdw.fyi:8443', false], ['a-ytdw.simons.workers.dev', false], ['ytdw.fyi', false], ['localhost', false],
    ],
    // Without the wildcard entry, Preview hostnames are rejected; exact entries stay exact.
    'ytdw.fyi,www.ytdw.fyi': [['a.previews.ytdw.fyi', false], ['ytdw.fyi', true], ['www.ytdw.fyi', true], ['sub.ytdw.fyi', false]],
    'ytdw.fyi,*.previews.ytdw.fyi': [['ytdw.fyi', true], ['a.previews.ytdw.fyi', true], ['b.ytdw.fyi', false]],
  };
  for (const [entries, table] of Object.entries(allowed)) {
    for (const [hostname, accepted] of table) {
      const response = await call('/api/auth/signup', { method: 'POST', body: credentials(previewEmail(), 'correct horse', `fixture-auth@${hostname}`), headers: { 'x-test-turnstile-hostnames': entries } });
      assert.equal(response.status, accepted ? 201 : 403, `${JSON.stringify(entries)} vs ${JSON.stringify(hostname)}`);
    }
  }
});

test('Preview emails link to the request host only when it is exactly one label under PREVIEW_HOST_SUFFIX', async () => {
  // APP_ORIGIN is unset in Previews, so a non-matching host sends nothing.
  const unset = { 'x-test-app-origin': 'unset' };
  const host = 'feat-any-branch.previews.ytdw.fyi';
  const verify = previewEmail();
  assert.equal((await atHost(host, '/api/auth/signup', credentials(verify), previewHeaders(unset))).status, 201);
  assert.ok((await emailTo(verify)).text.includes(`https://${host}/verify?token=`));

  const dupe = previewEmail();
  await atHost(host, '/api/auth/signup', credentials(dupe), previewHeaders(unset));
  await emailTo(dupe, 1);
  assert.equal((await atHost(host, '/api/auth/signup', credentials(dupe), previewHeaders(unset))).status, 409);
  assert.ok((await emailTo(dupe, 2)).text.includes(`https://${host}/?auth=forgot`));

  const reset = previewEmail();
  await atHost(host, '/api/auth/signup', credentials(reset), previewHeaders(unset));
  assert.equal((await atHost(host, '/api/auth/password/forgot', { email: reset, turnstileToken: 'fixture-auth-token' }, previewHeaders(unset))).status, 202);
  assert.ok((await emailTo(reset, 2)).text.includes(`https://${host}/reset-password?token=`));

  // Resend (a signed-in request) uses the same rule.
  const resend = previewEmail();
  const signup = await atHost(host, '/api/auth/signup', credentials(resend), previewHeaders(unset));
  await emailTo(resend, 1);
  await emailDb().then(db => db.prepare('UPDATE email_log SET sent_at = sent_at - 7200000 WHERE email = ?').bind(resend).run());
  assert.equal((await atHost(host, '/api/auth/verify/resend', {}, previewHeaders({ ...unset, cookie: cookieOf(signup) }))).status, 202);
  assert.ok((await emailTo(resend, 2)).text.includes(`https://${host}/verify?token=`));

  for (const bad of ['evil.com', 'a.b.previews.ytdw.fyi', 'previews.ytdw.fyi', 'x.previews.ytdw.fyi.evil.com', 'localhost', 'a-ytdw.simons.workers.dev']) {
    const email = previewEmail();
    assert.equal((await atHost(bad, '/api/auth/signup', credentials(email), previewHeaders(unset))).status, 201, bad);
    await settle();
    assert.equal((await emailsTo(email)).length, 0, `no email for Host ${bad}`);
    // With a valid APP_ORIGIN set, a non-matching host falls back to it and never links to the Host.
    const fallback = previewEmail();
    await atHost(bad, '/api/auth/signup', credentials(fallback), previewHeaders({ 'x-test-app-origin': 'https://ytdw.fyi' }));
    const body = (await emailTo(fallback)).text;
    assert.ok(body.includes('https://ytdw.fyi/verify?token=') && !body.includes(bad), `${bad}: ${body}`);
  }
});

test('production (no PREVIEW_HOST_SUFFIX) ignores the request host and always links to APP_ORIGIN', async () => {
  for (const host of ['feat-any-branch.previews.ytdw.fyi', 'evil.com', 'localhost']) {
    const email = previewEmail();
    assert.equal((await atHost(host, '/api/auth/signup', credentials(email))).status, 201);
    const body = (await emailTo(email)).text;
    assert.ok(body.includes('https://ytdw.fyi/verify?token=') && !body.includes(host === 'localhost' ? 'localhost' : host), `${host}: ${body}`);
  }
});

test('forgot password answers identically for known and unknown addresses and only emails real accounts', async () => {
  const email = 'forgetful@example.com';
  await signUp(email);
  await emailTo(email, 1);
  const known = await forgot(email);
  const unknown = await forgot('ghost@example.com');
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.equal(known.headers.get('cache-control'), 'no-store');
  assert.equal(await known.text(), await unknown.text());
  assert.deepEqual(await (await forgot('GHOST@example.com')).json(), { message: FORGOT_MESSAGE });
  const message = await emailTo(email, 2);
  assert.equal(message.subject, 'Reset your YT;DW password');
  assert.ok(message.text.includes('https://ytdw.fyi/reset-password?token='));
  await settle();
  assert.equal((await emailsTo('ghost@example.com')).length, 0);
  const db = await emailDb();
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM email_log WHERE email = 'ghost@example.com'").first()).n, 0);
});

test('forgot password needs an auth Turnstile token, a valid address, and passes the auth rate limit first', async () => {
  const before = h.verifications();
  assert.equal((await forgot('not-an-email')).status, 400);
  assert.equal(h.verifications(), before, 'validation fails before Siteverify');
  assert.equal((await forgot('someone@example.com', 'fixture-token')).status, 403, 'summarize token is the wrong action');
  assert.equal((await postJson('/api/auth/password/forgot', { email: 'someone@example.com' })).status, 403);
  const limited = await postJson('/api/auth/password/forgot', { email: 'someone@example.com', turnstileToken: 'fixture-auth-token' }, undefined, { 'x-test-deny': 'auth' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  const afterLimit = h.verifications();
  assert.equal((await forgot('someone@example.com')).status, 202);
  assert.equal(h.verifications(), afterLimit + 1);
});

test('reset sets a new password, verifies the address, revokes every session, and starts a new one', async () => {
  const email = 'reset@example.com';
  const first = await signUp(email);
  const second = cookieOf(await postJson('/api/auth/login', credentials(email)));
  assert.ok(second && second !== first);
  assert.equal((await forgot(email)).status, 202);
  const token = tokenOf(await emailTo(email, 2));
  const db = await emailDb();
  const stored = await db.prepare('SELECT t.* FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? AND t.purpose = ?').bind(email, 'reset').first();
  assert.equal(stored.expires_at - stored.created_at, 60 * 60 * 1000);
  assert.deepEqual(await meOf(first), { email, emailVerified: false });

  // Bad password rules and bad tokens fail without consuming the token.
  assert.equal((await postJson('/api/auth/password/reset', { token, password: 'short' })).status, 400);
  const badToken = await postJson('/api/auth/password/reset', { token: 'y'.repeat(43), password: 'a new password' });
  assert.equal(badToken.status, 400);
  assert.equal((await badToken.json()).error, INVALID_LINK);

  const reset = await postJson('/api/auth/password/reset', { token, password: 'a new password' }, first);
  assert.equal(reset.status, 200);
  assert.match(reset.headers.get('set-cookie'), /^__Host-ytdw_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  assert.deepEqual((await reset.json()).user, { email, emailVerified: true });
  const fresh = cookieOf(reset);
  assert.deepEqual(await meOf(fresh), { email, emailVerified: true });
  assert.equal(await meOf(first), null);
  assert.equal(await meOf(second), null);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?').bind(email).first()).n, 1);
  assert.equal((await postJson('/api/auth/login', credentials(email))).status, 401, 'old password no longer works');
  assert.equal((await postJson('/api/auth/login', credentials(email, 'a new password'))).status, 200);

  const reuse = await postJson('/api/auth/password/reset', { token, password: 'yet another one' });
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, INVALID_LINK);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE purpose = 'reset' AND user_id = (SELECT id FROM users WHERE email = ?)").bind(email).first()).n, 0);
});

test('expired reset links are rejected and a verify token cannot reset a password', async () => {
  const email = 'reset-expired@example.com';
  await signUp(email);
  const verifyToken = tokenOf(await emailTo(email, 1));
  assert.equal((await postJson('/api/auth/password/reset', { token: verifyToken, password: 'sneaky password' })).status, 400);
  assert.equal((await forgot(email)).status, 202);
  const token = tokenOf(await emailTo(email, 2));
  const db = await emailDb();
  await db.prepare("UPDATE auth_tokens SET expires_at = ? WHERE purpose = 'reset' AND user_id = (SELECT id FROM users WHERE email = ?)").bind(Date.now() - 1, email).run();
  assert.equal((await postJson('/api/auth/password/reset', { token, password: 'too late password' })).status, 400);
  assert.equal((await postJson('/api/auth/login', credentials(email))).status, 200, 'password unchanged');
  // The verify token was not consumed by the failed reset attempt.
  assert.equal((await postJson('/api/auth/verify', { token: verifyToken })).status, 200);
});

test('change password checks the current one, revokes other sessions, and keeps this one', async () => {
  const email = 'change@example.com';
  const here = await signUp(email);
  const elsewhere = cookieOf(await postJson('/api/auth/login', credentials(email)));
  assert.equal((await postJson('/api/auth/password/change', { currentPassword: 'correct horse', newPassword: 'a new password' })).status, 401);
  const wrong = await postJson('/api/auth/password/change', { currentPassword: 'wrong password', newPassword: 'a new password' }, here);
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'Current password is incorrect.');
  assert.equal((await postJson('/api/auth/password/change', { currentPassword: 'correct horse', newPassword: 'short' }, here)).status, 400);
  assert.equal((await postJson('/api/auth/password/change', { newPassword: 'a new password' }, here)).status, 400);
  assert.ok(await meOf(elsewhere), 'failed attempts revoke nothing');

  const changed = await postJson('/api/auth/password/change', { currentPassword: 'correct horse', newPassword: 'a new password' }, here);
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get('set-cookie'), null);
  assert.deepEqual((await changed.json()).user, { email, emailVerified: false });
  assert.ok(await meOf(here), 'current session survives');
  assert.equal(await meOf(elsewhere), null, 'other sessions are revoked');
  assert.equal((await postJson('/api/auth/login', credentials(email))).status, 401);
  assert.equal((await postJson('/api/auth/login', credentials(email, 'a new password'))).status, 200);
});

test('deleting an account needs the password and removes the user, briefs, sessions, and tokens', async () => {
  const email = 'delete@example.com';
  const cookie = await signUp(email);
  const other = cookieOf(await postJson('/api/auth/login', credentials(email)));
  const { shareId } = await shareOf(270, 'lib-delete');
  assert.equal((await postJson('/api/library', { shareId }, cookie)).status, 201);
  const db = await emailDb();
  const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  await emailTo(email, 1);
  const count = async table => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(user.id).first()).n;
  assert.deepEqual([await count('saved_briefs'), await count('auth_tokens')], [1, 1]);

  assert.equal((await postJson('/api/account/delete', { password: 'correct horse' })).status, 401);
  const wrong = await postJson('/api/account/delete', { password: 'wrong password' }, cookie);
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'Password is incorrect.');
  assert.equal((await postJson('/api/account/delete', {}, cookie)).status, 400);
  assert.ok(await meOf(cookie));

  const gone = await postJson('/api/account/delete', { password: 'correct horse' }, cookie);
  assert.equal(gone.status, 204);
  assert.equal(gone.headers.get('cache-control'), 'no-store');
  assert.match(gone.headers.get('set-cookie'), /^__Host-ytdw_session=; .*Max-Age=0$/);
  assert.equal(await db.prepare('SELECT id FROM users WHERE id = ?').bind(user.id).first(), null);
  assert.deepEqual([await count('saved_briefs'), await count('sessions'), await count('auth_tokens')], [0, 0, 0]);
  assert.equal(await meOf(cookie), null);
  assert.equal(await meOf(other), null);
  assert.equal((await postJson('/api/auth/login', credentials(email))).status, 401);
  // The address is free again.
  assert.equal((await postJson('/api/auth/signup', credentials(email, 'a different one'))).status, 201);
});

test('at most three emails per address per hour; throttled sends are silent and keep the older link valid', async () => {
  const email = 'throttle@example.com';
  await signUp(email);
  await emailTo(email, 1);
  assert.equal((await forgot(email)).status, 202);
  await emailTo(email, 2);
  assert.equal((await forgot(email)).status, 202);
  const third = await emailTo(email, 3);
  const fourth = await forgot(email);
  assert.equal(fourth.status, 202);
  assert.deepEqual(await fourth.json(), { message: FORGOT_MESSAGE });
  await settle();
  assert.equal((await emailsTo(email)).length, 3, 'the fourth email in an hour is not sent');
  const cookie = cookieOf(await postJson('/api/auth/login', credentials(email)));
  const resend = await postJson('/api/auth/verify/resend', {}, cookie);
  assert.equal(resend.status, 202, 'throttling never changes the response');
  await settle();
  assert.equal((await emailsTo(email)).length, 3);
  assert.equal((await postJson('/api/auth/password/reset', { token: tokenOf(third), password: 'still valid link' })).status, 200);

  // Rows age out of the window, and old rows are pruned when the next email is reserved.
  const db = await emailDb();
  await db.prepare('UPDATE email_log SET sent_at = ? WHERE email = ?').bind(Date.now() - 2 * 24 * 60 * 60 * 1000, email).run();
  assert.equal((await forgot(email)).status, 202);
  await emailTo(email, 4);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE email = ?').bind(email).first()).n, 1);
});

test('email send failures never change API responses and do not break later sends', async () => {
  const email = 'flaky@example.com';
  await h.failEmails(true);
  try {
    const signup = await postJson('/api/auth/signup', credentials(email));
    assert.equal(signup.status, 201);
    const cookie = cookieOf(signup);
    assert.equal((await postJson('/api/auth/verify/resend', {}, cookie)).status, 202);
    const known = await forgot(email);
    const unknown = await forgot('nobody-flaky@example.com');
    assert.equal(known.status, 202);
    assert.equal(await known.text(), await unknown.text());
    assert.equal((await postJson('/api/auth/signup', credentials(email))).status, 409);
    await settle();
    assert.equal((await emailsTo(email)).length, 0);
  } finally {
    await h.failEmails(false);
  }
  const cookie = cookieOf(await postJson('/api/auth/login', credentials(email)));
  assert.equal((await postJson('/api/auth/verify/resend', {}, cookie)).status, 202);
  // The throttle counts attempts, not deliveries: the failed attempts used the quota, so age them out of the window.
  const db = await emailDb();
  await db.prepare('UPDATE email_log SET sent_at = sent_at - 7200000 WHERE email = ?').bind(email).run();
  assert.equal((await postJson('/api/auth/verify/resend', {}, cookie)).status, 202);
  const message = await emailTo(email);
  assert.equal((await postJson('/api/auth/verify', { token: tokenOf(message) })).status, 200);
});

test('emails link only to APP_ORIGIN (https://ytdw.fyi) and contain nothing the requester supplied', async () => {
  const email = 'a<b>inj"ect@example.com';
  await signUp(email);
  const message = await emailTo(email);
  await postJson('/api/auth/signup', credentials(email));
  const notice = await emailTo(email, 2);
  for (const mail of [message, notice]) {
    for (const body of [mail.text, mail.html]) {
      assert.ok(!body.includes('inj') && !body.includes('<b>') && !body.includes('localhost') && !body.includes('example.com'));
      const urls = body.match(/https?:\/\/[^\s"<]+/g);
      assert.ok(urls.length > 0 && urls.every(url => /^https:\/\/ytdw\.fyi\/(verify\?token=[A-Za-z0-9_-]{43}|\?auth=forgot)$/.test(url)), body);
    }
    assert.ok(!mail.subject.includes('inj') && !mail.subject.includes('example.com'));
  }
});

test('/verify, /reset-password, and /account serve the app shell; token pages send no Referer', async () => {
  for (const [path, referrer] of [['/verify', 'no-referrer'], ['/reset-password', 'no-referrer'], ['/account', 'strict-origin-when-cross-origin'], ['/library', 'strict-origin-when-cross-origin']]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await h.request(`${path}?token=${'a'.repeat(43)}`, { method });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('referrer-policy'), referrer, path);
    }
    assert.match(await (await h.request(path)).text(), /<html/i);
  }
});

test('new routes share the mutation guards, the auth rate limit, and fixed methods', async () => {
  const cookie = await signUp('guards@example.com');
  const routes = [
    ['/api/auth/verify', { token: 'a'.repeat(43) }], ['/api/auth/verify/resend', {}], ['/api/auth/password/forgot', { email: 'g@example.com', turnstileToken: 'fixture-auth-token' }],
    ['/api/auth/password/reset', { token: 'a'.repeat(43), password: 'long enough' }], ['/api/auth/password/change', { currentPassword: 'x', newPassword: 'long enough' }],
    ['/api/account/delete', { password: 'x' }],
  ];
  for (const [path, body] of routes) {
    assert.equal((await postJson(path, body, cookie, { origin: 'https://evil.example' })).status, 403, `${path} cross-origin`);
    assert.equal((await h.request(path, { method: 'POST', headers: { 'content-type': 'text/plain', cookie }, body: JSON.stringify(body) })).status, 400, `${path} content type`);
    const limited = await postJson(path, body, cookie, { 'x-test-deny': 'auth' });
    assert.equal(limited.status, 429, `${path} rate limit`);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await call(path, { cookie })).status, 405, `${path} GET`);
  }
  assert.equal((await postJson('/api/account/unknown', {}, cookie)).status, 404);
  assert.deepEqual(await meOf(cookie), { email: 'guards@example.com', emailVerified: false });
});

// --- Background summary queue (Phase 2) -------------------------------------
const queueDb = () => h.mf.getD1Database('DB', 'test-ytdw');
const youtu = n => `https://youtu.be/${video(n)}`;
async function verifiedUser(email) {
  const cookie = await signUp(email);
  const db = await queueDb();
  await db.prepare('UPDATE users SET email_verified_at = ? WHERE email = ?').bind(Date.now(), email).run();
  const { id } = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  return { cookie, userId: id };
}
const enqueue = (cookie, urls, headers) => call('/api/queue', { method: 'POST', body: { urls }, cookie, headers });
const queueOf = async cookie => (await call('/api/queue', { cookie })).json();
const rowsOf = async userId => (await (await queueDb()).prepare('SELECT * FROM queue_items WHERE user_id = ? ORDER BY created_at, id').bind(userId).all()).results;
const rowFor = async (userId, n) => (await rowsOf(userId)).find(row => row.video_id === video(n));
// The runner works on real alarms, so tests wait for queue state. `tick` runs on
// every poll (for example to clear the Coordinator's admission window).
async function waitForQueue(predicate, { timeout = 15000, tick } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (tick) await tick();
    if (await predicate()) return;
    await sleep(50);
  }
  assert.fail('Queue condition did not become true');
}
const statusIs = (userId, n, status) => async () => (await rowFor(userId, n))?.status === status;
// Stop leftover queued work so it cannot use the shared Coordinator in later tests.
const drainQueue = async userId => (await queueDb()).prepare("UPDATE queue_items SET status = 'removed' WHERE user_id = ? AND status = 'queued'").bind(userId).run();

test('the queue needs a session, a verified email for adding, and the library guards', async () => {
  const id = '00000000-0000-4000-8000-000000000000';
  for (const [path, method] of [['/api/queue', 'GET'], ['/api/queue', 'POST'], [`/api/queue/${id}/retry`, 'POST'], [`/api/queue/${id}`, 'DELETE']]) {
    const response = await call(path, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const unverified = await signUp('queue-unverified@example.com');
  const empty = await call('/api/queue', { cookie: unverified });
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await empty.json(), { items: [], quota: { used: 0, limit: 50, remaining: 50 } });
  const refused = await enqueue(unverified, [youtu(300)]);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'Verify your email to queue videos.');

  const { cookie } = await verifiedUser('queue-guards@example.com');
  assert.equal((await enqueue(cookie, [youtu(300)], { origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.request('/api/queue', { method: 'POST', headers: { 'content-type': 'text/plain', cookie }, body: JSON.stringify({ urls: [youtu(300)] }) })).status, 400);
  const limited = await call('/api/queue', { cookie, headers: { 'x-test-deny': 'library' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  for (const urls of [undefined, [], 'https://youtu.be/x', [1], Array.from({ length: 11 }, (_, n) => youtu(301 + n))]) {
    const response = await enqueue(cookie, urls);
    assert.equal(response.status, 400, JSON.stringify(urls));
    assert.equal((await response.json()).error, 'Paste between 1 and 10 YouTube URLs.');
  }
  assert.equal((await call('/api/queue', { method: 'PATCH', cookie })).status, 405);
  assert.equal((await call(`/api/queue/${id}`, { cookie })).status, 405);
  assert.equal((await call(`/api/queue/${id}/retry`, { cookie })).status, 405);
  assert.equal((await call(`/api/queue/${id}/other`, { method: 'POST', cookie })).status, 404);
  assert.equal((await call('/api/queue/not-a-uuid', { method: 'DELETE', cookie })).status, 404);
  assert.deepEqual((await queueOf(cookie)).items, []);
});

test('pasting reports each URL and dedupes within the paste, against the queue, and against the library', async () => {
  const { cookie, userId } = await verifiedUser('queue-dedupe@example.com');
  const { shareId } = await shareOf(310, 'queue-dedupe');
  assert.equal((await call('/api/library', { method: 'POST', body: { shareId }, cookie })).status, 201);
  await h.control('hold', video(311));
  const response = await enqueue(cookie, [
    ` ${youtu(311)} `, `https://www.youtube.com/watch?v=${video(311)}&t=42`, 'not a url', `https://example.com/watch?v=${video(312)}`,
    `https://www.youtube.com/shorts/${video(310)}`,
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.results.map(({ url, videoId, status }) => ({ url, videoId, status })), [
    { url: youtu(311), videoId: video(311), status: 'queued' },
    { url: `https://www.youtube.com/watch?v=${video(311)}&t=42`, videoId: video(311), status: 'duplicate' },
    { url: 'not a url', videoId: null, status: 'invalid' },
    { url: `https://example.com/watch?v=${video(312)}`, videoId: null, status: 'invalid' },
    { url: `https://www.youtube.com/shorts/${video(310)}`, videoId: video(310), status: 'alreadySaved' },
  ]);
  assert.equal(body.results[3].error, 'Only HTTPS YouTube video URLs are accepted');
  assert.deepEqual(body.quota, { used: 1, limit: 50, remaining: 49 });
  assert.equal(body.items.length, 1);
  assert.deepEqual(Object.keys(body.items[0]).sort(), ['attempts', 'createdAt', 'error', 'id', 'retryable', 'status', 'videoId']);
  assert.equal(body.items[0].videoId, video(311));

  // While it is processing, pasting it again is reported as already queued.
  await waitForQueue(statusIs(userId, 311, 'processing'));
  assert.equal((await queueOf(cookie)).items[0].status, 'processing');
  assert.equal((await (await enqueue(cookie, [youtu(311)])).json()).results[0].status, 'alreadyQueued');
  await h.control('release', video(311));
  await waitForQueue(statusIs(userId, 311, 'done'));
  assert.equal((await (await enqueue(cookie, [youtu(311)])).json()).results[0].status, 'alreadySaved');
  assert.deepEqual((await queueOf(cookie)).quota, { used: 1, limit: 50, remaining: 49 });
});

test('the runner saves finished briefs to the library as unread, one video at a time', async () => {
  const { cookie, userId } = await verifiedUser('queue-runner@example.com');
  const before = (await h.control('stats')).model;
  await h.control('browser:ok', video(322));
  const body = await (await enqueue(cookie, [youtu(320), youtu(321), youtu(322)])).json();
  assert.deepEqual(body.results.map(r => r.status), ['queued', 'queued', 'queued']);
  let maxProcessing = 0;
  await waitForQueue(async () => {
    const rows = await rowsOf(userId);
    maxProcessing = Math.max(maxProcessing, rows.filter(row => row.status === 'processing').length);
    return rows.every(row => row.status === 'done');
  }, { tick: () => h.control('clear-budget') });
  assert.equal(maxProcessing <= 1, true);
  assert.equal((await h.control('stats')).model, before + 3);
  const library = await (await call('/api/library?filter=unread', { cookie })).json();
  assert.deepEqual(library.counts, { unread: 3, all: 3 });
  assert.deepEqual(library.items.map(item => item.videoId).sort(), [video(320), video(321), video(322)]);
  assert.ok(library.items.every(item => item.readAt === null && item.title === `Fixture ${item.videoId}`));
  assert.equal(library.items.find(item => item.videoId === video(322)).uploader, 'Fixture channel');
  const brief = await (await call(`/api/library/${library.items[0].id}`, { cookie })).json();
  assert.equal(brief.item.summary, summary);
  assert.deepEqual(await queueOf(cookie), { items: [], quota: { used: 3, limit: 50, remaining: 47 } });
});

test('permanent failures stop at once; transient failures back off and then fail as retryable', { timeout: 30000 }, async () => {
  const { cookie, userId } = await verifiedUser('queue-failures@example.com');
  await h.control('browser:long', video(330));
  h.failCaptions(video(331), 429);
  await h.control('foreign-caption-host', video(332));
  await enqueue(cookie, [youtu(330), youtu(331), youtu(332)]);
  await waitForQueue(async () => (await rowsOf(userId)).every(row => row.status === 'failed'), { timeout: 25000, tick: () => h.control('clear-budget') });
  const items = (await queueOf(cookie)).items;
  const long = items.find(item => item.videoId === video(330));
  assert.deepEqual({ status: long.status, error: long.error, retryable: long.retryable, attempts: long.attempts },
    { status: 'failed', error: 'Videos longer than six hours are not supported', retryable: false, attempts: 1 });
  const throttled = items.find(item => item.videoId === video(331));
  assert.equal(throttled.retryable, true);
  assert.equal(throttled.attempts, 5);
  assert.match(throttled.error, /YouTube is currently refusing caption requests/);
  const unknown = items.find(item => item.videoId === video(332));
  assert.equal(unknown.retryable, true);
  assert.equal(unknown.attempts, 3);
  assert.equal((await (await call('/api/library', { cookie })).json()).counts.all, 0);

  // Retry only applies to retryable failures, resets attempts, and costs no quota.
  const refused = await call(`/api/queue/${long.id}/retry`, { method: 'POST', cookie });
  assert.equal(refused.status, 409);
  h.failCaptions(video(331), undefined);
  const retried = await call(`/api/queue/${throttled.id}/retry`, { method: 'POST', cookie });
  assert.equal(retried.status, 200);
  assert.equal(retried.headers.get('cache-control'), 'no-store');
  const { item } = await retried.json();
  assert.deepEqual({ status: item.status, attempts: item.attempts, error: item.error }, { status: 'queued', attempts: 0, error: null });
  await waitForQueue(statusIs(userId, 331, 'done'), { tick: () => h.control('clear-budget') });
  assert.equal((await call(`/api/queue/${throttled.id}/retry`, { method: 'POST', cookie })).status, 404);
  assert.deepEqual((await queueOf(cookie)).quota, { used: 3, limit: 50, remaining: 47 });

  // Remove hides the item; it still counts towards the quota.
  const removed = await call(`/api/queue/${long.id}`, { method: 'DELETE', cookie });
  assert.equal(removed.status, 204);
  assert.equal((await call(`/api/queue/${long.id}`, { method: 'DELETE', cookie })).status, 404);
  assert.deepEqual((await queueOf(cookie)).items.map(i => i.videoId), [video(332)]);
  assert.equal((await rowFor(userId, 330)).status, 'removed');
  assert.deepEqual((await queueOf(cookie)).quota, { used: 3, limit: 50, remaining: 47 });
  // A removed video can be queued again.
  assert.equal((await (await enqueue(cookie, [youtu(330)])).json()).results[0].status, 'queued');
  await waitForQueue(async () => (await rowsOf(userId)).filter(row => row.video_id === video(330)).some(row => row.status === 'failed'), { tick: () => h.control('clear-budget') });
});

test('the daily quota of 50 counts every accepted URL, and concurrent pastes cannot overshoot it', async () => {
  const db = await queueDb();
  const fill = async (userId, count) => db.batch(Array.from({ length: count }, (_, n) => db.prepare(
    "INSERT INTO queue_items(id, user_id, video_id, status, attempts, retryable, created_at, updated_at, next_attempt_at) VALUES (?, ?, ?, 'removed', 0, 1, ?, ?, ?)",
  ).bind(crypto.randomUUID(), userId, `fill${String(n).padStart(7, '0')}`, Date.now(), Date.now(), Date.now())));
  const alice = await verifiedUser('queue-quota@example.com');
  await fill(alice.userId, 45);
  // Rows older than 24 hours no longer count.
  await db.prepare("INSERT INTO queue_items(id, user_id, video_id, status, attempts, retryable, created_at, updated_at, next_attempt_at) VALUES (?, ?, 'oldoldoldol', 'done', 1, 0, 1, 1, 1)")
    .bind(crypto.randomUUID(), alice.userId).run();
  await h.control('hold', video(340));
  const body = await (await enqueue(alice.cookie, Array.from({ length: 10 }, (_, n) => youtu(340 + n)))).json();
  await drainQueue(alice.userId);
  assert.deepEqual(body.results.map(r => r.status), [...Array(5).fill('queued'), ...Array(5).fill('overQuota')]);
  assert.deepEqual(body.quota, { used: 50, limit: 50, remaining: 0 });
  assert.equal((await (await enqueue(alice.cookie, [youtu(355)])).json()).results[0].status, 'overQuota');

  const bob = await verifiedUser('queue-race@example.com');
  await fill(bob.userId, 45);
  const [first, second] = await Promise.all([
    enqueue(bob.cookie, Array.from({ length: 5 }, (_, n) => youtu(360 + n))),
    enqueue(bob.cookie, Array.from({ length: 5 }, (_, n) => youtu(370 + n))),
  ]);
  await drainQueue(bob.userId);
  const statuses = [...(await first.json()).results, ...(await second.json()).results].map(r => r.status);
  assert.equal(statuses.filter(s => s === 'queued').length, 5);
  assert.equal(statuses.filter(s => s === 'overQuota').length, 5);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM queue_items WHERE user_id = ? AND created_at > ?').bind(bob.userId, Date.now() - 86_400_000).first()).n, 50);
  await h.control('release', video(340));
  await waitForQueue(async () => !(await rowsOf(alice.userId)).some(row => row.status === 'processing'));
});

test('background work only takes spare capacity and never a waiting place', { timeout: 30000 }, async () => {
  const { cookie, userId } = await verifiedUser('queue-fair@example.com');
  await h.control('clear-budget');
  // A visitor's job is running: queued work waits without starting or counting attempts.
  await h.control('hold', video(380));
  const visitor = h.post(video(380));
  await waitFor(async () => (await h.control('stats')).pending.includes(video(380)));
  await enqueue(cookie, [youtu(381)]);
  await sleep(400);
  assert.deepEqual({ status: (await rowFor(userId, 381)).status, attempts: (await rowFor(userId, 381)).attempts }, { status: 'queued', attempts: 0 });
  // Both waiting places are still free for visitors, and the queue limit still applies to them.
  const waiting = [h.post(video(382)), h.post(video(383))];
  await sleep(100);
  const overflow = await h.post(video(384));
  assert.equal(overflow.status, 503);
  assert.match((await overflow.json()).error, /queue is full/);
  await h.control('release', video(380));
  assert.equal((await visitor).status, 200);
  for (const response of await Promise.all(waiting)) assert.equal(response.status, 200);
  await waitForQueue(statusIs(userId, 381, 'done'));
  assert.equal((await rowFor(userId, 381)).attempts, 0);

  // Background work leaves two of the five admission places free for visitors.
  await h.control('clear-budget');
  await h.control('fill-window');
  await enqueue(cookie, [youtu(385)]);
  await sleep(400);
  assert.equal((await rowFor(userId, 385)).status, 'queued');
  await h.control('clear-budget');
  await waitForQueue(statusIs(userId, 385, 'done'));

  // Cached results are served at once, even while a visitor's job is running.
  await h.control('clear-budget');
  assert.equal((await h.post(video(386))).status, 200);
  await h.control('hold', video(387));
  const busy = h.post(video(387));
  await waitFor(async () => (await h.control('stats')).pending.includes(video(387)));
  await enqueue(cookie, [youtu(386)]);
  await waitForQueue(statusIs(userId, 386, 'done'));
  await h.control('release', video(387));
  assert.equal((await busy).status, 200);
});

test('Remove during processing discards the result; restarts requeue orphaned work', async () => {
  const { cookie, userId } = await verifiedUser('queue-remove@example.com');
  await h.control('clear-budget');
  await h.control('hold', video(390));
  await enqueue(cookie, [youtu(390)]);
  await waitForQueue(statusIs(userId, 390, 'processing'));
  const id = (await rowFor(userId, 390)).id;
  assert.equal((await call(`/api/queue/${id}`, { method: 'DELETE', cookie })).status, 204);
  await h.control('release', video(390));
  await waitFor(async () => !(await h.control('stats')).pending.includes(video(390)));
  await settle();
  assert.equal((await rowFor(userId, 390)).status, 'removed');
  assert.equal((await (await call('/api/library', { cookie })).json()).counts.all, 0);

  // A row left processing past its lease by a restarted runner is retried.
  const db = await queueDb();
  await db.prepare("INSERT INTO queue_items(id, user_id, video_id, status, attempts, retryable, created_at, updated_at, next_attempt_at, started_at) VALUES (?, ?, ?, 'processing', 0, 1, ?, ?, ?, 1)")
    .bind(crypto.randomUUID(), userId, video(391), Date.now(), Date.now(), Date.now()).run();
  await enqueue(cookie, [youtu(392)]);
  await waitForQueue(async () => (await rowFor(userId, 391))?.status === 'done' && (await rowFor(userId, 392))?.status === 'done', { tick: () => h.control('clear-budget') });
  assert.equal((await rowFor(userId, 391)).attempts, 1);
  // With nothing left to do, the runner sets no alarm.
  await waitForQueue(async () => (await h.control('runner:alarm')).alarm === null);
});

test('a runner restarted mid-job leaves a wake-up for the orphaned row', async () => {
  const { cookie, userId } = await verifiedUser('queue-orphan@example.com');
  const lease = 8 * 60 * 1000;
  await h.control('clear-budget');
  // While a job runs, the runner's alarm already covers the row's lease.
  await h.control('hold', video(393));
  await enqueue(cookie, [youtu(393)]);
  await waitForQueue(statusIs(userId, 393, 'processing'));
  const started = (await rowFor(userId, 393)).started_at;
  assert.equal((await h.control('runner:alarm')).alarm, started + lease);
  await h.control('release', video(393));
  await waitForQueue(statusIs(userId, 393, 'done'));

  // A row left processing by a killed run (and no other work) still gets a wake-up.
  const db = await queueDb();
  const now = Date.now();
  await db.prepare("INSERT INTO queue_items(id, user_id, video_id, status, attempts, retryable, created_at, updated_at, next_attempt_at, started_at) VALUES (?, ?, ?, 'processing', 0, 1, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, video(394), now, now, now, now).run();
  await h.control('runner:fire');
  assert.equal((await h.control('runner:alarm')).alarm, now + lease);
  // When that wake-up comes, the row is requeued and finished.
  await db.prepare('UPDATE queue_items SET started_at = 1 WHERE user_id = ? AND video_id = ?').bind(userId, video(394)).run();
  await h.control('runner:fire');
  await waitForQueue(statusIs(userId, 394, 'done'), { tick: () => h.control('clear-budget') });
  assert.equal((await rowFor(userId, 394)).attempts, 1);
  await waitForQueue(async () => (await h.control('runner:alarm')).alarm === null);
});

test('a full library fails the item without retry', async () => {
  const { cookie, userId } = await verifiedUser('queue-full@example.com');
  const db = await queueDb();
  await db.batch(Array.from({ length: 1000 }, (_, n) => db.prepare(
    "INSERT INTO saved_briefs(id, user_id, video_id, title, duration, summary, transcript_truncated, saved_at) VALUES (?, ?, ?, 't', 1, 's', 0, 1)",
  ).bind(crypto.randomUUID(), userId, `filler${n}`)));
  await enqueue(cookie, [youtu(395)]);
  await waitForQueue(statusIs(userId, 395, 'failed'), { tick: () => h.control('clear-budget') });
  const [item] = (await queueOf(cookie)).items;
  assert.equal(item.retryable, false);
  assert.match(item.error, /library is full/);
});

test('users cannot see or change each other\'s queue items', async () => {
  const alice = await verifiedUser('queue-alice@example.com');
  const bob = await verifiedUser('queue-bob@example.com');
  await h.control('browser:long', video(398));
  await enqueue(alice.cookie, [youtu(398)]);
  await waitForQueue(statusIs(alice.userId, 398, 'failed'), { tick: () => h.control('clear-budget') });
  const [item] = (await queueOf(alice.cookie)).items;
  assert.deepEqual(await queueOf(bob.cookie), { items: [], quota: { used: 0, limit: 50, remaining: 50 } });
  assert.equal((await call(`/api/queue/${item.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 404);
  await makeRetryable(alice.userId);
  assert.equal((await call(`/api/queue/${item.id}/retry`, { method: 'POST', cookie: bob.cookie })).status, 404);
  assert.equal((await rowFor(alice.userId, 398)).status, 'failed');
  // Bob queues the same video independently.
  assert.equal((await (await enqueue(bob.cookie, [youtu(398)])).json()).results[0].status, 'queued');
  assert.deepEqual((await queueOf(alice.cookie)).items.map(i => i.id), [item.id]);
});
// Makes a failed row retryable so a 404 for another user cannot be a 409 in disguise.
const makeRetryable = async userId => (await queueDb()).prepare("UPDATE queue_items SET retryable = 1 WHERE user_id = ? AND status = 'failed'").bind(userId).run();

test('the runner takes turns between users instead of draining one user first', async () => {
  const alice = await verifiedUser('queue-turns-a@example.com');
  const bob = await verifiedUser('queue-turns-b@example.com');
  await h.control('clear-budget');
  await h.control('hold', video(500));
  await enqueue(alice.cookie, [youtu(500), youtu(501), youtu(502)]);
  await waitForQueue(statusIs(alice.userId, 500, 'processing'));
  await enqueue(bob.cookie, [youtu(510)]);
  await h.control('release', video(500));
  await waitForQueue(async () => [...await rowsOf(alice.userId), ...await rowsOf(bob.userId)].every(row => row.status === 'done'), { tick: () => h.control('clear-budget') });
  const started = async (userId, n) => (await rowFor(userId, n)).started_at;
  // Bob's only item ran before Alice's second and third.
  assert.ok(await started(bob.userId, 510) < await started(alice.userId, 501));
  assert.ok(await started(bob.userId, 510) < await started(alice.userId, 502));
});
