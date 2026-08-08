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

// v1.3.12: the app restores the last-open group on boot, so at a mobile
// viewport the sidebar may be hidden behind the chat view. This helper opens
// the sidebar when needed and clicks the requested group in the list (scoped
// to #group-list so the topbar title can never collide).
async function clickGroup(page, name) {
  const toggle = page.locator('#sidebar-toggle, #sidebar-toggle-empty').first();
  if (await toggle.isVisible()) {
    await toggle.click();
  }
  const item = page.locator('#group-list .group-item', { hasText: name }).first();
  await item.click();
  await expect(page.locator('.chat-topbar-name')).toHaveText(name);
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
  await expect(logo).toHaveAttribute('src', /gchat_icon\.png\?v=20\d{6}-v\d+$/);
});

test('auth screen renders a theme-aware animated dot canvas behind the card', async ({ page }) => {
  await page.goto('/index.html');
  const canvas = page.locator('#auth-wave-canvas');
  const card = page.locator('.auth-card');
  const bottomDotPixels = () => page.evaluate(() => {
    const canvasElement = globalThis.document.querySelector('#auth-wave-canvas');
    const context = canvasElement.getContext('2d');
    const stripHeight = Math.max(1, Math.round(18 * (canvasElement.height / globalThis.innerHeight)));
    const pixels = context.getImageData(
      0,
      canvasElement.height - stripHeight,
      canvasElement.width,
      stripHeight,
    ).data;
    let visibleDots = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 230 && pixels[index + 1] > 230 && pixels[index + 2] > 230) {
        visibleDots += 1;
      }
    }
    return visibleDots;
  });
  await expect(canvas).toBeVisible();
  await expect(card).toBeVisible();
  const layers = await page.evaluate(() => {
    const canvasElement = globalThis.document.querySelector('#auth-wave-canvas');
    const cardElement = globalThis.document.querySelector('.auth-card');
    return {
      canvasPixels: [canvasElement.width, canvasElement.height],
      canvasZ: Number(globalThis.getComputedStyle(canvasElement).zIndex),
      cardZ: Number(globalThis.getComputedStyle(cardElement).zIndex),
      pointCount: Number(canvasElement.dataset.pointCount),
      nearDepth: Number(canvasElement.dataset.nearDepth),
      renderer: canvasElement.dataset.renderer,
    };
  });
  expect(layers.canvasPixels[0]).toBeGreaterThan(0);
  expect(layers.canvasPixels[1]).toBeGreaterThan(0);
  expect(layers.cardZ).toBeGreaterThan(layers.canvasZ);
  expect(layers.pointCount).toBeGreaterThan(2000);
  expect(layers.pointCount).toBeLessThan(8000);
  expect(layers.nearDepth).toBeLessThan(0);
  expect(layers.renderer).toBe('perspective-dot-wave');
  await expect.poll(bottomDotPixels).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(canvas).toBeVisible();
  await expect.poll(bottomDotPixels).toBeGreaterThan(0);
});

test('local root account loads v2 fixtures and switches themes', async ({ page }) => {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('status of 401')) errors.push(message.text());
  });
  await signInAsLocalRoot(page);
  await expect(page.getByText('Increment A Playground')).toBeVisible();
  await clickGroup(page, 'Increment A Playground');
  await expect(page.getByText('Welcome to the local UI playground', { exact: false })).toBeVisible();
  const chatPanel = page.locator('#chat-panel');
  const rightPanel = page.locator('#right-panel');
  await expect(page.locator('.chat-topbar')).toHaveCSS('display', 'flex');
  await expect(page.locator('.msg-mobile-actions-btn:visible')).toHaveCount(0);
  const expandedChatWidth = await chatPanel.evaluate((element) => element.getBoundingClientRect().width);
  await page.locator('#right-panel-toggle').click();
  await expect(rightPanel).toHaveClass(/desktop-collapsed/);
  await expect(rightPanel).toHaveCSS('width', '0px');
  await expect.poll(() => chatPanel.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(expandedChatWidth + 200);
  await page.locator('#right-panel-toggle').click();
  await expect(rightPanel).not.toHaveClass(/desktop-collapsed/);

  const welcomeRow = page.getByText('Welcome to the local UI playground', { exact: false }).locator('xpath=ancestor::div[contains(@class, "msg-row")]');
  await welcomeRow.click({ button: 'right' });
  await expect(page.locator('#ctx-menu')).toBeVisible();
  await expect(page.locator('#ctx-copy')).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(page.locator('#ctx-menu')).toBeHidden();

  const replyBox = page.locator('.msg-reply-box').first();
  await expect(replyBox).toHaveCSS('font-size', '10px');
  await expect(replyBox).toHaveCSS('border-left-width', '1px');
  await expect(replyBox.locator('.msg-reply-sender')).toHaveCSS('font-weight', '400');
  await page.locator('#whisper-mode-btn').click();
  await expect(page.locator('#whisper-picker')).toBeVisible();
  await expect(page.locator('#whisper-picker-confirm')).toBeVisible();
  await page.locator('#theme-toggle-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
  const afterFirst = await page.locator('html').getAttribute('data-theme');
  await expect(page.locator('.brand-icon')).toHaveAttribute(
    'src',
    afterFirst === 'light' ? /gchat_icon_light\.png$/ : /gchat_icon\.png\?v=20\d{6}-v\d+$/,
  );
  await page.locator('#theme-toggle-btn').click();
  const afterSecond = await page.locator('html').getAttribute('data-theme');
  expect(afterSecond).not.toBe(afterFirst);
  expect(['light', 'dark']).toContain(afterSecond);
  await expect(page.locator('.brand-icon')).toHaveAttribute(
    'src',
    afterSecond === 'light' ? /gchat_icon_light\.png$/ : /gchat_icon\.png\?v=20\d{6}-v\d+$/,
  );
  expect(errors).toEqual([]);
});

test('message stream remains usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsLocalRoot(page);
  await clickGroup(page, 'Increment A Playground');
  await expect(page.locator('.msg-row').first()).toBeVisible();
  const width = await page.locator('.chat-panel').evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(390.1);
});

test('mobile message actions and channel controls remain touch accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsLocalRoot(page);
  await clickGroup(page, 'Increment A Playground');

  const topbarLayout = await page.locator('.chat-topbar').evaluate((topbar) => {
    const filters = topbar.querySelector('#chat-tag-filters');
    const details = topbar.querySelector('#right-panel-toggle');
    const filtersRect = filters.getBoundingClientRect();
    const detailsRect = details.getBoundingClientRect();
    return {
      filtersTop: filtersRect.top,
      detailsBottom: detailsRect.bottom,
      topbarHeight: topbar.getBoundingClientRect().height,
    };
  });
  expect(topbarLayout.filtersTop).toBeGreaterThanOrEqual(topbarLayout.detailsBottom);
  expect(topbarLayout.topbarHeight).toBeGreaterThanOrEqual(80);

  // The channel chips re-render asynchronously (unread counts + cursor
  // broadcasts), so resolve the chip AFTER the app settles and let click()
  // retry detaches instead of scrollIntoViewIfNeeded (which aborts on them).
  await page.waitForTimeout(1200);
  const visualQaChannel = page.getByRole('button', { name: '#visual-qa', exact: true });
  await expect(visualQaChannel).toBeVisible();
  await visualQaChannel.click();
  await expect(visualQaChannel).toHaveClass(/active/);

  await page.getByRole('button', { name: '#main', exact: true }).click();
  const firstOwnMessage = page.locator('.msg-row.own').first();
  const mobileActions = firstOwnMessage.getByRole('button', { name: 'Message actions', exact: true });
  await expect(mobileActions).toBeVisible();
  await expect(mobileActions).toHaveCSS('pointer-events', 'auto');
  await mobileActions.click();
  await expect(page.locator('#ctx-menu')).toBeVisible();
  await expect(page.locator('#ctx-reply')).toBeVisible();
  await expect(page.locator('#ctx-edit')).toBeVisible();
  await expect(page.locator('#ctx-delete')).toBeVisible();
});

test('composer modes use the active channel without legacy tokens or slash commands', async ({ page }) => {
  await signInAsLocalRoot(page);
  await clickGroup(page, 'Increment A Playground');

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
  await expect(page.locator('#messages-area').getByText('Hi', { exact: true })).toBeVisible();
  await expect(page.locator('#messages-area').getByText('Disappears 3s after read', { exact: true })).toBeVisible();

  await expect(page.locator('[data-command="/w "]')).toHaveCount(0);
  await expect(page.locator('[data-command="/d "]')).toHaveCount(0);
});

test('image attachments reserve message-row space and open usable viewer actions', async ({ page }) => {
  await signInAsLocalRoot(page);
  await clickGroup(page, 'Increment A Playground');

  const baselineImageCount = await page.locator('.msg-image').count();
  await page.locator('#messages-area').evaluate((area) => {
    const baselineImages = area.querySelectorAll('.msg-image').length;
    const state = { sawPending: false, gap: false };
    const inspect = () => {
      const hasPending = !!area.querySelector('.msg-row.pending');
      const hasNewImage = area.querySelectorAll('.msg-image').length > baselineImages;
      if (hasPending) state.sawPending = true;
      if (state.sawPending && !hasPending && !hasNewImage) state.gap = true;
    };
    const observer = new globalThis.MutationObserver(inspect);
    observer.observe(area, { childList: true, subtree: true });
    globalThis.__attachmentContinuity = state;
    globalThis.__attachmentContinuityObserver = observer;
  });
  await page.locator('#file-input').setInputFiles('public/gchat_icon.png');
  await expect(page.locator('.msg-image')).toHaveCount(baselineImageCount + 1);
  const image = page.locator('.msg-image').last();
  await expect(image).toBeVisible();
  expect(await page.evaluate(() => globalThis.__attachmentContinuity.gap)).toBe(false);
  await page.evaluate(() => globalThis.__attachmentContinuityObserver.disconnect());

  const imageRow = image.locator('xpath=ancestor::div[contains(@class, "msg-row")]');
  await expect(imageRow).toHaveCount(1);
  const imageHeight = await image.evaluate((element) => element.getBoundingClientRect().height);
  expect(imageHeight).toBeGreaterThan(0);

  const nextMessage = 'Attachment layout regression check';
  await page.locator('#message-input').fill(nextMessage);
  await page.locator('#message-input').press('Enter');
  const nextMessageText = page.locator('#messages-area').getByText(nextMessage, { exact: true });
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

  await page.evaluate(() => {
    Object.defineProperty(globalThis.navigator.clipboard, 'write', {
      configurable: true,
      value: async (items) => {
        globalThis.__copiedImageTypes = items[0].types;
      },
    });
  });
  await page.locator('#image-viewer-copy-btn').click();
  await expect.poll(() => page.evaluate(() => globalThis.__copiedImageTypes)).toEqual(['image/png']);

  const imageDownload = page.waitForEvent('download');
  await page.locator('#image-viewer-download-btn').click();
  await expect(imageDownload).resolves.toBeTruthy();

  await page.mouse.click(5, 5);
  await expect(page.locator('#image-viewer-modal')).toBeHidden();
  const baselineFileCount = await page.locator('.msg-file-btn').count();
  await page.locator('#file-input').setInputFiles('package.json');
  await expect(page.locator('.msg-file-btn')).toHaveCount(baselineFileCount + 1);
  const fileCard = page.locator('.msg-file-btn').last();
  await expect(fileCard).toBeVisible();
  await expect(fileCard.getByText('Download', { exact: true })).toBeVisible();
  const fileDownload = page.waitForEvent('download');
  await fileCard.click();
  await expect(fileDownload).resolves.toBeTruthy();
});

test('pasting multiple copied files sends all of them, one by one', async ({ page }) => {
  await signInAsLocalRoot(page);
  await clickGroup(page, 'Increment A Playground');
  await page.locator('#messages-area .msg-row, #messages-area .channel-empty-state').first().waitFor();

  const baselineFileCount = await page.locator('.msg-file-btn').count();
  // Simulate a Ctrl+V with three files on the clipboard (multi-copy paste).
  await page.locator('#message-input').evaluate((input) => {
    const dataTransfer = new globalThis.DataTransfer();
    dataTransfer.items.add(new globalThis.File(['alpha content'], 'alpha.txt', { type: 'text/plain' }));
    dataTransfer.items.add(new globalThis.File(['beta content'], 'beta.txt', { type: 'text/plain' }));
    dataTransfer.items.add(new globalThis.File(['gamma content'], 'gamma.txt', { type: 'text/plain' }));
    const event = new globalThis.ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
  });

  await expect(page.locator('.msg-file-btn')).toHaveCount(baselineFileCount + 3, { timeout: 15000 });
  const names = await page.locator('.msg-file-btn strong').allTextContents();
  for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
    expect(names).toContain(name);
  }
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

test('join flow accepts a six-character invite code', async ({ page }) => {
  await signInAsLocalRoot(page);
  await page.locator('#join-group-btn').click();
  await expect(page.locator('#join-modal')).toBeVisible();
  await expect(page.locator('#join-modal').getByText('Invite Code', { exact: true })).toBeVisible();
  await expect(page.locator('#join-group-code')).toHaveAttribute('maxlength', '6');
});

test('group details keep Invite stable and render a bounded group-icon preview', async ({ page }) => {
  await signInAsLocalRoot(page);
  await clickGroup(page, 'Increment A Playground');

  const invite = page.locator('#copy-code-btn');
  await expect(invite).toHaveText('Invite');
  await invite.click();
  await page.waitForTimeout(1700);
  await expect(invite).toHaveText('Invite');

  await page.locator('#set-group-color-btn').click();
  await page.locator('#group-icon-mode-image').click();
  const confirm = page.locator('#group-color-save-btn');
  await expect(confirm).toBeDisabled();
  await page.locator('#group-icon-input').setInputFiles('public/gchat_icon.png');
  await expect(confirm).toBeEnabled();
  const preview = page.locator('#group-icon-preview-img');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS('width', '96px');
  await expect(preview).toHaveCSS('height', '96px');
  await expect(preview).toHaveCSS('object-fit', 'cover');
});

test('edited messages stay decryptable after a channel re-render', async ({ page }) => {
  // Regression: edits re-encrypt metadata with a new revision; the cache used
  // to keep the stale metadata ciphertext, so any re-render from cache showed
  // "Unable to decrypt this message" for every edited message.
  await signInAsLocalRoot(page);
  await clickGroup(page, 'Increment A Playground');
  await page.locator('#messages-area .msg-row, #messages-area .channel-empty-state').first().waitFor();

  const original = `edit-orig-${Date.now()}`;
  const edited = `edit-done-${Date.now()}`;
  await page.locator('#message-input').fill(original);
  await page.locator('#message-input').press('Enter');
  const sentRow = page.locator('#messages-area .msg-row', { hasText: original }).last();
  await expect(sentRow.locator('.msg-text')).toHaveText(original, { timeout: 10000 });

  // Right-click → Edit, replace the text, save. (Locate by the edited text
  // afterwards — the original text no longer exists in the transcript.)
  await sentRow.click({ button: 'right' });
  await page.locator('#ctx-edit').click();
  await page.locator('.msg-edit-input').fill(edited);
  await page.locator('.msg-edit-save').click();
  await expect(page.locator('#messages-area .msg-text', { hasText: edited }).last()).toHaveText(edited, { timeout: 10000 });

  // Switch to a sub-channel and back — forces a full stream re-render from the
  // message cache (the path that used to fail GCM auth on stale metadata).
  await page.locator('.chat-tag-add-btn').click();
  await page.locator('#channel-name-input').fill(`qa-${Date.now() % 100000}`);
  await page.locator('#channel-confirm-btn').click();
  await expect(page.locator('#messages-area .channel-empty-state')).toBeVisible();
  await page.locator('.chat-tag-filter-btn', { hasText: '#main' }).first().click();
  await expect(page.locator('#messages-area .msg-text', { hasText: edited }).last()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#messages-area').getByText('Unable to decrypt this message', { exact: true })).toHaveCount(0);
});

test('messages sent from a second device appear in a background group without reload', async ({ browser }) => {  // Two devices, one account. Device A opens "GChat Global" (filling its cache),
  // then switches to another group. Device B then sends a message into GChat
  // Global. Device A must see it when switching back — no reload, no stale
  // cache, and no reliance on reopening the tab.
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageErrors = [];
  pageA.on('pageerror', (error) => pageErrors.push('A: ' + error.message));
  pageB.on('pageerror', (error) => pageErrors.push('B: ' + error.message));

  await signInAsLocalRoot(pageA);
  // Prime device A's cache for GChat Global first.
  await clickGroup(pageA, 'GChat Global');
  await expect(pageA.locator('.chat-topbar-name')).toHaveText('GChat Global');
  await pageA.locator('#messages-area .msg-row, #messages-area .channel-empty-state').first().waitFor();
  // Then move device A to a different group so Global runs in the background.
  await clickGroup(pageA, 'Increment A Playground');
  await expect(pageA.locator('.chat-topbar-name')).toHaveText('Increment A Playground');

  // Device B (same account) sends a message into GChat Global.
  await signInAsLocalRoot(pageB);
  await clickGroup(pageB, 'GChat Global');
  await expect(pageB.locator('.chat-topbar-name')).toHaveText('GChat Global');
  const syncText = `sync-check-${Date.now()}`;
  await pageB.locator('#message-input').fill(syncText);
  await pageB.locator('#send-btn').click();
  await expect(pageB.locator('.msg-text', { hasText: syncText }).last()).toBeVisible();

  // Device A: switch back — the new message must already be there.
  await clickGroup(pageA, 'GChat Global');
  await expect(pageA.locator('.msg-text', { hasText: syncText }).last()).toBeVisible({ timeout: 10000 });
  expect(pageErrors).toEqual([]);

  await contextA.close();
  await contextB.close();
});

test('a sent message always shows its own sender header, never another user', async ({ browser }) => {
  // v1.3.14 regression: the optimistic-send path merged the message into the
  // cache before building its row, so the series scan found the message ITSELF
  // and rendered it as a continuation — no name header, time in the avatar
  // gutter — visually gluing the sender's own message to the previous (often
  // another user's) message block.
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await signInAsLocalRoot(pageA);
  await clickGroup(pageA, 'Increment A Playground');
  await pageA.locator('#messages-area .msg-row, #messages-area .channel-empty-state').first().waitFor();

  // Friend signs up and joins the fixture group via its invite code.
  await pageB.goto('/');
  await pageB.locator('.auth-tab[data-tab=signup]').click();
  const friendName = `friend${Date.now() % 100000}`;
  await pageB.locator('#signup-username').fill(friendName);
  await pageB.locator('#signup-password').fill('probe-pass');
  await pageB.locator('#signup-confirm').fill('probe-pass');
  await pageB.locator('#signup-btn').click();
  await pageB.locator('#group-list').first().waitFor({ timeout: 15000 });
  await pageB.locator('#join-group-btn').click();
  await pageB.locator('#join-group-code').fill('inca01');
  await pageB.locator('#join-confirm-btn').click();
  await pageB.waitForTimeout(800);
  await clickGroup(pageB, 'Increment A Playground');

  // A sends, then B sends immediately after (same day, minutes apart) — the
  // harshest condition for the identity-gluing bug. B then sends a second
  // message to prove legitimate same-sender continuations still collapse.
  const textA = `a-send-${Date.now()}`;
  const textB = `b-send-${Date.now()}`;
  const textB2 = `b-send-2-${Date.now()}`;
  await pageA.locator('#message-input').fill(textA);
  await pageA.locator('#message-input').press('Enter');
  await pageA.waitForTimeout(600);
  await pageB.locator('#message-input').fill(textB);
  await pageB.locator('#message-input').press('Enter');
  await pageB.waitForTimeout(400);
  await pageB.locator('#message-input').fill(textB2);
  await pageB.locator('#message-input').press('Enter');

  // On B's screen, B's first message (which follows A's, a DIFFERENT sender)
  // must carry B's own name header + letter avatar — the pre-fix bug rendered
  // it headerless and glued it to A's block.
  const bOwnRow = pageB.locator('#messages-area .msg-row.own', { hasText: textB }).last();
  await expect(bOwnRow).toBeVisible({ timeout: 10000 });
  await expect(bOwnRow.locator('.msg-sender-name')).toHaveText(friendName);
  await expect(bOwnRow).not.toHaveClass(/series-continued/);
  await expect(bOwnRow.locator('.msg-avatar')).toHaveText(friendName[0].toUpperCase());

  // B's SECOND message follows B's own — the legitimate series continuation
  // must still collapse into the same block (no duplicate headers).
  const bOwnRow2 = pageB.locator('#messages-area .msg-row.own', { hasText: textB2 }).last();
  await expect(bOwnRow2).toHaveClass(/series-continued/);

  // On A's screen, B's message shows B's identity and is never A's own.
  const bRowOnA = pageA.locator('#messages-area .msg-row', { hasText: textB }).last();
  await expect(bRowOnA).toBeVisible({ timeout: 10000 });
  await expect(bRowOnA.locator('.msg-sender-name')).toHaveText(friendName);
  await expect(bRowOnA).not.toHaveClass(/own/);
  const aOwnRow = pageA.locator('#messages-area .msg-row.own', { hasText: textA }).last();
  await expect(aOwnRow).toHaveAttribute('data-sender-id', /local-debug-root/);
  await expect(aOwnRow).not.toContainText(friendName);

  await contextA.close();
  await contextB.close();
});

test('duplicate channel names are rejected at creation', async ({ page }) => {
  await signInAsLocalRoot(page);
  await clickGroup(page, 'Increment A Playground');
  await page.locator('#messages-area .msg-row, #messages-area .channel-empty-state').first().waitFor();

  const channelName = `dup-${Date.now() % 100000}`;
  await page.locator('.chat-tag-add-btn').click();
  await page.locator('#channel-name-input').fill(channelName);
  await page.locator('#channel-confirm-btn').click();
  const chip = page.locator('.chat-tag-filter-btn', { hasText: `#${channelName}` });
  await expect(chip).toHaveCount(1);

  // Exact duplicate: the modal must stay open with an error and no second chip.
  await page.locator('.chat-tag-add-btn').click();
  await page.locator('#channel-name-input').fill(channelName);
  await page.locator('#channel-confirm-btn').click();
  await expect(page.locator('#channel-error')).toHaveText(/already exists/);
  await expect(page.locator('#channel-modal')).toBeVisible();
  await expect(chip).toHaveCount(1);

  // Normalized duplicate ('#' prefix + uppercase) must also be rejected.
  await page.locator('#channel-name-input').fill(`#${channelName.toUpperCase()}`);
  await page.locator('#channel-confirm-btn').click();
  await expect(page.locator('#channel-error')).toHaveText(/already exists/);
  await expect(chip).toHaveCount(1);

  // Cancel clears the error, and a fresh unique name still creates a channel.
  await page.locator('#channel-cancel-btn').click();
  await expect(page.locator('#channel-error')).toHaveText('');
  const secondName = `ok-${Date.now() % 100000}`;
  await page.locator('.chat-tag-add-btn').click();
  await page.locator('#channel-name-input').fill(secondName);
  await page.locator('#channel-confirm-btn').click();
  await expect(page.locator('.chat-tag-filter-btn', { hasText: `#${secondName}` })).toHaveCount(1);
});

test('right-clicking a message timestamp opens the message menu, not the profile invite menu', async ({ page }) => {
  await signInAsLocalRoot(page);
  await clickGroup(page, 'Increment A Playground');
  await page.locator('#messages-area .msg-row, #messages-area .channel-empty-state').first().waitFor();

  // Two quick consecutive messages: the second continues the series, so its
  // timestamp is rendered inside the avatar gutter.
  const first = `series-a-${Date.now()}`;
  const second = `series-b-${Date.now()}`;
  await page.locator('#message-input').fill(first);
  await page.locator('#message-input').press('Enter');
  await expect(page.locator('#messages-area .msg-row', { hasText: first }).last().locator('.msg-text')).toHaveText(first);
  await page.locator('#message-input').fill(second);
  await page.locator('#message-input').press('Enter');
  const continuedRow = page.locator('#messages-area .msg-row.series-continued', { hasText: second }).last();
  await expect(continuedRow).toBeVisible();
  const continuationTime = continuedRow.locator('.msg-continuation-time');
  await expect(continuationTime).toHaveCount(1);

  // Right-click the timestamp: the message context menu opens and the
  // avatar/invite menu must stay hidden.
  await continuationTime.dispatchEvent('contextmenu');
  await expect(page.locator('#ctx-menu')).toBeVisible();
  await expect(page.locator('#avatar-ctx-menu')).toBeHidden();

  // Regression guard: right-clicking an actual member avatar still offers
  // the invite action.
  const miraItem = page.locator('#members-list .member-item', { hasText: 'Mira' }).first();
  await miraItem.locator('.member-avatar').click({ button: 'right' });
  await expect(page.locator('#avatar-ctx-menu')).toBeVisible();
  await expect(page.locator('#avatar-ctx-invite')).toContainText(/Invite Mira/i);
});
