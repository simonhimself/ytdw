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
