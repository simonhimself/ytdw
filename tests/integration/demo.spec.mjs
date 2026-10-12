import { chromium, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TURNSTILE_SCRIPT, startHarness } from './support.mjs';

// Opt-in demo recording of the accounts + library feature: ONE continuous story against the real
// Worker (same harness as accounts/recovery specs), recorded as video with caption overlays.
//
//   RECORD_DEMO=1 npx playwright test -c tests/integration/playwright.config.mjs demo.spec.mjs --project=desktop
//   RECORD_DEMO=1 npx playwright test -c tests/integration/playwright.config.mjs demo.spec.mjs --project=mobile
//
// Output: recordings/ytdw-accounts-demo-<project>.webm (+ .steps.json with step timestamps).
// Skipped unless RECORD_DEMO=1, so `npm run test:integration` is unaffected.
test.skip(!process.env.RECORD_DEMO, 'demo recording is opt-in: set RECORD_DEMO=1');

const SLOW_MO = Number(process.env.DEMO_SLOWMO || 300);
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const recordingsDir = fileURLToPath(new URL('../../recordings/', import.meta.url));

const email = 'Alex.Reader@Example.com';
const password = 'correct horse battery';
const nextPassword = 'brand new passphrase';
const finalPassword = 'third time lucky pass';
const firstVideo = 'dQw4w9WgXcQ';
const secondVideo = 'jNQXAC9IVRw';

const escapeHtml = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

test('record accounts + library demo', async ({}, info) => {
  test.setTimeout(10 * 60 * 1000);
  const project = info.project.name;
  const mobile = project === 'mobile';
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  await mkdir(recordingsDir, { recursive: true });
  const videoTmp = await mkdtemp(`${tmpdir()}/ytdw-demo-`);

  const { h, origin } = await startHarness();
  const browser = await chromium.launch({
    slowMo: SLOW_MO,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync(systemChrome) ? systemChrome : undefined),
  });
  const context = await browser.newContext({ viewport, baseURL: origin, recordVideo: { dir: videoTmp, size: viewport } });
  const page = await context.newPage();
  const started = Date.now();
  const steps = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?*', route => route.fulfill({ contentType: 'application/javascript', body: TURNSTILE_SCRIPT }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  // Caption overlay: a fixed, non-interactive banner at the bottom, repainted after every document load
  // (the whole story runs in one page so it ends up in one video file).
  let current = null;
  const paint = (caption) => page.evaluate(({ title, detail, isMobile }) => {
    document.getElementById('demo-caption')?.remove();
    const bar = document.createElement('div');
    bar.id = 'demo-caption';
    bar.setAttribute('aria-hidden', 'true');
    Object.assign(bar.style, {
      position: 'fixed', left: '0', right: '0', bottom: '0', zIndex: '2147483647', pointerEvents: 'none',
      background: '#0b1220', color: '#fff', borderTop: '4px solid #facc15', boxSizing: 'border-box',
      padding: isMobile ? '10px 14px' : '16px 28px', fontFamily: 'system-ui, -apple-system, sans-serif', lineHeight: '1.3',
    });
    const heading = document.createElement('div');
    heading.textContent = title;
    Object.assign(heading.style, { fontSize: isMobile ? '17px' : '28px', fontWeight: '700', color: '#facc15' });
    bar.append(heading);
    if (detail) {
      const sub = document.createElement('div');
      sub.textContent = detail;
      Object.assign(sub.style, { fontSize: isMobile ? '13px' : '19px', marginTop: '4px', color: '#e5e7eb' });
      bar.append(sub);
    }
    document.documentElement.append(bar);
    // Modal <dialog> backdrops live in the top layer and would dim the caption; a manual popover joins the
    // top layer too, and re-showing it periodically keeps it above any dialog opened later.
    clearInterval(window.__demoCaptionTimer);
    if (typeof bar.showPopover === 'function') {
      bar.popover = 'manual';
      Object.assign(bar.style, { inset: 'auto', top: 'auto', left: '0', right: '0', bottom: '0', width: '100%', height: 'auto', margin: '0', overflow: 'visible', border: '0', borderTop: '4px solid #facc15' });
      const raise = () => { try { if (bar.matches(':popover-open')) bar.hidePopover(); bar.showPopover(); } catch {} };
      raise();
      window.__demoCaptionTimer = setInterval(raise, 300);
    }
  }, { ...caption, isMobile: mobile }).catch(() => {});
  page.on('domcontentloaded', () => { if (current) paint(current); });
  const step = async (title, detail = '') => {
    current = { title, detail };
    steps.push({ title, atSeconds: Math.round((Date.now() - started) / 100) / 10 });
    await paint(current);
    await pause(1800);
  };
  const pause = (ms = 1200) => page.waitForTimeout(ms);
  const type = async (selector, text) => { await page.locator(selector).click(); await page.locator(selector).pressSequentially(text, { delay: 45 }); };

  // Emails go out after the response, so wait for them to land.
  const emailFor = async (subjectPrefix, count = 1) => {
    await expect.poll(async () => (await h.emails()).filter(m => m.to === email.toLowerCase() && m.subject.startsWith(subjectPrefix)).length).toBe(count);
    return (await h.emails()).filter(m => m.to === email.toLowerCase() && m.subject.startsWith(subjectPrefix)).at(-1);
  };

  // "Show" a captured email inside the same recorded page, then click its (rewritten) link.
  const readEmail = async (message, linkLabel) => {
    const match = message.text.match(/https:\/\/ytdw\.fyi(\/\S*)/);
    expect(match, `link in ${message.subject}`).toBeTruthy();
    const href = `${origin}${match[1]}`;
    const body = escapeHtml(message.text).replace(/https:\/\/ytdw\.fyi\/\S*/g, `<a id="mail-link" href="${href}">${linkLabel}</a>`);
    await page.goto('about:blank');
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inbox</title></head>
      <body style="margin:0;background:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;color:#111827">
        <div style="max-width:720px;margin:${mobile ? '12px auto' : '56px auto'};padding:0 ${mobile ? '10px' : '0'}">
          <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:8px">Inbox · captured by the mock email binding</div>
          <div style="background:#fff;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.15);overflow:hidden">
            <div style="padding:${mobile ? '14px' : '20px 28px'};background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:${mobile ? '13px' : '16px'};line-height:1.7">
              <div><b>From:</b> ${escapeHtml(message.from.name)} &lt;${escapeHtml(message.from.email)}&gt;</div>
              <div><b>To:</b> ${escapeHtml(message.to)}</div>
              <div style="font-size:${mobile ? '16px' : '20px'}"><b>Subject:</b> ${escapeHtml(message.subject)}</div>
            </div>
            <pre style="margin:0;padding:${mobile ? '14px' : '24px 28px'};white-space:pre-wrap;word-break:break-word;font:${mobile ? '14px' : '17px'}/1.6 system-ui,-apple-system,sans-serif">${body}</pre>
          </div>
        </div>
        <style>#mail-link{background:#facc15;color:#111;padding:2px 10px;border-radius:6px;font-weight:700;text-decoration:underline}</style>
      </body></html>`);
    await paint(current);
    await pause(4000);
    await page.locator('#mail-link').click();
  };

  const signOut = async () => {
    await page.locator('#account-menu summary').click();
    await pause(600);
    await page.locator('#sign-out-button').click();
    await expect(page.locator('#sign-in-button')).toBeVisible();
  };
  const openSignIn = async () => {
    await page.locator('#sign-in-button').click();
    await expect(page.locator('#auth-dialog')).toBeVisible();
  };

  try {
    // ── 1. Summarize ────────────────────────────────────────────────────────────────────────────
    await page.goto('/');
    await expect(page.locator('#sign-in-button')).toBeVisible();
    await step('Step 1 — Summarize a video', 'Paste a YouTube URL and press Summarize. No account needed.');
    await type('#youtube-url', `https://www.youtube.com/watch?v=${firstVideo}`);
    await pause(500);
    await page.locator('#submit-button').click();
    await expect(page.locator('#result')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#result-title')).toHaveText(`Fixture ${firstVideo}`);
    await expect(page.locator('#save-button')).toBeEnabled();
    await pause(2500);

    // ── 2. Save while signed out → create account ───────────────────────────────────────────────
    await step('Step 2 — Save while signed out', 'Save opens “Create account”. Once the account exists, the brief is saved automatically.');
    await page.locator('#save-button').click();
    await expect(page.locator('#auth-dialog')).toBeVisible();
    await pause(1200);
    await page.locator('#auth-switch').click();
    await expect(page.locator('#auth-submit')).toHaveText('Create account');
    await type('#auth-email', email);
    await type('#auth-password', password);
    await pause(500);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#auth-dialog')).toBeHidden();
    await expect(page.locator('#save-button')).toHaveText('Saved');
    await expect(page.locator('#library-badge')).toHaveText('1');
    await pause(2500);

    // ── 3. Verify email ─────────────────────────────────────────────────────────────────────────
    await step('Step 3 — Verify email', 'A banner asks to verify the address. The email arrives in the inbox…');
    await expect(page.locator('#verify-banner')).toBeVisible();
    await pause(2500);
    const verifyMail = await emailFor('Verify your email');
    current = { title: 'Step 3 — Verify email', detail: 'The verification email (captured from the mock mailer). Clicking its link…' };
    await readEmail(verifyMail, 'Verify my email');
    await expect(page.locator('#verify-title')).toHaveText('Email verified');
    await pause(2500);
    await page.goto('/');
    await expect(page.locator('#account-menu')).toBeVisible();
    await expect(page.locator('#verify-banner')).toBeHidden();
    current = { title: 'Step 3 — Verify email', detail: 'Email verified — the banner is gone.' };
    await paint(current);
    await pause(2500);

    // ── 4. Library: Unread → open → Mark as read → All ──────────────────────────────────────────
    await step('Step 4 — Library', 'Unread tab → open the brief → Mark as read → All tab.');
    await page.locator('#library-link').click();
    await expect(page.locator('#library-list li')).toHaveCount(1);
    await expect(page.locator('#tab-unread .library-tab__count')).toHaveText('1');
    await pause(2500);
    await page.locator('#library-list li a, #library-list li button').first().click();
    await expect(page.locator('#result-title')).toHaveText(`Fixture ${firstVideo}`);
    await expect(page.locator('#read-button')).toHaveText('Mark as read');
    await pause(2500);
    await page.locator('#read-button').click();
    await expect(page.locator('#read-button')).toHaveText('Mark as unread');
    await expect(page.locator('#library-badge')).toBeHidden();
    await pause(1500);
    await page.locator('#library-back').click();
    await expect(page.locator('#tab-unread .library-tab__count')).toHaveText('0');
    await pause(1500);
    await page.locator('#tab-all').click();
    await expect(page.locator('#library-list li')).toHaveCount(1);
    await pause(2000);

    // ── 5. Second brief from a share link ───────────────────────────────────────────────────────
    await step('Step 5 — Save from a share link', 'Anyone can open a shared brief (/s/…) and save it to their library.');
    const response = await page.request.post('/api/summarize', { data: { url: `https://youtu.be/${secondVideo}`, turnstileToken: 'fixture-token' } });
    expect(response.status()).toBe(200);
    const brief = await response.json();
    expect(brief.share.url).toMatch(/^\/s\/[0-9a-f-]{36}$/);
    await page.goto(brief.share.url);
    await expect(page.locator('#result-title')).toHaveText(`Fixture ${secondVideo}`);
    await pause(2500);
    await expect(page.locator('#save-button')).toBeEnabled();
    await page.locator('#save-button').click();
    await expect(page.locator('#save-button')).toHaveText('Saved');
    await expect(page.locator('#library-badge')).toHaveText('1');
    await pause(2500);

    // Natural spot for the theme switch: browsing the library with two items.
    await step('Dark mode', 'Library with two briefs — switching theme once.');
    await page.locator('#library-link').click();
    // Unread shows only the new brief; All shows both.
    await expect(page.locator('#library-list li')).toHaveCount(1);
    await expect(page.locator('#tab-all .library-tab__count')).toHaveText('2');
    await pause(1500);
    await page.locator('#tab-all').click();
    await expect(page.locator('#library-list li')).toHaveCount(2);
    await pause(2000);
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await pause(3500);

    // ── 6. Sign out → forgot password → reset ───────────────────────────────────────────────────
    await step('Step 6 — Forgot password', 'Sign out, then request a reset link. The confirmation is generic on purpose.');
    await signOut();
    await openSignIn();
    await page.locator('#auth-forgot').click();
    await expect(page.locator('#auth-title')).toHaveText('Reset password');
    await type('#auth-email', email);
    await pause(500);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#auth-done')).toBeVisible();
    await expect(page.locator('#auth-done-message')).toHaveText(/If that address has an account, we.ve sent a link to reset the password\./);
    await pause(3000);
    const resetMail = await emailFor('Reset your YT;DW password');
    await page.locator('#auth-close').click();
    current = { title: 'Step 6 — Forgot password', detail: 'The reset email arrives. Clicking its link…' };
    await readEmail(resetMail, 'Reset my password');
    await expect(page.locator('#reset-form')).toBeVisible();
    await pause(1500);
    await type('#reset-password', nextPassword);
    await pause(500);
    await page.locator('#reset-submit').click();
    await expect(page).toHaveURL(`${origin}/library`);
    await expect(page.locator('#account-menu')).toBeVisible();
    current = { title: 'Step 6 — Forgot password', detail: 'New password set — landed in the library, signed in.' };
    await paint(current);
    await pause(3000);

    await step('Step 6b — Old password rejected, new one accepted', 'Sign out and try the old password first.');
    await signOut();
    await openSignIn();
    await type('#auth-email', email);
    await type('#auth-password', password);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#auth-error')).toHaveText('Email or password is incorrect.');
    await pause(3000);
    await page.locator('#auth-password').fill('');
    await type('#auth-password', nextPassword);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#auth-dialog')).toBeHidden();
    await expect(page.locator('#account-menu')).toBeVisible();
    await pause(2500);

    // ── 7. Change password ──────────────────────────────────────────────────────────────────────
    await step('Step 7 — Change password', 'Account page → current + new password.');
    await page.locator('#account-menu summary').click();
    await pause(600);
    await page.locator('#account-link').click();
    await expect(page).toHaveURL(`${origin}/account`);
    await expect(page.locator('#account-page-status')).toHaveText('Verified');
    await pause(2000);
    await type('#current-password', nextPassword);
    await type('#new-password', finalPassword);
    await pause(500);
    await page.locator('#password-submit').click();
    await expect(page.locator('#password-success')).toHaveText('Password changed.');
    await pause(3000);

    // ── 8. Delete account ───────────────────────────────────────────────────────────────────────
    await step('Step 8 — Delete account', 'Confirm with the password. The account and its library are erased.');
    await type('#delete-password', finalPassword);
    await pause(500);
    await page.locator('#delete-submit').click();
    await expect(page.locator('#delete-account-dialog')).toBeVisible();
    await pause(2500);
    await page.locator('#delete-account-confirm').click();
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.locator('#sign-in-button')).toBeVisible();
    await pause(2500);
    current = { title: 'Step 8 — Delete account', detail: 'Signed out on the home page. Signing in again must now fail.' };
    await paint(current);
    await openSignIn();
    await type('#auth-email', email);
    await type('#auth-password', finalPassword);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#auth-error')).toHaveText('Email or password is incorrect.');
    await pause(3500);
    await step('Done', 'Accounts + library: sign up, save, verify, reset, change password, delete.');
    await pause(1500);

    expect(pageErrors).toEqual([]);
  } finally {
    const video = page.video();
    const out = `${recordingsDir}ytdw-accounts-demo-${project}.webm`;
    await context.close();
    await video.saveAs(out);
    await browser.close();
    await h.mf.dispose();
    await writeFile(`${recordingsDir}ytdw-accounts-demo-${project}.steps.json`, JSON.stringify(steps, null, 2));
    console.log(`demo video: ${out}\nsteps: ${JSON.stringify(steps)}`);
  }
});
