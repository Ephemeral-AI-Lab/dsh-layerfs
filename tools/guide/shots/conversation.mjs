// Shots for docs/guide/conversation.md: the guide fixture's project conversation and its LayerFS tabs.
// Read only: nothing here sends a message, restores or saves.
const SESSION = 'session-64678a65-777f-4a45-9d48-2a548a901691'

/** Open the fixture conversation on one of its tabs. */
async function open(page, h, tab, ready) {
  await h.session(SESSION)
  await page.getByRole('tab', { name: tab, exact: true }).first().waitFor({ timeout: 20000 })
  await h.tab(tab)
  if (ready) await ready()
  await h.wait(1500)
}
const tab = (name) => (p) => p.getByRole('tab', { name, exact: true }).first()
/** A trajectory row of one kind (its kind pill's class). */
const kindRow = (p, kind) => p.locator('[data-row^="r:"]').filter({ has: p.locator(`[class*=kind_${kind}]`) })

export default [
  {
    file: 'conversation-overview',
    run: async (page, h) => open(page, h, 'Trajectory', () => h.see('Turn checkpoint')),
    callouts: [
      (p) => p.locator('[data-slot="conversation.session.header.actions"]').getByText('LayerFS', { exact: true }),
      tab('Trajectory'), tab('Files'), tab('History'), tab('Sandbox'), tab('Stats'),
    ],
  },
  {
    file: 'conversation-trajectory',
    run: async (page, h) => {
      await open(page, h, 'Trajectory', () => h.see('Turn checkpoint'))
      // the turn before the first: DSH's own calls (Sandbox, Workspace) and the Start checkpoint
      const before = page.getByRole('button', { name: /^Before the first turn/ })
      if (await before.count() && (await before.getAttribute('aria-expanded')) !== 'true') await before.click()
      await h.wait(600)
    },
    callouts: [
      (p) => p.getByRole('toolbar', { name: 'Trajectory toolbar' }).getByRole('button', { name: /(Collapse|Expand) turns/ }),
      (p) => p.getByRole('toolbar', { name: 'Trajectory toolbar' }).getByRole('button', { name: /LayerFS calls$/ }),
      (p) => p.getByRole('checkbox', { name: 'Only LayerFS writes' }),
      (p) => p.locator('[class*=timelineHead] [class*=counts]').first(),
      (p) => p.getByRole('searchbox', { name: 'Search trajectory' }),
      (p) => p.locator('[class*=timelineBlock]').first(),
      (p) => p.locator('[data-row^="t:"]').first(),
      (p) => p.getByRole('button', { name: /^Turn 1/ }),
      (p) => p.getByRole('button', { name: /^Context messages/ }).first(),
      (p) => kindRow(p, 'tool').first().locator('[class*=opCount]'),
      (p) => p.locator('[class*=opRow]').first(),
      (p) => p.locator('[data-row^="c:"]').nth(1).locator('button[class*=version]').first(),
    ],
  },
  {
    file: 'conversation-trajectory-inspector',
    run: async (page, h) => {
      await open(page, h, 'Trajectory', () => h.see('Turn checkpoint'))
      await kindRow(page, 'tool').first().locator('[class*=rowMain]').click()
      await h.wait(800)
      await page.getByRole('complementary', { name: 'Record details' }).getByRole('tab', { name: 'LayerFS', exact: true }).click()
      await h.wait(800)
    },
    callouts: [
      (p) => p.getByRole('complementary', { name: 'Record details' }).locator('header'),
      (p) => p.getByRole('complementary', { name: 'Record details' }).getByRole('tablist'),
      (p) => p.getByRole('complementary', { name: 'Record details' }).getByRole('tabpanel'),
    ],
  },
  {
    file: 'conversation-checkpoint',
    run: async (page, h) => {
      await open(page, h, 'Trajectory', () => h.see('Turn checkpoint'))
      await page.locator('[data-row^="c:"]').filter({ hasText: 'dsh turn 3' }).locator('[class*=rowMain]').click()
      await h.wait(800)
      await page.getByRole('complementary', { name: 'Record details' }).getByRole('tab', { name: 'LayerFS', exact: true }).click()
      await h.wait(800)
    },
    callouts: [
      (p) => p.locator('[data-row^="c:"]').filter({ hasText: 'dsh turn 3' }).locator('button[class*=version]').first(),
      (p) => p.getByRole('complementary', { name: 'Record details' }).getByRole('tab', { name: 'LayerFS', exact: true }),
      (p) => p.getByRole('complementary', { name: 'Record details' }).locator('button[class*=version]').first(),
      (p) => p.getByRole('complementary', { name: 'Record details' }).locator('button').filter({ hasText: /^Open in History$/ }),
    ],
  },
  {
    file: 'conversation-files',
    run: async (page, h) => open(page, h, 'Files', () => h.see('This session’s branch')),
    callouts: [
      (p) => p.getByText('This session’s branch').first(),
      (p) => p.getByText(/^(Workspace saved|\d+ unsaved in the workspace)$/).first(),
    ],
  },
  {
    file: 'conversation-history',
    run: async (page, h) => open(page, h, 'History', () => h.wait(2500)),
  },
  {
    file: 'conversation-sandbox',
    run: async (page, h) => open(page, h, 'Sandbox', () => h.see('workspace.commit')),
    callouts: [
      (p) => p.locator('[class*=sandbox_facts]').first(),
      (p) => p.getByRole('button', { name: /^(Play|Pause|Play again)$/ }),
      (p) => p.getByRole('button', { name: 'Replay' }),
      (p) => p.locator('[class*=sandbox_speed]').first(),
      (p) => p.getByRole('button', { name: 'Live' }),
      (p) => p.locator('[data-col="agents"]'),
      (p) => p.locator('[data-flow-node="project:"]'),
      (p) => p.locator('[data-flow-node^="branch:"]').first(),
      (p) => p.locator('[data-box]').first(),
      (p) => p.locator('[class*=sandbox_playback]').first(),
      (p) => p.getByRole('button', { name: /^(Activity|Following)/ }),
    ],
  },
  {
    file: 'conversation-sandbox-call',
    run: async (page, h) => {
      await open(page, h, 'Sandbox', () => h.see('workspace.commit'))
      await page.locator('ol li button').filter({ hasText: 'workspace.commit' }).first().click()
      await h.wait(1500)
    },
    clip: (p) => p.locator('section[class*=sandbox_inspector]').first(),
  },
  {
    file: 'conversation-stats',
    run: async (page, h) => open(page, h, 'Stats', () => h.see('Saves')),
  },
  {
    // last: it turns this browser's sidebar to its LayerFS projects view
    file: 'conversation-marker',
    size: '1440x420',
    run: async (page, h) => {
      await h.session(SESSION)
      const toggle = page.getByRole('button', { name: 'Show LayerFS projects' })
      if (await toggle.count()) await toggle.first().click()
      await h.wait(1200)
      const folder = page.getByRole('button', { name: 'Toggle conversations in handbook' })
      if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click()
      await h.wait(1000)
    },
    callouts: [
      (p) => p.getByRole('button', { name: 'Show DSH workspaces' }).first(),
      (p) => p.getByRole('button', { name: 'Toggle conversations in handbook' }),
      (p) => p.locator('[data-layerfs-project]').getByText('Fake session').first(),
    ],
    // the Workspaces section: the view toggle and the project list under it
    clip: (p) => p.getByRole('button', { name: 'Show DSH workspaces' }).first().locator('xpath=ancestor::*[.//ul[contains(@class,"list_projects")]][1]'),
  },
  {
    // 390x844: Filters replaces the toolbar and the timeline folds to one summary line
    file: 'conversation-phone', size: '390x844',
    run: async (page, h) => {
      await h.session(SESSION)
      await page.getByRole('tab', { name: 'Trajectory', exact: true }).first().waitFor({ timeout: 20000 })
      await page.getByRole('tab', { name: 'Trajectory', exact: true }).first().click()
      await h.wait(2500)
    },
  },
]
