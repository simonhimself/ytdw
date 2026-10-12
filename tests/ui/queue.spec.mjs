import { test, expect } from '@playwright/test';
import { setupPage, mockAccount, mockQueue, queueItem, makeItem } from './helpers.mjs';

const user = { email: 'reader@example.com' };
const ids = ['38vwjWpHFes', 'PJrntzMA4iQ', 'dQw4w9WgXcQ', 'aqz-KE-bpKQ', 'M7lc1UVf-VE'];
const link = id => `https://youtu.be/${id}`;
const itemId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test.beforeEach(async ({ page }, info) => {
  await setupPage(page, info);
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
});
test.afterEach(({ page }) => { expect(page.errors).toEqual([]); });

const noHorizontalScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
// The library page only polls while the tab is visible; tests trigger the check directly.
const recheck = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('signed out, the queue link invites sign-up; the header menu only exists for signed-in users', async ({ page }) => {
  const account = await mockAccount(page);
  await mockQueue(page, account);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeVisible();
  await expect(page.locator('#queue-box')).toBeHidden();
  await expect(page.locator('#queue-menu')).toBeHidden();
  const open = page.getByRole('button', { name: 'Queue several videos' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Create account' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#auth-lede')).toHaveText('Create an account to queue several videos. Their briefs land in your library.');
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
  // Signing up continues into the box; new accounts must verify before queuing.
  await open.click();
  await dialog.getByLabel('Email').fill('new@example.com');
  await dialog.getByLabel('Password').fill('correct horse battery');
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#queue-box')).toBeVisible();
  await expect(page.getByLabel('Queue several videos')).toBeDisabled();
  await expect(page.locator('#queue-left')).toHaveText('Verify your email to queue videos.');
  expect(await noHorizontalScroll(page)).toBe(true);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await setupPage(page, test.info());
  const signedIn = await mockAccount(page, { user });
  await mockQueue(page, signedIn);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Queue several videos' })).toBeVisible();
  // Nothing pending: no header menu, and the box is closed.
  await expect(page.locator('#queue-menu')).toBeHidden();
  await expect(page.locator('#queue-box')).toBeHidden();
  // Other pages have no queue box or link.
  await page.goto('/library');
  await expect(page.locator('#queue-toggle')).toBeHidden();
});

test('signed out, a finished brief invites signing in to save it', async ({ page }) => {
  const account = await mockAccount(page);
  await mockQueue(page, account);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.__verification))).toBe(true);
  await page.getByLabel('YouTube URL', { exact: true }).fill(`https://www.youtube.com/watch?v=${ids[0]}`);
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.locator('#result-title')).toHaveText('First video brief');
  const hint = page.locator('#save-hint');
  await expect(hint).toContainText('Keep this brief');
  await expect(hint).toContainText('Sign in to save it to your library and read it later.');
  expect(await noHorizontalScroll(page)).toBe(true);
  await hint.getByRole('button', { name: 'Sign in to save' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await dialog.getByLabel('Email').fill('reader@example.com');
  await dialog.getByLabel('Password').fill('correct horse battery');
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  // Signing in from the hint saves the brief, like the Save button does.
  await expect(page.locator('#save-button')).toHaveText('Saved');
  await expect(hint).toBeHidden();
});

test('the box opens on demand, counts lines, and closes with Cancel or Escape', async ({ page }) => {
  const account = await mockAccount(page, { user });
  await mockQueue(page, account, { used: 6 });
  await page.goto('/');
  const open = page.getByRole('button', { name: 'Queue several videos' });
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await open.click();
  const box = page.getByLabel('Queue several videos');
  await expect(box).toBeFocused();
  await expect(open).toBeHidden();
  await expect(page.locator('#queue-left')).toHaveText('44 of 50 left today');
  const submit = page.locator('#queue-submit');
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('Add to queue');
  await box.fill(`${link(ids[0])}\n\n  ${link(ids[1])}  \n`);
  await expect(submit).toHaveText('Add 2 to queue');
  await expect(submit).toBeEnabled();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#queue-box')).toBeHidden();
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await open.click();
  await expect(box).toHaveValue(`${link(ids[0])}\n\n  ${link(ids[1])}  \n`);
  await page.keyboard.press('Escape');
  await expect(page.locator('#queue-box')).toBeHidden();
  await expect(open).toBeFocused();
});

test('queuing valid links closes the box and shows progress in the header', async ({ page }) => {
  const account = await mockAccount(page, { user });
  const queue = await mockQueue(page, account);
  await page.goto('/');
  await page.getByRole('button', { name: 'Queue several videos' }).click();
  await page.getByLabel('Queue several videos').fill([link(ids[0]), `https://www.youtube.com/watch?v=${ids[1]}`].join('\n'));
  await page.getByRole('button', { name: 'Add 2 to queue' }).click();
  await expect(page.locator('#queue-box')).toBeHidden();
  await expect(page.locator('#queue-announcement')).toHaveText('2 videos queued. They land in your library when ready.');
  const post = queue.requests.find(r => r.method === 'POST');
  expect(post).toMatchObject({ path: '/api/queue', contentType: 'application/json', body: { urls: [link(ids[0]), `https://www.youtube.com/watch?v=${ids[1]}`] } });
  const menu = page.locator('#queue-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-active', '');
  await expect(page.locator('#queue-summary')).toHaveAttribute('aria-label', '2 videos in progress');
  await expect(page.locator('#queue-count')).toHaveText('2');
  // The single-video flow is untouched.
  await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeVisible();
  // Cmd/Ctrl+Enter submits from the box.
  await page.getByRole('button', { name: 'Queue several videos' }).click();
  await page.getByLabel('Queue several videos').fill(link(ids[2]));
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#queue-count')).toHaveText('3');
});

test('per-line problems keep the box open with only the lines that need attention', async ({ page }) => {
  const account = await mockAccount(page, { user });
  await mockQueue(page, account, { results: { [ids[1]]: 'alreadySaved', [ids[2]]: 'alreadyQueued', [ids[3]]: 'overQuota' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Queue several videos' }).click();
  const box = page.getByLabel('Queue several videos');
  await box.fill([link(ids[0]), link(ids[1]), link(ids[2]), link(ids[3]), 'https://vimeo.com/123', link(ids[0])].join('\n'));
  await page.getByRole('button', { name: 'Add 6 to queue' }).click();
  const results = page.locator('#queue-results li');
  await expect(results).toHaveText([
    /Already in library\s*youtu.be\/PJrntzMA4iQ/, /Already queued\s*youtu.be\/dQw4w9WgXcQ/, /Over today’s limit\s*youtu.be\/aqz-KE-bpKQ/,
    /Not a YouTube link\s*https:\/\/vimeo.com\/123/, /Listed twice\s*youtu.be\/38vwjWpHFes/,
  ]);
  await expect(box).toHaveValue(`${link(ids[3])}\nhttps://vimeo.com/123`);
  await expect(box).toBeFocused();
  await expect(page.locator('#queue-announcement')).toHaveText('1 video queued. It lands in your library when ready. 5 of 6 need attention.');
  await expect(page.locator('#queue-count')).toHaveText('1');
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('more than 10 lines is refused before any request', async ({ page }) => {
  const account = await mockAccount(page, { user });
  const queue = await mockQueue(page, account);
  await page.goto('/');
  await page.getByRole('button', { name: 'Queue several videos' }).click();
  await page.getByLabel('Queue several videos').fill(Array.from({ length: 11 }, (_, n) => link(`aaaaaaaaa${String(n).padStart(2, '0')}`)).join('\n'));
  await page.getByRole('button', { name: 'Add 11 to queue' }).click();
  await expect(page.locator('#queue-error')).toHaveText('Paste at most 10 URLs at a time. You have 11.');
  await expect(page.getByLabel('Queue several videos')).toHaveAttribute('aria-invalid', 'true');
  expect(queue.requests.filter(r => r.method === 'POST')).toEqual([]);
});

test('unverified accounts see why the box is unavailable', async ({ page }) => {
  const account = await mockAccount(page, { user: { ...user, emailVerified: false } });
  const queue = await mockQueue(page, account);
  await page.goto('/');
  await page.getByRole('button', { name: 'Queue several videos' }).click();
  await expect(page.getByLabel('Queue several videos')).toBeDisabled();
  await expect(page.locator('#queue-submit')).toBeDisabled();
  await expect(page.locator('#queue-left')).toHaveText('Verify your email to queue videos.');
  await expect(page.locator('#verify-banner')).toBeVisible();
  expect(queue.requests.filter(r => r.method === 'POST')).toEqual([]);
});

test('the header menu lists progress, retries and removes items, and announces finished briefs', async ({ page }) => {
  const account = await mockAccount(page, { user, items: [makeItem('1')] });
  const queue = await mockQueue(page, account, { used: 3, items: [
    queueItem(itemId(1), ids[0], { status: 'processing' }),
    queueItem(itemId(2), ids[1], { error: 'YouTube is busy', attempts: 1 }),
    queueItem(itemId(3), ids[2], { status: 'failed', error: 'YouTube is refusing caption requests', attempts: 5 }),
    queueItem(itemId(4), ids[3], { status: 'failed', error: 'This video has no English captions', retryable: false, attempts: 1 }),
  ] });
  await page.goto('/');
  const summary = page.locator('#queue-summary');
  await expect(summary).toHaveAttribute('aria-label', '2 videos in progress, 2 failed');
  await summary.click();
  const rows = page.locator('#queue-list li');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Summarizing…');
  await expect(rows.nth(1)).toContainText('Waiting to try again');
  await expect(rows.nth(2)).toContainText('YouTube is refusing caption requests');
  await expect(rows.nth(0).getByRole('link', { name: `youtu.be/${ids[0]}` })).toHaveAttribute('href', `https://www.youtube.com/watch?v=${ids[0]}`);
  await expect(page.locator('#queue-quota')).toHaveText('47 of 50 left today');
  // Retry only where it can help.
  await expect(rows.nth(2).getByRole('button', { name: `Retry youtu.be/${ids[2]}` })).toBeVisible();
  await expect(rows.nth(3).getByRole('button', { name: /Retry/ })).toHaveCount(0);
  const popover = page.locator('.queue-popover');
  const box = await popover.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x >= 0 && box.x + box.width <= viewport.width).toBe(true);

  await rows.nth(2).getByRole('button', { name: `Retry youtu.be/${ids[2]}` }).click();
  await expect(rows.nth(2)).toContainText('Queued');
  // Retry is gone from the row; focus stays on that row's video.
  await expect(rows.nth(2).getByRole('link', { name: `youtu.be/${ids[2]}` })).toBeFocused();
  expect(queue.requests.find(r => r.path.endsWith('/retry'))).toMatchObject({ method: 'POST', path: `/api/queue/${itemId(3)}/retry`, contentType: 'application/json' });
  await rows.nth(3).getByRole('button', { name: `Remove youtu.be/${ids[3]}` }).click();
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#account-status')).toHaveText(`Removed youtu.be/${ids[3]}.`);
  expect(queue.requests.find(r => r.method === 'DELETE')).toMatchObject({ path: `/api/queue/${itemId(4)}`, contentType: 'application/json' });
  // Focus moves to the neighboring row's video, never to another Remove.
  await expect(rows.nth(2).getByRole('link', { name: `youtu.be/${ids[2]}` })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#queue-menu')).not.toHaveAttribute('open', '');
  await expect(summary).toBeFocused();

  // The processing video finishes: it leaves the queue and lands in the library.
  queue.items = queue.items.filter(item => item.id !== itemId(1));
  account.items.unshift(makeItem('2', { title: 'Freshly finished' }));
  await recheck(page);
  await expect(page.locator('#account-status')).toHaveText('1 brief is ready in your library.');
  await expect(page.locator('#library-badge')).toHaveText('2');
  await expect(page.locator('#queue-count')).toHaveText('2');
  // Everything done: the menu disappears.
  queue.items = [];
  await recheck(page);
  await expect(page.locator('#queue-menu')).toBeHidden();
});

test('polling the header menu keeps keyboard focus where it was', async ({ page }) => {
  const account = await mockAccount(page, { user });
  const queue = await mockQueue(page, account, { items: [
    queueItem(itemId(1), ids[0], { status: 'processing' }),
    queueItem(itemId(2), ids[1]),
    queueItem(itemId(3), ids[2]),
  ] });
  await page.goto('/');
  await page.locator('#queue-summary').click();
  const rows = page.locator('#queue-list li');
  const remove = rows.nth(1).getByRole('button', { name: `Remove youtu.be/${ids[1]}` });
  await remove.focus();
  const before = await remove.elementHandle();
  // Nothing changed: the rows are left as they are.
  await recheck(page);
  await expect.poll(() => queue.requests.filter(r => r.method === 'GET').length).toBeGreaterThan(1);
  expect(await before.evaluate(el => el.isConnected && el === document.activeElement)).toBe(true);
  // Something changed: the same control on the same item gets focus back.
  queue.items[0].status = 'queued';
  await recheck(page);
  await expect(rows.nth(0)).toContainText('Queued');
  await expect(remove).toBeFocused();
  // The focused item finished elsewhere: focus moves to the row now in its place.
  queue.items = queue.items.filter(item => item.id !== itemId(2));
  await recheck(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).getByRole('link', { name: `youtu.be/${ids[2]}` })).toBeFocused();
});

test('the header menu closes on outside clicks and is gone after sign-out', async ({ page }) => {
  const account = await mockAccount(page, { user });
  await mockQueue(page, account, { items: [queueItem(itemId(1), ids[0])] });
  await page.goto('/');
  await page.locator('#queue-summary').click();
  await expect(page.locator('.queue-popover')).toBeVisible();
  await page.locator('.intro').click();
  await expect(page.locator('.queue-popover')).toBeHidden();
  await page.locator('#account-menu summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#queue-menu')).toBeHidden();
  // Signed out, the link stays as an invitation to create an account.
  await expect(page.getByRole('button', { name: 'Queue several videos' })).toBeVisible();
});

test('a single-bar summary shows in the header menu while it runs', async ({ page }) => {
  const account = await mockAccount(page, { user });
  await mockQueue(page, account, { items: [queueItem(itemId(1), ids[1])] });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/summarize', async route => {
    await held;
    await route.fulfill({ json: { id: ids[0], title: 'First video brief', uploader: 'Example channel', duration: 480, summary: '## Summary: X\n\nY', transcriptTruncated: false, share: null } });
  });
  await page.goto('/');
  await expect(page.locator('#queue-count')).toHaveText('1');
  await expect.poll(() => page.evaluate(() => Boolean(window.__verification))).toBe(true);
  await page.getByLabel('YouTube URL', { exact: true }).fill(link(ids[0]));
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.locator('#queue-count')).toHaveText('2');
  await expect(page.locator('#queue-summary')).toHaveAttribute('aria-label', '2 videos in progress');
  await page.locator('#queue-summary').click();
  const first = page.locator('#queue-list li').first();
  await expect(first).toContainText(`youtu.be/${ids[0]}`);
  await expect(first).toContainText('Summarizing on this page…');
  await expect(first.getByRole('button')).toHaveCount(0);
  release();
  await expect(page.locator('#result-title')).toHaveText('First video brief');
  await expect(page.locator('#queue-count')).toHaveText('1');
});

test('signed-out visitors never see the menu for a single-bar summary', async ({ page }) => {
  const account = await mockAccount(page);
  await mockQueue(page, account);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.__verification))).toBe(true);
  await page.getByLabel('YouTube URL', { exact: true }).fill(`https://www.youtube.com/watch?v=${ids[0]}`);
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.locator('#result-title')).toHaveText('First video brief');
  await expect(page.locator('#queue-menu')).toBeHidden();
});

test('several links in the single bar are moved into the queue box instead of failing', async ({ page }) => {
  const account = await mockAccount(page, { user });
  await mockQueue(page, account);
  await page.goto('/');
  const bar = page.getByLabel('YouTube URL', { exact: true });
  await bar.fill(`${link(ids[0])} ${link(ids[1])}`);
  await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeDisabled();
  const action = page.getByRole('button', { name: 'Queue them instead' });
  await expect(action).toBeVisible();
  await expect(page.locator('#queue-toggle')).toBeHidden();
  await action.click();
  await expect(bar).toHaveValue('');
  await expect(page.getByLabel('Queue several videos')).toHaveValue(`${link(ids[0])}\n${link(ids[1])}`);
  await expect(page.getByRole('button', { name: 'Add 2 to queue' })).toBeVisible();
  await expect(page.locator('#several-links')).toBeHidden();
  // One link again: the hint disappears and Summarize works as before.
  await bar.fill(link(ids[2]));
  await expect(page.locator('#several-links')).toBeHidden();
});

test('signed-out visitors with several links are asked to sign in', async ({ page }) => {
  const account = await mockAccount(page);
  await mockQueue(page, account);
  await page.goto('/');
  await page.getByLabel('YouTube URL', { exact: true }).fill(`${link(ids[0])}${link(ids[1])}`);
  await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Sign up to queue them' }).click();
  await expect(page.getByRole('dialog', { name: 'Create account' })).toBeVisible();
});
