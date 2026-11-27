// Shots for docs/guide/sandbox.md: the Sandbox page of guide-box (docker), its tabs,
// the Workspace grid and terminal pane (Workspace guide-ws, mounted for the guide),
// the New workspace form, the Commit… dialog and the Delete dialogs.
// Read-only: forms and dialogs are opened and closed (Escape / Cancel) without their action.

async function jump(page, h, query, option) {
  await h.center()
  await page.locator('header[aria-label="Home navigation"]').getByRole('button', { name: 'Jump to' }).first().click()
  await page.getByRole('combobox', { name: 'Jump to' }).fill(query)
  await h.wait(500)
  await page.getByRole('option', { name: option }).first().click()
  await h.wait(1500)
}
async function tab(page, h, name, ms = 2500) {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).first().click()
  await h.wait(ms)
}
const box = (page, h) => jump(page, h, 'guide-box', /^guide-box/)
const panel = (page) => page.getByRole('tabpanel').first()
const dialog = (page) => page.getByRole('dialog').first()
const card = (page) => page.locator('[data-ws-card="guide-box:guide-ws"]')
/** The Workspaces tab in one of its views. */
async function workspaces(page, h, view) {
  await box(page, h); await tab(page, h, 'Workspaces', 3000)
  await page.locator(`[data-ws-view="${view}"]`).click(); await h.wait(1500)
  // a form or a choice left open by an earlier shot (the page keeps its state): back to the plain view
  const cancel = page.getByRole('button', { name: 'Mount' }).locator('xpath=ancestor::form[1]').getByRole('button', { name: 'Cancel' })
  if (await cancel.count()) { await cancel.first().click(); await h.wait(500) }
  for (const word of ['Clear', 'Show all']) {
    const b = page.locator('[data-ws-chosen]').getByRole('button', { name: word })
    if (await b.count()) { await b.first().click(); await h.wait(500) }
  }
  await h.wait(800)
}
/** The Terminals view with the guide's read-only command shown, run once when the pane has none yet. */
async function terminals(page, h) {
  await workspaces(page, h, 'terminals')
  const ran = page.getByText('head -n 6 README.md').first()
  if (!(await ran.isVisible().catch(() => false))) {
    await page.locator('input[data-term-input]').fill('head -n 6 README.md')
    await page.locator('input[data-term-input]').press('Enter')
  }
  await ran.waitFor()
  await page.getByText('Neighborhood library').first().waitFor({ timeout: 20000 }).catch(() => {})
  await h.wait(1000)
}
/** Open the Sandbox menu on the Overview. */
async function menu(page, h) {
  await box(page, h); await tab(page, h, 'Overview', 2000)
  await page.getByRole('button', { name: 'More for Sandbox guide-box' }).first().click(); await h.wait(600)
}

export default [
  { file: 'sandbox-overview',
    run: async (page, h) => { await box(page, h); await tab(page, h, 'Overview', 5000); await page.locator('[data-sandbox-daemon]').waitFor() },
    callouts: [
      (p) => p.getByRole('tablist').first(),
      (p) => p.locator('[data-sandbox-details]'),
      (p) => p.getByRole('button', { name: 'Diagnose' }),
      (p) => panel(p).getByRole('button', { name: 'Refresh' }),
      (p) => p.getByRole('button', { name: 'More for Sandbox guide-box' }),
      (p) => p.locator('[data-ov-usage]'),
      (p) => p.locator('[data-sandbox-disk]'),
      (p) => p.locator('[data-sandbox-daemon]'),
    ] },
  { file: 'sandbox-menu',
    run: menu,
    clip: (p) => p.getByRole('menu'), pad: 60 },
  { file: 'sandbox-delete',
    run: async (page, h) => { await menu(page, h); await page.getByRole('menuitem', { name: 'Delete Sandbox…', exact: true }).click(); await h.wait(800) },
    clip: (p) => dialog(p), pad: 24 },
  { file: 'sandbox-force-delete',
    run: async (page, h) => { await menu(page, h); await page.getByRole('menuitem', { name: 'Force delete Sandbox…' }).click(); await h.wait(800) },
    clip: (p) => dialog(p), pad: 24 },
  { file: 'sandbox-workspaces',
    run: async (page, h) => {
      await workspaces(page, h, 'grid')
      await card(page).waitFor()
      await card(page).getByRole('checkbox').first().click(); await h.wait(500)
    },
    callouts: [
      (p) => p.locator('[data-ws-count]'),
      (p) => p.locator('[data-ws-chosen]'),
      (p) => p.getByRole('group', { name: 'Show Workspaces as' }),
      (p) => p.getByRole('button', { name: 'New workspace' }).first(),
      (p) => card(p).getByRole('checkbox').first(),
      (p) => card(p).getByRole('button', { name: /guide-ws/ }).first(),
      (p) => card(p).locator('dl'),
      (p) => card(p).getByRole('button', { name: 'Terminal' }),
      (p) => p.locator('[data-ws-new]'),
    ] },
  { file: 'sandbox-new-workspace',
    run: async (page, h) => {
      await workspaces(page, h, 'grid')
      await page.locator('[data-ws-new]').click(); await h.wait(1500)
      await page.getByRole('button', { name: 'Mount' }).waitFor()
    },
    clip: (p) => p.getByRole('button', { name: 'Mount' }).locator('xpath=ancestor::form[1]'), pad: 16 },
  { file: 'sandbox-terminals',
    run: async (page, h) => {
      await terminals(page, h)
    },
    callouts: [
      (p) => p.locator('[data-ws-view="terminals"]'),
      (p) => p.locator('section[aria-label] header').filter({ hasText: 'guide-ws' }).first(),
      (p) => p.getByRole('button', { name: 'Maximize' }),
      (p) => p.getByRole('button', { name: /^More for/ }).last(),
      (p) => p.getByRole('button', { name: /^Close guide-ws/ }),
      (p) => p.getByRole('log').last(),
      (p) => p.locator('input[data-term-input]'),
    ] },
  { file: 'sandbox-terminal-pane',
    run: async (page, h) => {
      await terminals(page, h)
    },
    clip: (p) => p.locator('input[data-term-input]').locator('xpath=ancestor::section[1]'), pad: 12 },
  { file: 'sandbox-commit',
    run: async (page, h) => {
      await workspaces(page, h, 'terminals')
      await page.getByRole('button', { name: /^More for/ }).last().click(); await h.wait(500)
      await page.getByRole('menuitem', { name: 'Commit…' }).click(); await h.wait(800)
      await dialog(page).getByText('Commit guide-ws').waitFor()
    },
    clip: (p) => dialog(p), pad: 24 },
  { file: 'sandbox-files',
    run: async (page, h) => {
      await box(page, h); await tab(page, h, 'Files', 3000)
      await page.getByRole('tab', { name: 'Workspaces', exact: true }).last().click(); await h.wait(2500)
      await page.getByRole('treeitem', { name: /^Workspace guide-ws/ }).getByRole('button').first().click(); await h.wait(2500)
      await page.getByRole('treeitem', { name: /^README\.md/ }).getByRole('button').first().click(); await h.wait(2500)
      await h.see('Neighborhood library')
    },
    callouts: [
      (p) => p.getByRole('tablist', { name: 'View' }),
      (p) => p.getByRole('textbox', { name: 'Path' }),
      (p) => p.getByRole('textbox', { name: 'Filter loaded entries' }),
      (p) => p.getByRole('treeitem', { name: /^Workspace guide-ws/ }).getByRole('button').first(),
      (p) => p.getByRole('treeitem', { name: /^README\.md/ }).getByRole('button').first(),
    ] },
  { file: 'sandbox-log',
    run: async (page, h) => { await box(page, h); await tab(page, h, 'Daemon log', 4000); await h.see(/Following/) },
  },
]
