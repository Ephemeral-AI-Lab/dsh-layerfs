import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
/** The running dev server's authenticated URL (scripts/dev.mjs writes <dev dir>/url.txt). */
export function devUrl() {
  const dir = process.env.DSH_LAYERFS_DEV_DIR ?? fileURLToPath(new URL('../.dev', import.meta.url))
  return readFileSync(join(dir, 'url.txt'), 'utf8').trim()
}
// Shared browser helpers for tools/shot.mjs step modules.

/**
 * Dialogs that cover the page (a welcome, a modal). DSH's phone sidebar is a
 * `role=dialog` drawer too (`data-shortcut-modal="sidebar"`): it is navigation,
 * opened on purpose by `openGlobalPanel`, and hidden while closed.
 */
const COVERING_DIALOG = '[role="dialog"]:not([data-shortcut-modal="sidebar"]):visible'
export async function dismiss(page) {
  for (let i = 0; i < 4; i++) {
    const cont = page.getByRole('button', { name: 'Continue' })
    if (await cont.count()) { await cont.first().click(); await page.waitForTimeout(400); continue }
    const dialog = page.locator(COVERING_DIALOG)
    if (await dialog.count()) {
      const close = dialog.first().getByRole('button', { name: /close/i })
      if (await close.count()) { await close.first().click(); await page.waitForTimeout(400); continue }
      await page.keyboard.press('Escape'); await page.waitForTimeout(400); continue
    }
    break
  }
}

const visible = (locator) => locator.first().isVisible().catch(() => false)

/**
 * A DSH global panel's row (`nav[aria-label="Global panels"]`, one button per
 * panel named by its label, wide or folded to the icon rail). Below 768 px the
 * sidebar is a drawer, closed by default: open it with the header's opener
 * (`[data-sidebar-opener]`, "Open sidebar") first, and close it if it stays open.
 */
async function openGlobalPanel(page, label) {
  const opener = page.locator('[data-sidebar-opener]')
  if (await visible(opener)) { await opener.first().click(); await page.waitForTimeout(400) }
  await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: label, exact: true }).first().click()
  await page.waitForTimeout(400)
  const drawer = page.locator('[data-shortcut-modal="sidebar"][aria-modal="true"]:visible')
  if (await drawer.count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400) }
}

/**
 * LayerFS pages reached from the LayerFS navigation bar
 * (`header[aria-label="Home navigation"]`, src/client/storage/Nav.tsx), by the
 * accessible name of their control: Doctor (Health), Logs and Settings are
 * icon buttons on every LayerFS page; on a phone (≤ 480 px) they fold into its
 * "More" menu as menu items.
 */
const CENTER_PAGES = { Health: 'Doctor', Doctor: 'Doctor', Logs: 'Logs', Settings: 'Settings' }
export async function openPanel(page, label) {
  await dismiss(page)
  const name = CENTER_PAGES[label]
  if (name) {
    const bar = page.locator('header[aria-label="Home navigation"]')
    if (!(await visible(bar))) {
      await openGlobalPanel(page, 'LayerFS')
      await bar.first().waitFor({ timeout: 15000 })
    }
    // "Doctor" or "Doctor: 3 findings" (a menu item's text); the button's name is the word itself.
    const named = new RegExp(`^${name}\\b`)
    const direct = bar.getByRole('button', { name: named })
    if (await visible(direct)) await direct.first().click()
    else {
      await bar.getByRole('button', { name: 'More', exact: true }).first().click()
      await page.getByRole('menuitem', { name: named }).first().click()
    }
    await page.waitForTimeout(1500)
    return
  }
  await openGlobalPanel(page, label)
  await page.waitForTimeout(1500)
}
