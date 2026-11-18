// LayerFS setup on the Machines pages (docs/specs/layerfs-setup.md §4.3–§4.4): a new VM's
// defaults from `options[].default`, the room line, and docker's socket choices.
//   node --test test/machine-setup.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyVm, roomOf, sizeText } from '../src/client/machines/model.ts'
import { onSocketRequest, requestSocketSetting, socketSetting, socketSourceWords, takeSocketRequest } from '../src/client/machines/socket.ts'

const GIB = 2 ** 30

test('a new VM starts from LayerFS’s defaults, else the ones this page knew', () => {
  // 2.0 `home get --with platforms`: a platform's options are keyed `option`
  const options = [{ option: 'cpus', kind: 'int', default: 4 }, { option: 'memory', kind: 'size', default: 8 * GIB }, { option: 'disk', kind: 'size', default: '40GiB' }]
  assert.deepEqual(emptyVm({ options }), { name: '', cpus: '4', memory: '8G', disk: '40GiB' })
  // an older CLI sends no default
  assert.deepEqual(emptyVm({ options: options.map(({ option, kind }) => ({ option, kind })) }), { name: '', cpus: '2', memory: '4G', disk: '20G' })
  assert.deepEqual(emptyVm(), { name: '', cpus: '2', memory: '4G', disk: '20G' })
  // an unreadable default falls back
  assert.deepEqual(emptyVm({ options: [{ option: 'cpus', kind: 'int', default: 'many' }, { option: 'memory', kind: 'size', default: null }] }), { name: '', cpus: '2', memory: '4G', disk: '20G' })
  assert.equal(sizeText(512 * 2 ** 20), '512M')
  assert.equal(sizeText(1.5 * GIB), '1536M')
  assert.equal(sizeText(-1), null)
})

test('the room line: this computer, the other VMs’ sizes, and what the new one overcommits', () => {
  const host = { cpus: 14, memory: 36 * GIB, diskFree: 304 * GIB }
  const machines = [
    { platform: 'native', cpus: null, memory: null },
    { platform: 'docker', cpus: 8, memory: 16 * GIB },
    { platform: 'lima', cpus: 2, memory: 4 * GIB },
    { platform: 'apple-container', cpus: 2, memory: 4 * GIB },
  ]
  const fits = roomOf(host, machines, { cpus: 2, memory: 4 * GIB, disk: 20 * GIB })
  assert.deepEqual(fits.others, { count: 2, cpus: 4, memory: 8 * GIB }, 'native and docker are not VMs')
  assert.deepEqual(fits.over, [])
  assert.deepEqual(roomOf(host, machines, { cpus: 12, memory: 30 * GIB, disk: 400 * GIB }).over, ['cpus', 'memory', 'disk'])
  // exactly what is left is not over
  assert.deepEqual(roomOf(host, machines, { cpus: 10, memory: 28 * GIB, disk: 304 * GIB }).over, [])
  // what was not observed (or not readable in the form) is never a warning
  assert.deepEqual(roomOf({ cpus: null, memory: null, diskFree: null }, machines, { cpus: 99, memory: 99 * GIB, disk: 9999 * GIB }).over, [])
  assert.deepEqual(roomOf(host, machines, { cpus: null, memory: null, disk: null }).over, [])
})

test('docker’s socket: Automatic names the socket in use while none is recorded', () => {
  const p = {
    socket: { path: '/Users/me/.docker/run/docker.sock', source: 'context:desktop-linux', state: 'silent' },
    candidates: [
      { path: '/Users/me/.docker/run/docker.sock', source: 'context:desktop-linux' },
      { path: null, source: 'context:remote', usable: false },
      { path: '/var/run/docker.sock', source: 'default' },
    ],
  }
  const s = socketSetting(p, undefined)
  assert.equal(s.recorded, false)
  assert.equal(s.current, '', 'Automatic is chosen')
  assert.deepEqual(s.inUse, { path: '/Users/me/.docker/run/docker.sock', source: 'context:desktop-linux', state: 'silent' })
  assert.deepEqual(s.choices.map((c) => [c.path, c.usable]), [['/Users/me/.docker/run/docker.sock', true], [null, false], ['/var/run/docker.sock', true]])
})

test('docker’s socket: a recorded one is the choice, listed first when LayerFS did not find it', () => {
  const p = { socket: { path: '/srv/docker.sock', source: 'recorded', state: 'answering' }, candidates: [{ path: '/var/run/docker.sock', source: 'default' }] }
  const s = socketSetting(p, '/srv/docker.sock')
  assert.equal(s.recorded, true)
  assert.equal(s.current, '/srv/docker.sock')
  assert.deepEqual(s.choices.map((c) => [c.path, c.source]), [['/srv/docker.sock', 'recorded'], ['/var/run/docker.sock', 'default']])
  // recorded per the platform row though the machine list did not carry it
  assert.equal(socketSetting(p, undefined).current, '/srv/docker.sock')
})

test('docker’s socket: an older CLI (no candidates) keeps the path field', () => {
  assert.equal(socketSetting({ socket: undefined, candidates: undefined }, '/var/run/docker.sock'), null)
  assert.equal(socketSetting(undefined, null), null)
})

test('where a socket was found, in words', () => {
  assert.deepEqual(socketSourceWords('context:colima'), { key: 'socketFromContext', values: { name: 'colima' } })
  assert.deepEqual(socketSourceWords('env:DOCKER_HOST'), { key: 'socketFromEnv' })
  assert.deepEqual(socketSourceWords('orbstack'), { key: 'socketFromOrbstack' })
  assert.deepEqual(socketSourceWords('somewhere'), { key: 'raw', values: { text: 'somewhere' } })
  assert.equal(socketSourceWords(null), null)
})

test('a request to open the socket setting is taken once', () => {
  let heard = 0
  const off = onSocketRequest(() => { heard++ })
  requestSocketSetting()
  off()
  assert.equal(heard, 1)
  assert.equal(takeSocketRequest(), true)
  assert.equal(takeSocketRequest(), false)
})
