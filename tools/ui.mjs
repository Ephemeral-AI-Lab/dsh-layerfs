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
/** Center pages with their own button in Center's bar (not in the sidebar). */
const CENTER_PAGES = new Set(['Health', 'Logs', 'Settings'])
export async function openPanel(page, label) {
  await dismiss(page)
  if (CENTER_PAGES.has(label)) {
    const bar = page.locator('header[aria-label="Center navigation"]')
    if (!(await bar.isVisible().catch(() => false))) {
      await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'LayerFS', exact: true }).first().click()
      await bar.waitFor({ timeout: 15000 })
    }
    await bar.getByRole('button', { name: new RegExp(`^${label}\\b`) }).first().click()
    await page.waitForTimeout(1500)
    return
  }
  const titled = page.locator('[class*=panelTitle]', { hasText: new RegExp(`^${label}$`) }).first()
  // At narrow widths the sidebar collapses to icons: fall back to the entry's accessible name.
  if (await titled.isVisible().catch(() => false)) await titled.click()
  else await page.getByRole('button', { name: label, exact: true }).first().click()
  await page.waitForTimeout(1500)
}
