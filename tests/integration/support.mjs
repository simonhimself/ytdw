import { expect } from '@playwright/test';
import { createHarness } from '../worker-harness.mjs';

// Shared by the integration specs: the real frontend against the real Worker, local D1, and real
// cookies. Only the Turnstile browser script is replaced (Siteverify is mocked inside the harness).
export const TURNSTILE_SCRIPT = `
  window.__widgets = {};
  window.__nextWidget = 1;
  window.turnstile = {
    render(selector, options) { const id = window.__nextWidget++; window.__widgets[id] = options; return id; },
    execute(id) { const options = window.__widgets[id]; setTimeout(() => options.callback(options.action === 'auth' ? 'fixture-auth-token' : 'fixture-token'), 10); },
    reset() {}
  };
  window.onTurnstileLoad();
`;

// Starts a harness and returns it with the loopback origin Chromium will browse.
export async function startHarness() {
  const h = await createHarness();
  const url = await h.mf.ready;
  // Chromium treats loopback hosts as secure contexts, so the Secure __Host- cookie is accepted over http.
  return { h, origin: `http://${process.env.INTEGRATION_HOST || 'localhost'}:${url.port}` };
}

export async function newPage(browser, project, origin) {
  const context = await browser.newContext({ viewport: project === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 }, baseURL: origin });
  const page = await context.newPage();
  const problems = [];
  const unexpected = [];
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  // Chromium logs every failed fetch as a console error; HTTP statuses are asserted via `unexpected` instead.
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console: ${message.text()}`); });
  // Same-origin 4xx/5xx responses are collected; steps that expect one consume it with expectStatus().
  page.on('response', response => {
    if (response.url().startsWith(origin) && response.status() >= 400) unexpected.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?*', route => route.fulfill({ contentType: 'application/javascript', body: TURNSTILE_SCRIPT }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const expectStatus = (entry) => {
    const index = unexpected.indexOf(entry);
    expect(index, `expected ${entry} among ${JSON.stringify(unexpected)}`).toBeGreaterThanOrEqual(0);
    unexpected.splice(index, 1);
  };
  return { context, page, problems, unexpected, expectStatus };
}
