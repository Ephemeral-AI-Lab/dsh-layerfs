// Shots for docs/guide/entry-points.md: every place LayerFS shows outside Center (sidebar row, Workspaces
// switch, New Session project control, session-row mark, project dialog, Set up LayerFS).
// The two project-session views use the seeded handbook project in the private guide profile.
// Choosing it on a blank draft creates a real placement without sending a message.
const panels = (p) => p.getByRole('navigation', { name: 'Global panels' })
const sw = (p) => p.locator('[data-layerfs-view-switch]').first()
const lfsView = (p) => p.locator('[data-layerfs-workspaces-view]').first()
const chip = (p) => p.getByRole('button', { name: /^LayerFS project:/ })
const dialog = (p) => p.getByRole('dialog').last()

/** The sidebar's Workspaces list in LayerFS view (true) or DSH view (false). */
async function view(page, h, layerfs) {
  await h.dismiss()
  if (!(await sw(page).isVisible())) await page.getByRole('button', { name: 'LayerFS Projects', exact: true }).click()
  const isLfs = (await sw(page).getAttribute('aria-label')) === 'Show DSH workspaces'
  if (isLfs !== layerfs) { await sw(page).click(); await h.wait(2500) }
}

async function handbookDraft(page, h) {
  await view(page, h, false)
  if (!(await chip(page).isVisible())) await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  if (await chip(page).getAttribute('aria-label') !== 'LayerFS project: handbook') {
    await chip(page).click()
    await page.getByRole('menuitem', { name: /^handbook / }).click()
  }
  await page.getByRole('button', { name: 'LayerFS project: handbook' }).waitFor()
  await page.getByRole('button', { name: /^Scratch folder:/ }).waitFor()
}

/** The LayerFS view's + menu, then one of its items. */
async function newMenu(page, h, item) {
  await view(page, h, true)
  await page.getByRole('button', { name: 'New session or project' }).click(); await h.wait(500)
  if (item) { await page.getByRole('menuitem', { name: item }).click(); await h.wait(2500) }
}

/** Replace the home folder (/Users/<name>) with ~ in the page's text, so no account name shows. */
async function maskHome(page) {
  await page.evaluate(() => {
    const home = /(?:\/Users|\/home)\/[^/\s]+/g
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (home.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(home, '~')
    for (const el of document.querySelectorAll('[title]')) { const v = el.getAttribute('title'); if (/(?:\/Users|\/home)\//.test(v)) el.setAttribute('title', v.replace(home, '~')) }
  })
}

/** Settings on Center's navigation bar opens Set up LayerFS. */
async function setup(page, h) {
  await h.home()
  await page.locator('header[aria-label="Home navigation"]').getByRole('button', { name: 'Settings' }).click()
  await dialog(page).getByText('Machines').first().waitFor({ timeout: 20000 })
  await h.wait(2500)
}

export default [
  {
    file: 'entry-sidebar',
    run: async (page, h) => {
      await view(page, h, false)
      await page.getByRole('button', { name: 'New Session' }).first().click(); await h.wait(2000)
      await chip(page).waitFor({ timeout: 15000 })
    },
    callouts: [
      (p) => panels(p).getByRole('button', { name: 'LayerFS', exact: true }),
      (p) => sw(p),
      (p) => chip(p),
    ],
  },
  {
    file: 'entry-hero-menu',
    run: async (page, h) => {
      if (!(await chip(page).isVisible().catch(() => false))) { await page.getByRole('button', { name: 'New Session' }).first().click(); await h.wait(2000) }
      await chip(page).click(); await h.wait(1500)
    },
    callouts: [(p) => p.getByRole('menu').first()],
  },
  {
    file: 'entry-project-session',
    run: handbookDraft,
    callouts: [
      (p) => p.getByRole('button', { name: /^Scratch folder:/ }),
      (p) => chip(p),
      (p) => p.getByRole('button', { name: 'LayerFS', exact: true }).last(),
    ],
  },
  {
    file: 'entry-layerfs-view',
    run: async (page, h) => {
      await handbookDraft(page, h)
      await view(page, h, true)
      const toggle = lfsView(page).getByRole('button', { name: 'Toggle conversations in handbook' })
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      await h.wait(3000)
      await toggle.hover(); await h.wait(600)
    },
    callouts: [
      (p) => sw(p),
      (p) => p.locator('[data-layerfs-new-menu]'),
      (p) => lfsView(p).getByRole('button', { name: 'Toggle conversations in handbook' }),
      (p) => lfsView(p).getByRole('button', { name: 'Set up handbook' }),
      (p) => lfsView(p).getByRole('button', { name: 'New session in handbook' }),
      (p) => lfsView(p).getByRole('button', { name: /^Fake session/ }).first(),
    ],
  },
  {
    file: 'entry-new-menu',
    run: async (page, h) => { await newMenu(page, h) },
    callouts: [(p) => p.getByRole('menu').first()],
  },
  {
    file: 'entry-project-pick',
    run: async (page, h) => {
      await newMenu(page, h, 'Other project…'); await dialog(page).getByText('handbook').first().waitFor({ timeout: 15000 })
      await dialog(page).getByText('handbook', { exact: true }).first().hover(); await h.wait(500) // the gear shows on hover
    },
    callouts: [
      (p) => dialog(p).getByRole('searchbox').or(dialog(p).getByPlaceholder('Search projects or Stores')),
      (p) => dialog(p).getByRole('button', { name: 'Set up handbook' }),
      (p) => dialog(p).getByRole('button', { name: 'Import a folder' }),
      (p) => dialog(p).getByRole('button', { name: 'New project' }),
    ],
  },
  {
    file: 'entry-project-configure',
    run: async (page, h) => {
      await newMenu(page, h, 'Other project…'); await dialog(page).getByText('handbook').first().waitFor({ timeout: 15000 })
      await dialog(page).getByRole('button', { name: 'Set up handbook' }).click(); await h.wait(2500)
    },
    callouts: [
      (p) => dialog(p).getByRole('button', { name: 'Projects' }),
      (p) => dialog(p).getByRole('button', { name: 'Hide from sidebar' }),
      (p) => dialog(p).getByRole('button', { name: 'Done' }),
    ],
  },
  {
    file: 'entry-project-new',
    run: async (page, h) => { await newMenu(page, h, 'New project'); await h.wait(500) },
    callouts: [
      (p) => dialog(p).getByRole('radiogroup'),
      (p) => dialog(p).getByRole('button', { name: 'Cancel' }),
      (p) => dialog(p).getByRole('button', { name: 'Create and open' }),
    ],
  },
  {
    file: 'entry-project-store',
    run: async (page, h) => {
      await newMenu(page, h, 'New project')
      await dialog(page).getByRole('radio').filter({ hasText: /SQLite/ }).first().scrollIntoViewIfNeeded(); await h.wait(1200)
    },
    callouts: [(p) => dialog(p).getByRole('radio').filter({ hasText: /SQLite/ }).first(), (p) => dialog(p).getByRole('radio').filter({ hasText: /PostgreSQL/ }).first()],
  },
  {
    file: 'entry-project-machine',
    run: async (page, h) => {
      await newMenu(page, h, 'New project')
      await dialog(page).getByRole('radio', { name: /docker/ }).scrollIntoViewIfNeeded(); await h.wait(1500)
    },
  },
  {
    file: 'entry-project-pg',
    run: async (page, h) => {
      await newMenu(page, h, 'New project')
      await dialog(page).getByRole('radio', { name: /PostgreSQL/ }).click(); await h.wait(1200)
      await dialog(page).getByText('Database URL', { exact: true }).scrollIntoViewIfNeeded(); await h.wait(1200)
    },
  },
  {
    file: 'entry-project-import',
    run: async (page, h) => { await newMenu(page, h, 'Import a folder…') },
    callouts: [(p) => dialog(p).getByRole('button', { name: 'Browse…' }), (p) => dialog(p).getByRole('button', { name: 'Import and open' })],
  },
  {
    file: 'entry-center-rail',
    run: async (page, h) => { await h.home(); await h.wait(1500) },
    callouts: [
      (p) => panels(p).getByRole('button', { name: 'LayerFS', exact: true }),
      (p) => p.getByRole('button', { name: 'LayerFS Projects' }),
    ],
  },
  {
    file: 'entry-setup',
    run: async (page, h) => { await setup(page, h); await maskHome(page) },
    callouts: [
      (p) => dialog(p).getByRole('button', { name: /^(Change|Choose)…$/ }),
      (p) => dialog(p).getByRole('button', { name: 'Check again' }),
      (p) => dialog(p).getByRole('button', { name: 'Done' }),
    ],
  },
  {
    file: 'entry-setup-runtime',
    run: async (page, h) => {
      await setup(page, h)
      await dialog(page).getByRole('button', { name: /^(Change|Choose)…$/ }).click(); await h.wait(2000)
      await maskHome(page)
    },
  },
  {
    // 390x844: the shell gives the dialog its full height; the form scrolls, the head and footer stay
    file: 'entry-project-phone', size: '390x844',
    run: async (page, h) => {
      await h.center()
      const sw = page.locator('[data-layerfs-view-switch]').first()
      if (!(await sw.isVisible().catch(() => false))) await page.getByRole('button', { name: 'LayerFS Projects', exact: true }).click()
      if ((await sw.getAttribute('aria-label')) !== 'Show DSH workspaces') { await sw.click(); await h.wait(2000) }
      await page.getByRole('button', { name: 'New session or project' }).click()
      await page.getByRole('menuitem', { name: 'New project' }).click()
      await dialog(page).getByText('Save to', { exact: true }).waitFor({ timeout: 15000 })
      await h.wait(1500)
    },
  },
]
