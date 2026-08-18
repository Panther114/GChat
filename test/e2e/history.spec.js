'use strict';

// v1.3.12: chat-history integrity e2e — the core claims of the history &
// unread overhaul, exercised in a real browser against the local debug server:
//  1. The transcript renders from the durable cache without a server flash and
//     never shows the loading placeholder for an already-loaded group.
//  2. Opening a group marks its active channel read (server-authoritative
//     cursor) — the sidebar badge clears and no `.unseen` rows remain.
//  3. Channel switches are instant: the target channel's history is present
//     immediately and the transcript never blanks mid-switch.
//  4. Sent messages survive a reload (durable IndexedDB history).
//  5. Scroll position is restored after a reload (anchor-based, per channel)
//     so history never "disappears".
const { test, expect } = require('@playwright/test');

const GROUP_NAME = 'Increment A Playground';
const WELCOME_TEXT = 'Welcome to the local UI playground.';
const QA_TEXT = 'Try the sidebar, search, reactions, reply layout, long messages, and responsive breakpoints.';

async function signInAsRoot(page) {
  await page.goto('/');
  await page.locator('#signin-username').fill('root');
  await page.locator('#signin-password').fill('root');
  await Promise.all([
    page.waitForURL(/chat\.html/),
    page.locator('#signin-btn').click(),
  ]);
  // The app does not auto-select a group after sign-in.
  const item = page.locator('.group-item', { hasText: GROUP_NAME }).first();
  await item.click();
  await expect(page.locator('#chat-group-name')).toHaveText(GROUP_NAME, { timeout: 10_000 });
}

async function openGroup(page, name = GROUP_NAME) {
  const item = page.locator('.group-item', { hasText: name }).first();
  await item.click();
  await expect(page.locator('#chat-group-name')).toHaveText(name);
}

async function registerFreshUser(page, prefix = 'anchor') {
  await page.goto('/');
  await page.locator('.auth-tab[data-tab=signup]').click();
  const username = `${prefix}${Date.now() % 100000}`;
  await page.locator('#signup-username').fill(username);
  await page.locator('#signup-password').fill('probe-pass');
  await page.locator('#signup-confirm').fill('probe-pass');
  await page.locator('#signup-btn').click();
  await page.locator('#group-list').first().waitFor({ timeout: 15_000 });
  await page.locator('#join-group-btn').click();
  await page.locator('#join-group-code').fill('inca01');
  await page.locator('#join-confirm-btn').click();
  await page.waitForTimeout(800);
}

test('initial chat startup issues exactly one bootstrap request', async ({ page }) => {
  let bootstrapRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/sync/bootstrap') bootstrapRequests += 1;
  });
  await signInAsRoot(page);
  await page.locator('#group-list').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  expect(bootstrapRequests).toBe(1);
});

function transcriptState(page) {
  return page.evaluate(() => {
    const area = globalThis.document.getElementById('messages-area');
    const rows = area ? Array.from(area.querySelectorAll('.msg-row')) : [];
    return {
      msgCount: rows.length,
      visibleRows: rows.filter((row) => !row.hidden).length,
      text: rows.map((row) => row.textContent || '').join('|'),
      scrollTop: area ? area.scrollTop : -1,
      scrollHeight: area ? area.scrollHeight : -1,
      loadingPlaceholder: area ? area.querySelectorAll('.channel-loading-indicator').length : -1,
    };
  });
}

test('opening channels marks them read: no unseen rows, badge clears once every channel is visited', async ({ page }) => {
  await signInAsRoot(page);
  await openGroup(page);

  // The fixture messages were sent by Mira — two of them live in other
  // channels (#local-debug, #visual-qa), so the group starts unread.
  const badge = page.locator('.group-item', { hasText: GROUP_NAME }).locator('.group-item-badge');
  await expect(badge).toBeVisible();

  // Opening #main marks it read — no `.unseen` rows may remain in the
  // active channel after the cursor broadcast settles.
  await expect(page.locator('#messages-area .msg-row.unseen')).toHaveCount(0, { timeout: 10_000 });

  // Per-channel cursors: visiting each remaining channel clears its unread,
  // and the group badge drops to zero once every channel has been read.
  await page.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' }).click();
  await expect(page.locator('#messages-area .msg-row.unseen')).toHaveCount(0, { timeout: 10_000 });

  await page.locator('.chat-tag-filter-btn', { hasText: '#local-debug' }).click();
  await expect(page.locator('#messages-area .msg-row.unseen')).toHaveCount(0, { timeout: 10_000 });

  await expect(badge).toBeHidden({ timeout: 10_000 });
});

test('an inactive-channel arrival stays unread until that channel is opened', async ({ browser }) => {
  const rootContext = await browser.newContext();
  const friendContext = await browser.newContext();
  const rootPage = await rootContext.newPage();
  const friendPage = await friendContext.newPage();
  await signInAsRoot(rootPage);
  await openGroup(rootPage);
  await rootPage.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' }).click();
  await expect(rootPage.locator('#messages-area .msg-row.unseen')).toHaveCount(0, { timeout: 10_000 });
  await rootPage.locator('.chat-tag-filter-btn', { hasText: '#main' }).click();
  await expect(rootPage.locator('.chat-tag-filter-btn', { hasText: '#main' })).toHaveClass(/active/);

  await friendPage.goto('/');
  await friendPage.locator('.auth-tab[data-tab=signup]').click();
  const friendName = `unread${Date.now() % 100000}`;
  await friendPage.locator('#signup-username').fill(friendName);
  await friendPage.locator('#signup-password').fill('probe-pass');
  await friendPage.locator('#signup-confirm').fill('probe-pass');
  await friendPage.locator('#signup-btn').click();
  await friendPage.locator('#group-list').first().waitFor({ timeout: 15_000 });
  await friendPage.locator('#join-group-btn').click();
  await friendPage.locator('#join-group-code').fill('inca01');
  await friendPage.locator('#join-confirm-btn').click();
  await friendPage.waitForTimeout(800);
  await openGroup(friendPage);
  await friendPage.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' }).click();

  const marker = `inactive-unread-${Date.now()}`;
  await friendPage.locator('#message-input').fill(marker);
  await friendPage.locator('#message-input').press('Enter');
  await expect(friendPage.locator('#messages-area .msg-row', { hasText: marker })).toBeVisible();

  const visualChip = rootPage.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' });
  await expect(visualChip).toHaveClass(/has-unread/, { timeout: 10_000 });
  await expect(rootPage.locator('#messages-area .msg-row', { hasText: marker })).toHaveCount(0);
  await visualChip.click();
  await expect(rootPage.locator('#messages-area .msg-row', { hasText: marker })).toBeVisible({ timeout: 10_000 });
  await expect(rootPage.locator('#messages-area .msg-row.unseen')).toHaveCount(0, { timeout: 10_000 });
  await expect(visualChip).not.toHaveClass(/has-unread/, { timeout: 10_000 });

  await rootContext.close();
  await friendContext.close();
});

test('channel switches are instant and never blank the transcript', async ({ page }) => {
  await signInAsRoot(page);
  await openGroup(page);
  await expect(page.locator('#messages-area .msg-row', { hasText: WELCOME_TEXT })).toBeVisible({ timeout: 10_000 });

  // Hook a mutation observer that flags any moment the transcript goes empty
  // (a blank flash) or shows the loading placeholder during a channel switch.
  await page.evaluate(() => {
    globalThis.__transcriptGlitches = [];
    const area = globalThis.document.getElementById('messages-area');
    const record = () => {
      const hasRows = area.querySelectorAll('.msg-row').length > 0;
      const placeholder = area.querySelectorAll('.channel-loading-indicator').length > 0;
      if ((!hasRows || placeholder) && !area.hidden) globalThis.__transcriptGlitches.push(Date.now());
    };
    new globalThis.MutationObserver(record).observe(area, { childList: true, subtree: true });
    record();
  });

  // First switch builds the channel (full path), then we bounce back and forth
  // so every later switch re-attaches the memoized rows (O(1) swap).
  await page.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' }).click();
  await expect(page.locator('#messages-area .msg-row', { hasText: QA_TEXT })).toBeVisible({ timeout: 5_000 });

  await page.locator('.chat-tag-filter-btn', { hasText: '#main' }).click();
  await expect(page.locator('#messages-area .msg-row', { hasText: WELCOME_TEXT })).toBeVisible({ timeout: 5_000 });

  await page.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' }).click();
  await expect(page.locator('#messages-area .msg-row', { hasText: QA_TEXT })).toBeVisible({ timeout: 5_000 });

  await page.locator('.chat-tag-filter-btn', { hasText: '#main' }).click();
  await expect(page.locator('#messages-area .msg-row', { hasText: WELCOME_TEXT })).toBeVisible({ timeout: 5_000 });

  // Give any straggler mutations a beat, then assert the transcript never
  // blanked and never showed the loading placeholder.
  await page.waitForTimeout(400);
  const glitches = await page.evaluate(() => globalThis.__transcriptGlitches || []);
  expect(glitches, `transcript blanked/placeholder during switch: ${JSON.stringify(glitches)}`).toEqual([]);
});

test('delayed channel history shows a scoped loader while stale content stays covered', async ({ page }) => {
  await signInAsRoot(page);
  await openGroup(page);
  await expect(page.locator('#messages-area .msg-row', { hasText: WELCOME_TEXT })).toBeVisible({ timeout: 10_000 });

  let delayedRequest = true;
  await page.route('**/api/groups/*/messages*', async (route) => {
    if (delayedRequest) {
      delayedRequest = false;
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    await route.continue();
  });

  await page.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' }).click();
  await expect(page.locator('#message-loading-overlay')).toBeVisible({ timeout: 1_000 });
  const loadingState = await page.evaluate(() => {
    const area = globalThis.document.getElementById('messages-area');
    const overlay = globalThis.document.getElementById('message-loading-overlay');
    return {
      busy: area?.getAttribute('aria-busy'),
      filter: globalThis.getComputedStyle(area).filter,
      staleMessageStillMounted: !!area?.querySelector('.msg-row'),
      overlayLabel: globalThis.document.getElementById('message-loading-label')?.textContent,
      overlayHidden: overlay?.hidden,
    };
  });
  expect(loadingState.busy).toBe('true');
  expect(loadingState.filter).toContain('blur');
  expect(loadingState.staleMessageStillMounted).toBe(true);
  expect(loadingState.overlayLabel).toContain('#visual-qa');
  expect(loadingState.overlayHidden).toBe(false);

  await expect(page.locator('#messages-area .msg-row', { hasText: QA_TEXT })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('#message-loading-overlay')).toBeHidden();
  await page.unroute('**/api/groups/*/messages*');
});

test('rapid channel switching keeps the final transcript scoped to the selected channel', async ({ page }) => {
  await signInAsRoot(page);
  await openGroup(page);
  await expect(page.locator('#messages-area .msg-row', { hasText: WELCOME_TEXT })).toBeVisible({ timeout: 10_000 });

  let firstChannelRequest = true;
  await page.route('**/api/groups/*/messages*', async (route) => {
    if (firstChannelRequest) {
      firstChannelRequest = false;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await route.continue();
  });

  await page.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' }).click();
  await page.locator('.chat-tag-filter-btn', { hasText: '#main' }).click();
  await expect(page.locator('.chat-tag-filter-btn', { hasText: '#main' })).toHaveClass(/active/);
  await expect(page.locator('#messages-area .msg-row', { hasText: WELCOME_TEXT })).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(900);

  const finalState = await page.evaluate(() => ({
    active: globalThis.document.querySelector('.chat-tag-filter-btn.active')?.textContent?.trim(),
    text: Array.from(globalThis.document.querySelectorAll('#messages-area .msg-row')).map((row) => row.textContent || '').join('|'),
    busy: globalThis.document.getElementById('messages-area')?.getAttribute('aria-busy'),
  }));
  expect(finalState.active).toBe('#main');
  expect(finalState.text).toContain(WELCOME_TEXT);
  expect(finalState.text).not.toContain(QA_TEXT);
  expect(finalState.busy).toBe('false');
  await page.unroute('**/api/groups/*/messages*');
});

test('web avatar uploads submit a 256px thumbnail', async ({ page }) => {
  await signInAsRoot(page);
  await page.locator('#sidebar-user-btn').click();
  await expect(page.locator('#profile-modal')).toBeVisible();
  await page.locator('#profile-mode-image-label').click();

  const sourceDataUrl = await page.evaluate(() => {
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    context.fillStyle = '#2b65d9';
    context.fillRect(0, 0, 512, 512);
    return canvas.toDataURL('image/png');
  });
  const requestBodies = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/profile') && request.method() === 'PATCH') {
      try { requestBodies.push(request.postDataJSON()); } catch { /* ignore unrelated malformed bodies */ }
    }
  });
  await page.locator('#profile-picture-input').setInputFiles({
    name: 'large-avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from(sourceDataUrl.split(',')[1], 'base64'),
  });
  await expect(page.locator('#profile-picture-preview')).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => page.locator('#profile-picture-preview-img').evaluate((img) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([256, 256]);
  await page.locator('#profile-save-picture').click();
  await expect.poll(() => requestBodies.length).toBeGreaterThan(0);
  const body = requestBodies[requestBodies.length - 1];
  expect(body.profilePicture).toMatch(/^data:image\/(?:webp|jpeg);base64,/);
  expect(body.profilePicture.length).toBeLessThan(100_000);
});

test('sent messages persist across a reload', async ({ page }) => {
  await signInAsRoot(page);
  await openGroup(page);
  await expect(page.locator('#messages-area .msg-row', { hasText: WELCOME_TEXT })).toBeVisible({ timeout: 10_000 });

  const marker = `persist-e2e-${Date.now()}`;
  await page.locator('#message-input').fill(marker);
  await page.locator('#send-btn').click();
  await expect(page.locator('#messages-area .msg-row', { hasText: marker })).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.locator('#chat-group-name')).toHaveText(GROUP_NAME, { timeout: 10_000 });
  await expect(page.locator('#messages-area .msg-row', { hasText: marker })).toBeVisible({ timeout: 10_000 });
  // A loaded group never shows the loading placeholder after reload.
  await expect(page.locator('#messages-area .channel-loading-indicator')).toHaveCount(0);
});

test('scroll position is restored after a reload (history does not disappear)', async ({ page }) => {
  await signInAsRoot(page);
  await openGroup(page);
  await expect(page.locator('#messages-area .msg-row', { hasText: WELCOME_TEXT })).toBeVisible({ timeout: 10_000 });

  // Seed enough history that the transcript actually scrolls, then scroll up
  // into it and let the anchor recorder (debounced) persist the position.
  for (let i = 0; i < 24; i += 1) {
    await page.locator('#message-input').fill(`anchor-seed-${i}`);
    await page.locator('#send-btn').click();
  }
  await expect(page.locator('#messages-area .msg-row', { hasText: 'anchor-seed-23' })).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => {
    const area = globalThis.document.getElementById('messages-area');
    area.scrollTop = Math.round(area.scrollHeight / 3);
  });
  await page.waitForTimeout(900);

  const before = await transcriptState(page);
  expect(before.scrollTop).toBeGreaterThan(0);

  await page.reload();
  await expect(page.locator('#chat-group-name')).toHaveText(GROUP_NAME, { timeout: 10_000 });
  await expect(page.locator('#messages-area .msg-row', { hasText: WELCOME_TEXT })).toBeVisible({ timeout: 10_000 });

  // The reload must restore the reading position instead of snapping to the
  // bottom (scrollTop is bounded by the restored content height).
  const after = await transcriptState(page);
  expect(after.scrollTop).toBeGreaterThan(0);
  expect(after.scrollTop).toBeLessThan(after.scrollHeight - 100);
});

test('scrolling stays put: switching groups and resyncing never moves the transcript', async ({ page }) => {
  await signInAsRoot(page);
  await expect(page.locator('#messages-area .msg-row').first()).toBeVisible({ timeout: 10_000 });

  // Make the transcript tall enough to scroll, then scroll up to a position.
  for (let i = 0; i < 20; i += 1) {
    await page.locator('#message-input').fill(`stay-put-${i}`);
    await page.locator('#send-btn').click();
  }
  await expect(page.locator('#messages-area .msg-row', { hasText: 'stay-put-19' })).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    const area = globalThis.document.getElementById('messages-area');
    area.scrollTop = Math.round(area.scrollHeight / 3);
  });
  await page.waitForTimeout(900); // let the debounced anchor recorder persist

  const firstVisibleMsgId = await page.evaluate(() => {
    const area = globalThis.document.getElementById('messages-area');
    const row = Array.from(area.querySelectorAll('.msg-row[data-msg-id]:not([hidden])')).find((r) => {
      const rect = r.getBoundingClientRect();
      const aRect = area.getBoundingClientRect();
      return rect.bottom > aRect.top + 2 && rect.top < aRect.bottom;
    });
    return row ? String(row.dataset.msgId) : null;
  });
  const scrollBefore = await page.evaluate(() => globalThis.document.getElementById('messages-area').scrollTop);
  expect(firstVisibleMsgId).toBeTruthy();
  expect(scrollBefore).toBeGreaterThan(0);

  // Switch to another group (background resync runs), then switch back — the
  // transcript must re-attach with the reading position intact (the oldest
  // message is legitimately above the viewport after the restore).
  const globalItem = page.locator('#group-list .group-item', { hasText: 'GChat Global' }).first();
  await globalItem.click();
  await expect(page.locator('#chat-group-name')).toHaveText('GChat Global', { timeout: 10_000 });
  const playgroundItem = page.locator('#group-list .group-item', { hasText: GROUP_NAME }).first();
  await playgroundItem.click();
  await expect(page.locator('#chat-group-name')).toHaveText(GROUP_NAME, { timeout: 10_000 });
  await expect(page.locator('#messages-area .msg-row').first()).toBeVisible({ timeout: 10_000 });

  const scrollAfter = await page.evaluate(() => globalThis.document.getElementById('messages-area').scrollTop);
  const firstVisibleMsgIdAfter = await page.evaluate(() => {
    const area = globalThis.document.getElementById('messages-area');
    const row = Array.from(area.querySelectorAll('.msg-row[data-msg-id]:not([hidden])')).find((r) => {
      const rect = r.getBoundingClientRect();
      const aRect = area.getBoundingClientRect();
      return rect.bottom > aRect.top + 2 && rect.top < aRect.bottom;
    });
    return row ? String(row.dataset.msgId) : null;
  });

  // The exact first-visible message and its pixel offset are preserved.
  expect(firstVisibleMsgIdAfter, 'first visible message must not change across the switch').toBe(firstVisibleMsgId);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(1);
});

test('inactive-channel traffic preserves the active transcript pixel offset', async ({ browser }) => {
  const rootContext = await browser.newContext();
  const friendContext = await browser.newContext();
  const rootPage = await rootContext.newPage();
  const friendPage = await friendContext.newPage();
  await signInAsRoot(rootPage);
  await registerFreshUser(friendPage);
  await openGroup(rootPage);
  await openGroup(friendPage);

  for (let i = 0; i < 18; i += 1) {
    await rootPage.locator('#message-input').fill(`inactive-anchor-${i}`);
    await rootPage.locator('#message-input').press('Enter');
  }
  await rootPage.evaluate(() => {
    const area = globalThis.document.getElementById('messages-area');
    area.scrollTop = Math.round(area.scrollHeight / 3);
  });
  await rootPage.waitForTimeout(500);
  const before = await rootPage.locator('#messages-area').evaluate((area) => area.scrollTop);

  await friendPage.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' }).click();
  await friendPage.locator('#message-input').fill(`inactive-anchor-event-${Date.now()}`);
  await friendPage.locator('#message-input').press('Enter');
  await rootPage.waitForTimeout(800);

  const after = await rootPage.locator('#messages-area').evaluate((area) => area.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  await rootContext.close();
  await friendContext.close();
});

test('exhausted channel history never requests a raw message UUID cursor', async ({ page }) => {
  await signInAsRoot(page);
  await openGroup(page);
  const badRequests = [];
  page.on('response', (response) => {
    const url = response.url();
    if (/\/messages\?channel=.*&before=[0-9a-f-]{36}/i.test(url)) {
      badRequests.push({ url, status: response.status() });
    }
  });
  await page.locator('.chat-tag-filter-btn', { hasText: '#visual-qa' }).click();
  await page.locator('.chat-tag-filter-btn', { hasText: '#main' }).click();
  await page.locator('#messages-area').evaluate((area) => { area.scrollTop = 0; });
  await page.waitForTimeout(500);
  expect(badRequests).toEqual([]);
});
