// Shots for docs/guide/machine.md: the machine page (docker and native), its tabs,
// its ⋯ menu and dialogs, the Machines board on Home and the Add machine dialog.
// Read-only: every dialog is opened and closed (Escape) without its action.

/** Jump to: type `query`, open the option whose accessible name matches `option`. */
async function jump(page, h, query, option) {
  await h.center()
  await page.locator('header[aria-label="Home navigation"]').getByRole('button', { name: 'Jump to' }).first().click()
  await page.getByRole('combobox', { name: 'Jump to' }).fill(query)
  await h.wait(500)
  await page.getByRole('option', { name: option }).first().click()
  await h.wait(1500)
}
/** A tab whose name starts with `name` (a count may follow it). */
async function tab(page, h, name, ms = 2500) {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).first().click()
  await h.wait(ms)
}
const docker = (page, h) => jump(page, h, 'docker', /^docker Docker/)
const panel = (page) => page.getByRole('tabpanel').first()
const dialog = (page) => page.getByRole('dialog').first()

/** Home's Machines tab with the docker row open. */
async function board(page, h) {
  await h.home()
  await page.getByRole('tab', { name: /^Machines/ }).first().click()
  await h.wait(2500)
  const toggle = page.getByRole('button', { name: 'Show what docker holds' })
  if (await toggle.count()) { await toggle.first().click(); await h.wait(800) }
}

export default [
  { file: 'machine-overview',
    run: async (page, h) => { await docker(page, h); await tab(page, h, 'Overview', 4000); await h.see('Healthy') },
    callouts: [
      (p) => p.getByRole('tablist').first(),
      (p) => panel(p).getByRole('heading', { name: 'docker' }),
      (p) => p.getByRole('button', { name: 'Stop worker (docker)' }),
      (p) => p.getByRole('button', { name: 'More for docker' }),
      (p) => p.locator('[data-ov-usage]'),
      (p) => p.getByRole('button', { name: 'Where it goes' }),
      (p) => p.locator('[data-machine-details]'),
      (p) => p.getByRole('button', { name: 'Run diagnostics' }),
      (p) => p.locator('[data-machine-details]').getByRole('button', { name: 'Update settings…' }),
    ] },
  { file: 'machine-menu',
    run: async (page, h) => {
      await docker(page, h); await tab(page, h, 'Overview', 1500)
      await page.getByRole('button', { name: 'More for docker' }).click(); await h.wait(600)
    },
    clip: (p) => p.getByRole('menu'), pad: 60 },
  { file: 'machine-force-stop',
    run: async (page, h) => {
      await docker(page, h); await tab(page, h, 'Overview', 1500)
      await page.getByRole('button', { name: 'More for docker' }).click(); await h.wait(500)
      await page.getByRole('menuitem', { name: 'Force stop…' }).click(); await h.wait(800)
      await dialog(page).getByText('Force stop docker?').waitFor()
    },
    clip: (p) => dialog(p), pad: 24 },
  { file: 'machine-settings',
    run: async (page, h) => {
      await docker(page, h); await tab(page, h, 'Overview', 1500)
      await page.locator('[data-machine-details]').getByRole('button', { name: 'Update settings…' }).click(); await h.wait(800)
      await dialog(page).getByText('Update settings').first().waitFor()
    },
    clip: (p) => dialog(p), pad: 24 },
  { file: 'machine-space', size: '1440x1500',
    run: async (page, h) => {
      await docker(page, h); await tab(page, h, 'Overview', 3000)
      await page.getByRole('button', { name: 'Where it goes' }).click(); await h.wait(1500)
      await page.locator('[data-space-breakdown]').waitFor({ timeout: 20000 })
    },
    clip: (p) => dialog(p), pad: 24 },
  { file: 'machine-sandboxes',
    run: async (page, h) => { await docker(page, h); await tab(page, h, 'Sandboxes', 4000); await page.locator('[data-sb-card="guide-box"]').waitFor() },
    callouts: [
      (p) => p.getByRole('group', { name: 'Show Sandboxes' }),
      (p) => panel(p).getByRole('button', { name: 'New Sandbox' }),
      (p) => p.locator('[data-sb-card="guide-box"] button').first(),
      (p) => p.locator('[data-sb-card="guide-box"]').getByRole('button', { name: 'More for Sandbox guide-box' }),
      (p) => p.locator('[data-sb-card="guide-box"] [data-sb-image]'),
      (p) => p.locator('[data-sb-card="guide-box"] dl'),
      (p) => p.locator('[data-sb-card="guide-box"]').getByRole('button', { name: 'Terminals' }),
    ] },
  { file: 'machine-sandbox-card',
    run: async (page, h) => { await docker(page, h); await tab(page, h, 'Sandboxes', 4000); await page.locator('[data-sb-card="guide-box"]').waitFor() },
    clip: (p) => p.locator('[data-sb-card="guide-box"]'), pad: 16 },
  { file: 'machine-new-sandbox',
    run: async (page, h) => {
      await docker(page, h); await tab(page, h, 'Sandboxes', 2000)
      await panel(page).getByRole('button', { name: 'New Sandbox' }).click(); await h.wait(1500)
      const d = dialog(page)
      await d.getByRole('button', { name: 'Project' }).click(); await h.wait(500)
      await page.getByRole('menuitem', { name: 'demo-starter/bookshelf' }).click()
      await h.wait(1200)
    },
    clip: (p) => dialog(p), pad: 24 },
  { file: 'machine-images',
    run: async (page, h) => { await docker(page, h); await tab(page, h, 'Images', 5000); await page.locator('[data-images-stored]').waitFor() },
    callouts: [
      (p) => p.locator('[data-images-disk]'),
      (p) => p.locator('[data-images-stored] li').first(),
      (p) => p.locator('[data-images-stored] li').first().getByRole('button', { name: 'New Sandbox' }),
      (p) => p.getByText('Images are copied here from Docker once.'),
      (p) => panel(p).getByRole('textbox', { name: 'Search Docker images' }),
      (p) => panel(p).getByRole('button', { name: 'Refresh' }),
      (p) => p.locator('[data-copy-image]').first(),
    ] },
  { file: 'machine-files',
    run: async (page, h) => {
      await docker(page, h); await tab(page, h, 'Files', 3000)
      await h.see('Data disk')
      await page.getByRole('button', { name: 'Logs/layerfs/data/log' }).click(); await h.wait(2500)
    },
    callouts: [
      (p) => p.getByRole('tablist', { name: 'View' }),
      (p) => p.getByRole('textbox', { name: 'Path' }),
      (p) => p.getByRole('button', { name: 'Go to path' }),
      (p) => panel(p).getByRole('button', { name: 'Refresh' }),
      (p) => p.getByRole('textbox', { name: 'Filter loaded entries' }),
      (p) => p.getByRole('treeitem', { name: /^Logs/ }),
    ] },
  { file: 'machine-log',
    run: async (page, h) => { await docker(page, h); await tab(page, h, 'Worker log', 4000); await h.see(/Following/) },
    callouts: [
      (p) => p.getByRole('textbox', { name: 'Find in loaded lines' }),
      (p) => p.locator('[data-log-status]'),
      (p) => p.getByRole('button', { name: 'Wrap' }),
      (p) => panel(p).getByRole('button', { name: 'Copy' }),
      (p) => p.getByRole('button', { name: 'Read again' }),
      (p) => p.locator('[data-log-scroll]'),
    ] },
  { file: 'machine-native',
    run: async (page, h) => { await jump(page, h, 'LayerFS Home', /^LayerFS Home/); await tab(page, h, 'Overview', 4000); await page.locator('[data-machine-details]').waitFor() },
  },
  { file: 'machine-board',
    run: async (page, h) => { await board(page, h); await page.locator('[data-machine="docker"] [data-sandbox-row="guide-box"]').waitFor() },
    callouts: [
      (p) => p.getByRole('button', { name: 'Hide what docker holds' }),
      (p) => p.locator('[data-machine="docker"]').getByRole('button', { name: 'docker', exact: true }),
      (p) => p.locator('[data-machine="docker"] [role="row"] [role="cell"]').nth(1),
      (p) => p.locator('[data-machine="docker"] [role="row"] [role="cell"]').nth(2),
      (p) => p.locator('[data-machine="docker"] [role="row"] [role="cell"]').nth(3),
      (p) => p.locator('[data-machine="docker"] [role="row"] [role="cell"]').nth(4),
      (p) => p.getByRole('button', { name: 'Stop worker (docker)' }),
      (p) => p.getByRole('button', { name: 'More for docker' }),
      (p) => p.locator('[data-machine="docker"]').getByRole('button', { name: /Add Store/ }),
      (p) => p.locator('[data-machine="docker"]').getByRole('button', { name: /New Sandbox/ }),
      (p) => p.locator('[data-machine="docker"] [data-sandbox-row="guide-box"]'),
      (p) => p.getByRole('button', { name: 'New machine' }),
    ] },
  { file: 'machine-add',
    run: async (page, h) => {
      await board(page, h)
      await page.getByRole('button', { name: 'New machine' }).click(); await h.wait(1500)
      await dialog(page).getByText('Add a machine').first().waitFor()
      await dialog(page).getByRole('button', { name: /^Create Lima/ }).first().click(); await h.wait(1500)
    },
    clip: (p) => dialog(p), pad: 24 },
]
