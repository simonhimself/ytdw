import { expect, test } from '@playwright/test';
import { newPage as openPage, startHarness } from './support.mjs';

// End-to-end check of the background queue (Q1 in TEST_PLAN.md): the real UI, Worker,
// QueueRunner alarms, Coordinator, and local D1. See support.mjs for what is mocked.
let h;
let origin;
test.beforeAll(async () => { ({ h, origin } = await startHarness()); });
test.afterAll(async () => { await h?.mf.dispose(); });

test.describe.configure({ mode: 'serial' });

const flow = (project) => project === 'mobile'
  ? { email: 'queue.mobile@example.com', videos: ['00000000501', '00000000502'] }
  : { email: 'queue.desktop@example.com', videos: ['00000000511', '00000000512'] };

test('a verified user queues several videos and they land in the library unread', async ({ browser }, info) => {
  const { email, videos } = flow(info.project.name);
  const { context, page, problems, unexpected } = await openPage(browser, info.project.name, origin);

  // Sign up from the header; new accounts are unverified and cannot queue yet.
  await page.goto('/');
  await page.locator('#sign-in-button').click();
  await page.locator('#auth-switch').click();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill('correct horse battery');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#account-menu')).toBeVisible();
  await page.locator('#queue-open').click();
  await expect(page.locator('#queue-urls')).toBeDisabled();
  await expect(page.locator('#queue-left')).toHaveText('Verify your email to queue videos.');

  // Verify with the emailed link, then return home.
  let message;
  await expect.poll(async () => (message = (await h.emails()).find(m => m.to === email && m.subject.startsWith('Verify')))).toBeTruthy();
  const token = message.text.match(/token=([A-Za-z0-9_-]{43})/)[1];
  await page.goto(`/verify?token=${token}`);
  await expect(page.locator('#verify-title')).toHaveText('Email verified');
  await page.goto('/');

  await page.locator('#queue-open').click();
  await expect(page.locator('#queue-left')).toHaveText('50 of 50 left today');
  await page.locator('#queue-urls').fill([...videos.map(id => `https://youtu.be/${id}`), 'https://vimeo.com/123'].join('\n'));
  await page.locator('#queue-submit').click();
  await expect(page.locator('#queue-results li')).toHaveText([/Not a YouTube link\s*https:\/\/vimeo.com\/123/]);
  await expect(page.locator('#queue-urls')).toHaveValue('https://vimeo.com/123');
  await page.locator('#queue-cancel').click();

  // The header menu shows progress until both briefs are done, then disappears (it polls every 10s).
  await expect(page.locator('#queue-menu')).toBeVisible();
  await expect(page.locator('#queue-menu')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('#library-badge')).toHaveText('2');
  await page.locator('#library-link').click();
  await expect(page.locator('#library-list li')).toHaveCount(2);
  for (const id of videos) await expect(page.locator('#library-list')).toContainText(`Fixture ${id}`);

  expect(problems).toEqual([]);
  expect(unexpected).toEqual([]);
  await context.close();
});
