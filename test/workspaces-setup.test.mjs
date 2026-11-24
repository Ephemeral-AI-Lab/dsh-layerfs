import assert from 'node:assert/strict'
import test from 'node:test'
import { createSteps, defaultMachine, freeStoreName, machinesFor, needsStart, pgLoginBody, pgLoginProblem, pickable, primaryMachine, runsOn, stoppedOf, tileBlocks } from '../src/client/projects/setup/model.ts'

const view = {
  machines: [
    // 2.0 records: six states, `supports` a list
    { name: 'native', platform: 'native', state: 'ready', supports: ['sqlite', 'postgresql_sandbox'] },
    { name: 'dev', platform: 'lima', state: 'ready', supports: ['sqlite', 'postgresql_sandbox'] },
    { name: 'docker', platform: 'docker', state: 'stopped', supports: ['sqlite', 'postgresql_sandbox'] },
    { name: 'old', platform: 'ssh', state: 'broken', reason: 'unsupported', supports: [] },
    { name: 'nopg', platform: 'x', state: 'ready', supports: ['sqlite'] },
  ],
  stores: [{ name: 'website' }, { name: 'website-2' }],
}
const ids = (steps) => steps.map((s) => s.id)

test('machines: docker first, then native, then by name; unsupported ones out', () => {
  assert.deepEqual(machinesFor(view, 'sqlite').map((m) => m.name), ['docker', 'native', 'dev', 'nopg'])
  assert.deepEqual(machinesFor(view, 'postgresql').map((m) => m.name), ['docker', 'native', 'dev'])
  // a stopped docker is never the default (Create would start it): native is
  assert.equal(defaultMachine(machinesFor(view, 'sqlite')), 'native')
  assert.equal(defaultMachine(machinesFor({ machines: view.machines.filter((m) => m.name !== 'docker') }, 'sqlite')), 'native')
})

test('the default machine (U10 add-on 1/2): the page it was opened from when that runs, else native; never broken or stopped', () => {
  const machines = machinesFor(view, 'sqlite')
  assert.equal(defaultMachine(machines, new Map(), 'dev'), 'dev', 'opened from a running machine\'s page')
  assert.equal(defaultMachine(machines, new Map(), 'docker'), 'native', 'a stopped machine needs the person\'s pick and named Start')
  const broken = machinesFor({ machines: view.machines.map((m) => (m.name === 'docker' ? { ...m, state: 'broken', reason: 'record_unreadable' } : m)) }, 'sqlite')
  assert.equal(defaultMachine(broken, new Map(), 'docker'), 'native', 'never a broken machine, even from its own page')
  assert.equal(defaultMachine(broken), 'native')
  const ready = machinesFor({ machines: view.machines.map((m) => (m.name === 'docker' ? { ...m, state: 'ready' } : m)) }, 'sqlite')
  assert.equal(defaultMachine(ready), 'native', 'docker is no longer preferred over native')
  assert.equal(defaultMachine(ready, new Map(), 'docker'), 'docker', 'from docker\'s own page when it runs')
  // no native: the first that runs, never a stopped or broken one
  assert.equal(defaultMachine(broken.filter((m) => m.name !== 'native')), 'dev')
  // a broken machine needs no Start (its fix is LayerFS's), a stopped one does, native never
  assert.deepEqual(stoppedOf(['docker', 'native', 'old', 'dev'], view), ['docker'])
  assert.deepEqual(needsStart({ kind: 'sqlite', store: null, machines: ['docker'] }, view), ['docker'])
  assert.deepEqual(needsStart({ kind: 'postgresql', store: null, machines: ['dev'] }, view), [])
})

test('a blocked docker is not the default: native is', () => {
  const row = (platform, missing = [], extra = {}) => ({ platform, ready: missing.length === 0, missing, ...extra })
  const machines = machinesFor(view, 'sqlite')
  // Docker's Engine does not answer on Linux: blocked, not pickable
  const linux = tileBlocks(view.machines, [row('native'), row('docker', ['host:/var/run/docker.sock']), row('lima')], 'linux')
  assert.deepEqual([...linux.keys()], ['docker'])
  assert.equal(pickable('docker', linux), false)
  assert.equal(defaultMachine(machines, linux), 'native')
  // on macOS Start launches the Engine first: pickable (Create starts it), but still not the default
  const mac = tileBlocks(view.machines, [row('native'), row('docker', ['host:/var/run/docker.sock']), row('lima')], 'macos')
  assert.equal(pickable('docker', mac), true)
  assert.equal(defaultMachine(machines, mac), 'native')
  // the docker group fix is not something Start does
  const denied = tileBlocks(view.machines, [row('docker', ['host:/var/run/docker.sock'], { socket: { path: '/var/run/docker.sock', source: 'default', state: 'denied' } })], 'macos')
  assert.equal(pickable('docker', denied), false)
  // platforms ready, or not read (an older host): docker is still stopped in this view, so native stays the default
  assert.equal(defaultMachine(machines, tileBlocks(view.machines, [row('docker'), row('native')], 'macos')), 'native')
  assert.equal(tileBlocks(view.machines, undefined, 'macos').size, 0)
})

test('where a project runs: SQLite its Store machine; PostgreSQL the machines attached to it, its readiness a placeable one', () => {
  assert.deepEqual(runsOn({ kind: 'sqlite', machine: 'dev' }), ['dev'])
  const rows = [{ machine: 'native', reached: 'ok' }, { machine: 'docker', reached: 'ok' }, { machine: 'vm', reached: 'failed' }]
  assert.deepEqual(runsOn({ kind: 'postgresql', machine: null, attached: rows }), ['native', 'docker', 'vm'])
  assert.deepEqual(runsOn({ kind: 'postgresql', machine: null }), [], 'nothing attached yet')
  const machines = [{ name: 'native', state: 'ready' }, { name: 'docker', state: 'stopped' }, { name: 'vm', state: 'ready' }]
  // docker reached but stopped, vm running though its check failed: an attached running machine all the same
  assert.equal(primaryMachine({ kind: 'postgresql', machine: null, attached: rows.slice(2) }, machines), 'vm', 'the only attached machine')
  assert.equal(primaryMachine({ kind: 'postgresql', machine: null, attached: rows.slice(1) }, machines), null, 'several attached: the person picks')
  assert.equal(primaryMachine({ kind: 'postgresql', machine: null, attached: [] }, machines), null, 'none attached: no machine, never native by default')
  assert.equal(primaryMachine({ kind: 'sqlite', machine: null }), 'native')
})

test('store names', () => {
  assert.equal(freeStoreName('website', view), 'website-3')
  assert.equal(freeStoreName('fresh', view), 'fresh')
})

test('a new PostgreSQL Store\'s user and password: both needed; the user trimmed, the password as typed', () => {
  const fresh = { user: ' app ', password: 'p w' }
  assert.equal(pgLoginProblem(fresh), null)
  assert.deepEqual(pgLoginBody(fresh), { user: 'app', passwordValue: 'p w' })
  assert.equal(pgLoginProblem({ ...fresh, user: '  ' }), 'user')
  assert.equal(pgLoginProblem({ ...fresh, password: '' }), 'password')
})

test('the setup copy offers no password reference, in either language', async () => {
  const { locales } = await import('../src/client/projects/setup/locale.ts')
  for (const [lang, words] of Object.entries(locales)) {
    for (const [key, text] of Object.entries(words)) assert.doesNotMatch(text, /env:|file:\//, `${lang}.${key}`)
    assert.ok(words.user && words.password, lang)
    assert.ok(!('loginName' in words) && !('loginNameTaken' in words), `${lang}: no saved-login names`)
  }
  assert.deepEqual(Object.keys(locales.zh).sort(), Object.keys(locales.en).sort())
})

test('create steps: new SQLite Store on docker is made on native, then pushed; Create starts no machine', () => {
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['docker'] }, view)),
    ['store', 'init', 'place:docker', 'open'])
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['native'] }, view)),
    ['store', 'init', 'open'])
})

test('create steps: existing SQLite Store inits on its machine, moves only when asked; its start is the person\'s press', () => {
  const onDocker = { name: 's', kind: 'sqlite', machine: 'docker', projects: [] }
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: onDocker, machines: ['docker'] }, view)), ['init', 'open'])
  assert.deepEqual(needsStart({ kind: 'sqlite', store: onDocker, machines: ['docker'] }, view), ['docker'], 'Create waits for docker\'s own Start')
  const onNative = { name: 's', kind: 'sqlite', machine: 'native', projects: [] }
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: onNative, machines: ['dev'] }, view)), ['init', 'place:dev', 'open'])
})

test('create steps: a PostgreSQL Store attaches the machine picked when it is not attached yet; that machine is the first session\'s own', () => {
  // docker is stopped in this view, and Create does not start it
  const fresh = createSteps({ name: 'app', kind: 'postgresql', store: null, newStore: { name: 'pg' }, machines: ['docker'] }, view)
  assert.deepEqual(ids(fresh), ['connect', 'init', 'attach:docker', 'open'])
  assert.equal(fresh[0].machine, undefined, 'connect carries no machine')
  assert.equal(fresh[3].machine, 'docker', 'the session opens on the machine picked')
  const existing = { name: 'pg', kind: 'postgresql', projects: [], attached: [{ machine: 'dev', reached: 'ok', reach: null }] }
  const picked = createSteps({ name: 'app', kind: 'postgresql', store: existing, machines: ['dev'] }, view)
  assert.deepEqual(ids(picked), ['init', 'open'], 'dev is attached already')
  assert.equal(picked[1].machine, 'dev')
})

test('create steps: a folder is checked before anything is made', () => {
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['docker'], source: '/Users/me/code/shop' }, view)),
    ['check', 'store', 'init', 'place:docker', 'open'])
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'postgresql', store: null, newStore: { name: 'pg' }, machines: ['native'], source: '/srv/app' }, view)),
    ['check', 'connect', 'init', 'attach:native', 'open'])
  assert.equal(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['native'] }, view)[0].id, 'store', 'an empty project has no check')
})
