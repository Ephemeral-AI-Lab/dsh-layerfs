// UI state coverage against an isolated dev server. Machine responses are
// simulated; no VM is started or stopped. The initial archive failure check
// uses the real host operation.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDev } from '../tools/e2e-lib.mjs'

const { browser, page, logs } = await openDev()
page.setDefaultTimeout(15_000)
const artifacts = join(process.env.DSH_LAYERFS_DEV_DIR ?? new URL('../.dev', import.meta.url).pathname, 'project-overview-artifacts')
mkdirSync(artifacts, { recursive: true })
try {
  await page.waitForFunction(() => window.__dshLayerfs)
  const discovery = await page.evaluate(async () => {
    const api = window.__dshLayerfs
    return [await api.op('sessions.list', { project: 'missing-store/missing-project' }), await api.op('sessions.list', { project: 'missing-store/missing-project', localOnly: true })]
  })
  assert.ok(discovery[0].discoveryError, 'real host exposes archive failure')
  assert.equal(discovery[1].discoveryError, null, 'local-only reads require no machine access')
  await page.evaluate(() => {
    const api = window.__dshLayerfs
    const call = api.call.bind(api), op = api.op.bind(api)
    const fixture = window.__projectOverviewFixture = { state: 'stopped', starts: 0, sessions: 0, archive: 'failed', store: 'idle' }
    api.call = async (method, path, body) => {
      if (method === 'GET' && path === '/api/projects') return [{ key: 'demo-store/compiler', name: 'compiler', store: 'demo-store', kind: 'sqlite', machine: 'build', created: 1794400000000, storeState: fixture.store }]
      if (method === 'GET' && path === '/api/machines') return { available: true, machines: [{ name: 'build', platform: 'lima', state: fixture.state, stores: ['demo-store'], sandboxes: [], cpus: 2, memory: 4000000000, disk: 20000000000 }], status: {}, platforms: [], stores: [], postgresql: [], sandboxes: [] }
      if (method === 'POST' && path === '/api/machines/build/start') {
        fixture.starts++
        await new Promise((resolve) => setTimeout(resolve, 400))
        fixture.state = 'running'
        return {}
      }
      return call(method, path, body)
    }
    api.op = async (name, args) => {
      if (name === 'projects.catalog') return { rows: await api.call('GET', '/api/projects'), scratchKey: null }
      if (name === 'sessions.list' && args.project === 'demo-store/compiler') {
        const local = { sessionId: 'local-overview-conversation', title: 'Saved local conversation', local: true, updatedAt: 1794400000000 }
        if (args.localOnly) return { sessions: [local] }
        if (fixture.archive === 'pending') return new Promise(() => {})
        return { sessions: [local], discoveryError: fixture.archive === 'failed' ? { code: 'Unavailable', message: 'Machine is offline' } : null }
      }
      return op(name, args)
    }
    api.openProjectSession = async () => { fixture.sessions++; return { sessionId: 'new-overview-session', workspaceId: 'scratch' } }
    api.openPanel('layerfs-projects')
  })
  const list = page.locator('div[role=region][aria-label="LayerFS Projects"]')
  await list.getByText('Stopped', { exact: true }).waitFor()
  assert.equal(await list.getByRole('button', { name: 'New session', exact: true }).isDisabled(), true)
  const sidebarProject = page.locator('button[title="compiler · demo-store"]')
  await sidebarProject.waitFor({ timeout: 25_000 })
  await page.getByRole('button', { name: 'Toggle conversations in compiler · demo-store', exact: true }).click()
  await page.locator('[data-layerfs-workspace-mount]').getByText('Saved local conversation', { exact: true }).waitFor()
  assert.equal(await list.isVisible(), true, 'chevron expands conversations without navigating')
  await sidebarProject.click()
  const home = page.getByRole('region', { name: 'compiler', exact: true })
  await home.getByText('Project information', { exact: true }).waitFor()
  await home.getByText('Saved local conversation', { exact: true }).waitFor()
  await home.getByText(/Archived conversations are unavailable:/).waitFor()
  assert.equal(await home.getByText('No sessions yet', { exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => window.__projectOverviewFixture.starts), 0, 'opening the page never starts a machine')
  await page.screenshot({ path: join(artifacts, 'stopped-desktop.png') })
  await home.getByRole('button', { name: 'Start machine', exact: true }).click()
  await home.getByText('Starting…', { exact: true }).waitFor()
  await home.getByText('Available', { exact: true }).waitFor()
  await home.getByRole('button', { name: 'New session', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__projectOverviewFixture.sessions), 1)
  assert.equal(await page.evaluate(() => window.__projectOverviewFixture.starts), 1)

  await page.evaluate(() => { window.__projectOverviewFixture.state = 'missing' })
  await home.getByRole('button', { name: 'Refresh status', exact: true }).click()
  await home.getByText('Unavailable', { exact: true }).waitFor()
  assert.equal(await home.getByRole('button', { name: 'New session', exact: true }).isDisabled(), true)
  assert.equal(await home.getByRole('button', { name: 'Start machine', exact: true }).count(), 0)
  await home.getByText('demo-store/compiler', { exact: true }).waitFor()
  await home.getByRole('tab', { name: 'Files', exact: true }).click()
  await home.getByText(/Project files and history require access/).waitFor()
  await home.getByRole('tab', { name: 'Overview', exact: true }).click()
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(artifacts, 'unavailable-mobile.png') })
  const overflow = await home.evaluate((element) => element.scrollWidth > element.clientWidth)
  assert.equal(overflow, false, 'overview fits a phone viewport')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(artifacts, 'unavailable-mobile-dark.png') })

  await page.setViewportSize({ width: 1280, height: 820 })
  await page.evaluate(() => { window.__projectOverviewFixture.state = 'running'; window.__projectOverviewFixture.store = 'down' })
  await home.getByRole('button', { name: 'Refresh status', exact: true }).click()
  await home.getByText(/project storage is not ready/).waitFor()
  assert.equal(await home.getByRole('button', { name: 'New session', exact: true }).isDisabled(), true)
  await home.getByRole('button', { name: 'Open machine', exact: true }).click()
  await page.getByRole('region', { name: 'build', exact: true }).getByRole('heading', { name: 'build', exact: true }).waitFor()
  assert.deepEqual(logs, [], 'no browser errors')
  console.log('PASS: real archive errors, local conversations, explicit machine start, execution guards, metadata, responsive layout, and light/dark rendering')
} catch (error) { await page.screenshot({ path: join(artifacts, 'failure.png') }); console.error(await page.locator('body').innerText()); throw error } finally { await browser.close() }
