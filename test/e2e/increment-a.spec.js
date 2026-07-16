'use strict';

const { test, expect } = require('@playwright/test');

test('local root account loads v2 fixtures and switches themes', async ({ page }) => {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('status of 401')) errors.push(message.text());
  });
  await page.goto('/');
  await page.locator('#signin-username').fill('root');
  await page.locator('#signin-password').fill('root');
  await page.locator('#signin-btn').click();
  await expect(page).toHaveURL(/chat\.html/);
  await expect(page.getByText('Increment A Playground')).toBeVisible();
  await page.getByText('Increment A Playground').click();
  await expect(page.getByText('Welcome to the local UI playground', { exact: false })).toBeVisible();
  await page.locator('#theme-toggle-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
  const afterFirst = await page.locator('html').getAttribute('data-theme');
  await page.locator('#theme-toggle-btn').click();
  const afterSecond = await page.locator('html').getAttribute('data-theme');
  expect(afterSecond).not.toBe(afterFirst);
  expect(['light', 'dark']).toContain(afterSecond);
  expect(errors).toEqual([]);
});

test('message stream remains usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('#signin-username').fill('root');
  await page.locator('#signin-password').fill('root');
  await page.locator('#signin-btn').click();
  await page.getByText('Increment A Playground').click();
  await expect(page.locator('.msg-row').first()).toBeVisible();
  const width = await page.locator('.chat-panel').evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(390.1);
});

test('startup fetches bounded group metadata without eager transcript hydration', async ({ page }) => {
  const apiPaths = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/groups/')) apiPaths.push(url.pathname);
  });
  await page.goto('/');
  await page.locator('#signin-username').fill('root');
  await page.locator('#signin-password').fill('root');
  await page.locator('#signin-btn').click();
  await expect(page.getByText('Increment A Playground')).toBeVisible();
  expect(apiPaths).toContain('/api/groups/mine');
  expect(apiPaths).not.toContain('/api/groups/preload');
  expect(apiPaths.some((path) => /\/messages$|\/members$/.test(path))).toBe(false);
});

test('secure invite fragment survives authentication and opens the join flow', async ({ page }) => {
  const secret = Buffer.alloc(32, 7).toString('base64url');
  const invite = Buffer.from(JSON.stringify({ v: 2, code: 'hosted-invite-test', secret })).toString('base64url');
  await page.goto(`/#invite=${invite}`);
  await expect(page).toHaveURL(new RegExp(`#invite=${invite}$`));
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('gchat:pending-secure-invite')))
    .toBe(`#invite=${invite}`);
  await page.locator('#signin-username').fill('root');
  await page.locator('#signin-password').fill('root');
  await page.locator('#signin-btn').click();
  await expect(page.locator('#join-modal')).toBeVisible();
  await expect(page).toHaveURL(/chat\.html$/);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('gchat:pending-secure-invite')))
    .toBe(`#invite=${invite}`);
  await expect(page.locator('#join-group-code')).toHaveValue('Secure invite ready');
});
