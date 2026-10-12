import { test, expect } from '@playwright/test';
import { videoA, videoB, markdown, shareId, setupPage, mockAccount, makeItem } from './helpers.mjs';

const email = 'reader@example.com';
const password = 'correct horse battery';

test.beforeEach(async ({ page }, info) => {
  await setupPage(page, info);
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
});
test.afterEach(({ page }) => { expect(page.errors).toEqual([]); });

const seedItems = () => [
  makeItem('3', { title: 'Newest unread brief', savedAt: Date.UTC(2026, 9, 3) }),
  makeItem('2', { title: 'Already read brief', readAt: Date.UTC(2026, 9, 4), savedAt: Date.UTC(2026, 9, 2) }),
  makeItem('1', { title: 'Oldest unread brief', uploader: null, duration: 600, savedAt: Date.UTC(2026, 9, 1) }),
];

async function generate(page, url = videoA, title = 'First video brief') {
  await expect.poll(() => page.evaluate(() => Boolean(window.__verification))).toBe(true);
  await page.getByLabel('YouTube URL', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.locator('#result-title')).toHaveText(title);
  await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeEnabled();
}

async function fillAuth(page, address = email, secret = password) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(address);
  await dialog.getByLabel('Password').fill(secret);
}

test('signed-out header offers Sign in; the dialog opens, closes with Escape and the close button, and restores focus', async ({ page }) => {
  await mockAccount(page);
  await page.goto('/');
  const signIn = page.locator('#sign-in-button');
  await expect(signIn).toBeVisible();
  await expect(page.locator('#library-link')).toBeHidden();
  await expect(page.locator('#account-menu')).toBeHidden();
  await signIn.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Email')).toBeFocused();
  await expect(dialog.getByLabel('Email')).toHaveAttribute('autocomplete', 'email');
  await expect(dialog.getByLabel('Password')).toHaveAttribute('autocomplete', 'current-password');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(signIn).toBeFocused();
  await signIn.click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(signIn).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('client-side validation blocks short passwords and invalid emails without a request', async ({ page }) => {
  const account = await mockAccount(page);
  await page.goto('/');
  await page.locator('#sign-in-button').click();
  const dialog = page.getByRole('dialog');
  await fillAuth(page, 'not-an-email', password);
  await dialog.locator('#auth-submit').click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a valid email address.');
  await expect(dialog.getByLabel('Email')).toBeFocused();
  await fillAuth(page, email, 'short');
  await dialog.locator('#auth-submit').click();
  await expect(dialog.getByRole('alert')).toContainText('at least 8 characters');
  expect(account.requests).toEqual([]);
  expect(await page.evaluate(() => window.__authExecuteCount)).toBe(0);
});

test('create account posts to signup with the auth Turnstile token and updates the header', async ({ page }) => {
  const account = await mockAccount(page, { items: seedItems() });
  await page.goto('/');
  await page.locator('#sign-in-button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create an account' }).click();
  await expect(page.getByRole('dialog', { name: 'Create account' })).toBeVisible();
  await expect(dialog.getByLabel('Password')).toHaveAttribute('autocomplete', 'new-password');
  await fillAuth(page);
  await dialog.locator('#auth-submit').click();
  await expect(dialog).toBeHidden();
  const signup = account.requests.find(request => request.path === '/api/auth/signup');
  expect(signup.body).toEqual({ email, password, turnstileToken: 'auth-token' });
  expect(signup.contentType).toContain('application/json');
  expect(await page.evaluate(() => window.__authVerification.action)).toBe('auth');
  // The summarize widget is never executed by the auth flow.
  expect(await page.evaluate(() => window.__executeCount)).toBe(0);
  await expect(page.locator('#sign-in-button')).toBeHidden();
  const library = page.getByRole('link', { name: 'Library, 2 unread' });
  await expect(library).toBeVisible();
  await expect(library).toHaveAttribute('href', '/library');
  await page.locator('#account-menu summary').click();
  await expect(page.locator('#account-email')).toHaveText(email);
  await expect(page.locator('#account-status')).toHaveText(`Signed in as ${email}.`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('sign in shows the server error inline, recovers, then succeeds against the login endpoint', async ({ page }) => {
  let attempts = 0;
  const account = await mockAccount(page, {
    authResponse: () => (++attempts === 1 ? { status: 401, json: { error: 'Email or password is incorrect.' } } : undefined),
  });
  await page.goto('/');
  await page.locator('#sign-in-button').click();
  const dialog = page.getByRole('dialog');
  await fillAuth(page);
  await dialog.locator('#auth-submit').click();
  await expect(dialog.getByRole('alert')).toHaveText('Email or password is incorrect.');
  await expect(dialog.locator('#auth-submit')).toHaveAttribute('aria-disabled', 'false');
  await expect(dialog.getByLabel('Email')).toHaveValue(email);
  // A fresh token is required for every attempt.
  await expect.poll(() => page.evaluate(() => window.__resets.length)).toBeGreaterThan(0);
  await dialog.locator('#auth-submit').click();
  await expect(dialog).toBeHidden();
  expect(account.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/api/auth/login', '/api/auth/login']);
  expect(account.requests[1].body).toEqual({ email, password, turnstileToken: 'auth-token' });
  expect(await page.evaluate(() => window.__authExecuteCount)).toBe(2);
  await expect(page.locator('#account-menu')).toBeVisible();
});

test('a verification failure in the auth dialog is shown and can be retried', async ({ page }) => {
  const account = await mockAccount(page);
  await page.goto('/');
  await page.locator('#sign-in-button').click();
  const dialog = page.getByRole('dialog');
  await page.evaluate(() => { window.__autoAuthVerify = false; });
  await fillAuth(page);
  await dialog.locator('#auth-submit').click();
  await expect(dialog.locator('#auth-submit')).toHaveText('Verifying…');
  await page.evaluate(() => window.__authVerification['timeout-callback']());
  await expect(dialog.getByRole('alert')).toContainText('timed out');
  expect(account.requests).toEqual([]);
  await page.evaluate(() => { window.__autoAuthVerify = true; });
  await dialog.locator('#auth-submit').click();
  await expect(dialog).toBeHidden();
  expect(account.requests.filter(request => request.method === 'POST')).toHaveLength(1);
});

test('Save from a result while signed in posts the share id and reports Saved with a library link', async ({ page }) => {
  const account = await mockAccount(page, { user: { email } });
  await page.goto('/');
  await generate(page);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await expect(page.locator('#save-status')).toHaveText('Saved to your library.');
  await expect(page.locator('#save-note').getByRole('link', { name: 'Open library' })).toHaveAttribute('href', '/library');
  const post = account.requests.find(request => request.method === 'POST');
  expect(post.body).toEqual({ shareId });
  expect(post.contentType).toContain('application/json');
  // Saved is terminal: further clicks do not repost.
  await page.getByRole('button', { name: 'Saved', exact: true }).click({ force: true });
  expect(account.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  await expect(page.getByRole('link', { name: /Library, 1 unread/ })).toBeVisible();
});

test('Save handles already-saved, expired (404), and expired-session (401) responses', async ({ page }) => {
  let mode = 'already';
  const account = await mockAccount(page, {
    user: { email },
    saveResponse: () => mode === 'already' ? { status: 200, json: { item: makeItem('9'), alreadySaved: true } }
      : mode === 'gone' ? { status: 404, json: { error: 'This brief is no longer available to save. Summarize the video again.' } }
      : { status: 401, json: { error: 'Sign in to continue.' } },
  });
  await page.goto('/');
  await generate(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('This brief was already in your library.');
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();

  // A fresh brief object for the failing cases.
  mode = 'gone';
  await generate(page, videoB, 'Second video brief');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('no longer available to save');
  await expect(page.locator('#save-status')).toBeVisible();
  await expect(page.locator('#regenerate-link')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  mode = 'expired-session';
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('#save-status')).toContainText('session expired');
  await expect(page.locator('#sign-in-button')).toBeVisible();
  expect(account.requests.filter(request => request.method === 'POST')).toHaveLength(3);
});

test('Save while signed out opens the dialog and saves automatically after sign-in', async ({ page }) => {
  const account = await mockAccount(page);
  await page.goto('/');
  await generate(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await expect(dialog).toBeVisible();
  expect(account.requests).toEqual([]);
  await fillAuth(page);
  await dialog.locator('#auth-submit').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(account.requests.map(request => `${request.method} ${request.path}`)).toEqual(expect.arrayContaining(['POST /api/auth/login', 'POST /api/library']));
  expect(account.requests.find(request => request.path === '/api/library').body).toEqual({ shareId });
});

test('dismissing the dialog drops the pending save so a later sign-in does not save', async ({ page }) => {
  const account = await mockAccount(page);
  await page.goto('/');
  await generate(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  await page.locator('#sign-in-button').click();
  await fillAuth(page);
  await page.getByRole('dialog').locator('#auth-submit').click();
  await expect(page.locator('#account-menu')).toBeVisible();
  expect(account.requests.some(request => request.path === '/api/library' && request.method === 'POST')).toBe(false);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
});

test('shared brief view offers Save, loads Turnstile only for the dialog, and disables Save without a share', async ({ page }) => {
  const account = await mockAccount(page);
  let verificationRequests = 0;
  page.on('request', request => { if (request.url().includes('challenges.cloudflare.com')) verificationRequests++; });
  await page.goto(`/s/${shareId}`);
  await expect(page.locator('#result-title')).toHaveText('First video brief');
  expect(verificationRequests).toBe(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await fillAuth(page);
  await dialog.locator('#auth-submit').click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(verificationRequests).toBe(1);
  expect(account.requests.find(request => request.path === '/api/library').body).toEqual({ shareId });
});

test('Save is disabled when the brief has no share link', async ({ page }) => {
  await mockAccount(page, { user: { email } });
  await page.goto('/');
  await page.route('**/api/summarize', route => route.fulfill({ json: { id: '38vwjWpHFes', title: 'No share', uploader: null, duration: 60, summary: markdown, transcriptTruncated: false, share: null } }));
  await generate(page, videoA, 'No share');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.locator('#share-expiry')).toContainText('temporarily unavailable');
});

test('library lists items newest first and the Unread/All tabs filter with counts', async ({ page }) => {
  const account = await mockAccount(page, { user: { email }, items: seedItems() });
  await page.goto('/library');
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await expect(page.locator('.composer')).toBeHidden();
  const unreadTab = page.getByRole('button', { name: /^Unread 2$/ });
  const allTab = page.getByRole('button', { name: /^All 3$/ });
  await expect(unreadTab).toHaveAttribute('aria-pressed', 'true');
  const rows = page.locator('#library-list li');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Newest unread brief');
  await expect(rows.first()).toContainText('Example channel · 1h 5m · Saved');
  await expect(rows.nth(1)).toContainText('YouTube · 10 min');
  await expect(rows.first().getByText('Unread', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Library, 2 unread' })).toHaveAttribute('aria-current', 'page');
  await allTab.click();
  await expect(allTab).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(3);
  await expect(allTab).toBeFocused();
  await expect(rows.nth(1)).toContainText('Already read brief');
  await expect(rows.nth(1).getByText('Unread', { exact: true })).toHaveCount(0);
  expect(account.requests.map(request => request.path)).toEqual(['/api/library?filter=unread', '/api/library?filter=all']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('library empty states cover nothing saved and all caught up', async ({ page }) => {
  await mockAccount(page, { user: { email } });
  await page.goto('/library');
  await expect(page.locator('#library-empty-title')).toHaveText('Nothing saved yet');
  const account = await mockAccount(page, { user: { email }, items: [makeItem('1', { readAt: Date.now() })] });
  await page.reload();
  await expect(page.locator('#library-empty-title')).toHaveText('You’re all caught up');
  await page.getByRole('button', { name: /^All 1$/ }).click();
  await expect(page.locator('#library-list li')).toHaveCount(1);
  await expect(page.locator('#library-empty')).toBeHidden();
  expect(account.requests.length).toBeGreaterThan(0);
});

test('signed-out library prompts to sign in and then loads the list', async ({ page }) => {
  await mockAccount(page, { items: seedItems() });
  await page.goto('/library');
  await expect(page.locator('#library-signed-out-title')).toHaveText('Sign in to see your library');
  await expect(page.locator('#library-list-view')).toBeHidden();
  await page.locator('#library-sign-in').click();
  await fillAuth(page);
  await page.getByRole('dialog').locator('#auth-submit').click();
  await expect(page.locator('#library-list li')).toHaveCount(2);
  await expect(page.locator('#library-signed-out')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeFocused();
});

test('opening an item renders the brief; mark read/unread updates counts without auto-marking', async ({ page }) => {
  const account = await mockAccount(page, { user: { email }, items: seedItems() });
  await page.goto('/library');
  await page.getByRole('link', { name: /Newest unread brief/ }).click();
  await expect(page).toHaveURL(/\/library\?item=3$/);
  await expect(page.locator('#result-title')).toHaveText('Newest unread brief');
  await expect(page.locator('#result-summary')).toContainText('Keep this number');
  await expect(page.locator('#result-summary li')).toHaveCount(2);
  await expect(page.getByRole('link', { name: /Watch on YouTube/ })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=vid00000003');
  await expect(page.locator('#library-meta')).toContainText('Unread');
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(await page.locator('.result__actions button:visible').allTextContents()).toEqual(['Copy', 'Share', 'Mark as read', 'Delete']);
  expect(account.requests.some(request => request.method === 'PATCH')).toBe(false);

  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => window.__copies[0])).toBe(markdown);

  await page.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark as unread', exact: true })).toBeVisible();
  await expect(page.locator('#item-status')).toHaveText('Marked as read.');
  await expect(page.locator('#library-meta')).toContainText('Read');
  await expect(page.getByRole('link', { name: 'Library, 1 unread' })).toBeVisible();
  const patch = account.requests.find(request => request.method === 'PATCH');
  expect(patch.body).toEqual({ read: true });
  expect(patch.contentType).toContain('application/json');

  await page.getByRole('button', { name: 'Mark as unread', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark as read', exact: true })).toBeVisible();
  await expect(page.locator('#item-status')).toHaveText('Marked as unread.');
  await expect(page.getByRole('link', { name: 'Library, 2 unread' })).toBeVisible();

  await page.getByRole('link', { name: 'Back to library' }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('#library-list li')).toHaveCount(2);
  await page.goBack();
  await expect(page.locator('#result-title')).toHaveText('Newest unread brief');
  await page.goBack();
  await expect(page.locator('#library-list li')).toHaveCount(2);
});

test('Share on a library item creates a link on click, copies it, and shows the expiry', async ({ page }) => {
  const account = await mockAccount(page, { user: { email }, items: seedItems() });
  await page.goto('/library?item=3');
  await expect(page.locator('#result-title')).toHaveText('Newest unread brief');
  const shareButton = page.getByRole('button', { name: 'Share', exact: true });
  // Nothing is created, and no note shows, until Share is used.
  await expect(page.locator('#share-expiry')).toBeHidden();
  expect(account.requests.some(request => request.path.endsWith('/share'))).toBe(false);

  await shareButton.click();
  await expect(page.locator('#share-status')).toHaveText('Share link copied.');
  await expect(page.locator('#share-expiry')).toContainText('Share link available until');
  await expect(page.locator('#share-expiry')).toContainText('Anyone with the link can read and forward it.');
  const posts = account.requests.filter(request => request.path === '/api/library/3/share');
  expect(posts).toHaveLength(1);
  expect(posts[0].method).toBe('POST');
  expect(posts[0].contentType).toContain('application/json');
  const copied = await page.evaluate(() => window.__copies);
  expect(copied).toHaveLength(1);
  expect(copied[0]).toMatch(/\/s\/[0-9a-f-]{36}$/);
  await expect(page.locator('#share-fallback')).toBeHidden();
  await expect(page.locator('#share-status')).toHaveClass(/sr-only/);

  // A second click re-checks the existing link instead of creating another one.
  await shareButton.click();
  await expect.poll(() => page.evaluate(() => window.__copies.length)).toBe(2);
  expect(account.requests.filter(request => request.path.endsWith('/share'))).toHaveLength(1);

  // Opening another item starts from a clean slate.
  await page.goto('/library?item=1');
  await expect(page.locator('#result-title')).toHaveText('Oldest unread brief');
  await expect(page.locator('#share-expiry')).toBeHidden();
  await expect(page.locator('#share-status')).toHaveText('');
});

test('Share on a library item falls back to a selectable link when copying is blocked', async ({ page }) => {
  await mockAccount(page, { user: { email }, items: seedItems() });
  await page.addInitScript(() => { window.__denyClipboard = true; });
  await page.goto('/library?item=3');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('#share-fallback')).toBeVisible();
  await expect(page.locator('#share-url')).toHaveValue(/\/s\/[0-9a-f-]{36}$/);
  await expect(page.locator('#share-url')).toBeFocused();
  await expect(page.locator('#share-status')).toHaveText('Select and copy the link below.');
  await expect(page.locator('#share-status')).not.toHaveClass(/sr-only/);
  await expect(page.locator('#share-expiry')).toContainText('Share link available until');
});

test('Share on a library item reports failures and a lapsed session', async ({ page }) => {
  let mode = 'error';
  const account = await mockAccount(page, {
    user: { email }, items: seedItems(),
    shareResponse: () => mode === 'error' ? { status: 503, json: { error: 'Something went wrong. Please try again.' } }
      : mode === 'missing' ? { status: 404, json: { error: 'Brief not found.' } }
        : mode === 'session' ? { status: 401, json: { error: 'Sign in to use your library.' } } : undefined,
  });
  await page.goto('/library?item=3');
  const shareButton = page.getByRole('button', { name: 'Share', exact: true });
  await shareButton.click();
  await expect(page.locator('#share-status')).toHaveText('Something went wrong. Please try again.');
  await expect(page.locator('#share-status')).not.toHaveClass(/sr-only/);
  await expect(page.locator('#share-fallback')).toBeHidden();
  expect(await page.evaluate(() => window.__copies)).toEqual([]);
  await expect(shareButton).toBeEnabled();

  mode = 'missing';
  await shareButton.click();
  await expect(page.locator('#share-status')).toHaveText('This brief is no longer in your library.');

  // A lapsed session sends the reader back to the sign-in prompt like other library actions.
  mode = 'session';
  await shareButton.click();
  await expect(page.locator('#library-signed-out-title')).toHaveText('Your session has ended');
  expect(account.requests.filter(request => request.path.endsWith('/share'))).toHaveLength(3);
});

test('deep links open an item directly and a missing item explains itself', async ({ page }) => {
  await mockAccount(page, { user: { email }, items: seedItems() });
  await page.goto('/library?item=2');
  await expect(page.locator('#result-title')).toHaveText('Already read brief');
  await expect(page.getByRole('button', { name: 'Mark as unread', exact: true })).toBeVisible();
  await page.goto('/library?item=nope');
  await expect(page.locator('#library-error')).toContainText('no longer in your library');
  await page.locator('#library-error').getByRole('link', { name: 'Back to library' }).click();
  await expect(page.locator('#library-list li')).toHaveCount(2);
});

test('Delete asks for confirmation; Cancel keeps the item and Delete removes it', async ({ page }) => {
  const account = await mockAccount(page, { user: { email }, items: seedItems() });
  await page.goto('/library?item=3');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this brief?' });
  await expect(dialog).toContainText('Newest unread brief');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  expect(account.requests.some(request => request.method === 'DELETE')).toBe(false);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('#library-list li')).toHaveCount(1);
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole('link', { name: 'Newest unread brief' })).toHaveCount(0);
  const deletion = account.requests.find(request => request.method === 'DELETE');
  expect(deletion.path).toBe('/api/library/3');
  expect(deletion.contentType).toContain('application/json');
  await expect(page.getByRole('link', { name: 'Library, 1 unread' })).toBeVisible();
});

test('sign out posts an empty JSON body, returns the header to Sign in, and shows the signed-out library', async ({ page }) => {
  const account = await mockAccount(page, { user: { email }, items: seedItems() });
  await page.goto('/library');
  await expect(page.locator('#library-list li')).toHaveCount(2);
  await page.locator('#account-menu summary').click();
  await expect(page.locator('#account-email')).toHaveText(email);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#sign-in-button')).toBeVisible();
  await expect(page.locator('#sign-in-button')).toBeFocused();
  await expect(page.locator('#account-menu')).toBeHidden();
  await expect(page.locator('#library-link')).toBeHidden();
  await expect(page.locator('#library-signed-out')).toBeVisible();
  const logout = account.requests.find(request => request.path === '/api/auth/logout');
  expect(logout.body).toEqual({});
  expect(logout.contentType).toContain('application/json');
});

test('an expired session while loading the library returns to the sign-in prompt', async ({ page }) => {
  const account = await mockAccount(page, { user: { email }, items: seedItems() });
  await page.goto('/library');
  await expect(page.locator('#library-list li')).toHaveCount(2);
  account.user = null;
  await page.getByRole('button', { name: /^All 3$/ }).click();
  await expect(page.locator('#library-signed-out-title')).toHaveText('Your session has ended');
  await expect(page.locator('#sign-in-button')).toBeVisible();
});

test('account menu closes with Escape and returns focus to its trigger', async ({ page }) => {
  await mockAccount(page, { user: { email } });
  await page.goto('/');
  const summary = page.locator('#account-menu summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#account-menu')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-menu')).not.toHaveAttribute('open', '');
  await expect(summary).toBeFocused();
});

// Screenshots for visual review; written under test-results/accounts-screenshots when CAPTURE_SCREENSHOTS=1.
test('capture account screenshots', async ({ page }, info) => {
  test.skip(!process.env.CAPTURE_SCREENSHOTS, 'set CAPTURE_SCREENSHOTS=1 to capture');
  const dir = 'test-results/accounts-screenshots';
  // Let the settle animation finish so screenshots show the resting layout.
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: `${dir}/${info.project.name}-${name}.png`, fullPage: true }); };
  await mockAccount(page, { user: { email }, items: seedItems() });
  await page.goto('/library');
  await expect(page.locator('#library-list li')).toHaveCount(2);
  await shot('library-list');
  await page.getByRole('link', { name: /Newest unread brief/ }).click();
  await expect(page.locator('#result-title')).toBeVisible();
  await shot('library-item');
  await page.goto('/');
  await generate(page);
  await shot('result-save');
  await page.locator('#account-menu summary').click();
  await shot('account-menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await shot('result-saved');
  await page.goto('/library?item=3');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await shot('delete-confirm');
  await mockAccount(page);
  await page.goto('/');
  await page.locator('#sign-in-button').click();
  await shot('auth-signin');
  await page.getByRole('dialog').getByRole('button', { name: 'Create an account' }).click();
  await page.getByRole('dialog').getByLabel('Email').fill('bad');
  await page.getByRole('dialog').locator('#auth-submit').click();
  await shot('auth-signup-error');
});
