// Shared fixtures for the UI specs: brief factory, Turnstile mock, and a stateful fake account API.
export const videoA = 'https://www.youtube.com/watch?v=38vwjWpHFes';
export const videoB = 'https://www.youtube.com/watch?v=PJrntzMA4iQ';
export const markdown = '## Summary: A useful subject\n\nFirst overview paragraph.\n\n## Key Points\n### Details\n1. **First:** Keep this number.\n2. **Second:** Keep this paragraph boundary.';
export const shareId = '75aad086-16f5-47f3-a449-9a3fd1d2e878';
export const makeBrief = (url = videoA) => ({
  id: new URL(url).searchParams.get('v'), title: url === videoA ? 'First video brief' : 'Second video brief', uploader: 'Example channel', duration: 480,
  summary: markdown, transcriptTruncated: false,
  share: { url: `/s/${shareId}`, expiresAt: Date.now() + 86400000 },
});

export async function setupPage(page, info) {
  await page.addInitScript(({ dark }) => {
    localStorage.setItem('ytdw-theme', dark ? 'dark' : 'light');
    window.__copies = [];
    window.__executeCount = 0;
    window.__autoVerify = true;
    window.__authExecuteCount = 0;
    window.__autoAuthVerify = true;
    window.__resets = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
      if (window.__deferClipboard) await new Promise((resolve, reject) => { window.__pendingClipboard = { resolve, reject }; });
      if (window.__denyClipboard) throw new Error('Clipboard blocked');
      window.__copies.push(text);
    } } });
  }, { dark: info.project.name.endsWith('dark') });
  await page.route('**/api/config', route => route.fulfill({ json: { turnstileSitekey: 'test-key' } }));
  // The mock supports several widgets: the summarize widget keeps the legacy window.__verification
  // hooks; the auth widget (action "auth") uses window.__authVerification.
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?*', route => route.fulfill({ contentType: 'application/javascript', body: `
    window.__widgets = {};
    window.__nextWidget = 1;
    window.turnstile = {
      render(selector, options) {
        const id = window.__nextWidget++;
        window.__widgets[id] = options;
        if (options.action === 'auth') window.__authVerification = options;
        else window.__verification = options;
        return id;
      },
      execute(id) {
        const options = window.__widgets[id];
        if (options.action === 'auth') {
          window.__authExecuteCount++;
          if (window.__autoAuthVerify) setTimeout(() => options.callback('auth-token'), 10);
        } else {
          window.__executeCount++;
          if (window.__autoVerify) setTimeout(() => options.callback('test-token'), 10);
        }
      },
      reset(id) { window.__resets.push(id); }
    };
    window.onTurnstileLoad();
  ` }));
  await page.route('**/api/summarize', route => route.fulfill({ json: makeBrief(route.request().postDataJSON().url) }));
  await page.route('**/api/shares/*', route => route.fulfill({ json: makeBrief() }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
}

export function makeItem(id, overrides = {}) {
  return {
    id, videoId: 'vid' + id.padStart(8, '0'), title: `Saved brief ${id}`, uploader: 'Example channel',
    duration: 3900, savedAt: Date.UTC(2026, 9, 1, 12), readAt: null, summary: markdown, transcriptTruncated: false, ...overrides,
  };
}

const toListItem = ({ summary, transcriptTruncated, ...item }) => item;

// Stateful fake of the accounts + library API. Records every request for assertions.
export const accountPassword = 'correct horse battery';
export const invalidLink = 'This link is invalid or has expired.';
export const forgotMessage = "If that address has an account, we've sent a link to reset the password.";

// `user` is verified unless it says otherwise. `respond` maps an API path to a hook that may return a
// custom route.fulfill() payload for the Phase 1b endpoints (verify, resend, forgot, reset, change, delete).
export async function mockAccount(page, { user = null, items = [], authResponse, saveResponse, shareResponse, respond = {}, password = accountPassword, verifyToken = 'good-token', resetToken = 'reset-token', email = 'reader@example.com' } = {}) {
  const state = { user: user && { emailVerified: true, ...user }, password, items: items.map(item => ({ ...item })), requests: [] };
  const counts = () => ({ unread: state.items.filter(item => item.readAt === null).length, all: state.items.length });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: state.user } }));
  await page.route(url => url.pathname === '/api/auth/signup' || url.pathname === '/api/auth/login', async route => {
    const request = route.request();
    const body = request.postDataJSON();
    state.requests.push({ method: request.method(), path: new URL(request.url()).pathname, body, contentType: request.headers()['content-type'] });
    const custom = authResponse?.(body, state);
    if (custom) return route.fulfill(custom);
    const signup = request.url().endsWith('signup');
    // New accounts start unverified, which is what shows the banner.
    state.user = { email: body.email, emailVerified: !signup };
    await route.fulfill({ status: signup ? 201 : 200, json: { user: state.user } });
  });
  const handlers = {
    '/api/auth/verify': body => {
      if (body.token !== verifyToken) return { status: 400, json: { error: invalidLink } };
      if (state.user) state.user.emailVerified = true;
      return { json: { user: state.user ?? { email, emailVerified: true } } };
    },
    '/api/auth/verify/resend': () => {
      if (!state.user) return { status: 401, json: { error: 'Sign in to continue.' } };
      return state.user.emailVerified ? { json: { user: state.user } } : { status: 202, json: {} };
    },
    '/api/auth/password/forgot': () => ({ status: 202, json: { message: forgotMessage } }),
    '/api/auth/password/reset': body => {
      if (body.token !== resetToken) return { status: 400, json: { error: invalidLink } };
      state.password = body.password;
      state.user = { email, emailVerified: true };
      return { json: { user: state.user } };
    },
    '/api/auth/password/change': body => {
      if (!state.user) return { status: 401, json: { error: 'Sign in to continue.' } };
      if (body.currentPassword !== state.password) return { status: 403, json: { error: 'Current password is incorrect.' } };
      state.password = body.newPassword;
      return { json: { user: state.user } };
    },
    '/api/account/delete': body => {
      if (!state.user) return { status: 401, json: { error: 'Sign in to continue.' } };
      if (body.password !== state.password) return { status: 403, json: { error: 'Password is incorrect.' } };
      state.user = null;
      state.items = [];
      return { status: 204, body: '' };
    },
  };
  for (const [path, handler] of Object.entries(handlers)) {
    await page.route(url => url.pathname === path, async route => {
      const request = route.request();
      const body = request.postDataJSON();
      // pageSearch is the page's own query string when the request left, to prove tokens were stripped first.
      const pageSearch = await page.evaluate(() => location.search).catch(() => null);
      state.requests.push({ method: request.method(), path, body, contentType: request.headers()['content-type'], pageSearch });
      await route.fulfill(respond[path]?.(body, state) ?? handler(body));
    });
  }
  await page.route('**/api/auth/logout', async route => {
    const request = route.request();
    state.requests.push({ method: 'POST', path: '/api/auth/logout', body: request.postDataJSON(), contentType: request.headers()['content-type'] });
    state.user = null;
    await route.fulfill({ status: 204, body: '' });
  });
  await page.route(url => url.pathname.startsWith('/api/library'), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const id = decodeURIComponent(url.pathname.split('/')[3] || '');
    state.requests.push({ method, path: url.pathname + url.search, body: method === 'GET' || method === 'DELETE' ? undefined : request.postDataJSON(), contentType: request.headers()['content-type'] });
    if (!state.user) return route.fulfill({ status: 401, json: { error: 'Sign in to continue.' } });
    const item = state.items.find(candidate => candidate.id === id);
    if (method === 'GET' && !id) {
      const filter = url.searchParams.get('filter');
      const visible = state.items.filter(candidate => filter !== 'unread' || candidate.readAt === null);
      return route.fulfill({ json: { items: visible.map(toListItem), counts: counts() } });
    }
    if (method === 'GET') return item ? route.fulfill({ json: { item } }) : route.fulfill({ status: 404, json: { error: 'Not found.' } });
    // POST /api/library/:id/share mints a link from the saved copy (checked before the save branch).
    if (method === 'POST' && url.pathname.split('/')[4] === 'share') {
      const custom = shareResponse?.(item, state);
      if (custom) return route.fulfill(custom);
      if (!item) return route.fulfill({ status: 404, json: { error: 'Brief not found.' } });
      state.shareCount = (state.shareCount ?? 0) + 1;
      return route.fulfill({ json: { share: { url: `/s/${shareId.slice(0, -2)}${String(10 + state.shareCount).slice(-2)}`, expiresAt: Date.now() + 86400000 } } });
    }
    if (method === 'POST') {
      const custom = saveResponse?.(request.postDataJSON(), state);
      if (custom) return route.fulfill(custom);
      const saved = makeItem(String(state.items.length + 1), { title: 'First video brief', videoId: '38vwjWpHFes', duration: 480 });
      state.items.unshift(saved);
      return route.fulfill({ status: 201, json: { item: toListItem(saved) } });
    }
    if (!item) return route.fulfill({ status: 404, json: { error: 'Not found.' } });
    if (method === 'PATCH') {
      item.readAt = request.postDataJSON().read ? Date.now() : null;
      return route.fulfill({ json: { item: toListItem(item) } });
    }
    if (method === 'DELETE') {
      state.items = state.items.filter(candidate => candidate !== item);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 405, json: { error: 'Method not allowed.' } });
  });
  return state;
}

// Stateful fake of /api/queue on top of mockAccount's state. `results` can override the
// per-URL outcome by video id (for example { abcdefghijk: 'alreadySaved' }).
export function queueItem(id, videoId, overrides = {}) {
  return { id, videoId, status: 'queued', error: null, retryable: true, attempts: 0, createdAt: Date.UTC(2026, 9, 12, 12), ...overrides };
}

export async function mockQueue(page, account, { items = [], used = 0, results = {} } = {}) {
  const queue = { items: items.map(item => ({ ...item })), used, requests: [] };
  const quota = () => ({ used: queue.used, limit: 50, remaining: 50 - queue.used });
  const videoIdOf = url => {
    try {
      const parsed = new URL(url.trim());
      if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname)) return null;
      const id = parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1) : parsed.searchParams.get('v');
      return /^[A-Za-z0-9_-]{11}$/.test(id ?? '') ? id : null;
    } catch { return null; }
  };
  await page.route(url => url.pathname === '/api/queue' || url.pathname.startsWith('/api/queue/'), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const [, , , id, action] = url.pathname.split('/');
    queue.requests.push({ method, path: url.pathname, body: method === 'GET' ? undefined : request.postDataJSON(), contentType: request.headers()['content-type'] });
    if (!account.user) return route.fulfill({ status: 401, json: { error: 'Sign in to use your queue.' } });
    if (method === 'GET') return route.fulfill({ json: { items: queue.items, quota: quota() } });
    if (method === 'POST' && !id) {
      if (!account.user.emailVerified) return route.fulfill({ status: 403, json: { error: 'Verify your email to queue videos.' } });
      const seen = new Set();
      const out = request.postDataJSON().urls.map(raw => {
        const videoId = videoIdOf(raw);
        if (!videoId) return { url: raw.trim(), videoId: null, status: 'invalid', error: 'Enter a valid YouTube video URL' };
        if (seen.has(videoId)) return { url: raw.trim(), videoId, status: 'duplicate' };
        seen.add(videoId);
        const status = results[videoId] ?? (queue.used >= 50 ? 'overQuota' : 'queued');
        if (status === 'queued') {
          queue.used++;
          queue.items.push(queueItem(`00000000-0000-4000-8000-${String(queue.items.length + 100).padStart(12, '0')}`, videoId));
        }
        return { url: raw.trim(), videoId, status };
      });
      return route.fulfill({ json: { results: out, items: queue.items, quota: quota() } });
    }
    const item = queue.items.find(candidate => candidate.id === id);
    if (!item) return route.fulfill({ status: 404, json: { error: 'Queue item not found.' } });
    if (method === 'POST' && action === 'retry') {
      if (item.status !== 'failed' || !item.retryable) return route.fulfill({ status: 409, json: { error: 'Only failed videos that may succeed later can be retried.' } });
      Object.assign(item, { status: 'queued', error: null, attempts: 0 });
      return route.fulfill({ json: { item } });
    }
    if (method === 'DELETE') {
      queue.items = queue.items.filter(candidate => candidate !== item);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 405, json: { error: 'Method not allowed' } });
  });
  return queue;
}
