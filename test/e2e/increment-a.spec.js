'use strict';

const { test, expect } = require('@playwright/test');

async function signInAsLocalRoot(page) {
  await page.goto('/');
  const username = page.locator('#signin-username');
  const password = page.locator('#signin-password');
  await username.fill('root');
  await password.fill('root');
  await expect(username).toHaveValue('root');
  await expect(password).toHaveValue('root');
  await Promise.all([
    page.waitForURL(/chat\.html/),
    page.locator('#signin-btn').click(),
  ]);
}

test('auth theme toggle swaps the GChat logo for the active theme', async ({ page }) => {
  await page.addInitScript(() => globalThis.localStorage.setItem('gchat:theme-preference', 'dark'));
  await page.goto('/index.html');

  const toggle = page.locator('#auth-theme-toggle');
  const logo = page.locator('.auth-logo-icon');
  await expect(toggle).toBeVisible();

  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(logo).toHaveAttribute('src', '/gchat_icon_light.png');

  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(logo).toHaveAttribute('src', '/gchat_icon.png?v=20260716-v132');
});

test('local root account loads v2 fixtures and switches themes', async ({ page }) => {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('status of 401')) errors.push(message.text());
  });
  await signInAsLocalRoot(page);
  await expect(page.getByText('Increment A Playground')).toBeVisible();
  await page.getByText('Increment A Playground').click();
  await expect(page.getByText('Welcome to the local UI playground', { exact: false })).toBeVisible();
  await page.locator('#right-panel-toggle').click();
  await expect(page.locator('#right-panel')).toHaveClass(/desktop-collapsed/);
  await page.locator('#right-panel-toggle').click();
  await expect(page.locator('#right-panel')).not.toHaveClass(/desktop-collapsed/);
  await page.locator('#whisper-mode-btn').click();
  await expect(page.locator('#whisper-picker')).toBeVisible();
  await expect(page.locator('#whisper-picker-confirm')).toBeVisible();
  await page.locator('#theme-toggle-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
  const afterFirst = await page.locator('html').getAttribute('data-theme');
  await expect(page.locator('.brand-icon')).toHaveAttribute(
    'src',
    afterFirst === 'light' ? /gchat_icon_light\.png$/ : /gchat_icon\.png\?v=20260716-v132$/,
  );
  await page.locator('#theme-toggle-btn').click();
  const afterSecond = await page.locator('html').getAttribute('data-theme');
  expect(afterSecond).not.toBe(afterFirst);
  expect(['light', 'dark']).toContain(afterSecond);
  await expect(page.locator('.brand-icon')).toHaveAttribute(
    'src',
    afterSecond === 'light' ? /gchat_icon_light\.png$/ : /gchat_icon\.png\?v=20260716-v132$/,
  );
  expect(errors).toEqual([]);
});

test('message stream remains usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsLocalRoot(page);
  await page.getByText('Increment A Playground').click();
  await expect(page.locator('.msg-row').first()).toBeVisible();
  const width = await page.locator('.chat-panel').evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(390.1);
});

test('composer modes use the active channel without legacy tokens or slash commands', async ({ page }) => {
  await signInAsLocalRoot(page);
  await page.getByText('Increment A Playground').click();

  await page.locator('#whisper-mode-btn').click();
  await expect(page.locator('#whisper-mode-btn')).toHaveCSS('color', 'rgb(124, 58, 237)');
  const pickerWidth = await page.locator('#whisper-picker').evaluate((element) => element.getBoundingClientRect().width);
  expect(pickerWidth).toBeLessThanOrEqual(280.1);
  await page.locator('#whisper-picker-cancel').click();
  await expect(page.locator('#whisper-picker')).toBeHidden();
  await expect(page.locator('#whisper-mode-btn')).not.toHaveClass(/whisper-active/);

  await page.locator('#whisper-mode-btn').click();
  await page.locator('#message-input').press('Escape');
  await expect(page.locator('#whisper-picker')).toBeHidden();
  await expect(page.locator('#whisper-mode-btn')).not.toHaveClass(/whisper-active/);

  await page.locator('#whisper-mode-btn').click();
  const recipients = page.locator('.whisper-picker-item input');
  await expect(recipients).toHaveCount(1);
  await recipients.check();
  await page.locator('#whisper-picker-confirm').click();

  await expect(page.locator('#message-token-strip')).toBeHidden();
  await expect(page.locator('#whisper-mode-btn')).toHaveClass(/whisper-active/);
  await expect(page.locator('#message-input')).toHaveAttribute('placeholder', /Whisper to Mira · #main · Increment A Playground/);
  await page.locator('#message-input').press('Backspace');
  await expect(page.locator('#whisper-mode-btn')).toHaveClass(/whisper-active/);

  await page.locator('#whisper-mode-btn').click();
  await expect(page.locator('#whisper-mode-btn')).toHaveClass(/disappearing-active/);
  await expect(page.locator('#message-input')).toHaveAttribute('placeholder', /Disappearing message #main · Increment A Playground/);
  await page.locator('#message-input').fill('Hi');
  await expect(page.locator('#message-input')).toHaveCSS('color', 'rgb(220, 38, 38)');
  await page.locator('#message-input').press('Enter');
  await expect(page.getByText('Hi', { exact: true })).toBeVisible();
  await expect(page.getByText('Disappears 3s after read', { exact: true })).toBeVisible();

  await expect(page.locator('[data-command="/w "]')).toHaveCount(0);
  await expect(page.locator('[data-command="/d "]')).toHaveCount(0);
});

test('image attachments reserve message-row space and open usable viewer actions', async ({ page }) => {
  await signInAsLocalRoot(page);
  await page.getByText('Increment A Playground').click();

  await page.locator('#file-input').setInputFiles('public/gchat_icon.png');
  const image = page.locator('.msg-image');
  await expect(image).toBeVisible();

  const imageRow = image.locator('xpath=ancestor::div[contains(@class, "msg-row")]');
  await expect(imageRow).toHaveCount(1);
  const imageHeight = await image.evaluate((element) => element.getBoundingClientRect().height);
  expect(imageHeight).toBeGreaterThan(0);

  const nextMessage = 'Attachment layout regression check';
  await page.locator('#message-input').fill(nextMessage);
  await page.locator('#message-input').press('Enter');
  const nextMessageText = page.getByText(nextMessage, { exact: true });
  await expect(nextMessageText).toBeVisible();
  const layout = await nextMessageText.evaluate((element) => {
    const imageElement = element.ownerDocument.querySelector('.msg-image');
    const nextRow = element.closest('.msg-row');
    if (!imageElement || !nextRow) return null;
    const imageRect = imageElement.getBoundingClientRect();
    const nextRowRect = nextRow.getBoundingClientRect();
    return { imageBottom: imageRect.bottom, nextRowTop: nextRowRect.top };
  });
  expect(layout).not.toBeNull();
  expect(layout.nextRowTop).toBeGreaterThanOrEqual(layout.imageBottom - 1);

  await image.click();
  await expect(page.locator('#image-viewer-modal')).toBeVisible();
  await expect(page.locator('#image-viewer-copy-btn')).toBeVisible();
  await expect(page.locator('#image-viewer-download-btn')).toBeVisible();

  const imageDownload = page.waitForEvent('download');
  await page.locator('#image-viewer-download-btn').click();
  await expect(imageDownload).resolves.toBeTruthy();

  await page.mouse.click(5, 5);
  await expect(page.locator('#image-viewer-modal')).toBeHidden();
  await page.locator('#file-input').setInputFiles('package.json');
  const fileCard = page.locator('.msg-file-btn');
  await expect(fileCard).toBeVisible();
  await expect(fileCard.getByText('Download', { exact: true })).toBeVisible();
  const fileDownload = page.waitForEvent('download');
  await fileCard.click();
  await expect(fileDownload).resolves.toBeTruthy();
});

test('startup fetches bounded group metadata without eager transcript hydration', async ({ page }) => {
  const apiPaths = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/groups/')) apiPaths.push(url.pathname);
  });
  await signInAsLocalRoot(page);
  await expect(page.getByText('Increment A Playground')).toBeVisible();
  expect(apiPaths).toContain('/api/groups/mine');
  expect(apiPaths).toContain('/api/groups/keys');
  expect(apiPaths).not.toContain('/api/groups/preload');
  expect(apiPaths.some((path) => /\/messages$|\/members$/.test(path))).toBe(false);
});

test('secure invite fragment survives authentication and opens the join flow', async ({ page }) => {
  const secret = Buffer.alloc(32, 7).toString('base64url');
  const invite = Buffer.from(JSON.stringify({ v: 2, code: 'hosted-invite-test', secret })).toString('base64url');
  await page.goto(`/index.html#invite=${invite}`);
  await expect(page).toHaveURL(new RegExp(`#invite=${invite}$`));
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('gchat:pending-secure-invite')))
    .toBe(`#invite=${invite}`);
  const username = page.locator('#signin-username');
  const password = page.locator('#signin-password');
  await username.fill('root');
  await password.fill('root');
  await expect(username).toHaveValue('root');
  await expect(password).toHaveValue('root');
  await Promise.all([
    page.waitForURL(/chat\.html$/),
    page.locator('#signin-btn').click(),
  ]);
  await expect(page.locator('#join-modal')).toBeVisible();
  await expect(page).toHaveURL(/chat\.html$/);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('gchat:pending-secure-invite')))
    .toBe(`#invite=${invite}`);
  await expect(page.locator('#join-group-code')).toHaveValue('Secure invite ready');
});
