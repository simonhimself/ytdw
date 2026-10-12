import { expect, test } from '@playwright/test';
import { newPage as openPage, startHarness } from './support.mjs';

// End-to-end check of accounts + library: see support.mjs for what is real and what is mocked.
let h;
let origin;
test.beforeAll(async () => { ({ h, origin } = await startHarness()); });
test.afterAll(async () => { await h?.mf.dispose(); });

test.describe.configure({ mode: 'serial' });

// One account/video pair per project so the shared database never collides.
const flow = (project) => project === 'mobile'
  ? { email: 'Mobile.Reader@Example.com', password: 'correct horse battery', videoId: '00000000098' }
  : { email: 'Desktop.Reader@Example.com', password: 'correct horse battery', videoId: '00000000099' };

const newPage = (browser, project) => openPage(browser, project, origin);

test('sign up, save, read, delete, sign out, sign in', async ({ browser }, info) => {
  const { email, password, videoId } = flow(info.project.name);
  const { context, page, problems, unexpected, expectStatus } = await newPage(browser, info.project.name);

  // Summarize a video with the real Worker.
  await page.goto('/');
  await expect(page.locator('#sign-in-button')).toBeVisible();
  await page.locator('#youtube-url').fill(`https://www.youtube.com/watch?v=${videoId}`);
  await page.locator('#submit-button').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#result-title')).toHaveText(`Fixture ${videoId}`);
  await expect(page.locator('#share-button')).toBeEnabled();
  await expect(page.locator('#save-button')).toBeEnabled();

  // Save while signed out opens the auth dialog; creating an account saves automatically.
  await page.locator('#save-button').click();
  const dialog = page.locator('#auth-dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#auth-switch').click();
  await expect(page.locator('#auth-submit')).toHaveText('Create account');
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#save-button')).toHaveText('Saved');
  await expect(page.locator('#library-link')).toBeVisible();
  await expect(page.locator('#library-badge')).toHaveText('1');
  await expect(page.locator('#account-menu')).toBeVisible();

  // The session cookie is real, HttpOnly, and Secure.
  const cookie = (await context.cookies()).find(c => c.name === '__Host-ytdw_session');
  expect(cookie, 'session cookie accepted by Chromium').toBeTruthy();
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  expect(await page.evaluate(() => document.cookie)).toBe('');

  // Library: Unread tab lists the item.
  await page.locator('#library-link').click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('#library-list li')).toHaveCount(1);
  await expect(page.locator('#tab-unread .library-tab__count')).toHaveText('1');
  await expect(page.locator('#tab-all .library-tab__count')).toHaveText('1');
  await expect(page.locator('#library-list')).toContainText(`Fixture ${videoId}`);

  // Open the item, mark it read.
  await page.locator('#library-list li a, #library-list li button').first().click();
  await expect(page).toHaveURL(/\/library\?item=[0-9a-f-]{36}$/);
  const itemUrl = page.url();
  await expect(page.locator('#result-title')).toHaveText(`Fixture ${videoId}`);
  await expect(page.locator('#result-summary')).toContainText('Test brief');
  await expect(page.locator('#read-button')).toHaveText('Mark as read');
  await expect(page.locator('#library-badge')).toHaveText('1');
  await page.locator('#read-button').click();
  await expect(page.locator('#read-button')).toHaveText('Mark as unread');
  await expect(page.locator('#library-badge')).toBeHidden();

  // Back to the list: Unread is empty, All has the item.
  await page.locator('#library-back').click();
  await expect(page.locator('#tab-unread .library-tab__count')).toHaveText('0');
  await expect(page.locator('#library-empty')).toBeVisible();
  await page.locator('#tab-all').click();
  await expect(page.locator('#library-list li')).toHaveCount(1);
  await expect(page.locator('#tab-all .library-tab__count')).toHaveText('1');

  // Reload: the session persists and the item deep link works.
  await page.goto(itemUrl);
  await expect(page.locator('#result-title')).toHaveText(`Fixture ${videoId}`);
  await expect(page.locator('#read-button')).toHaveText('Mark as unread');
  await expect(page.locator('#account-menu')).toBeVisible();
  await page.reload();
  await expect(page.locator('#result-title')).toHaveText(`Fixture ${videoId}`);

  // Delete with confirmation.
  await page.locator('#delete-button').click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#confirm-delete').click();
  await expect(page.locator('#library-empty')).toBeVisible();
  await expect(page.locator('#tab-all .library-tab__count')).toHaveText('0');
  await expect(page.locator('#library-list li')).toHaveCount(0);

  // Sign out: /library is signed out, the cookie is gone, the old session is dead.
  await page.locator('#account-menu summary').click();
  await page.locator('#sign-out-button').click();
  await expect(page.locator('#sign-in-button')).toBeVisible();
  await page.goto('/library');
  await expect(page.locator('#library-signed-out')).toBeVisible();
  expect((await context.cookies()).find(c => c.name === '__Host-ytdw_session')).toBeUndefined();
  await page.reload();
  await expect(page.locator('#library-signed-out')).toBeVisible();

  // Wrong password: generic message, no session.
  await page.locator('#library-sign-in').click();
  await expect(dialog).toBeVisible();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill('definitely wrong');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-error')).toHaveText('Email or password is incorrect.');
  expectStatus('401 POST /api/auth/login');

  // Correct password (email casing differs from signup): signed in again and the library loads.
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#account-menu')).toBeVisible();
  await expect(page.locator('#library-empty')).toBeVisible();
  await expect(page.locator('#library-signed-out')).toBeHidden();

  await expect.poll(() => unexpected, { message: 'unexpected 4xx/5xx' }).toEqual([]);
  expect(problems).toEqual([]);
  await context.close();
});

test('save from a shared brief and duplicate signup', async ({ browser }, info) => {
  const { email, password, videoId } = flow(info.project.name);
  const { context, page, problems, unexpected, expectStatus } = await newPage(browser, info.project.name);

  // The summary is cached, so a second summarize returns a fresh share link for the same video.
  const response = await page.request.post('/api/summarize', { data: { url: `https://youtu.be/${videoId}`, turnstileToken: 'fixture-token' } });
  expect(response.status()).toBe(200);
  const brief = await response.json();
  expect(brief.share.url).toMatch(/^\/s\/[0-9a-f-]{36}$/);

  // Signed out: Save opens the dialog; signing in (existing account) saves the brief.
  await page.goto(brief.share.url);
  await expect(page.locator('#result-title')).toHaveText(`Fixture ${videoId}`);
  await expect(page.locator('#save-button')).toBeEnabled();
  await page.locator('#save-button').click();
  await expect(page.locator('#auth-dialog')).toBeVisible();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-dialog')).toBeHidden();
  await expect(page.locator('#save-button')).toHaveText('Saved');
  await expect(page.locator('#library-badge')).toHaveText('1');

  // Saving the same video again from a new share view is idempotent (still one item).
  const second = await (await page.request.post('/api/summarize', { data: { url: `https://youtu.be/${videoId}`, turnstileToken: 'fixture-token' } })).json();
  await page.goto(second.share.url);
  await expect(page.locator('#save-button')).toHaveText('Save');
  await page.locator('#save-button').click();
  await expect(page.locator('#save-button')).toHaveText('Saved');
  // In-page fetch, not page.request: Playwright's APIRequestContext withholds Secure cookies from http://127.0.0.1,
  // whereas Chromium itself sends them, so this reflects real browser behavior on either host.
  const list = await page.evaluate(async () => (await fetch('/api/library?filter=all')).json());
  expect(list.counts).toEqual({ unread: 1, all: 1 });
  expect(list.items).toHaveLength(1);

  // Signing up with an existing email shows the conflict inline.
  await page.locator('#account-menu summary').click();
  await page.locator('#sign-out-button').click();
  await page.locator('#sign-in-button').click();
  await page.locator('#auth-switch').click();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-error')).toContainText('already exists');
  expectStatus('409 POST /api/auth/signup');

  await expect.poll(() => unexpected, { message: 'unexpected 4xx/5xx' }).toEqual([]);
  expect(problems).toEqual([]);
  await context.close();
});
