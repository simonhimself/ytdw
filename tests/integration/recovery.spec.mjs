import { expect, test } from '@playwright/test';
import { newPage as openPage, startHarness } from './support.mjs';

// Phase 1b end to end: email verification, password reset, duplicate-signup notice,
// change password, and account deletion. The Worker, D1, cookies, and frontend are real; email
// is captured by the harness's mocked EMAIL binding and the links in it are opened in the browser.
let h;
let origin;
test.beforeAll(async () => { ({ h, origin } = await startHarness()); });
test.afterAll(async () => { await h?.mf.dispose(); });

test.describe.configure({ mode: 'serial' });

const newPage = (browser, project) => openPage(browser, project, origin);

// Addresses are per project and per test: the Worker allows only 3 emails per address per hour,
// and each test below is budgeted to stay within that.
const account = (project, name) => ({ email: `${name}.${project}@example.com`, password: 'correct horse battery', next: 'brand new passphrase' });

const emailsFor = async (email, subject) => (await h.emails()).filter(m => m.to === email && m.subject.startsWith(subject));
const VERIFY = 'Verify your email';
const RESET = 'Reset your YT;DW password';
const NOTICE = 'Someone tried to create';

// Emails go out after the response, so wait for them to land.
async function emailsArrive(email, subject, count) {
  await expect.poll(async () => (await emailsFor(email, subject)).length, { message: `${count} "${subject}" email(s) for ${email}` }).toBe(count);
  return emailsFor(email, subject);
}

// The captured link points at the production APP_ORIGIN; keep path + query and browse the harness instead.
function linkOf(message) {
  const match = message.text.match(/https:\/\/ytdw\.fyi(\/\S*)/);
  expect(match, `link in ${message.subject}`).toBeTruthy();
  return match[1];
}

async function signUp(page, { email, password }) {
  await page.goto('/');
  await page.locator('#sign-in-button').click();
  await page.locator('#auth-switch').click();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-dialog')).toBeHidden();
  await expect(page.locator('#account-menu')).toBeVisible();
}

async function signIn(page, email, password) {
  await page.locator('#sign-in-button').click();
  await expect(page.locator('#auth-dialog')).toBeVisible();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
}

async function signOut(page) {
  await page.locator('#account-menu summary').click();
  await page.locator('#sign-out-button').click();
  await expect(page.locator('#sign-in-button')).toBeVisible();
}

// The Worker's view of the cookie in this browser context, independent of what the page rendered.
const whoAmI = (page) => page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user);

test('verify email, reset a forgotten password, and revoke other sessions', async ({ browser }, info) => {
  const { email, password, next } = account(info.project.name, 'recover');
  const { context, page, problems, unexpected, expectStatus } = await newPage(browser, info.project.name);

  // Sign up: signed in, unverified banner on the main view.
  await signUp(page, { email, password });
  await expect(page.locator('#verify-banner')).toBeVisible();
  await expect(page.locator('#verify-banner-resend')).toBeVisible();
  expect(await whoAmI(page)).toEqual({ email: email.toLowerCase(), emailVerified: false });
  const [first] = await emailsArrive(email, VERIFY, 1);
  expect(first.from).toEqual({ email: 'noreply@ytdw.fyi', name: 'YT;DW' });

  // Resend replaces the first link with a second one.
  await page.locator('#verify-banner-resend').click();
  await expect(page.locator('#verify-banner-sent')).toBeVisible();
  await expect(page.locator('#verify-banner-resend')).toBeHidden();
  const verifyEmails = await emailsArrive(email, VERIFY, 2);
  const [staleLink, verifyLink] = verifyEmails.map(linkOf);
  expect(staleLink).toMatch(/^\/verify\?token=[A-Za-z0-9_-]{43}$/);
  expect(verifyLink).not.toBe(staleLink);

  // The replaced link is dead; the page says so and the account stays unverified.
  const stale = await page.goto(staleLink);
  expect(stale.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.locator('#verify-title')).toHaveText('This link didn’t work');
  await expectUrl(page, '/verify');
  expectStatus('400 POST /api/auth/verify');

  // The latest link verifies; the token never stays in the URL.
  const verify = await page.goto(verifyLink);
  expect(verify.status()).toBe(200);
  expect(verify.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.locator('#verify-title')).toHaveText('Email verified');
  await expect(page.locator('#verify-continue')).toBeVisible();
  await expectUrl(page, '/verify');
  expect(await whoAmI(page)).toEqual({ email: email.toLowerCase(), emailVerified: true });

  // Reload does not re-consume anything; the banner is gone on the home view, before and after a reload.
  await page.goto('/');
  await expect(page.locator('#account-menu')).toBeVisible();
  await expect(page.locator('#verify-banner')).toBeHidden();
  await page.reload();
  await expect(page.locator('#account-menu')).toBeVisible();
  await expect(page.locator('#verify-banner')).toBeHidden();

  // A second context signs in with the current password; the reset below must end it.
  const other = await newPage(browser, info.project.name);
  await other.page.goto('/');
  await signIn(other.page, email, password);
  await expect(other.page.locator('#account-menu')).toBeVisible();
  expect(await whoAmI(other.page)).toMatchObject({ emailVerified: true });

  // Forgot password from the sign-in dialog: generic confirmation, one reset email.
  await signOut(page);
  await page.locator('#sign-in-button').click();
  await page.locator('#auth-forgot').click();
  await expect(page.locator('#auth-title')).toHaveText('Reset password');
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-done')).toBeVisible();
  await expect(page.locator('#auth-done-message')).toHaveText(/If that address has an account, we.ve sent a link to reset the password\./);
  const [reset] = await emailsArrive(email, RESET, 1);
  await page.locator('#auth-close').click();

  // The reset link: token stripped, new password signs in and lands on /library.
  const resetLink = linkOf(reset);
  expect(resetLink).toMatch(/^\/reset-password\?token=[A-Za-z0-9_-]{43}$/);
  const resetPage = await page.goto(resetLink);
  expect(resetPage.status()).toBe(200);
  expect(resetPage.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.locator('#reset-form')).toBeVisible();
  await expectUrl(page, '/reset-password');
  await page.locator('#reset-password').fill(next);
  await page.locator('#reset-submit').click();
  await expect(page).toHaveURL(`${origin}/library`);
  await expect(page.locator('#account-menu')).toBeVisible();
  await expect(page.locator('#library-empty')).toBeVisible();
  await expect(page.locator('#verify-banner')).toBeHidden();
  expect(await whoAmI(page)).toEqual({ email: email.toLowerCase(), emailVerified: true });

  // The link is single-use.
  // The page cannot know the token is spent until the form is submitted.
  await page.goto(resetLink);
  await page.locator('#reset-password').fill('another passphrase');
  await page.locator('#reset-submit').click();
  await expect(page.locator('#reset-invalid')).toBeVisible();
  await expect(page.locator('#reset-title')).toHaveText('This link didn’t work');
  expectStatus('400 POST /api/auth/password/reset');

  // The context that was signed in before the reset has been signed out by the server.
  expect(await whoAmI(other.page)).toBeNull();
  await other.page.reload();
  await expect(other.page.locator('#sign-in-button')).toBeVisible();

  // Old password fails with the generic message; the new password works.
  await signIn(other.page, email, password);
  await expect(other.page.locator('#auth-error')).toHaveText('Email or password is incorrect.');
  other.expectStatus('401 POST /api/auth/login');
  await other.page.locator('#auth-password').fill(next);
  await other.page.locator('#auth-submit').click();
  await expect(other.page.locator('#auth-dialog')).toBeHidden();
  await expect(other.page.locator('#account-menu')).toBeVisible();

  for (const p of [{ unexpected, problems }, { unexpected: other.unexpected, problems: other.problems }]) {
    await expect.poll(() => p.unexpected, { message: 'unexpected 4xx/5xx' }).toEqual([]);
    expect(p.problems).toEqual([]);
  }
  await other.context.close();
  await context.close();
});

test('duplicate signup notice, change password, delete account', async ({ browser }, info) => {
  const { email, password, next } = account(info.project.name, 'manage');
  const { context, page, problems, unexpected, expectStatus } = await newPage(browser, info.project.name);

  // Create the account (email 1: verification), then try to sign up again while signed out.
  await signUp(page, { email, password });
  await emailsArrive(email, VERIFY, 1);
  await signOut(page);
  await page.locator('#sign-in-button').click();
  await page.locator('#auth-switch').click();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-error')).toContainText('already exists');
  expectStatus('409 POST /api/auth/signup');
  await expect(page.locator('#auth-error-signin')).toBeVisible();
  await expect(page.locator('#auth-error-reset')).toBeVisible();

  // The inline Reset action switches to forgot mode and keeps the typed address.
  await page.locator('#auth-error-reset').click();
  await expect(page.locator('#auth-title')).toHaveText('Reset password');
  await expect(page.locator('#auth-email')).toHaveValue(email);
  await page.locator('#auth-close').click();

  // The owner is told (email 2: notice). It carries no token; its link opens the dialog in forgot mode.
  const [notice] = await emailsArrive(email, NOTICE, 1);
  expect(notice.text).not.toContain('token=');
  const noticeLink = linkOf(notice);
  expect(noticeLink).toBe('/?auth=forgot');
  const fresh = await newPage(browser, info.project.name);
  await fresh.page.goto(noticeLink);
  await expect(fresh.page.locator('#auth-dialog')).toBeVisible();
  await expect(fresh.page.locator('#auth-title')).toHaveText('Reset password');
  await expect(fresh.page.locator('#auth-password-field')).toBeHidden();
  await expectUrl(fresh.page, '/');
  await fresh.page.reload();
  await expect(fresh.page.locator('#sign-in-button')).toBeVisible();
  await expect(fresh.page.locator('#auth-dialog')).toBeHidden();
  await fresh.context.close();
  // The duplicate attempt did not touch the account: the original password still works.
  await signIn(page, email, password);
  await expect(page.locator('#auth-dialog')).toBeHidden();
  await expect(page.locator('#account-menu')).toBeVisible();

  // A second signed-in context, to prove changing the password signs other devices out.
  const other = await newPage(browser, info.project.name);
  await other.page.goto('/');
  await signIn(other.page, email, password);
  await expect(other.page.locator('#account-menu')).toBeVisible();

  // /account from the menu: unverified status, banner, wrong current password, then success.
  await page.locator('#account-menu summary').click();
  await page.locator('#account-link').click();
  await expect(page).toHaveURL(`${origin}/account`);
  await expect(page.locator('#account-page-email')).toHaveText(email);
  await expect(page.locator('#account-page-status')).toHaveText('Not verified');
  await expect(page.locator('#verify-banner')).toBeVisible();
  await page.locator('#current-password').fill('not my password');
  await page.locator('#new-password').fill(next);
  await page.locator('#password-submit').click();
  await expect(page.locator('#password-error')).toHaveText('Current password is incorrect.');
  expectStatus('403 POST /api/auth/password/change');
  await page.locator('#current-password').fill(password);
  await page.locator('#password-submit').click();
  await expect(page.locator('#password-success')).toHaveText('Password changed.');
  await expect(page.locator('#password-error')).toBeHidden();
  // This session survives, including across a reload; the other one does not.
  await page.reload();
  await expect(page.locator('#account-page-email')).toHaveText(email);
  expect(await whoAmI(other.page)).toBeNull();
  await other.page.reload();
  await expect(other.page.locator('#sign-in-button')).toBeVisible();
  await signIn(other.page, email, password);
  await expect(other.page.locator('#auth-error')).toHaveText('Email or password is incorrect.');
  other.expectStatus('401 POST /api/auth/login');
  await other.page.locator('#auth-password').fill(next);
  await other.page.locator('#auth-submit').click();
  await expect(other.page.locator('#account-menu')).toBeVisible();

  // Delete: a wrong password is refused, cancelling keeps the account, confirming removes it.
  await page.locator('#delete-password').fill('not my password');
  await page.locator('#delete-submit').click();
  await expect(page.locator('#delete-account-dialog')).toBeVisible();
  await page.locator('#delete-account-confirm').click();
  await expect(page.locator('#delete-error')).toHaveText('Password is incorrect.');
  expectStatus('403 POST /api/account/delete');
  await expect(page.locator('#delete-account-dialog')).toBeHidden();
  await page.locator('#delete-password').fill(next);
  await page.locator('#delete-submit').click();
  await expect(page.locator('#delete-account-dialog')).toBeVisible();
  await page.locator('#delete-account-cancel').click();
  await expect(page.locator('#delete-account-dialog')).toBeHidden();
  await page.reload();
  await expect(page.locator('#account-page-email')).toHaveText(email);
  expect(await whoAmI(page)).toMatchObject({ email: email.toLowerCase() });

  await page.locator('#delete-password').fill(next);
  await page.locator('#delete-submit').click();
  await page.locator('#delete-account-confirm').click();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator('#sign-in-button')).toBeVisible();
  expect(await whoAmI(page)).toBeNull();
  // Every session of the deleted account is gone, not only the one that deleted it.
  expect(await whoAmI(other.page)).toBeNull();

  // The credentials no longer work, but the address is free to sign up again.
  await signIn(page, email, next);
  await expect(page.locator('#auth-error')).toHaveText('Email or password is incorrect.');
  expectStatus('401 POST /api/auth/login');
  await page.locator('#auth-switch').click();
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-dialog')).toBeHidden();
  await expect(page.locator('#account-menu')).toBeVisible();
  await expect(page.locator('#verify-banner')).toBeVisible();
  await page.goto('/library');
  await expect(page.locator('#library-empty')).toBeVisible();
  await emailsArrive(email, VERIFY, 2);

  for (const p of [{ unexpected, problems }, { unexpected: other.unexpected, problems: other.problems }]) {
    await expect.poll(() => p.unexpected, { message: 'unexpected 4xx/5xx' }).toEqual([]);
    expect(p.problems).toEqual([]);
  }
  await other.context.close();
  await context.close();
});

// Query strings must not linger after an emailed link is opened.
async function expectUrl(page, path) {
  await expect(page).toHaveURL(`${origin}${path}`);
}
