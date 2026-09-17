import { test, expect } from '@playwright/test';

const videoA = 'https://www.youtube.com/watch?v=38vwjWpHFes';
const videoB = 'https://www.youtube.com/watch?v=PJrntzMA4iQ';
const markdown = '## Summary: A useful subject\n\nFirst overview paragraph.\n\n## Key Points\n### Details\n1. **First:** Keep this number.\n2. **Second:** Keep this paragraph boundary.';
const makeBrief = (url = videoA) => ({
  id: new URL(url).searchParams.get('v'), title: url === videoA ? 'First video brief' : 'Second video brief', uploader: 'Example channel', duration: 480,
  summary: markdown, transcriptTruncated: false,
  share: { url: '/s/75aad086-16f5-47f3-a449-9a3fd1d2e878', expiresAt: Date.now() + 86400000 },
});

test.beforeEach(async ({ page }, info) => {
  await page.addInitScript(({ dark }) => {
    localStorage.setItem('ytdw-theme', dark ? 'dark' : 'light');
    window.__copies = [];
    window.__executeCount = 0;
    window.__autoVerify = true;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
      if (window.__deferClipboard) await new Promise((resolve, reject) => { window.__pendingClipboard = { resolve, reject }; });
      if (window.__denyClipboard) throw new Error('Clipboard blocked');
      window.__copies.push(text);
    } } });
  }, { dark: info.project.name.endsWith('dark') });
  await page.route('**/api/config', route => route.fulfill({ json: { turnstileSitekey: 'test-key' } }));
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?*', route => route.fulfill({ contentType: 'application/javascript', body: `
    window.turnstile = {
      render(selector, callbacks) { window.__verification = callbacks; return 1; },
      execute() { window.__executeCount++; if (window.__autoVerify) setTimeout(() => window.__verification.callback('test-token'), 10); },
      reset() {}
    };
    window.onTurnstileLoad();
  ` }));
  await page.route('**/api/summarize', route => route.fulfill({ json: makeBrief(route.request().postDataJSON().url) }));
  await page.route('**/api/shares/*', route => route.fulfill({ json: makeBrief() }));
});

async function generate(page, url = videoA) {
  await expect.poll(() => page.evaluate(() => Boolean(window.__verification))).toBe(true);
  await page.getByLabel('YouTube URL', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeEnabled();
}

test('Copy preserves Markdown structure; Share shows only expiry and accessible confirmation', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await generate(page);
  await expect(page.locator('#share-expiry')).toBeHidden();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => window.__copies[0])).toBe(markdown);
  await expect(page.locator('#copy-status')).toHaveText('Brief copied.');
  await expect(page.locator('#copy-status')).toHaveCSS('position', 'absolute');
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('#share-expiry')).toBeVisible();
  await expect(page.locator('#share-status')).toHaveText('Share link copied.');
  await expect(page.locator('#share-status')).toHaveCSS('width', '1px');
  await expect(page.locator('#share-status')).not.toHaveCSS('display', 'none');
  expect((await page.evaluate(() => window.__copies)).at(-1)).toContain('/s/75aad086-16f5-47f3-a449-9a3fd1d2e878');
  await expect(page.locator('#page-title')).toHaveCSS('font-size', '28px');
  const bounds = await page.locator('#page-title').boundingBox();
  expect(Math.abs(bounds.x + bounds.width / 2 - page.viewportSize().width / 2)).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('result.png'), fullPage: true });
});

test('blocked Copy/Share provide selected manual fallbacks and reset for the next result', async ({ page }) => {
  await page.goto('/');
  await generate(page);
  await page.evaluate(() => { window.__denyClipboard = true; });
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByLabel('Select and copy the brief', { exact: true })).toHaveValue(markdown);
  await expect(page.locator('#copy-text')).toBeFocused();
  expect(await page.locator('#copy-text').evaluate(el => el.selectionEnd - el.selectionStart)).toBe(markdown.length);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('#share-url')).toBeVisible();
  await expect(page.locator('#share-status')).toHaveCSS('position', 'static');
  await generate(page, videoB);
  await expect(page.locator('#copy-fallback')).toBeHidden();
  await expect(page.locator('#share-fallback')).toBeHidden();
  await expect(page.locator('#share-expiry')).toBeHidden();
});

test('previous brief remains readable and copyable during a failed replacement', async ({ page }) => {
  await page.goto('/');
  await generate(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/summarize', async route => { await gate; await route.fulfill({ status: 503, json: { error: 'The processing queue is full. Please try again.' } }); });
  await page.getByLabel('YouTube URL', { exact: true }).fill(videoB);
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.locator('#status-title')).toHaveText('Opening the video');
  await expect(page.locator('#status-detail')).toHaveText('Starting a secure media worker');
  await expect(page.locator('#previous-result-note')).toBeVisible();
  await expect(page.locator('#result-title')).toHaveText('First video brief');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => window.__copies.at(-1))).toBe(markdown);
  await expect(page.locator('#status-title')).toHaveText('Reading the captions', { timeout: 6000 });
  await expect(page.locator('#status-detail')).toHaveText('Separating dialogue from timing data');
  await expect(page.locator('#status-title')).toHaveText('Finding the signal', { timeout: 6000 });
  await expect(page.locator('#status-detail')).toHaveText('Distilling claims, facts, and conclusions');
  release();
  await expect(page.locator('#error')).toContainText('queue is full');
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#result-title')).toHaveText('First video brief');
  await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeEnabled();
  await expect(page.locator('#status')).toBeHidden();
  await expect(page.locator('#process-announcement')).toBeEmpty();
});

test('verification guards duplicate submissions and preserves the initiating URL', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.__verification))).toBe(true);
  await page.evaluate(() => { window.__autoVerify = false; });
  await page.getByLabel('YouTube URL', { exact: true }).fill(videoA);
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.locator('#status-title')).toHaveText('Verifying…');
  await expect(page.locator('#submit-button')).toBeDisabled();
  await expect(page.locator('#youtube-url')).toHaveAttribute('readonly', '');
  await page.evaluate(() => { document.querySelector('#summary-form').requestSubmit(); document.querySelector('#youtube-url').value = 'https://youtu.be/PJrntzMA4iQ'; });
  expect(await page.evaluate(() => window.__executeCount)).toBe(1);
  const requestPromise = page.waitForRequest('**/api/summarize');
  await page.evaluate(() => window.__verification.callback('test-token'));
  expect((await requestPromise).postDataJSON().url).toBe(videoA);
  await expect(page.locator('#result-title')).toHaveText('First video brief');
});

test('expired sharing uses server availability and offers regeneration without automatically submitting', async ({ page }) => {
  await page.goto('/');
  await generate(page);
  await page.route('**/api/shares/*', route => route.fulfill({ status: 404, json: { error: 'Unavailable' } }));
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('#share-expiry')).toContainText('expired or is unavailable');
  await expect(page.locator('#regenerate-link')).toBeVisible();
  expect(await page.evaluate(() => window.__copies)).toEqual([]);
  await page.getByRole('link', { name: 'Summarize this video again' }).click();
  await expect(page.getByLabel('YouTube URL', { exact: true })).toHaveValue(videoA);
  await expect(page.locator('#result')).toBeHidden();
  expect(await page.evaluate(() => window.__executeCount)).toBe(0);
});

test('unavailable recipients see recovery instructions without loading Turnstile', async ({ page }) => {
  let verificationRequests = 0;
  page.on('request', request => { if (request.url().includes('challenges.cloudflare.com')) verificationRequests++; });
  await page.route('**/api/shares/*', route => route.fulfill({ status: 404, json: { error: 'Unavailable' } }));
  await page.goto('/s/75aad086-16f5-47f3-a449-9a3fd1d2e878');
  await expect(page.locator('#error')).toContainText('Ask the sender for the original video URL');
  expect(verificationRequests).toBe(0);
  await expect(page.getByRole('link', { name: 'Summarize another video' })).toBeVisible();
});

test('landing logo stays large and mobile inputs do not use zoom-triggering small text', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#page-title')).toHaveCSS('font-size', page.viewportSize().width < 640 ? '48px' : '64px');
  await expect(page.locator('#youtube-url')).toHaveCSS('font-size', '16px');
  const response = await page.request.get('/');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(response.headers()['content-security-policy'].split(';').find(p => p.includes('script-src'))).not.toContain('unsafe-inline');
});

test('keyboard focus remains on successful actions and moves to expired-link recovery', async ({ page }) => {
  await page.goto('/');
  await generate(page);
  const copy = page.getByRole('button', { name: 'Copy', exact: true });
  const share = page.getByRole('button', { name: 'Share', exact: true });
  await copy.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#copy-status')).toHaveText('Brief copied.');
  await expect(copy).toBeFocused();
  await share.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#share-status')).toHaveText('Share link copied.');
  await expect(share).toBeFocused();
  await page.route('**/api/shares/*', route => route.fulfill({ status: 404, json: { error: 'Unavailable' } }));
  await page.keyboard.press('Enter');
  await expect(page.locator('#regenerate-link')).toBeFocused();
});

test('late clipboard feedback cannot modify a replacement brief', async ({ page }) => {
  await page.goto('/');
  await generate(page);
  await page.evaluate(() => { window.__deferClipboard = true; });
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__pendingClipboard))).toBe(true);
  await generate(page, videoB);
  await page.evaluate(() => { window.__pendingClipboard.reject(new Error('Delayed failure')); window.__deferClipboard = false; });
  await expect(page.locator('#result-title')).toHaveText('Second video brief');
  await expect(page.locator('#copy-fallback')).toBeHidden();
  await expect(page.locator('#copy-status')).toBeEmpty();
  await expect(page.locator('#copy-button')).toHaveAttribute('aria-disabled', 'false');
});

test('late share checks cannot reveal feedback on a replacement brief', async ({ page }) => {
  await page.goto('/');
  await generate(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/shares/*', async route => { await gate; await route.fulfill({ status: 404, json: { error: 'Unavailable' } }); });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await generate(page, videoB);
  release();
  await expect(page.locator('#result-title')).toHaveText('Second video brief');
  await expect(page.locator('#regenerate-link')).toBeHidden();
  await expect(page.locator('#share-expiry')).toBeHidden();
  await expect(page.locator('#share-button')).toBeEnabled();
});

test('a malformed successful response leaves the previous brief intact', async ({ page }) => {
  await page.goto('/');
  await generate(page);
  await page.route('**/api/summarize', route => route.fulfill({ json: { ...makeBrief(videoB), summary: null } }));
  await generate(page, videoB);
  await expect(page.locator('#error')).toContainText('incomplete brief');
  await expect(page.locator('#result-title')).toHaveText('First video brief');
  await expect(page.locator('#result-summary')).toContainText('Keep this number');
});

test('verification failure can be retried and late expiry cannot cancel processing', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.__verification))).toBe(true);
  await page.evaluate(() => { window.__autoVerify = false; });
  await page.getByLabel('YouTube URL', { exact: true }).fill(videoA);
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await page.evaluate(() => window.__verification['timeout-callback']());
  await expect(page.locator('#turnstile-error')).toContainText('timed out');
  await expect(page.locator('#submit-button')).toBeEnabled();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/summarize', async route => { await gate; await route.fulfill({ json: makeBrief() }); });
  await page.evaluate(() => { window.__autoVerify = true; });
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.locator('#status-title')).toHaveText('Opening the video');
  await page.evaluate(() => window.__verification['expired-callback']());
  await expect(page.locator('#submit-button')).toBeDisabled();
  await expect(page.locator('#status-title')).toHaveText('Opening the video');
  release();
  await expect(page.locator('#result-title')).toHaveText('First video brief');
});
