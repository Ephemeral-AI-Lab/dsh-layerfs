// A tools/shot.mjs steps module for the Store upgrade UI (LayerFS #804): opens
// LayerFS Home, then the Store page of $STORE (default the first Store row),
// and reports what the page shows: the head's format signal, the Store menu's
// Upgrade…, the details Format row and any upgrade card. `UPGRADE=1` also
// opens Upgrade… and presses Upgrade (it starts a real upgrade: only on a
// Store of your own); `CANCEL=1` then presses Cancel.
//   STORE=w4-old node tools/shot.mjs <url|dev> /tmp/upgrade.png --steps tools/shot-store-upgrade.mjs
import { openPanel } from './ui.mjs'

export default async function (page, { logs }) {
  const say = (line) => logs.push(`[upgrade] ${line}`)
  await openPanel(page, 'LayerFS')
  await page.getByRole('tab', { name: /^Stores/ }).first().click().catch(() => page.getByText(/^Stores\s*\d*$/).first().click())
  await page.waitForTimeout(1000)
  const store = process.env.STORE
  const open = store ? page.getByTitle(`Open ${store}`, { exact: true }) : page.locator('[title^="Open "]')
  await open.first().click()
  await page.waitForTimeout(2000)
  const format = page.locator('[data-store-format]')
  say(`head format signal: ${(await format.count()) ? `${await format.first().getAttribute('data-store-format')} "${(await format.first().innerText()).trim()}"` : 'none'}`)
  await page.getByRole('button', { name: /actions$/ }).first().click()
  const item = page.getByRole('menuitem', { name: 'Upgrade…' })
  say(`menu Upgrade…: ${(await item.count()) ? (await item.first().isDisabled() ? 'disabled' : 'offered') : 'absent'}`)
  await page.keyboard.press('Escape')
  const details = page.getByText('Store details', { exact: false })
  if (await details.count()) { await details.first().click().catch(() => {}); await page.waitForTimeout(300) }
  const row = page.getByText(/^Format$/)
  say(`details Format: ${(await row.count()) ? (await row.first().locator('xpath=..').innerText().catch(() => '?')).replace(/\s+/g, ' ') : 'absent'}`)
  if (process.env.UPGRADE === '1' && (await item.count())) {
    await page.getByRole('button', { name: /actions$/ }).first().click()
    await page.getByRole('menuitem', { name: 'Upgrade…' }).first().click()
    const dialog = page.getByRole('dialog')
    say(`dialog: ${(await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 200)}`)
    await dialog.getByRole('button', { name: 'Upgrade', exact: true }).click()
    await page.waitForTimeout(800)
    if (process.env.CANCEL === '1') {
      await page.locator('[data-upgrade-cancel]').first().click().catch((e) => say(`cancel: ${e.message}`))
      await page.waitForTimeout(500)
    }
  }
  const card = page.locator('[data-upgrade]')
  say(`upgrade card: ${(await card.count()) ? `${await card.first().getAttribute('data-upgrade')} "${(await card.first().innerText()).replace(/\s+/g, ' ').trim()}"` : 'none'}`)
}
