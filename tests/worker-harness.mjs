import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
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
    .replace('const COMMAND_TIMEOUT = 120_000;', 'const COMMAND_TIMEOUT = 7000;');
  const fixture = `
import worker, { Coordinator as BaseCoordinator, SharedBrief as BaseSharedBrief } from 'production-worker';
const counts = { model: 0, commands: 0, mediaStarts: 0, limits: {} };
const held = new Set();
const pending = new Map();
const brokenTransports = new Set();
const slowStartups = new Set();
const delayedCommands = new Map();
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
  if (command.includes('--dump-single-json')) return {success:true,exitCode:0,stdout:JSON.stringify({id,title:'Fixture '+id,duration:300,automatic_captions:{'en-orig':[{ext:'vtt'}]}}),stderr:''};
  if (!command.includes("--sub-langs '^en-orig$'")) throw new Error('Expected a single original English track');
  return {success:true,exitCode:0,stdout:'WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\nTest captions.',stderr:''};
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
  constructor(ctx, env) { super(ctx, {...env, Sandbox:{exec}, AI:{run}}); }
  async control(action) {
    if (action === 'clear-budget') this.ctx.storage.sql.exec('DELETE FROM admissions');
    if (action === 'expire-cache') this.ctx.storage.sql.exec('UPDATE completed_summaries SET expires_at = 0');
    if (action === 'cleanup') await super.alarm();
    if (action === 'lease') this.ctx.storage.sql.exec('INSERT OR REPLACE INTO coordinator_state(id,active_until) VALUES (1,?)',Date.now()+60000);
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
export default { async fetch(request, env) {
  const url = new URL(request.url);
  const scope = request.headers.get('x-test-scope') || 'global';
  const legacy = url.pathname.startsWith('/__legacy');
  if (legacy) {
    url.pathname = url.pathname.slice('/__legacy'.length) || '/';
    request = new Request(url, request);
  }
  if (url.pathname === '/__control') {
    const {action,id} = await request.json();
    if (action === 'hold') held.add(id);
    if (action === 'break-transport') brokenTransports.add(id);
    if (action === 'slow-startup') slowStartups.add(id);
    if (action === 'release-startup') {delayedCommands.get(id)?.();delayedCommands.delete(id);}
    if (action === 'release') {held.delete(id);pending.get(id)?.();pending.delete(id);}
    if (action === 'clear-edge') await caches.default.delete(new Request('https://summary-cache.internal/v4/'+id));
    if (action.startsWith('share:')) return Response.json(await env.SHARED_BRIEFS.getByName(id).control(action.slice(6)));
    const storage=await env.COORDINATOR.getByName(scope).control(action);
    return Response.json({...counts,pending:[...pending.keys()],...storage});
  }
  const limited = request.headers.get('x-test-deny');
  const limit = name => ({limit:async()=>{counts.limits[name]=(counts.limits[name]||0)+1;return {success:limited!==name};}});
  const namespace = env.COORDINATOR;
  return worker.fetch(request, {...env,
    MIGRATION_TARGET: legacy ? 'https://ytdw.simons.workers.dev' : undefined,
    REQUEST_RATE_LIMIT:limit('request'),CLIENT_RATE_LIMIT:limit('client'),GLOBAL_RATE_LIMIT:limit('global'),
    SHARE_READ_RATE_LIMIT:limit('share-client'),SHARE_GLOBAL_RATE_LIMIT:limit('share-global'),
    COORDINATOR:{idFromName:()=>scope,get:()=>namespace.getByName(scope)},Sandbox:{exec},
  });
} };
`;
  const bundled = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', external: ['cloudflare:*'], plugins: [{ name: 'fixture', setup(builder) {
    builder.onResolve({ filter: /^production-worker$/ }, () => ({ path: 'production', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: testSource, loader: 'ts', resolveDir: root }));
    builder.onResolve({ filter: /^@cloudflare\/sandbox$/ }, () => ({ path: 'sandbox', namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const getSandbox = binding => binding; export class Sandbox {}', loader: 'js' }));
  } }] });
  let verifications = 0;
  const options = { port: 0, workers: [{ config: {
    name: 'test-ytdw', type: 'worker', compatibilityDate: '2026-08-27', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.js', modulesRoot: root, modules: { 'index.js': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    exports: { Coordinator: { type: 'durable-object', storage: 'sqlite' }, SharedBrief: { type: 'durable-object', storage: 'sqlite' } },
    env: {
      COORDINATOR: { type: 'durable-object', worker: 'test-ytdw', exportName: 'Coordinator' },
      SHARED_BRIEFS: { type: 'durable-object', worker: 'test-ytdw', exportName: 'SharedBrief' },
      ASSETS: { type: 'assets' }, TURNSTILE_SITEKEY: { type: 'text', value: 'fixture-sitekey' },
      TURNSTILE_SECRET: { type: 'text', value: 'fixture-secret' }, TURNSTILE_HOSTNAMES: { type: 'text', value: 'localhost' },
      TEST_TOKEN: { type: 'text', value: 'fixture-diagnostic-token' },
    },
    assets: { directory: `${root}/public`, hasUserWorker: true, runWorkerFirst: ['/api/*', '/s/*', '/__*'] },
  }, dev: { outboundService: { type: 'fetcher', handler: async (request) => {
    if (!request.url.includes('/turnstile/v0/siteverify')) throw new Error('Unexpected outbound request');
    verifications++;
    return Response.json({ success: true, action: 'summarize', hostname: 'localhost' });
  } } } }] };
  const mf = new Miniflare(options);
  await mf.ready;
  const request = (path, init = {}) => mf.dispatchFetch(`http://localhost${path}`, init);
  const control = async (action, id, scope = 'global') => (await request('/__control', { method: 'POST', headers: { 'x-test-scope': scope }, body: JSON.stringify({ action, id }) })).json();
  const post = (id, scope = 'global', headers = {}) => request('/api/summarize', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-scope': scope, ...headers }, body: JSON.stringify({ url: `https://youtu.be/${id}`, turnstileToken: 'fixture-token' }) });
  return { mf, request, control, post, verifications: () => verifications, async reload() {
    options.workers[0].config.manifest.modules['index.js'].contents += '\n// restart fixture';
    await mf.setOptions(options);
  } };
}
