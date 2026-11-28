import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { defaultStoreName, locationsOf, preferredStore, slugify } from '../src/client/picker/location.ts'
import { sidebarProjects } from '../src/client/projects/recent.ts'

test('slugify turns free text into a project name', () => {
  assert.equal(slugify('My App'), 'my-app')
  assert.equal(slugify('  --Hello, World!!  '), 'hello-world')
  assert.equal(slugify('v1.2_beta'), 'v1.2_beta')
  assert.equal(slugify('x'.repeat(80)).length, 63)
  assert.equal(slugify('***'), '')
})

test('locations: host machine SQLite then PostgreSQL, never other machines', () => {
  const view = { stores: [
    { name: 'team', kind: 'postgresql', postgresql: { target: 'db.lan:5432/app' }, attached: [{ machine: 'macos-host', reached: 'ok' }, { machine: 'vm2', reached: null }] },
    { name: 'local', kind: 'sqlite', machine: 'macos-host' },
    { name: 'far', kind: 'sqlite', machine: 'vm1' },
  ] }
  assert.deepEqual(locationsOf(view), [
    { store: 'local', kind: 'sqlite', server: null, attached: [] },
    { store: 'team', kind: 'postgresql', server: 'db.lan:5432/app', attached: ['macos-host', 'vm2'] },
  ])
  assert.equal(defaultStoreName(view), 'projects')
  assert.equal(defaultStoreName({ stores: [{ name: 'projects' }, { name: 'projects-2' }] }), 'projects-3')
})


test('the last Store is preselected while it is still offered', () => {
  const locations = [{ store: 'a' }, { store: 'b' }]
  assert.equal(preferredStore(locations, 'b'), 'b')
  assert.equal(preferredStore(locations, 'gone'), 'a')
  assert.equal(preferredStore([], null), '')
})

test('sidebar projects: projects with sessions, newest first, hidden ones out', () => {
  const catalog = [
    { key: 's1/app', name: 'app', store: 's1', projectId: 'p-app' },
    { key: 's2/app', name: 'app', store: 's2', projectId: 'p-app2' },
    { key: 'pg/api', name: 'api', store: 'pg', projectId: 'p-api', kind: 'postgresql' },
    { key: 's1/idle', name: 'idle', store: 's1', projectId: 'p-idle' },
  ]
  const recent = [
    { project: 'pg/api', projectId: 'p-api', lastActivity: 30, sessionIds: ['a1'] },
    { project: 's1/app', projectId: 'p-app', lastActivity: 50, newestSession: 45, sessionIds: ['b1'] },
    { project: 's2/app', lastActivity: 40, sessionIds: ['c1'] },
    { project: 's1/draft', lastActivity: 60, sessionIds: ['d1'] },
    { project: 's1/gone', lastActivity: 10, sessionIds: ['e1'] },
  ]
  const rows = sidebarProjects([...recent, { project: 's1/idle', lastActivity: 99, sessionIds: [] }], catalog, {})
  // An unused draft keeps a just-made project listed; a project without sessions never is.
  assert.deepEqual(rows.map((r) => r.row.key), ['s1/draft', 's1/app', 's2/app', 'pg/api', 's1/gone'])
  // The Store shows only when two listed projects share a name.
  assert.deepEqual(rows.map((r) => r.showStore), [false, true, true, false, false])
  assert.equal(rows[0].row.catalogState, 'removed')
  // Hidden until a newer session.
  // Hidden until a newer session: later activity on an old session does not bring it back.
  assert.ok(!sidebarProjects(recent, catalog, { 'p-app': 46 }).some((r) => r.row.key === 's1/app'))
  assert.ok(sidebarProjects(recent, catalog, { 'p-app': 44 }).some((r) => r.row.key === 's1/app'))
  // A project the catalog doesn't list yet, in a Store that exists, is not called removed.
  assert.equal(sidebarProjects(recent, catalog, {}, new Set(['s1'])).find((r) => r.row.key === 's1/gone').row.catalogState, undefined)
  // An unread catalog marks nothing removed.
  assert.equal(sidebarProjects(recent, null, {}).find((r) => r.row.key === 's1/gone').row.catalogState, undefined)
})

test('sidebar projects: Projects in sidebar adds a project without sessions, and hiding it again removes it', () => {
  const catalog = [{ key: 's1/idle', name: 'idle', store: 's1', projectId: 'p-idle' }, { key: 's1/app', name: 'app', store: 's1', projectId: 'p-app' }]
  const recent = [{ project: 's1/app', projectId: 'p-app', lastActivity: 50, sessionIds: ['b1'] }]
  const rows = sidebarProjects(recent, catalog, {}, undefined, { 'p-idle': 70 })
  assert.deepEqual(rows.map((r) => r.row.key), ['s1/idle', 's1/app'], 'listed from when it was added')
  assert.equal(rows[0].sessions, 0)
  assert.equal(rows[0].hideKey, 'p-idle')
  assert.deepEqual(sidebarProjects(recent, catalog, { 'p-idle': 80 }, undefined, { 'p-idle': 70 }).map((r) => r.row.key), ['s1/app'], 'hidden after it was added')
  assert.deepEqual(sidebarProjects(recent, catalog, {}, undefined, { 'p-app': 90 }).map((r) => r.row.key), ['s1/app'], 'a project with sessions is listed once')
  assert.deepEqual(sidebarProjects(recent, catalog, {}, undefined, { 'p-gone': 90 }).map((r) => r.row.key), ['s1/app'], 'an added project the catalog lacks is not listed')
})

// DSH owns these nodes. The Center launcher stays inside public extension
// points. The Workspaces switch is the one allowed DOM workaround (2026-11-28,
// DSH has no header slot): it may only add its own host beside the stock
// header's actions, and falls back to the footer when that row is missing.
test('the Workspaces switch and Center launcher stay inside public extension points', () => {
  const read = (path) => readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
  assert.doesNotMatch(read('storage/index.tsx'), /createPortal|MutationObserver|document\.(?:querySelector|addEventListener)|:global\(\[class\*=/, 'storage/index.tsx')
  const view = read('projects/WorkspacesView.tsx')
  assert.equal(view.match(/document\.querySelector/g)?.length, 1, 'one lookup: the header actions row')
  assert.match(view, /insertBefore\(element, actions\)/, 'our host goes beside DSH\'s actions, never inside')
  assert.doesNotMatch(view, /(?<!element)\.(?:remove|replaceWith|setAttribute|classList)\b/, 'nothing of DSH\'s is removed or restyled')
  assert.match(view, /return <ViewSwitch t=\{t\} rail=\{!wide\} \/>/, 'footer fallback when the header row is not found')
})
