import { test, expect, type Page } from '@playwright/test';

async function join(page: Page, code: string, name: string) {
  await page.goto('/');
  await page.getByLabel('房间号').fill(code);
  await page.getByLabel('昵称').fill(name);
  await page.getByRole('button', { name: '加入房间' }).click();
}

test('full room: 6th is rejected, 5 players play, scores come from the server', async ({ browser }) => {
  const code = `E${Date.now().toString(36).slice(-6)}`;
  const pages: Page[] = [];
  for (let i = 0; i < 5; i++) {
    const page = await (await browser.newContext()).newPage();
    await join(page, code, `玩家${i + 1}`);
    await expect(page.getByTestId('room-code')).toHaveText(code.toUpperCase());
    pages.push(page);
  }
  // Room is full -> skips the 30s window and goes straight into 3-2-1.
  await expect(pages[0].getByTestId('countdown')).toBeVisible();

  const late = await (await browser.newContext()).newPage();
  await join(late, code, '迟到者');
  await expect(late.getByRole('alert')).toContainText('房间已满');

  const [me] = pages;
  await expect(me.getByTestId('game-timer')).toBeVisible({ timeout: 6000 });
  await expect(me.getByTestId('score-row')).toHaveCount(5);

  // Grab a few coins: the optimistic effect shows instantly, the score follows the server.
  let grabbed = 0;
  for (let attempt = 0; attempt < 6 && grabbed < 2; attempt++) {
    const coin = me.getByTestId('coin');
    await coin.waitFor({ timeout: 6000 });
    // Pin the exact cell (a re-resolving locator would chase the *next* coin).
    const cellIndex = await coin.locator('xpath=..').getAttribute('data-cell');
    const cell = me.locator(`[data-cell="${cellIndex}"]`);
    // Spam the same coin within ~100ms: only one request may reach the server.
    await cell.evaluate(el => { for (let i = 0; i < 10; i++) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    await expect(me.getByTestId('fx-won').or(me.getByTestId('fx-lost'))).toBeVisible();
    grabbed++;
    await expect(me.getByTestId('my-score')).toHaveText(String(grabbed));
  }
  // Everyone sees the same authoritative score for player 1.
  await expect(pages[3].getByTestId('score-row').filter({ hasText: '玩家1' })).toContainText(String(grabbed));
});
