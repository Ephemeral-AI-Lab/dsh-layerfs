// Screenshots for docs/guide/project.md: Center's Project page
// (LayerFS › Home › Stores › <store> › <project>) and its Files and History views.
//   DSH_LAYERFS_DEV_DIR=$PWD/.dev-guide node tools/guide/shoot.mjs tools/guide/shots/project.mjs [--only <file>]
// Fixture: demo-starter/bookshelf (History, Files, Stats) and guide-notes/handbook (Sessions, Sandboxes).
// Read-only: menus and dialogs are opened, shot and closed with Escape; nothing is pressed that writes.

const bar = (page) => page.locator('header[aria-label="Home navigation"]')
const body = (page) => page.locator('[data-storage-page^="project:"]')
const projectTabs = (page) => page.getByRole('tablist', { name: 'Project views' })
const fileView = (page) => page.getByRole('tablist', { name: 'File view' })
const graph = (page) => page.locator('[aria-label^="History tree"]')
const dock = (page) => page.getByRole('group', { name: 'History', exact: true })
const inspector = (page) => page.getByRole('complementary', { name: 'Commit details' })
const tag = (page, name) => page.getByRole('button', { name: `Open the ${name} branch`, exact: true })

/** The project page on its Files tab. */
async function files(page, h, project = 'bookshelf') {
  await h.jump(project)
  await projectTabs(page).getByRole('tab', { name: 'Files', exact: true }).click()
  await page.getByRole('tree', { name: 'Files' }).waitFor({ timeout: 20000 })
  await h.wait(800)
}

/** Open a file from the tree's top level. */
async function openFile(page, name) {
  await page.getByRole('tree', { name: 'Files' }).getByRole('button', { name, exact: true }).click()
  await page.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { name: new RegExp(`^${name.replace('.', '\\.')}`) }).waitFor()
  await page.waitForTimeout(800)
}

/** The project page on its History tab, with the whole history drawn. */
async function history(page, h) {
  await h.jump('bookshelf')
  await projectTabs(page).getByRole('tab', { name: 'History', exact: true }).click()
  await h.see(/\d+ Branches · \d+ checkpoints/, 30000)
  // the view keeps its zoom per project: start every shot on the whole run, nothing selected
  await page.getByRole('group', { name: 'Zoom history' }).getByRole('button', { name: 'Whole run' }).click()
  const close = page.getByRole('button', { name: 'Close commit details' })
  if (await close.count()) await close.click()
  await tag(page, 'loans-001').waitFor({ timeout: 20000 })
  await h.wait(1500)
}

/** Select a Branch's newest checkpoint through its name tag: the commit details open. */
async function selectBranch(page, name) {
  await tag(page, name).click()
  await inspector(page).waitFor({ timeout: 10000 })
  await inspector(page).getByRole('heading', { name: 'Changed paths' }).waitFor({ timeout: 15000 })
  await page.waitForTimeout(600)
}

export default [
  {
    file: 'project-overview',
    run: async (page, h) => { await files(page, h); await page.getByText('Neighborhood library').first().waitFor() },
    callouts: [
      bar,
      projectTabs,
      (page) => page.getByRole('button', { name: 'Refresh project' }),
      (page) => page.getByRole('button', { name: 'bookshelf actions' }),
      (page) => body(page).getByRole('tabpanel', { name: 'Files' }),
    ],
  },
  {
    file: 'project-menu',
    run: async (page, h) => {
      await files(page, h)
      await page.getByRole('button', { name: 'bookshelf actions' }).click()
      await page.getByRole('menuitem', { name: 'Delete project…' }).waitFor()
    },
    clip: (page) => page.getByRole('menu'),
    pad: 40,
  },
  {
    // the confirm dialog only: closed with Escape, Delete is never pressed
    file: 'project-delete-confirm',
    run: async (page, h) => {
      await files(page, h)
      await page.getByRole('button', { name: 'bookshelf actions' }).click()
      await page.getByRole('menuitem', { name: 'Delete project…' }).click()
      await page.getByRole('dialog').waitFor()
      await h.wait(500)
    },
    clip: (page) => page.getByRole('dialog'),
    pad: 24,
  },
  {
    file: 'project-files',
    run: async (page, h) => {
      await files(page, h)
      const tree = page.getByRole('tree', { name: 'Files' })
      if (!(await tree.getByRole('treeitem', { name: 'schema.sql' }).count())) await tree.getByRole('button', { name: 'db', exact: true }).click()
      await tree.getByRole('treeitem', { name: 'migrations' }).first().waitFor({ timeout: 15000 }).catch(() => {})
      await openFile(page, 'package.json')
      await fileView(page).getByRole('tab', { name: 'Code' }).click()
      await h.wait(800)
    },
    callouts: [
      (page) => page.getByRole('button', { name: 'Branch', exact: true }),
      (page) => page.getByText(/^Saved [0-9a-f]+/),
      (page) => page.getByRole('textbox', { name: 'Find in opened folders' }),
      (page) => page.getByRole('tree', { name: 'Files' }),
      (page) => page.getByRole('tablist', { name: 'Open files' }),
      fileView,
      (page) => page.locator('[role=tabpanel]').filter({ has: page.getByRole('button', { name: 'Wrap lines' }) }).last(),
    ],
  },
  {
    file: 'project-branch-picker',
    run: async (page, h) => {
      await files(page, h)
      await page.getByRole('button', { name: 'Branch', exact: true }).click()
      await page.getByRole('menu').waitFor()
      await h.wait(500)
    },
    clip: (page) => page.getByRole('menu'),
    pad: 24,
  },
  {
    file: 'project-blame',
    run: async (page, h) => {
      await files(page, h)
      await openFile(page, 'CHANGELOG.md')
      await fileView(page).getByRole('tab', { name: 'Blame' }).click()
      await h.see('Select a version to see what it changed in this file.')
      await h.wait(800)
    },
    clip: (page) => body(page).getByRole('tabpanel', { name: 'Files' }),
  },
  {
    file: 'project-file-history',
    run: async (page, h) => {
      await files(page, h)
      await openFile(page, 'CHANGELOG.md')
      await fileView(page).getByRole('tab', { name: 'History' }).click()
      await page.getByRole('button', { name: /^Compare with:/ }).waitFor({ timeout: 20000 })
      await h.wait(1200)
    },
    clip: (page) => body(page).getByRole('tabpanel', { name: 'Files' }),
    callouts: [
      (page) => page.getByRole('list', { name: 'History' }),
      (page) => page.getByText('Include other branches'),
      (page) => page.getByRole('button', { name: /^Compare with:/ }),
    ],
  },
  {
    file: 'project-history',
    run: async (page, h) => { await history(page, h) },
    callouts: [
      graph,
      (page) => tag(page, 'loans-001'),
      (page) => page.getByRole('group', { name: 'Zoom history' }),
      (page) => dock(page).getByRole('button', { name: 'Compare' }),
      (page) => dock(page).getByRole('button', { name: /Branches, main included/ }),
      (page) => dock(page).getByRole('button', { name: 'Refresh' }),
      (page) => page.locator('[aria-label="History legend"]'),
    ],
  },
  {
    // a fresh page (its own size, so no history is kept in it yet): the first read, before the tree grows in
    file: 'project-history-loading',
    size: '1440x899',
    run: async (page, h) => {
      await h.jump('bookshelf')
      await projectTabs(page).getByRole('tab', { name: 'History', exact: true }).click()
      await page.getByText(/Reading history…|Loading checkpoints…/).first().waitFor({ timeout: 10000 })
    },
    clip: (page) => body(page).getByRole('tabpanel', { name: 'History' }),
  },
  {
    file: 'project-history-zoomed',
    run: async (page, h) => {
      await history(page, h)
      const zoom = page.getByRole('group', { name: 'Zoom history' })
      for (let i = 0; i < 3; i++) { await zoom.getByRole('button', { name: 'Zoom in' }).click(); await h.wait(300) }
      await h.wait(800)
    },
    clip: (page) => body(page).getByRole('tabpanel', { name: 'History' }),
  },
  {
    file: 'project-commit',
    run: async (page, h) => { await history(page, h); await selectBranch(page, 'feature-holds') },
    callouts: [
      inspector,
      (page) => inspector(page).getByRole('list'),
      (page) => inspector(page).getByRole('button', { name: 'View diff' }),
      (page) => inspector(page).getByRole('button', { name: 'Compare with…' }),
    ],
  },
  {
    file: 'project-diff',
    run: async (page, h) => {
      await history(page, h)
      await selectBranch(page, 'feature-holds')
      await inspector(page).getByRole('button', { name: 'View diff' }).click()
      await page.getByRole('dialog').getByText('Changed paths').waitFor()
      await page.getByRole('dialog').getByRole('button', { name: 'Open at this commit' }).first().waitFor({ timeout: 15000 })
      await h.wait(1000)
    },
    callouts: [
      (page) => page.getByRole('dialog').getByRole('list'),
      (page) => page.getByRole('dialog').getByRole('button', { name: 'Open at this commit' }),
    ],
  },
  {
    // Compare with…: the bar that waits for the second side, picked in the graph
    file: 'project-compare-pick',
    run: async (page, h) => {
      await history(page, h)
      await selectBranch(page, 'feature-holds')
      await inspector(page).getByRole('button', { name: 'Compare with…' }).click()
      await h.see(/Select another version or a Branch in the graph to compare with/)
      await h.wait(400)
    },
    callouts: [(page) => page.getByRole('status').filter({ hasText: 'Select another version or a Branch' })],
  },
  {
    file: 'project-compare',
    run: async (page, h) => {
      // the graph is still waiting for the second side (the shot above): pick main's newest Layer.
      // A point in the graph or a Branch name tag completes the pick.
      if (!(await page.getByText(/Select another version or a Branch in the graph/).count())) {
        await history(page, h)
        await selectBranch(page, 'feature-holds')
        await inspector(page).getByRole('button', { name: 'Compare with…' }).click()
      }
      await page.locator('[data-history-node][data-kind=layer]').last().click()
      await page.getByRole('dialog', { name: 'Compare versions' }).waitFor()
      await page.getByRole('dialog').getByText(/files? changed|Both sides have the same files/).first().waitFor({ timeout: 20000 })
      await h.wait(1500)
    },
    callouts: [
      (page) => page.getByRole('dialog').getByText('From', { exact: true }),
      (page) => page.getByRole('dialog').getByText('To', { exact: true }),
      (page) => page.getByRole('dialog').getByRole('button', { name: 'Swap' }),
    ],
  },
  {
    file: 'project-branch-finder',
    run: async (page, h) => {
      await history(page, h)
      await dock(page).getByRole('button', { name: /Branches, main included/ }).click()
      await page.getByRole('dialog', { name: 'Find a branch' }).waitFor()
      await h.wait(500)
    },
    clip: (page) => page.getByRole('dialog', { name: 'Find a branch' }),
    pad: 24,
  },
  {
    file: 'project-sandboxes',
    run: async (page, h) => {
      await h.jump('handbook')
      await projectTabs(page).getByRole('tab', { name: 'Sandboxes', exact: true }).click()
      await h.see(/The newest \d+ calls on this project/, 30000)
      await h.wait(2500)
    },
  },
  {
    file: 'project-sessions',
    run: async (page, h) => {
      await h.jump('handbook')
      await projectTabs(page).getByRole('tab', { name: 'Sessions', exact: true }).click()
      await body(page).getByRole('button', { name: 'Open', exact: true }).first().waitFor({ timeout: 20000 })
      await h.wait(600)
    },
    callouts: [
      (page) => body(page).getByRole('button', { name: 'New session' }),
      (page) => body(page).getByRole('table'),
      (page) => body(page).getByRole('button', { name: 'Open', exact: true }),
    ],
    clip: (page) => body(page),
  },
  {
    file: 'project-stats',
    run: async (page, h) => {
      await h.jump('bookshelf')
      await projectTabs(page).getByRole('tab', { name: 'Stats', exact: true }).click()
      await h.see('From this project’s snapshots to packed bytes', 30000)
      await h.wait(2500)
    },
    size: '1440x1400',
  },
  {
    // 390x844: the tab strip scrolls and the actions take the next line
    file: 'project-phone', size: '390x844',
    run: async (page, h) => {
      await h.center()
      const collapse = page.getByRole('button', { name: 'Collapse sidebar' })
      if (await collapse.count()) await collapse.first().click()
      await h.wait(500)
      const bar = page.locator('header[aria-label="Home navigation"]')
      await bar.getByRole('button', { name: /Jump to/ }).first().click()
      await page.getByRole('combobox', { name: 'Jump to' }).fill('bookshelf')
      await h.wait(500)
      await page.getByRole('option').filter({ hasText: 'bookshelf' }).first().click()
      await h.wait(2500)
      await projectTabs(page).getByRole('tab', { name: 'Files', exact: true }).click()
      await page.getByRole('tablist', { name: 'Open files' }).waitFor({ timeout: 20000 })
      await h.wait(1500)
    },
  },
]
