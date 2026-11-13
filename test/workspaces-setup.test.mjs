import assert from 'node:assert/strict'
import test from 'node:test'
import { createSteps, defaultMachine, freeStoreName, machinesFor, passwordBody, pgMachine, primaryMachine, runsOn } from '../src/client/projects/setup/model.ts'

const view = {
  machines: [
    { name: 'native', platform: 'native', state: 'running', supports: { sqlite: true, postgresql_sandbox: true, reason: null } },
    { name: 'dev', platform: 'lima', state: 'running', supports: { sqlite: true, postgresql_sandbox: true, reason: null } },
    { name: 'docker', platform: 'docker', state: 'stopped', supports: { sqlite: true, postgresql_sandbox: true, reason: null } },
    { name: 'old', platform: 'ssh', state: 'unsupported', supports: null },
    { name: 'nopg', platform: 'x', state: 'running', supports: { sqlite: true, postgresql_sandbox: false, reason: 'no' } },
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

test('where a project runs: SQLite its Store machine, PostgreSQL its attachments', () => {
  assert.deepEqual(runsOn({ kind: 'sqlite', machine: 'dev' }), ['dev'])
  assert.deepEqual(runsOn({ kind: 'postgresql', attachments: [{ machine: 'docker' }, { machine: 'native' }] }), ['docker', 'native'])
  assert.deepEqual(runsOn({ kind: 'postgresql', attachments: null }), ['native'])
  assert.equal(pgMachine({ attachments: [{ machine: 'docker' }, { machine: 'native' }] }), 'native')
  assert.equal(pgMachine({ attachments: [{ machine: 'a' }, { machine: 'b', checked: { at: 1 } }] }), 'b')
  assert.equal(primaryMachine({ kind: 'postgresql', attachments: [{ machine: 'docker', checked: null }] }), 'docker')
  assert.equal(primaryMachine({ kind: 'sqlite', machine: null }), 'native')
})

test('store names and passwords', () => {
  assert.equal(freeStoreName('website', view), 'website-3')
  assert.equal(freeStoreName('fresh', view), 'fresh')
  assert.deepEqual(passwordBody('env:PGPASS'), { password: 'env:PGPASS' })
  assert.deepEqual(passwordBody('file:/run/pw'), { password: 'file:/run/pw' })
  assert.deepEqual(passwordBody('hunter2'), { passwordValue: 'hunter2' })
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

test('create steps: PostgreSQL connects, attaches ticked machines, detaches native when unticked', () => {
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'postgresql', store: null, newStore: { name: 'pg' }, machines: ['docker'] }, view)),
    ['connect', 'init', 'start:docker', 'attach:docker', 'detach:native', 'open'])
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'postgresql', store: null, newStore: { name: 'pg' }, machines: ['native', 'dev'] }, view)),
    ['connect', 'init', 'attach:dev', 'open'])
  const existing = { name: 'pg', kind: 'postgresql', attachments: [{ machine: 'native' }], projects: [] }
  assert.deepEqual(ids(createSteps({ name: 'app', kind: 'postgresql', store: existing, machines: ['native'] }, view)), ['init', 'open'])
})
