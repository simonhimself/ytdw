import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const summary = '## Summary: Test brief\n\nAn overview with paragraph boundaries.\n\n## Key Points\n### Topic\n1. **First:** A detailed point.\n2. **Second:** Another point.';

// Production routes and SQLite DOs run in workerd. Only YouTube/AI/Turnstile and
// edge-rate decisions are simulated; controls below exist solely in this fixture.
export async function createHarness() {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const testSource = source.replace('const MAX_QUEUE_WAIT_MS = 90_000;', 'const MAX_QUEUE_WAIT_MS = 1000;')
    .replace('const PROCESSING_TIMEOUT_MS = 6 * 60 * 1000;', 'const PROCESSING_TIMEOUT_MS = 8000;')
    .replace('const RECOVERY_GRACE_MS = 10_000;', 'const RECOVERY_GRACE_MS = 200;')
    .replace('const COMMAND_TIMEOUT = 120_000;', 'const COMMAND_TIMEOUT = 7000;')
    .replace('const INTERACTIVE_QUIET_MS = 30_000;', 'const INTERACTIVE_QUIET_MS = 300;');
  // The queue runner's waits are shortened the same way; its logic is unchanged.
  const queueSource = (await readFile(new URL('../src/queue.ts', import.meta.url), 'utf8'))
    .replace('const JOB_GAP_MS = 5_000;', 'const JOB_GAP_MS = 20;')
    .replace('const BUSY_RETRY_MS = 15_000;', 'const BUSY_RETRY_MS = 100;')
    .replace('const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];', 'const BACKOFF_MS = [50, 50, 50, 50];');
  if ([testSource, queueSource].some(text => /INTERACTIVE_QUIET_MS = 30_000|JOB_GAP_MS = 5_000|BUSY_RETRY_MS = 15_000|BACKOFF_MS = \[60_000/.test(text))) {
    throw new Error('A patched constant no longer matches the source');
  }
  const fixture = `
import worker, { Coordinator as BaseCoordinator, SharedBrief as BaseSharedBrief, QueueRunner as BaseQueueRunner } from 'production-worker';
const counts = { model: 0, commands: 0, mediaStarts: 0, limits: {} };
const held = new Set();
const pending = new Map();
const brokenTransports = new Set();
const slowStartups = new Set();
const delayedCommands = new Map();
const captionHosts = new Map();
// Browser Rendering is "down" unless a test selects a mode for the video, so
// existing tests exercise the Sandbox fallback exactly as before.
const browserModes = new Map();
// Email Sending is mocked: messages are captured for tests, and delivery can be forced to fail.
const sentEmails = [];
let emailFailure = false;
const EMAIL = { async send(message) {
  if (emailFailure) throw Object.assign(new Error('Delivery failed for ' + JSON.stringify(message.to)), { code: 'E_DELIVERY_FAILED' });
  sentEmails.push({ to: message.to, from: message.from, subject: message.subject, text: message.text, html: message.html });
  return { messageId: 'fixture-' + sentEmails.length };
} };
async function player(id) {
  counts.browser = (counts.browser || 0) + 1;
  const mode = browserModes.get(id) ?? 'down';
  if (mode === 'down') throw new Error('Browser launch failed');
  const caption = (lang, kind, extra = '') => ({languageCode:lang,kind,baseUrl:'https://www.youtube.com/api/timedtext?v='+id+'&lang='+lang+'&src=browser'+extra});
  const ok = {status:'OK',videoId:id,title:'Fixture '+id,lengthSeconds:'300',author:'Fixture channel',translatableToEnglish:true,
    tracks:[caption('de',undefined),caption('en','asr'),caption('en-GB',undefined)]};
  if (mode === 'ok') return ok;
  if (mode === 'no-tracks') return {...ok,tracks:[]};
  if (mode === 'translate') return {...ok,tracks:[caption('ko','asr')]};
  if (mode === 'long') return {...ok,lengthSeconds:'30000'};
  if (mode === 'bot-wall') return {status:'LOGIN_REQUIRED',reason:"Sign in to confirm you're not a bot",tracks:[],translatableToEnglish:false};
  throw new Error('Unknown browser mode '+mode);
}
async function exec(command) {
  counts.commands++;
  if (command.includes('python3 --version')) return {success:true,exitCode:0,stdout:'fixture tools',stderr:''};
  const encoded = command.match(/printf %s '([^']+)'/)[1];
  const id = new URL(Buffer.from(encoded, 'base64').toString()).searchParams.get('v');
  if (!command.includes('$(date +%s)') || !command.includes('test "$remaining" -lt 1')) throw new Error('Absolute shell deadline missing');
  if (brokenTransports.has(id)) {counts.mediaStarts++;throw new Error('Durable Object reset because its code was updated');}
  if (slowStartups.has(id)) {
    await new Promise(resolve => delayedCommands.set(id,resolve));
    const deadline = Number(command.match(/remaining=\\$\\(\\( (\\d+)/)[1])*1000;
    if (Date.now() >= deadline-6000) return {success:false,exitCode:124,stdout:'',stderr:''};
  }
  counts.mediaStarts++;
  if (!command.includes('--dump-single-json')) throw new Error('Captions must be fetched by the Worker, not the Sandbox');
  // Caption host is overridable per video so tests can check URL validation.
  const host = captionHosts.get(id) ?? 'www.youtube.com';
  const track = lang => [{ext:'json3',url:'https://'+host+'/api/timedtext?v='+id+'&lang='+lang+'&fmt=json3'},{ext:'vtt',url:'https://'+host+'/api/timedtext?v='+id+'&lang='+lang+'&fmt=vtt'}];
  return {success:true,exitCode:0,stdout:JSON.stringify({id,title:'Fixture '+id,duration:300,automatic_captions:{'en':track('en'),'en-orig':track('en-orig'),'de':track('de')}}),stderr:''};
}
async function run(model, input, options) {
  counts.model++;
  const id = input.messages[1].content.match(/Title: Fixture ([\\w-]{11})/)[1];
  if (held.has(id)) await new Promise((resolve, reject) => {
    pending.set(id, resolve);
    options.signal.addEventListener('abort', () => { pending.delete(id); reject(options.signal.reason); }, {once:true});
  });
  return {response:${JSON.stringify(summary)}};
}
export class Coordinator extends BaseCoordinator {
  constructor(ctx, env) { super(ctx, {...env, Sandbox:{exec}, AI:{run}, BROWSER:{player}}); }
  async control(action) {
    if (action === 'clear-budget') this.ctx.storage.sql.exec('DELETE FROM admissions');
    if (action === 'expire-cache') this.ctx.storage.sql.exec('UPDATE completed_summaries SET expires_at = 0');
    if (action === 'cleanup') await super.alarm();
    if (action === 'lease') this.ctx.storage.sql.exec('INSERT OR REPLACE INTO coordinator_state(id,active_until) VALUES (1,?)',Date.now()+60000);
    if (action === 'fill-window') for (let i = 0; i < 3; i++) this.ctx.storage.sql.exec('INSERT INTO admissions(admitted_at) VALUES (?)', Date.now());
    return {cached:this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM completed_summaries').one().n,cacheExpiry:this.ctx.storage.sql.exec('SELECT MIN(expires_at) AS n FROM completed_summaries').one().n};
  }
}
export class SharedBrief extends BaseSharedBrief {
  async control(action) {
    if (action === 'expire') {const record=await this.ctx.storage.get('brief');record.expiresAt=0;await this.ctx.storage.put('brief',record);}
    if (action === 'cleanup') await super.alarm();
    return (await this.ctx.storage.get('brief')) ?? null;
  }
}
export class QueueRunner extends BaseQueueRunner {
  async control(action) {
    // Runs the alarm now, as if its scheduled time had come.
    if (action === 'fire') await this.alarm();
    return this.ctx.storage.getAlarm();
  }
}
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  const scope = request.headers.get('x-test-scope') || 'global';
  const legacy = url.pathname.startsWith('/__legacy');
  if (legacy) {
    url.pathname = url.pathname.slice('/__legacy'.length) || '/';
    request = new Request(url, request);
  }
  if (url.pathname === '/__control') {
    const {action,id} = await request.json();
    if (action === 'email:list') return Response.json(sentEmails);
    if (action === 'email:clear') {sentEmails.length = 0;return Response.json(sentEmails);}
    if (action === 'email:fail' || action === 'email:ok') {emailFailure = action === 'email:fail';return Response.json({emailFailure});}
    if (action === 'hold') held.add(id);
    if (action === 'break-transport') brokenTransports.add(id);
    if (action === 'slow-startup') slowStartups.add(id);
    if (action === 'foreign-caption-host') captionHosts.set(id, 'evil.example');
    if (action.startsWith('browser:')) browserModes.set(id, action.slice(8));
    if (action === 'release-startup') {delayedCommands.get(id)?.();delayedCommands.delete(id);}
    if (action === 'release') {held.delete(id);pending.get(id)?.();pending.delete(id);}
    if (action === 'clear-edge') await caches.default.delete(new Request('https://summary-cache.internal/v4/'+id));
    if (action.startsWith('runner:')) return Response.json({alarm: await env.QUEUE_RUNNER.getByName('global').control(action.slice(7))});
    if (action.startsWith('share:')) return Response.json(await env.SHARED_BRIEFS.getByName(id).control(action.slice(6)));
    const storage=await env.COORDINATOR.getByName(scope).control(action);
    return Response.json({...counts,pending:[...pending.keys()],...storage});
  }
  const limited = request.headers.get('x-test-deny');
  const limit = name => ({limit:async()=>{counts.limits[name]=(counts.limits[name]||0)+1;return {success:limited!==name};}});
  const namespace = env.COORDINATOR;
  return worker.fetch(request, {...env,
    MIGRATION_TARGET: legacy ? 'https://ytdw.fyi' : undefined,
    // The header value "unset" leaves APP_ORIGIN undefined, as in Previews.
    APP_ORIGIN: request.headers.get('x-test-app-origin') === 'unset' ? undefined : request.headers.get('x-test-app-origin') ?? 'https://ytdw.fyi',
    // Previews-only vars; unset (like production) unless a test sends the header.
    PREVIEW_HOST_SUFFIX: request.headers.get('x-test-preview-suffix') ?? undefined,
    TURNSTILE_HOSTNAMES: request.headers.get('x-test-turnstile-hostnames') ?? env.TURNSTILE_HOSTNAMES,
    REQUEST_RATE_LIMIT:limit('request'),CLIENT_RATE_LIMIT:limit('client'),GLOBAL_RATE_LIMIT:limit('global'),
    SHARE_READ_RATE_LIMIT:limit('share-client'),SHARE_GLOBAL_RATE_LIMIT:limit('share-global'),
    AUTH_RATE_LIMIT:limit('auth'),LIBRARY_RATE_LIMIT:limit('library'),
    COORDINATOR:{idFromName:()=>scope,get:()=>namespace.getByName(scope)},Sandbox:{exec},EMAIL,
  }, ctx);
} };
`;
  const bundled = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', external: ['cloudflare:*'], plugins: [{ name: 'fixture', setup(builder) {
    builder.onResolve({ filter: /^production-worker$/ }, () => ({ path: 'production', namespace: 'fixture' }));
    // The patched index.ts imports sibling modules (./auth, ./http, ...) from src/.
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: testSource, loader: 'ts', resolveDir: `${root}src` }));
    builder.onLoad({ filter: /src[\\/]queue\.ts$/ }, () => ({ contents: queueSource, loader: 'ts', resolveDir: `${root}src` }));
    builder.onResolve({ filter: /^@cloudflare\/sandbox$/ }, () => ({ path: 'sandbox', namespace: 'mock' }));
    builder.onResolve({ filter: /youtube-browser$/ }, () => ({ path: 'browser', namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ loader: 'js', contents: args.path === 'browser'
      ? 'export const fetchPlayerResponse = (binding, id, timeout) => binding.player(id, timeout);'
      : 'export const getSandbox = binding => binding; export class Sandbox {}' }));
  } }] });
  let verifications = 0;
  const captionRequests = [];
  const captionStatuses = new Map();
  const options = { port: 0, workers: [{ config: {
    name: 'test-ytdw', type: 'worker', compatibilityDate: '2026-08-27', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.js', modulesRoot: root, modules: { 'index.js': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    exports: { Coordinator: { type: 'durable-object', storage: 'sqlite' }, SharedBrief: { type: 'durable-object', storage: 'sqlite' }, QueueRunner: { type: 'durable-object', storage: 'sqlite' } },
    env: {
      COORDINATOR: { type: 'durable-object', worker: 'test-ytdw', exportName: 'Coordinator' },
      SHARED_BRIEFS: { type: 'durable-object', worker: 'test-ytdw', exportName: 'SharedBrief' },
      QUEUE_RUNNER: { type: 'durable-object', worker: 'test-ytdw', exportName: 'QueueRunner' },
      DB: { type: 'd1', id: 'ytdw-test' },
      ASSETS: { type: 'assets' }, TURNSTILE_SITEKEY: { type: 'text', value: 'fixture-sitekey' },
      TURNSTILE_SECRET: { type: 'text', value: 'fixture-secret' }, TURNSTILE_HOSTNAMES: { type: 'text', value: 'localhost' },
      TEST_TOKEN: { type: 'text', value: 'fixture-diagnostic-token' },
    },
    assets: { directory: `${root}/public`, hasUserWorker: true, runWorkerFirst: ['/api/*', '/s/*', '/library', '/verify', '/reset-password', '/account', '/__*'] },
  }, dev: { outboundService: { type: 'fetcher', handler: async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'www.youtube.com' && url.pathname === '/api/timedtext') {
      captionRequests.push(request.url);
      const id = url.searchParams.get('v');
      const status = captionStatuses.get(url.searchParams.get('src') === 'browser' ? `browser:${id}` : id);
      if (status) return new Response('Too Many Requests', { status });
      return new Response('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTest captions.');
    }
    if (!request.url.includes('/turnstile/v0/siteverify')) throw new Error('Unexpected outbound request');
    verifications++;
    // Tokens named for auth return the auth action; every other token is a summarize token.
    // A token of the form "<token>@<hostname>" makes Siteverify report that hostname.
    const token = new URLSearchParams(await request.text()).get('response') ?? '';
    return Response.json({ success: true, action: token.startsWith('fixture-auth') ? 'auth' : 'summarize', hostname: token.includes('@') ? token.slice(token.indexOf('@') + 1) : 'localhost' });
  } } } }] };
  const mf = new Miniflare(options);
  await mf.ready;
  // Apply the real D1 migrations, as `wrangler d1 migrations apply` would.
  const db = await mf.getD1Database('DB', 'test-ytdw');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    const statements = (await readFile(new URL(file, migrations), 'utf8')).replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
    await db.batch(statements.map(sql => db.prepare(sql)));
  }
  const request = (path, init = {}) => mf.dispatchFetch(`http://localhost${path}`, init);
  // Same as request, but addressed to another Host (Previews hostname tests).
  const requestAt = (host, path, init = {}) => mf.dispatchFetch(`http://${host}${path}`, init);
  const control = async (action, id, scope = 'global') => (await request('/__control', { method: 'POST', headers: { 'x-test-scope': scope }, body: JSON.stringify({ action, id }) })).json();
  const post = (id, scope = 'global', headers = {}) => request('/api/summarize', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-scope': scope, ...headers }, body: JSON.stringify({ url: `https://youtu.be/${id}`, turnstileToken: 'fixture-token' }) });
  return { mf, request, requestAt, control, post, verifications: () => verifications,
    emails: () => control('email:list'), clearEmails: () => control('email:clear'), failEmails: failing => control(failing ? 'email:fail' : 'email:ok'),
    captionRequests: () => [...captionRequests], failCaptions: (id, status) => captionStatuses.set(id, status),
    failBrowserCaptions: (id, status) => captionStatuses.set(`browser:${id}`, status), async reload() {
    options.workers[0].config.manifest.modules['index.js'].contents += '\n// restart fixture';
    await mf.setOptions(options);
  } };
}
