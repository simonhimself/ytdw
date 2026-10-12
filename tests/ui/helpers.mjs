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
export async function mockAccount(page, { user = null, items = [], authResponse, saveResponse } = {}) {
  const state = { user, items: items.map(item => ({ ...item })), requests: [] };
  const counts = () => ({ unread: state.items.filter(item => item.readAt === null).length, all: state.items.length });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: state.user } }));
  await page.route(url => url.pathname === '/api/auth/signup' || url.pathname === '/api/auth/login', async route => {
    const request = route.request();
    const body = request.postDataJSON();
    state.requests.push({ method: request.method(), path: new URL(request.url()).pathname, body, contentType: request.headers()['content-type'] });
    const custom = authResponse?.(body, state);
    if (custom) return route.fulfill(custom);
    state.user = { email: body.email };
    await route.fulfill({ status: request.url().endsWith('signup') ? 201 : 200, json: { user: state.user } });
  });
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
