// Shots for docs/guide/home.md: Center's Home page, its head card, its three tabs and the nav bar every Center page shares.
// One page serves every shot in a run, so each shot sets the tab, kind and view it needs instead of assuming them.

const bar = (p) => p.locator('header[aria-label="Home navigation"]')
const tools = (p) => p.getByRole('group').filter({ has: p.getByRole('button', { name: 'Refresh', exact: true }) })
const head = (p) => p.locator('header[class*=HomeHero]')
const homeTab = (p, name) => p.getByRole('tablist', { name: 'Projects, Stores, backups, connections and machines' }).getByRole('tab', { name: new RegExp(`^${name}\\b`) })

/** Home, on one of its tabs. */
async function homeOn(page, h, name) {
  await h.home()
  await homeTab(page, name).click()
  await h.wait(1500)
}

/** Home › Stores on a kind (SQLite or PostgreSQL) and, on SQLite, a view (Stores or Buckets). */
async function storesOn(page, h, kind, view) {
  await homeOn(page, h, 'Stores')
  await page.getByRole('tablist', { name: 'Kind of Store' }).getByRole('tab', { name: new RegExp(`^${kind}`, 'i') }).click()
  await h.wait(1500)
}

/** Open a toggle (row) unless it is open already: the choice is remembered per browser. */
async function ensureOpen(button) {
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
}

export default [
  {
    file: 'home-overview',
    run: async (page, h) => { await homeOn(page, h, 'Projects'); await h.see('handbook'); await h.wait(2000) },
    callouts: [
      (p) => bar(p),
      (p) => head(p),
      (p) => p.getByRole('tablist', { name: 'Projects, Stores, backups, connections and machines' }),
      (p) => p.getByRole('tabpanel').getByRole('search', { name: 'Search and sort projects' }),
      (p) => p.getByRole('tabpanel').getByRole('row').filter({ hasText: 'handbook' }).first(),
    ],
  },
  {
    file: 'home-overview-head',
    run: async (page, h) => { await homeOn(page, h, 'Projects'); await h.wait(1000) },
    clip: (p) => head(p),
    pad: 16,
    callouts: [
      (p) => head(p).locator('h1'),
      (p) => head(p).getByRole('button', { name: /^LayerFS 2/ }),
      (p) => head(p).locator('[class*=HomeHero_status]'),
      (p) => tools(p).getByRole('button', { name: 'Refresh' }),
    ],
  },
  {
    file: 'home-nav-bar',
    run: async (page, h) => { await h.home(); await h.jump('bookshelf', 'bookshelf'); await h.wait(1500) },
    clip: (p) => bar(p),
    pad: 30,
    callouts: [
      (p) => bar(p).getByRole('button', { name: 'Back' }),
      (p) => bar(p).getByRole('button', { name: 'Forward' }),
      (p) => bar(p).getByRole('navigation', { name: 'Location' }),
      (p) => bar(p).locator('[class*=crumbMore]'),
      (p) => bar(p).getByRole('button', { name: /Jump to/ }),
      (p) => bar(p).getByRole('button', { name: 'Refresh' }),
      (p) => bar(p).getByRole('button', { name: 'Add' }),
      (p) => bar(p).getByRole('button', { name: 'Doctor', exact: true }),
      (p) => bar(p).getByRole('button', { name: 'Logs', exact: true }),
      (p) => bar(p).getByRole('button', { name: 'Settings', exact: true }),
    ],
  },
  {
    file: 'home-navigation',
    run: (_page, h) => h.home(),
    clip: bar,
    callouts: ['Doctor', 'Logs', 'Settings'].map(name => p => bar(p).getByRole('button', { name, exact: true })),
  },
  {
    file: 'home-jump-search',
    run: async (page, h) => {
      await h.home()
      await bar(page).getByRole('button', { name: /Jump to/ }).click()
      await page.getByRole('combobox').fill('Fake session')
      await page.getByRole('option', { name: /Fake session/i }).first().waitFor()
    },
    clip: p => p.getByRole('dialog'),
  },
  {
    file: 'home-crumb-switcher',
    run: async (page, h) => {
      await h.home(); await h.jump('bookshelf', 'bookshelf'); await h.wait(1200)
      await bar(page).locator('[class*=crumbMore]').first().click(); await h.wait(600)
    },
    callouts: [(p) => p.getByRole('menu').first()],
  },
  {
    file: 'home-jump',
    run: async (page, h) => { await homeOn(page, h, 'Projects'); await bar(page).getByRole('button', { name: /Jump to/ }).click(); await h.wait(800) },
    callouts: [
      (p) => p.getByRole('combobox', { name: 'Jump to' }),
      (p) => p.getByRole('listbox', { name: 'Jump to' }),
    ],
  },
  {
    file: 'home-add-menu',
    run: async (page, h) => { await homeOn(page, h, 'Projects'); await bar(page).getByRole('button', { name: 'Add' }).click(); await h.wait(600) },
    callouts: [(p) => p.getByRole('menu').first()],
  },
  {
    file: 'home-projects-row',
    run: async (page, h) => {
      await homeOn(page, h, 'Projects'); await h.see('handbook')
      const toggle = page.getByRole('button', { name: /^(Show|Hide) handbook's sessions and Sandboxes$/ })
      await ensureOpen(toggle); await h.wait(2500)
    },
    callouts: [
      (p) => p.getByRole('button', { name: "Hide handbook's sessions and Sandboxes" }),
      (p) => p.getByRole('tabpanel').getByRole('button', { name: 'handbook', exact: true }),
      (p) => p.getByRole('tabpanel').getByRole('button', { name: /^(guide-notes|demo-starter)$/ }).first(),
      (p) => p.locator('[data-session]').first(),
      (p) => p.locator('[data-list-switch]').first(),
      (p) => p.getByRole('button', { name: 'handbook actions' }),
    ],
  },
  {
    file: 'home-project-menu',
    run: async (page, h) => {
      await homeOn(page, h, 'Projects'); await h.see('handbook')
      await page.getByRole('button', { name: 'bookshelf actions' }).click(); await h.wait(600)
    },
    callouts: [(p) => p.getByRole('menu').first()],
  },
  {
    file: 'home-stores',
    run: async (page, h) => { await storesOn(page, h, 'sqlite', 'Stores'); await h.see('guide-notes'); await h.wait(1500) },
    callouts: [
      (p) => p.getByRole('tablist', { name: 'Kind of Store' }),
      (p) => homeTab(p, 'Buckets'),
      (p) => p.getByRole('button', { name: 'New Store' }),
      (p) => p.locator('[data-store="guide-notes"]'),
    ],
  },
  {
    file: 'home-buckets',
    run: async (page, h) => { await homeOn(page, h, 'Buckets'); await h.see('guide-backups'); await h.wait(1000) },
    callouts: [
      (p) => homeTab(p, 'Buckets'),
      (p) => p.getByRole('button', { name: 'List bucket files' }),
      (p) => p.getByRole('button', { name: 'Add bucket', exact: true }).first(),
      (p) => p.locator('[data-bucket="guide-backups"]'),
      (p) => p.getByRole('button', { name: 'More actions for guide-backups' }),
    ],
  },
  {
    file: 'home-stores-pg',
    run: async (page, h) => { await storesOn(page, h, 'postgresql'); await h.wait(800) },
    callouts: [
      (p) => p.locator('[data-store-kind=postgresql]'),
      (p) => p.getByRole('button', { name: 'Connect a database', exact: true }),
      (p) => p.getByText('No PostgreSQL database connected yet.'),
    ],
  },
  {
    file: 'home-machines',
    run: async (page, h) => {
      await homeOn(page, h, 'Machines'); await h.see('Docker · Linux namespaces')
      await ensureOpen(page.getByRole('button', { name: /^(Show|Hide) what docker holds$/ })); await h.wait(2500)
    },
    callouts: [
      (p) => p.getByRole('button', { name: 'New machine' }),
      (p) => p.getByRole('button', { name: 'Diagnose this host' }),
      (p) => p.getByRole('button', { name: 'Hide what docker holds' }),
      (p) => p.getByRole('button', { name: 'docker', exact: true }),
      (p) => p.locator('[data-machine="docker"] button[data-machine="docker"]'),
      (p) => p.getByRole('button', { name: 'More for docker' }),
      (p) => p.getByRole('button', { name: 'Add Store' }),
      (p) => p.getByRole('button', { name: 'New Sandbox' }),
    ],
  },
  {
    // 390x844: the one-row nav bar, the scrolling tab strip and project cards
    file: 'home-phone', size: '390x844',
    run: async (page, h) => {
      await h.center()
      const collapse = page.getByRole('button', { name: 'Collapse sidebar' })
      if (await collapse.count()) await collapse.first().click()
      await h.wait(500)
      await homeTab(page, 'Projects').click()
      await h.see('handbook'); await h.wait(2000)
    },
  },
]
