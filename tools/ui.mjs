import { readFileSync } from 'node:fs'
import { join } from 'node:path'
/** The running dev server's authenticated URL (scripts/dev.mjs writes <dev dir>/url.txt). */
export function devUrl() {
  const dir = process.env.DSH_LAYERFS_DEV_DIR ?? new URL('../.dev', import.meta.url).pathname
  return readFileSync(join(dir, 'url.txt'), 'utf8').trim()
}
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
