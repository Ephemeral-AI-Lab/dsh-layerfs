// Shots for docs/guide/store.md: the Store page, its ⋯ menu, its modals and the machine Stores board.
// Nothing here confirms anything: every modal is opened, shot, then closed (the runner presses Escape).
//   DSH_LAYERFS_DEV_DIR=$PWD/.dev-guide node tools/guide/shoot.mjs tools/guide/shots/store.mjs [--only <file>]

const bar = (page) => page.locator('header[aria-label="Home navigation"]')
const dialog = (page) => page.getByRole('dialog').last()
const menu = (page) => page.getByRole('menu').last()
const heading = (page, name) => page.getByRole('heading', { name, level: 1, exact: true })

/** The Store page of a SQLite Store, on `tab` (Overview, Projects, Backups). */
async function store(page, h, name, tab) {
  await h.jump(`${name} sqlite`)
  await heading(page, name).waitFor({ timeout: 20000 })
  if (tab) await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).first().click()
  await h.wait(2500)
}

/** The Store's ⋯ menu, open. */
async function storeMenu(page, name) {
  await page.getByRole('button', { name: `${name} actions` }).first().click()
  await menu(page).waitFor()
  await page.waitForTimeout(1000)
}

/** A row of the open menu. */
async function pick(page, item) {
  await menu(page).getByRole('menuitem', { name: item }).first().click()
  await dialog(page).waitFor({ timeout: 15000 })
  await page.waitForTimeout(1200)
}

/** The nav bar's Add menu, then one of its rows. */
async function add(page, h, item) {
  await h.center()
  await bar(page).getByRole('button', { name: 'Add', exact: true }).first().click()
  await menu(page).waitFor()
  await pick(page, item)
}

/** Home › Stores (the SQLite board, its Stores view). */
async function homeStores(page, h) {
  await h.home()
  await page.getByRole('tab', { name: /^Stores/ }).first().click()
  await h.wait(800)
  await page.getByRole('tab', { name: /^SQLite/ }).first().click()
  await page.getByRole('tab', { name: /^Stores \d/ }).first().click()
  await h.wait(2500)
}

/** A machine page's Stores tab (from the Store page's place link, so the Jump to list is not guessed). */
async function machineStores(page, h, machine) {
  if (machine === 'docker') {
    await store(page, h, 'demo-starter')
    await page.getByRole('button', { name: 'docker', exact: true }).first().click()
  }
  await h.wait(2000)
  await page.getByRole('tab', { name: /^Stores/ }).first().click()
  await h.wait(1000)
  // the board remembers its kind per machine: start on SQLite
  await page.getByRole('tab', { name: /^SQLite/ }).first().click()
  await h.wait(1500)
}

const card = (page, name) => page.locator(`[data-store="${name}"]`).first()

export default [
  // ---------- the page ----------
  {
    file: 'store-overview', size: '1440x1100',
    run: async (page, h) => { await store(page, h, 'demo-starter', 'Overview') },
    callouts: [
      (page) => bar(page),
      (page) => page.locator('header').filter({ has: heading(page, 'demo-starter') }).locator('[class*=heading]').first(),
      (page) => page.getByRole('button', { name: 'Check integrity' }),
      (page) => page.getByRole('button', { name: 'demo-starter actions' }),
      (page) => page.getByRole('tablist', { name: 'demo-starter tabs' }),
      (page) => page.locator('[aria-label="Store details"]'),
      (page) => page.locator('[data-store-file]'),
      (page) => page.locator('[data-store-shares]'),
      (page) => page.locator('[data-store-health]'),
      (page) => page.locator('summary', { hasText: 'Store details' }),
    ],
  },
  {
    file: 'store-details', size: '1440x1100',
    run: async (page, h) => {
      await store(page, h, 'demo-starter', 'Overview')
      await page.locator('summary', { hasText: 'Store details' }).click()
      await h.wait(600)
      await page.locator('details').filter({ hasText: 'Remove Store' }).scrollIntoViewIfNeeded()
    },
    clip: (page) => page.locator('details').filter({ hasText: 'Remove Store' }),
  },
  {
    file: 'store-projects',
    run: async (page, h) => { await store(page, h, 'demo-starter', 'Projects'); await h.wait(2000) },
    callouts: [
      (page) => page.getByRole('button', { name: 'Add project' }),
      (page) => page.locator('[role=tabpanel]').getByRole('table').first(),
    ],
  },
  {
    file: 'store-backups',
    run: async (page, h) => { await store(page, h, 'guide-notes', 'Backups') },
    callouts: [
      (page) => page.locator('[role=tabpanel]').getByRole('button', { name: 'Back up to…' }),
      (page) => page.locator('[data-backup-link="guide-backups"]'),
      (page) => page.locator('[data-backup-link="guide-backups"] [class*=statePill]'),
      (page) => page.locator('[data-backup-link="guide-backups"]').getByRole('button', { name: 'Back up now' }),
      (page) => page.locator('[data-backup-link="guide-backups"]').getByRole('button', { name: 'Restore…' }),
    ],
  },
  // ---------- the ⋯ menu ----------
  {
    file: 'store-menu-machine',
    run: async (page, h) => { await store(page, h, 'demo-starter'); await storeMenu(page, 'demo-starter') },
    clip: (page) => menu(page), pad: 16,
  },
  {
    file: 'store-menu-home',
    run: async (page, h) => { await store(page, h, 'guide-notes'); await storeMenu(page, 'guide-notes') },
    clip: (page) => menu(page), pad: 16,
  },
  // ---------- modals ----------
  {
    file: 'store-push',
    run: async (page, h) => { await store(page, h, 'guide-notes'); await storeMenu(page, 'guide-notes'); await pick(page, 'Push to…') },
    clip: dialog,
  },
  {
    file: 'store-move',
    run: async (page, h) => { await store(page, h, 'demo-starter'); await storeMenu(page, 'demo-starter'); await pick(page, 'Move to another machine…'); await h.wait(1500) },
    clip: dialog,
  },
  {
    file: 'store-backup',
    run: async (page, h) => { await store(page, h, 'guide-notes'); await storeMenu(page, 'guide-notes'); await pick(page, 'Back up to…') },
    clip: dialog,
  },
  {
    file: 'store-compact',
    run: async (page, h) => { await store(page, h, 'guide-notes'); await storeMenu(page, 'guide-notes'); await pick(page, 'Compact…') },
    clip: dialog,
  },
  {
    file: 'store-remove',
    run: async (page, h) => { await store(page, h, 'guide-notes'); await storeMenu(page, 'guide-notes'); await pick(page, 'Remove…') },
    clip: dialog,
  },
  {
    file: 'store-restore',
    run: async (page, h) => {
      await store(page, h, 'guide-notes', 'Backups')
      await page.locator('[data-backup-link="guide-backups"]').getByRole('button', { name: 'Restore…' }).click()
      await dialog(page).waitFor()
      await h.wait(800)
    },
    clip: dialog,
  },
  {
    file: 'store-add-project',
    run: async (page, h) => {
      await store(page, h, 'guide-notes', 'Projects')
      await page.getByRole('button', { name: 'Add project' }).click()
      await dialog(page).waitFor()
      await h.wait(800)
    },
    clip: dialog,
  },
  {
    file: 'store-new',
    run: async (page, h) => { await add(page, h, 'New Store') },
    clip: dialog,
  },
  {
    file: 'store-new-restore',
    run: async (page, h) => {
      await add(page, h, 'New Store')
      await dialog(page).getByRole('radio', { name: 'Restore from a backup' }).or(dialog(page).getByText('Restore from a backup', { exact: true })).first().click()
      await h.wait(800)
    },
    clip: dialog,
  },
  {
    file: 'store-connect-new',
    run: async (page, h) => { await add(page, h, 'Connect a database') },
    clip: dialog,
  },
  {
    file: 'store-connect-options',
    run: async (page, h) => {
      await add(page, h, 'Connect a database')
      await dialog(page).locator('summary', { hasText: 'More options' }).click()
      await h.wait(500)
    },
    clip: dialog,
  },
  {
    file: 'store-bucket-add',
    run: async (page, h) => { await add(page, h, 'Add bucket') },
    clip: dialog,
  },
  {
    file: 'store-backups-dialog',
    run: async (page, h) => {
      await homeStores(page, h)
      await card(page, 'guide-notes').getByRole('button', { name: /^Backups of guide-notes/ }).click()
      await dialog(page).waitFor()
      await h.wait(3000)
    },
    clip: dialog,
  },
  // ---------- Store cards and the machine Stores board ----------
  {
    file: 'store-card',
    run: async (page, h) => { await homeStores(page, h) },
    callouts: [
      (page) => card(page, 'guide-notes').getByRole('button', { name: 'guide-notes', exact: true }),
      (page) => card(page, 'guide-notes').getByRole('button', { name: 'guide-notes actions' }),
      (page) => card(page, 'guide-notes').getByRole('button', { name: 'LayerFS Home' }),
      (page) => card(page, 'guide-notes').locator('[class*=projects] button').first(),
      (page) => card(page, 'guide-notes').getByRole('button', { name: /^Backups of guide-notes/ }),
      (page) => card(page, 'guide-notes').getByRole('button', { name: 'Push to…' }),
    ],
    clip: (page) => page.locator('[class*=grid]').filter({ has: card(page, 'guide-notes') }).first(), pad: 28,
  },
  {
    file: 'store-machine-board',
    run: async (page, h) => { await machineStores(page, h, 'docker') },
    callouts: [
      (page) => page.getByRole('tablist', { name: 'Kind of Store' }),
      (page) => page.getByRole('button', { name: 'Push a Store here' }),
      (page) => card(page, 'demo-starter'),
    ],
  },
  {
    file: 'store-machine-board-pg',
    run: async (page, h) => {
      await machineStores(page, h, 'docker')
      await page.getByRole('tab', { name: /^PostgreSQL/ }).first().click()
      await h.wait(800)
    },
    clip: (page) => page.locator('[data-machine-stores="docker"]'), pad: 16,
  },
  {
    file: 'store-to-machine',
    run: async (page, h) => {
      await machineStores(page, h, 'docker')
      await page.getByRole('button', { name: 'Push a Store here' }).click()
      await dialog(page).waitFor()
      await h.wait(800)
    },
    clip: dialog,
  },
  {
    file: 'store-connect-machine',
    run: async (page, h) => {
      await machineStores(page, h, 'docker')
      await page.getByRole('tab', { name: /^PostgreSQL/ }).first().click()
      await h.wait(600)
      await page.locator('[data-machine-stores="docker"]').getByRole('button', { name: 'Connect a database' }).click()
      await dialog(page).waitFor()
      await h.wait(800)
    },
    clip: dialog,
  },
]
