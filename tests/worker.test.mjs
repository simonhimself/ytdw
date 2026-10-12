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
