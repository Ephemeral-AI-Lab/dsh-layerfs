// Shared browser helpers for tools/shot.mjs step modules.
export async function dismiss(page) {
  for (let i = 0; i < 4; i++) {
    const cont = page.getByRole('button', { name: 'Continue' })
    if (await cont.count()) { await cont.first().click(); await page.waitForTimeout(400); continue }
    const dialog = page.getByRole('dialog')
    if (await dialog.count()) {
      const close = dialog.getByRole('button', { name: /close/i })
      if (await close.count()) { await close.first().click(); await page.waitForTimeout(400); continue }
      await page.keyboard.press('Escape'); await page.waitForTimeout(400); continue
    }
    break
  }
}
export async function openPanel(page, label) {
  await dismiss(page)
  await page.locator('[class*=panelTitle]', { hasText: new RegExp(`^${label}$`) }).first().click()
  await page.waitForTimeout(1500)
}
