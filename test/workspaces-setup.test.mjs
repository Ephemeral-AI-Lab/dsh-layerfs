import assert from 'node:assert/strict'
import test from 'node:test'
import { createSteps, defaultMachine, defaultStoreChoice, freeStoreName, lastUsedStore, machinesFor, needsStart, pgLoginBody, pgLoginProblem, pickable, primaryMachine, runsOn, stoppedOf, tileBlocks } from '../src/client/projects/setup/model.ts'

const view = {
  machines: [
    // 2.0 records: six states, `supports` a list
    { name: 'macos-host', platform: 'host', state: 'ready', supports: ['sqlite', 'postgresql_sandbox'] },
    { name: 'dev', platform: 'lima', state: 'ready', supports: ['sqlite', 'postgresql_sandbox'] },
    { name: 'docker', platform: 'docker', state: 'stopped', supports: ['sqlite', 'postgresql_sandbox'] },
    { name: 'old', platform: 'ssh', state: 'broken', reason: 'unsupported', supports: [] },
    { name: 'nopg', platform: 'x', state: 'ready', supports: ['sqlite'] },
  ],
  stores: [{ name: 'website' }, { name: 'website-2' }],
}
const ids = (steps) => steps.map((s) => s.id)

test('machines: docker first, then the host machine, then by name; unsupported ones out', () => {
  assert.deepEqual(machinesFor(view, 'sqlite').map((m) => m.name), ['docker', 'macos-host', 'dev', 'nopg'])
  assert.deepEqual(machinesFor(view, 'postgresql').map((m) => m.name), ['docker', 'macos-host', 'dev'])
  // a stopped docker is never the default (Create would start it): the host machine is
  assert.equal(defaultMachine(machinesFor(view, 'sqlite')), 'macos-host')
  assert.equal(defaultMachine(machinesFor({ machines: view.machines.filter((m) => m.name !== 'docker') }, 'sqlite')), 'macos-host')
})

test('the default machine (U10 add-on 1/2): the page it was opened from when that runs, else the host machine; never broken or stopped', () => {
  const machines = machinesFor(view, 'sqlite')
  assert.equal(defaultMachine(machines, new Map(), 'dev'), 'dev', 'opened from a running machine\'s page')
  assert.equal(defaultMachine(machines, new Map(), 'docker'), 'macos-host', 'a stopped machine needs the person\'s pick and named Start')
  const broken = machinesFor({ machines: view.machines.map((m) => (m.name === 'docker' ? { ...m, state: 'broken', reason: 'record_unreadable' } : m)) }, 'sqlite')
  assert.equal(defaultMachine(broken, new Map(), 'docker'), 'macos-host', 'never a broken machine, even from its own page')
  assert.equal(defaultMachine(broken), 'macos-host')
  const ready = machinesFor({ machines: view.machines.map((m) => (m.name === 'docker' ? { ...m, state: 'ready' } : m)) }, 'sqlite')
  assert.equal(defaultMachine(ready), 'macos-host', 'docker is no longer preferred over the host machine')
  assert.equal(defaultMachine(ready, new Map(), 'docker'), 'docker', 'from docker\'s own page when it runs')
  // no host machine: the first that runs, never a stopped or broken one
  assert.equal(defaultMachine(broken.filter((m) => m.name !== 'macos-host')), 'dev')
  // a broken machine needs no Start (its fix is LayerFS's), a stopped one does, the host machine too
  assert.deepEqual(stoppedOf(['docker', 'macos-host', 'old', 'dev'], view), ['docker'])
  assert.deepEqual(needsStart({ kind: 'sqlite', store: null, machines: ['docker'] }, view), ['docker'])
  assert.deepEqual(needsStart({ kind: 'postgresql', store: null, machines: ['dev'] }, view), [])
})

test('a blocked docker is not the default: the host machine is', () => {
  const row = (platform, missing = [], extra = {}) => ({ platform, ready: missing.length === 0, missing, ...extra })
  const machines = machinesFor(view, 'sqlite')
  // Docker's Engine does not answer on Linux: blocked, not pickable
  const linux = tileBlocks(view.machines, [row('host'), row('docker', ['host:/var/run/docker.sock']), row('lima')], 'linux')
  assert.deepEqual([...linux.keys()], ['docker'])
  assert.equal(pickable('docker', linux), false)
  assert.equal(defaultMachine(machines, linux), 'macos-host')
  // on macOS Start launches the Engine first: pickable (Create starts it), but still not the default
  const mac = tileBlocks(view.machines, [row('host'), row('docker', ['host:/var/run/docker.sock']), row('lima')], 'macos')
  assert.equal(pickable('docker', mac), true)
  assert.equal(defaultMachine(machines, mac), 'macos-host')
  // the docker group fix is not something Start does
  const denied = tileBlocks(view.machines, [row('docker', ['host:/var/run/docker.sock'], { socket: { path: '/var/run/docker.sock', source: 'default', state: 'denied' } })], 'macos')
  assert.equal(pickable('docker', denied), false)
  // platforms ready, or not read (an older host): docker is still stopped in this view, so the host machine stays the default
  assert.equal(defaultMachine(machines, tileBlocks(view.machines, [row('docker'), row('host')], 'macos')), 'macos-host')
  assert.equal(tileBlocks(view.machines, undefined, 'macos').size, 0)
})

test('where a project runs: SQLite its Store machine; PostgreSQL the machines attached to it, its readiness a placeable one', () => {
  assert.deepEqual(runsOn({ kind: 'sqlite', machine: 'dev' }), ['dev'])
  const rows = [{ machine: 'macos-host', reached: 'ok' }, { machine: 'docker', reached: 'ok' }, { machine: 'vm', reached: 'failed' }]
  assert.deepEqual(runsOn({ kind: 'postgresql', machine: null, attached: rows }), ['macos-host', 'docker', 'vm'])
  assert.deepEqual(runsOn({ kind: 'postgresql', machine: null }), [], 'nothing attached yet')
  const machines = [{ name: 'macos-host', state: 'ready' }, { name: 'docker', state: 'stopped' }, { name: 'vm', state: 'ready' }]
  // docker reached but stopped, vm running though its check failed: an attached running machine all the same
  assert.equal(primaryMachine({ kind: 'postgresql', machine: null, attached: rows.slice(2) }, machines), 'vm', 'the only attached machine')
  assert.equal(primaryMachine({ kind: 'postgresql', machine: null, attached: rows.slice(1) }, machines), null, 'several attached: the person picks')
  assert.equal(primaryMachine({ kind: 'postgresql', machine: null, attached: [] }, machines), null, 'none attached: no machine, never the host machine by default')
  assert.equal(primaryMachine({ kind: 'sqlite', machine: null }), null, 'no machine recorded: none is guessed')
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

test('create steps: new SQLite Store on docker is made on the host machine, then pushed; Create starts no machine', () => {
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['docker'] }, view)),
    ['store', 'init', 'place:docker', 'open'])
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['macos-host'] }, view)),
    ['store', 'init', 'open'])
})

test('create steps: existing SQLite Store inits on its machine, moves only when asked; its start is the person\'s press', () => {
  const onDocker = { name: 's', kind: 'sqlite', machine: 'docker', projects: [] }
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: onDocker, machines: ['docker'] }, view)), ['init', 'open'])
  assert.deepEqual(needsStart({ kind: 'sqlite', store: onDocker, machines: ['docker'] }, view), ['docker'], 'Create waits for docker\'s own Start')
  const onNative = { name: 's', kind: 'sqlite', machine: 'macos-host', projects: [] }
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

test('create steps: a PostgreSQL Store attaches every checked machine not attached yet; the session opens on the first', () => {
  const existing = { name: 'pg', kind: 'postgresql', projects: [], attached: [{ machine: 'dev', reached: 'ok', reach: null }] }
  const steps = createSteps({ name: 'app', kind: 'postgresql', store: existing, machines: ['dev', 'docker', 'lima1', 'docker'] }, view)
  assert.deepEqual(ids(steps), ['init', 'attach:docker', 'attach:lima1', 'open'], 'dev is attached already; each other one once')
  assert.equal(steps.at(-1).machine, 'dev', 'the first session runs on the first machine')
  const fresh = createSteps({ name: 'app', kind: 'postgresql', store: null, newStore: { name: 'pg' }, machines: ['lima1', 'docker'] }, view)
  assert.deepEqual(ids(fresh), ['connect', 'init', 'attach:lima1', 'attach:docker', 'open'])
  assert.equal(fresh.at(-1).machine, 'lima1')
})

test('create steps: a folder is checked before anything is made', () => {
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['docker'], source: '/Users/me/code/shop' }, view)),
    ['check', 'store', 'init', 'place:docker', 'open'])
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'postgresql', store: null, newStore: { name: 'pg' }, machines: ['macos-host'], source: '/srv/app' }, view)),
    ['check', 'connect', 'init', 'attach:macos-host', 'open'])
  assert.equal(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['macos-host'] }, view)[0].id, 'store', 'an empty project has no check')
})

test('the last-used Store: the newest recent project whose Store still exists', () => {
  const stores = [{ name: 'shop' }, { name: 'notes' }]
  assert.equal(lastUsedStore([{ project: 'gone/x' }, { project: 'notes/daily' }, { project: 'shop/cart' }], stores)?.name, 'notes', 'a removed Store is skipped')
  assert.equal(lastUsedStore([], stores), null, 'no recent project: none')
  assert.equal(lastUsedStore([{ project: 'gone/x' }], stores), null)
})

test('the default Store: the last-used one when usable, else a new SQLite Store (and it says it fell back)', () => {
  const usable = (s) => s.state === 'ready' || s.state === 'blocked'
  assert.deepEqual(defaultStoreChoice({ name: 'shop', state: 'ready' }, usable), { choice: { kind: 'existing', store: 'shop' }, fellBack: false })
  assert.deepEqual(defaultStoreChoice({ name: 'shop', state: 'blocked' }, usable), { choice: { kind: 'existing', store: 'shop' }, fellBack: false }, 'a stopped machine keeps it: its Start is shown')
  assert.deepEqual(defaultStoreChoice({ name: 'shop', state: 'broken' }, usable), { choice: { kind: 'sqlite' }, fellBack: true })
  assert.deepEqual(defaultStoreChoice(null, usable), { choice: { kind: 'sqlite' }, fellBack: false }, 'a first project: a new Store, nothing to explain')
})
