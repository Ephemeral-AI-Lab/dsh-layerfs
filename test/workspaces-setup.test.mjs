import assert from 'node:assert/strict'
import test from 'node:test'
import { createSteps, defaultMachine, freeStoreName, machinesFor, pgLoginBody, pgLoginProblem, pgMachine, pickable, primaryMachine, runsOn, tileBlocks } from '../src/client/projects/setup/model.ts'

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
  assert.equal(defaultMachine(machinesFor(view, 'sqlite')), 'docker')
  assert.equal(defaultMachine(machinesFor({ machines: view.machines.filter((m) => m.name !== 'docker') }, 'sqlite')), 'native')
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
  // ready, or platforms not read (an older host): docker stays the default
  assert.equal(defaultMachine(machines, tileBlocks(view.machines, [row('docker'), row('native')], 'macos')), 'docker')
  assert.equal(tileBlocks(view.machines, undefined, 'macos').size, 0)
})

test('where a project runs: SQLite its Store machine, PostgreSQL the machine its Store runs on', () => {
  assert.deepEqual(runsOn({ kind: 'sqlite', machine: 'dev' }), ['dev'])
  assert.deepEqual(runsOn({ kind: 'postgresql', machine: null, runsOn: 'docker' }), ['docker'])
  assert.deepEqual(runsOn({ kind: 'postgresql', machine: null }), ['native'], 'a host that names none: native')
  assert.equal(pgMachine({ runsOn: 'dev' }), 'dev')
  assert.equal(pgMachine({ runsOn: null }), 'native')
  assert.equal(primaryMachine({ kind: 'postgresql', machine: null, runsOn: 'docker' }), 'docker')
  assert.equal(primaryMachine({ kind: 'sqlite', machine: null }), 'native')
})

test('store names', () => {
  assert.equal(freeStoreName('website', view), 'website-3')
  assert.equal(freeStoreName('fresh', view), 'fresh')
})

test('a new PostgreSQL Store\'s login: a saved one by name, or a new one (name, user, password) never under a saved name', () => {
  const saved = ['team', 'ro']
  // success: a new login, sent as authName + user + passwordValue; a saved one by its name
  const fresh = { authName: ' shop ', user: ' app ', password: 'p w' }
  assert.equal(pgLoginProblem(fresh, saved), null)
  assert.deepEqual(pgLoginBody(fresh), { authName: 'shop', user: 'app', passwordValue: 'p w' }, 'names trimmed, the password as typed')
  assert.equal(pgLoginProblem({ auth: 'team' }, saved), null)
  assert.deepEqual(pgLoginBody({ auth: 'team' }), { auth: 'team' })
  // an existing login name is refused, never saved over
  assert.equal(pgLoginProblem({ ...fresh, authName: 'team' }, saved), 'nameTaken')
  // a missing user, password or name; an invalid name; a saved login not picked or not listed
  assert.equal(pgLoginProblem({ ...fresh, user: '  ' }, saved), 'user')
  assert.equal(pgLoginProblem({ ...fresh, password: '' }, saved), 'password')
  assert.equal(pgLoginProblem({ ...fresh, authName: '' }, saved), 'name')
  assert.equal(pgLoginProblem({ ...fresh, authName: 'Shop Login' }, saved), 'nameInvalid')
  assert.equal(pgLoginProblem({ auth: '' }, saved), 'pick')
  assert.equal(pgLoginProblem({ auth: 'gone' }, saved), 'pick')
})

test('the setup copy offers no password reference, in either language', async () => {
  const { locales } = await import('../src/client/projects/setup/locale.ts')
  for (const [lang, words] of Object.entries(locales)) {
    for (const [key, text] of Object.entries(words)) assert.doesNotMatch(text, /env:|file:\//, `${lang}.${key}`)
    assert.ok(words.loginName && words.user && words.password && words.loginNameTaken.includes('{auth}'), lang)
  }
  assert.deepEqual(Object.keys(locales.zh).sort(), Object.keys(locales.en).sort())
})

test('create steps: new SQLite Store on docker is made on native, docker started, then pushed', () => {
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['docker'] }, view)),
    ['store', 'init', 'start:docker', 'place:docker', 'open'])
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['native'] }, view)),
    ['store', 'init', 'open'])
})

test('create steps: existing SQLite Store starts its machine, inits there, moves only when asked', () => {
  const onDocker = { name: 's', kind: 'sqlite', machine: 'docker', projects: [] }
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: onDocker, machines: ['docker'] }, view)), ['start-store', 'init', 'open'])
  const onNative = { name: 's', kind: 'sqlite', machine: 'native', projects: [] }
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: onNative, machines: ['dev'] }, view)), ['init', 'place:dev', 'open'])
})

test('create steps: a new PostgreSQL Store is connected with where it runs; an existing one only has that changed', () => {
  // nothing attaches (a PostgreSQL Store is on no machine); docker is stopped in this view, so it is started for the session Create opens
  const fresh = createSteps({ name: 'app', kind: 'postgresql', store: null, newStore: { name: 'pg' }, machines: ['docker'] }, view)
  assert.deepEqual(ids(fresh), ['connect', 'init', 'start:docker', 'open'])
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'postgresql', store: null, newStore: { name: 'pg' }, machines: ['dev'] }, view)), ['connect', 'init', 'open'], 'a running machine is not started')
  assert.equal(fresh[0].machine, 'docker', 'connect carries the machine its sessions run on')
  const existing = { name: 'pg', kind: 'postgresql', runsOn: 'native', projects: [] }
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'postgresql', store: existing, machines: ['native'] }, view)), ['init', 'open'])
  const moved = createSteps({ name: 'app', kind: 'postgresql', store: existing, machines: ['dev'] }, view)
  assert.deepEqual(ids(moved), ['init', 'runs-on:dev', 'open'])
  assert.equal(moved[1].machine, 'dev')
})

test('create steps: a folder is checked before anything is made', () => {
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['docker'], source: '/Users/me/code/shop' }, view)),
    ['check', 'store', 'init', 'start:docker', 'place:docker', 'open'])
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'postgresql', store: null, newStore: { name: 'pg' }, machines: ['native'], source: '/srv/app' }, view)),
    ['check', 'connect', 'init', 'open'])
  assert.equal(createSteps({ name: 'app', kind: 'sqlite', store: null, newStore: { name: 'app' }, machines: ['native'] }, view)[0].id, 'store', 'an empty project has no check')
})
