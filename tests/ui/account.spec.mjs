import { test, expect } from '@playwright/test';
import { setupPage, mockAccount, makeItem, accountPassword, invalidLink, forgotMessage } from './helpers.mjs';

const email = 'reader@example.com';
const unverified = { email, emailVerified: false };

test.beforeEach(async ({ page }, info) => {
  await setupPage(page, info);
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
});
test.afterEach(({ page }) => { expect(page.errors).toEqual([]); });

const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const posts = (account, path) => account.requests.filter(request => request.path === path);

test('the verify banner shows only for unverified accounts and Resend confirms inline', async ({ page }) => {
  const account = await mockAccount(page, { user: unverified });
  await page.goto('/');
  const banner = page.locator('#verify-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Verify your email to keep your account recoverable.');
  await page.getByRole('button', { name: 'Resend email' }).click();
  await expect(banner.getByText('Sent — check your inbox')).toBeVisible();
  await expect(banner.getByText('Sent — check your inbox')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Resend email' })).toBeHidden();
  expect(posts(account, '/api/auth/verify/resend')).toHaveLength(1);
  expect(posts(account, '/api/auth/verify/resend')[0].body).toEqual({});
  expect(posts(account, '/api/auth/verify/resend')[0].contentType).toContain('application/json');
  expect(await noOverflow(page)).toBe(true);
});

test('the banner appears on the library and account views and stays away from verified and signed-out users', async ({ page }) => {
  await mockAccount(page, { user: unverified, items: [makeItem('1')] });
  await page.goto('/library');
  await expect(page.locator('#verify-banner')).toBeVisible();
  await page.goto('/account');
  await expect(page.locator('#verify-banner')).toBeVisible();
  await page.goto('/s/75aad086-16f5-47f3-a449-9a3fd1d2e878');
  await expect(page.locator('#result-title')).toBeVisible();
  await expect(page.locator('#verify-banner')).toBeHidden();
});

test('no banner for a verified account or when signed out', async ({ page }) => {
  const account = await mockAccount(page, { user: { email } });
  await page.goto('/');
  await expect(page.locator('#account-menu')).toBeVisible();
  await expect(page.locator('#verify-banner')).toBeHidden();
  account.user = null;
  await page.reload();
  await expect(page.locator('#sign-in-button')).toBeVisible();
  await expect(page.locator('#verify-banner')).toBeHidden();
});

test('Resend reports a failure and keeps the button; a signed-out session ends cleanly', async ({ page }) => {
  let calls = 0;
  const account = await mockAccount(page, {
    user: unverified,
    respond: { '/api/auth/verify/resend': () => (++calls === 1 ? { status: 429, json: { error: 'Too many requests. Try again later.' } } : undefined) },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Resend email' }).click();
  await expect(page.locator('#verify-banner-note')).toHaveText('Too many requests. Try again later.');
  await expect(page.getByRole('button', { name: 'Resend email' })).toBeVisible();
  account.user = null;
  await page.getByRole('button', { name: 'Resend email' }).click();
  await expect(page.locator('#verify-banner')).toBeHidden();
  await expect(page.locator('#sign-in-button')).toBeVisible();
});

test('forgot password sends email and a Turnstile token and always ends in the generic confirmation', async ({ page }) => {
  const account = await mockAccount(page);
  await page.goto('/');
  await page.locator('#sign-in-button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('dialog', { name: 'Reset password' })).toBeVisible();
  await expect(dialog.getByLabel('Password')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Forgot password?' })).toBeHidden();
  await dialog.getByLabel('Email').fill('not-an-email');
  await dialog.locator('#auth-submit').click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a valid email address.');
  expect(account.requests).toEqual([]);
  await dialog.getByLabel('Email').fill(email);
  await dialog.locator('#auth-submit').click();
  await expect(page.getByRole('dialog', { name: 'Check your email' })).toBeVisible();
  await expect(dialog.locator('#auth-done-message')).toHaveText(forgotMessage);
  await expect(dialog.locator('#auth-done-message')).toBeFocused();
  const [request] = posts(account, '/api/auth/password/forgot');
  expect(request.body).toEqual({ email, turnstileToken: 'auth-token' });
  expect(request.contentType).toContain('application/json');
  expect(await page.evaluate(() => window.__authVerification.action)).toBe('auth');
  await dialog.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('dialog', { name: 'Sign in' })).toBeVisible();
  await expect(dialog.getByLabel('Email')).toHaveValue(email);
  await expect(dialog.getByLabel('Password')).toBeVisible();
});

test('a duplicate signup offers inline Sign in and Reset password actions', async ({ page }) => {
  const message = 'An account with this email already exists. Sign in or reset your password.';
  const account = await mockAccount(page, {
    authResponse: (body, state) => (state.requests.at(-1).path === '/api/auth/signup' ? { status: 409, json: { error: message } } : undefined),
  });
  await page.goto('/');
  await page.locator('#sign-in-button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create an account' }).click();
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(accountPassword);
  await dialog.locator('#auth-submit').click();
  await expect(dialog.getByRole('alert')).toHaveText(message);
  const signIn = dialog.locator('#auth-error-signin');
  const reset = dialog.locator('#auth-error-reset');
  await expect(signIn).toBeVisible();
  await expect(reset).toBeVisible();

  await reset.click();
  await expect(page.getByRole('dialog', { name: 'Reset password' })).toBeVisible();
  await expect(dialog.getByLabel('Email')).toHaveValue(email);
  await expect(dialog.getByLabel('Email')).toBeFocused();
  await expect(signIn).toBeHidden();
  await dialog.locator('#auth-switch').click();
  await dialog.locator('#auth-switch').click();
  await dialog.getByLabel('Password').fill(accountPassword);
  await dialog.locator('#auth-submit').click();
  await expect(dialog.getByRole('alert')).toHaveText(message);

  await signIn.click();
  await expect(page.getByRole('dialog', { name: 'Sign in' })).toBeVisible();
  await expect(dialog.getByLabel('Email')).toHaveValue(email);
  await expect(dialog.getByLabel('Password')).toBeFocused();
  await expect(dialog.locator('#auth-error')).toBeHidden();
  await expect(signIn).toBeHidden();
  expect(posts(account, '/api/auth/signup')).toHaveLength(2);
});

test('/?auth=forgot opens the forgot dialog when signed out and strips the param', async ({ page }) => {
  await mockAccount(page);
  await page.goto('/?auth=forgot&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D38vwjWpHFes');
  await expect(page.getByRole('dialog', { name: 'Reset password' })).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Email')).toBeFocused();
  expect(new URL(page.url()).search).toBe('?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D38vwjWpHFes');
  await expect(page.getByLabel('YouTube URL', { exact: true })).toHaveValue('https://www.youtube.com/watch?v=38vwjWpHFes');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('#sign-in-button')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('/?auth=forgot only strips the param when already signed in', async ({ page }) => {
  await mockAccount(page, { user: { email } });
  await page.goto('/?auth=forgot');
  await expect(page.locator('#account-menu')).toBeVisible();
  await expect(page.locator('#auth-dialog')).not.toHaveAttribute('open', '');
  expect(new URL(page.url()).search).toBe('');
});

test('/verify strips the token, posts it, and shows success', async ({ page }) => {
  const account = await mockAccount(page, { user: unverified });
  await page.goto('/verify?token=good-token');
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeFocused();
  const [request] = posts(account, '/api/auth/verify');
  expect(request.body).toEqual({ token: 'good-token' });
  expect(request.contentType).toContain('application/json');
  // The token left the address bar before the request went out.
  expect(request.pageSearch).toBe('');
  expect(new URL(page.url()).search).toBe('');
  await expect(page.locator('#verify-banner')).toBeHidden();
  await page.getByRole('link', { name: 'Continue to library' }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('#verify-banner')).toBeHidden();
});

test('/verify with a bad or missing token shows the invalid state; signed-in users can resend', async ({ page }) => {
  const account = await mockAccount(page, { user: unverified });
  await page.goto('/verify?token=stale-token');
  await expect(page.getByRole('heading', { name: 'This link didn’t work' })).toBeVisible();
  await expect(page.locator('#verify-detail')).toContainText(invalidLink);
  expect(posts(account, '/api/auth/verify')[0].pageSearch).toBe('');
  await page.getByRole('button', { name: 'Resend email' }).click();
  await expect(page.locator('#verify-detail')).toContainText('Sent — check your inbox');
  expect(posts(account, '/api/auth/verify/resend')).toHaveLength(1);

  const before = posts(account, '/api/auth/verify').length;
  await page.goto('/verify');
  await expect(page.getByRole('heading', { name: 'This link didn’t work' })).toBeVisible();
  expect(posts(account, '/api/auth/verify')).toHaveLength(before);
});

test('/verify invalid while signed out offers Sign in', async ({ page }) => {
  await mockAccount(page, { authResponse: (body, state) => { state.user = { email: body.email, emailVerified: false }; return { json: { user: state.user } }; } });
  await page.goto('/verify?token=stale-token');
  await expect(page.getByRole('heading', { name: 'This link didn’t work' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resend email' })).toBeHidden();
  await page.locator('#verify-sign-in').click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(accountPassword);
  await dialog.locator('#auth-submit').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Resend email' })).toBeVisible();
});

test('/verify can retry after a transient failure', async ({ page }) => {
  let calls = 0;
  await mockAccount(page, { respond: { '/api/auth/verify': () => (++calls === 1 ? { status: 503, json: { error: 'Try again in a moment.' } } : undefined) } });
  await page.goto('/verify?token=good-token');
  await expect(page.getByRole('heading', { name: 'Could not verify your email' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
});

test('/reset-password strips the token, signs in, and lands on the library', async ({ page }) => {
  const account = await mockAccount(page, { items: [makeItem('1', { title: 'Welcome back brief' })] });
  await page.goto('/reset-password?token=reset-token');
  expect(new URL(page.url()).search).toBe('');
  const field = page.locator('#reset-password');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('autocomplete', 'new-password');
  await expect(field).toHaveAttribute('minlength', '8');
  await field.fill('short');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 8 characters');
  expect(account.requests).toEqual([]);
  await field.fill('a brand new passphrase');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByText('Welcome back brief')).toBeVisible();
  await expect(page.locator('#account-menu')).toBeVisible();
  const [request] = posts(account, '/api/auth/password/reset');
  expect(request.body).toEqual({ token: 'reset-token', password: 'a brand new passphrase' });
  expect(request.contentType).toContain('application/json');
  expect(request.pageSearch).toBe('');
});

test('/reset-password with an invalid link offers a new one through the forgot flow', async ({ page }) => {
  const account = await mockAccount(page);
  await page.goto('/reset-password?token=stale');
  await page.locator('#reset-password').fill('a brand new passphrase');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('heading', { name: 'This link didn’t work' })).toBeVisible();
  await expect(page.locator('#reset-invalid-detail')).toContainText(invalidLink);
  await expect(page.locator('#reset-password')).toBeHidden();
  await page.getByRole('button', { name: 'Request a new link' }).click();
  // Unnamed: the dialog title changes to "Check your email" once the request completes.
  const dialog = page.getByRole('dialog');
  await expect(page.getByRole('dialog', { name: 'Reset password' })).toBeVisible();
  await dialog.getByLabel('Email').fill(email);
  await dialog.locator('#auth-submit').click();
  await expect(dialog.locator('#auth-done-message')).toHaveText(forgotMessage);
  expect(posts(account, '/api/auth/password/forgot')).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Request a new link' })).toBeFocused();
});

test('/reset-password without a token goes straight to the invalid state', async ({ page }) => {
  const account = await mockAccount(page);
  await page.goto('/reset-password');
  await expect(page.getByRole('heading', { name: 'This link didn’t work' })).toBeVisible();
  expect(account.requests).toEqual([]);
});

test('/account shows the email and status and is reached from the account menu', async ({ page }) => {
  await mockAccount(page, { user: unverified });
  await page.goto('/');
  await page.locator('#account-menu summary').click();
  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Account', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('#account-page-email')).toHaveText(email);
  await expect(page.locator('#account-page-status')).toHaveText('Not verified');
  await expect(page.locator('#current-password')).toHaveAttribute('autocomplete', 'current-password');
  await expect(page.locator('#new-password')).toHaveAttribute('autocomplete', 'new-password');
  expect(await noOverflow(page)).toBe(true);
});

test('/account change password reports a wrong current password, then succeeds', async ({ page }) => {
  const account = await mockAccount(page, { user: { email } });
  await page.goto('/account');
  await expect(page.locator('#account-page-status')).toHaveText('Verified');
  const form = page.locator('#password-form');
  await form.getByLabel('Current password').fill('definitely wrong');
  await form.getByLabel('New password').fill('a brand new passphrase');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.getByRole('alert')).toHaveText('Current password is incorrect.');
  await expect(form.getByLabel('Current password')).toBeFocused();
  await form.getByLabel('Current password').fill(accountPassword);
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('#password-success')).toHaveText('Password changed.');
  await expect(form.getByRole('alert')).toBeHidden();
  await expect(form.getByLabel('Current password')).toHaveValue('');
  const changes = posts(account, '/api/auth/password/change');
  expect(changes.map(request => request.body)).toEqual([
    { currentPassword: 'definitely wrong', newPassword: 'a brand new passphrase' },
    { currentPassword: accountPassword, newPassword: 'a brand new passphrase' },
  ]);
  expect(changes[0].contentType).toContain('application/json');
  expect(account.password).toBe('a brand new passphrase');
});

test('/account change password validates before sending', async ({ page }) => {
  const account = await mockAccount(page, { user: { email } });
  await page.goto('/account');
  const form = page.locator('#password-form');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.getByRole('alert')).toHaveText('Enter your current password.');
  await form.getByLabel('Current password').fill(accountPassword);
  await form.getByLabel('New password').fill('short');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.getByRole('alert')).toContainText('at least 8 characters');
  await expect(form.getByLabel('New password')).toBeFocused();
  expect(account.requests.filter(request => request.method !== 'GET')).toEqual([]);
});

test('/account delete: Cancel keeps the account, confirm signs out and returns to /', async ({ page }) => {
  const account = await mockAccount(page, { user: { email }, items: [makeItem('1')] });
  await page.goto('/account');
  const form = page.locator('#delete-form');
  await form.getByRole('button', { name: 'Delete account…' }).click();
  await expect(form.getByRole('alert')).toHaveText('Enter your password to delete your account.');
  await form.getByLabel('Password').fill(accountPassword);
  await form.getByRole('button', { name: 'Delete account…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('all of your saved briefs will be permanently removed');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(form.getByRole('button', { name: 'Delete account…' })).toBeFocused();
  expect(posts(account, '/api/account/delete')).toHaveLength(0);
  expect(account.user).not.toBeNull();

  await form.getByRole('button', { name: 'Delete account…' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(posts(account, '/api/account/delete')).toHaveLength(0);

  await form.getByRole('button', { name: 'Delete account…' }).click();
  await dialog.getByRole('button', { name: 'Delete account' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#sign-in-button')).toBeVisible();
  await expect(page.locator('#account-menu')).toBeHidden();
  const [request] = posts(account, '/api/account/delete');
  expect(request.body).toEqual({ password: accountPassword });
  expect(request.contentType).toContain('application/json');
  expect(account.user).toBeNull();
});

test('/account delete with a wrong password closes the dialog and shows the error on the field', async ({ page }) => {
  const account = await mockAccount(page, { user: { email } });
  await page.goto('/account');
  const form = page.locator('#delete-form');
  await form.getByLabel('Password').fill('not my password');
  await form.getByRole('button', { name: 'Delete account…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(form.getByRole('alert')).toHaveText('Password is incorrect.');
  await expect(form.getByLabel('Password')).toBeFocused();
  await expect(page.locator('#account-menu')).toBeVisible();
  expect(account.user).not.toBeNull();
});

test('signed-out /account prompts to sign in and then shows the settings', async ({ page }) => {
  await mockAccount(page);
  await page.goto('/account');
  await expect(page.getByText('Sign in to manage your account')).toBeVisible();
  await expect(page.locator('#account-settings')).toBeHidden();
  await page.locator('#account-sign-in').click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(accountPassword);
  await dialog.locator('#auth-submit').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#account-page-email')).toHaveText(email);
  await expect(page.locator('#account-title')).toBeFocused();
  await page.locator('#account-menu summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Sign in to manage your account')).toBeVisible();
  await expect(page.locator('#account-settings')).toBeHidden();
});

// Opt-in visual review: CAPTURE_SCREENSHOTS=1 npx playwright test tests/ui/account.spec.mjs -g screenshots
test('captures account screenshots for visual review', async ({ page }, info) => {
  test.skip(!process.env.CAPTURE_SCREENSHOTS, 'Set CAPTURE_SCREENSHOTS=1 to capture screenshots.');
  const shot = name => page.screenshot({ path: `test-results/accounts-screenshots/${info.project.name}-${name}.png`, fullPage: true });
  const account = await mockAccount(page, { user: unverified });
  await page.goto('/');
  await expect(page.locator('#verify-banner')).toBeVisible();
  await shot('banner');

  account.user = null;
  await page.reload();
  await page.locator('#sign-in-button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Forgot password?' }).click();
  await shot('forgot');
  await dialog.getByLabel('Email').fill(email);
  await dialog.locator('#auth-submit').click();
  await expect(dialog.locator('#auth-done-message')).toBeVisible();
  await shot('forgot-sent');
  await page.keyboard.press('Escape');

  account.user = { email, emailVerified: false };
  await page.goto('/verify?token=good-token');
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await shot('verify-success');

  await page.goto('/reset-password?token=reset-token');
  await expect(page.locator('#reset-password')).toBeVisible();
  await shot('reset-form');

  account.user = { email, emailVerified: false };
  await page.goto('/account');
  await expect(page.locator('#account-page-email')).toHaveText(email);
  await page.locator('#delete-password').fill(accountPassword);
  await shot('account');
  await page.getByRole('button', { name: 'Delete account…' }).click();
  await shot('delete-dialog');
});
