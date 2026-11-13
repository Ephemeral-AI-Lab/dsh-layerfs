import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTree, buildSandboxMap, execWords, innerCommand, mountedAt, phaseOf, replayClock, sanitizeCommand, rootOf, targetsOf, CALL_GAP_S, FLASH_S, MAX_CALL_S, MIN_CALL_S, RESULT_S, TAIL_S, requestS } from '../src/client/views/model.ts'

const byId = {
  root: { running: false },
  kid: { origin: 'subagent', parentId: 'root', running: true },
  grandkid: { origin: 'subagent', parentId: 'kid' },
  fork: { parentId: 'root' },
  orphan: { origin: 'subagent', parentId: 'gone' },
}

test('rootOf walks subagent parents and stops at forks and orphans', () => {
  assert.equal(rootOf('grandkid', byId), 'root')
  assert.equal(rootOf('kid', byId), 'root')
  assert.equal(rootOf('fork', byId), 'fork')
  assert.equal(rootOf('orphan', byId), 'orphan')
  assert.equal(rootOf('unknown', byId), 'unknown')
  assert.ok(['a', 'b'].includes(rootOf('a', { a: { origin: 'subagent', parentId: 'b' }, b: { origin: 'subagent', parentId: 'a' } })), 'a cycle ends')
})

test('agentTree lists the root, then each subagent after its parent', () => {
  assert.deepEqual(agentTree('root', byId), [
    { id: 'root', depth: 0, running: false },
    { id: 'kid', depth: 1, running: true, parent: 'root' },
    { id: 'grandkid', depth: 2, running: false, parent: 'kid' },
  ])
})

test('targetsOf reads branches, workspaces and sandboxes from CLI words', () => {
  assert.deepEqual(targetsOf(['file', 'write', 'st/p', 'main', 'a.txt', '<3 bytes>']), { branch: 'main' })
  assert.deepEqual(targetsOf(['branch', 'fork', 'st/p', 'feature', 'main']), { branch: 'feature' })
  assert.deepEqual(targetsOf(['branch', 'list', 'st/p']), {})
  assert.deepEqual(targetsOf(['sandbox', 'create', 'st/p', 'sbx', 'docker']), { sandbox: 'sbx', machine: 'docker' })
  assert.deepEqual(targetsOf(['sandbox', 'close', 'sbx']), { sandbox: 'sbx' })
  assert.deepEqual(targetsOf(['workspace', 'mount', 'sbx', 'main', '--name', 'ws']), { sandbox: 'sbx', branch: 'main', ws: 'sbx:ws' })
  assert.deepEqual(targetsOf(['workspace', 'exec', 'sbx:ws', '<12 bytes>']), { ws: 'sbx:ws', sandbox: 'sbx' })
  assert.deepEqual(targetsOf(['workspace', 'commit', 'sbx:ws', '--message', '<9 bytes>']), { ws: 'sbx:ws', sandbox: 'sbx' })
})

test('replayClock shortens idle gaps to one second', () => {
  const clock = replayClock([{ at: 0, ms: 500 }, { at: 60_500, ms: 100 }])
  assert.equal(clock(0), 0)
  assert.equal(clock(500), 0.5)
  assert.equal(clock(1000), 1)
  assert.equal(clock(30_000), 1.5)
  assert.equal(clock(60_500), 1.5)
  assert.equal(clock(60_600), 1.6)
})

test('buildSandboxMap places calls on nodes and the replay clock', () => {
  const agents = agentTree('root', byId)
  const line = (at, argv, outcome = 'ok', ms = 10) => ({ v: 1, at, ms, client: 'cli', argv, outcome })
  const model = buildSandboxMap(agents, { project: 'st/p', branch: 'main', sandbox: 'sbx', ws: 'sbx:dsh', machine: 'native' }, {
    root: [line(1000, ['workspace', 'exec', 'sbx:dsh', '<5 bytes>'], 'ok', 2000), line(2000, ['workspace', 'status', 'sbx:dsh'])],
    kid: [
      line(1500, ['workspace', 'mount', 'sbx2', 'feature', '--name', 'w2']),
      line(90_000, ['workspace', 'exec', 'sbx2:w2', '<3 bytes>'], 'Refused'),
    ],
  })
  assert.deepEqual(model.branches, ['main', 'feature'])
  assert.deepEqual(model.sandboxes.map((s) => [s.name, s.machine, s.workspaces.map((w) => `${w.id}@${w.branch}`)]), [
    ['sbx', 'native', ['sbx:dsh@main']],
    ['sbx2', undefined, ['sbx2:w2@feature']],
  ])
  assert.equal(model.events.length, 3, 'status polls are left out')
  const [exec, mount, late] = model.events
  assert.equal(exec.branch, 'main', 'a workspace call inherits its workspace branch')
  assert.equal(exec.end, 2)
  assert.ok(Math.abs(mount.end - mount.start - MIN_CALL_S) < 1e-9)
  assert.equal(late.branch, 'feature')
  assert.equal(late.outcome, 'Refused')
  assert.equal(late.start, 3, 'the long idle gap became one second')
  assert.ok(model.duration > late.end)
})

test('replay pacing: one agent\'s back-to-back calls get their own windows, long calls are capped', () => {
  const agents = agentTree('root', byId)
  const line = (at, argv, ms = 5) => ({ v: 1, at, ms, client: 'cli', argv, outcome: 'ok' })
  const model = buildSandboxMap(agents, null, {
    root: [
      line(0, ['branch', 'fork', 'st/p', 'b1']),
      line(10, ['sandbox', 'create', 'st/p', 'sbx', 'native']),
      line(20, ['workspace', 'mount', 'sbx', 'b1', '--name', 'w']),
      line(30, ['workspace', 'exec', 'sbx:w', '<9 bytes>'], 600_000),
      line(600_100, ['project', 'get', 'st/p']),
    ],
    kid: [line(15, ['file', 'read', 'st/p', 'b1', '/a'])],
  })
  const [fork, create, kid, mount, exec] = model.events
  assert.equal(model.events.length, 5, 'project.get is a quiet read')
  assert.equal(fork.start, 0)
  assert.ok(Math.abs(create.start - (fork.end + CALL_GAP_S)) < 1e-9, 'the next call waits for the previous one of the same agent')
  assert.equal(kid.agent, 'kid')
  assert.ok(kid.start >= create.start, 'order across agents is kept')
  assert.ok(Math.abs(mount.start - (create.end + CALL_GAP_S)) < 1e-9)
  assert.ok(Math.abs(exec.end - exec.start - MAX_CALL_S) < 1e-9, 'a ten-minute exec holds the replay for MAX_CALL_S')
  assert.ok(Math.abs(model.duration - (exec.end + TAIL_S)) < 1e-9)
})

test('phaseOf: a request travels out once, holds, its result comes back once and fades', () => {
  const e = { start: 10, end: 14 }
  const req = requestS(e)
  assert.equal(phaseOf(e, 9), null)
  assert.deepEqual(phaseOf(e, 10), { kind: 'request', u: 0 })
  const mid = phaseOf(e, 10 + req / 2)
  assert.equal(mid.kind, 'request'); assert.ok(Math.abs(mid.u - 0.5) < 1e-9)
  assert.equal(phaseOf(e, 10 + req + 1).kind, 'held', 'no looping while the call runs')
  const back = phaseOf(e, 14 + RESULT_S / 2)
  assert.equal(back.kind, 'result'); assert.ok(Math.abs(back.u - 0.5) < 1e-9)
  const fade = phaseOf(e, 14 + RESULT_S + FLASH_S / 2)
  assert.equal(fade.kind, 'flash'); assert.ok(Math.abs(fade.f - 0.5) < 1e-9)
  assert.equal(phaseOf(e, 14 + TAIL_S), null)
  // Reduced motion: no travel, a steady result colour for the tail.
  assert.equal(phaseOf(e, 10, true).kind, 'held')
  assert.deepEqual(phaseOf(e, 15, true), { kind: 'flash', u: 0, f: 1 })
})

test('a refused call adds no node; it still names the nodes that exist', () => {
  const agents = agentTree('root', byId)
  const line = (at, argv, outcome = 'ok') => ({ v: 1, at, ms: 5, client: 'cli', argv, outcome })
  const model = buildSandboxMap(agents, { project: 'st/p', branch: 'main', sandbox: 'sbx', ws: 'sbx:dsh' }, {
    root: [
      line(0, ['sandbox', 'create', 'st/p', 'box2', 'native'], 'Failed'),
      line(10, ['branch', 'fork', 'st/p', 'feat', 'main']),
      line(20, ['workspace', 'mount', 'sbx', 'feat', '--name', 'w'], 'Failed'),
      line(30, ['workspace', 'exec', 'sbx:dsh', '<3 bytes>'], 'Failed'),
    ],
  })
  assert.deepEqual(model.sandboxes.map((s) => [s.name, s.workspaces.map((w) => w.id)]), [['sbx', ['sbx:dsh']]], 'no box2, no sbx:w')
  assert.deepEqual(model.branches, ['main', 'feat'])
  const [create, , mount, exec] = model.events
  assert.equal(create.sandbox, undefined, 'the refused create names no sandbox that exists')
  assert.equal(mount.ws, undefined)
  assert.equal(mount.sandbox, 'sbx', 'the refused mount still names the sandbox it was refused in')
  assert.equal(mount.branch, 'feat')
  assert.equal(exec.ws, 'sbx:dsh', 'a refused call on an existing workspace stays on it')
  assert.equal(exec.branch, 'main')
})

test('a project map: open Sandboxes seed the map, closed ones retire, a re-created one reopens', () => {
  const line = (at, argv, outcome = 'ok') => ({ v: 1, at, ms: 5, client: 'cli', argv, outcome })
  const agents = [{ id: 'host', depth: 0, running: false }]
  const live = { at: 3500, sandboxes: [{ name: 'box', machine: 'm1', workspaces: [{ id: 'box:main', branch: 'main' }] }] }
  const model = buildSandboxMap(agents, null, { host: [
    line(1000, ['sandbox', 'create', 's/p', 'old', 'm2']),
    line(2000, ['sandbox', 'close', 'old']),
    line(3000, ['sandbox', 'create', 's/p', 'old', 'm2']),
    line(4000, ['sandbox', 'create', 's/p', 'gone', 'm2']),
  ] }, live)
  const byName = Object.fromEntries(model.sandboxes.map((b) => [b.name, b]))
  assert.deepEqual(byName.box, { name: 'box', machine: 'm1', workspaces: [{ id: 'box:main', name: 'main', branch: 'main' }], closed: false })
  assert.equal(byName.old.closed, true, 'not open now: closed, although re-created in the calls')
  assert.equal(byName.gone.closed, false, 'a call newer than the list: still open')
  assert.equal(buildSandboxMap(agents, null, { host: [line(4000, ['sandbox', 'create', 's/p', 'gone', 'm2'])] }, { ...live, at: 5000 }).sandboxes.find((b) => b.name === 'gone').closed, true)
  const reopened = buildSandboxMap(agents, null, { host: [line(1000, ['sandbox', 'close', 'x']), line(2000, ['sandbox', 'create', 's/p', 'x', 'm'])] })
  assert.equal(reopened.sandboxes[0].closed, false, 'a create after a close reopens')
})

test('mountedAt: a workspace shows from its mount until an unmount after it ends', () => {
  const line = (at, argv, outcome = 'ok') => ({ v: 1, at, ms: 5, client: 'cli', argv, outcome })
  const agents = [{ id: 'a', depth: 0, running: false }]
  const model = buildSandboxMap(agents, null, { a: [
    line(1000, ['workspace', 'mount', 'box', 'main', '--name', 'w']),
    line(1100, ['workspace', 'unmount', 'box:w']),
    line(1200, ['workspace', 'unmount', 'box:w'], 'Busy'),
    line(1300, ['workspace', 'mount', 'box', 'main', '--name', 'w']),
  ] })
  const [mount1, unmount, busy, mount2] = model.events
  assert.equal(busy.outcome, 'Busy')
  assert.equal(mountedAt(model.events, 'box:w', mount1.start - 0.01), false, 'before its first mount')
  assert.equal(mountedAt(model.events, 'box:w', mount1.start), true)
  assert.equal(mountedAt(model.events, 'box:w', unmount.end - 0.01), true, 'until the unmount ends')
  assert.equal(mountedAt(model.events, 'box:w', unmount.end), false)
  assert.equal(mountedAt(model.events, 'box:w', mount2.start), true, 'mounted again')
  assert.equal(mountedAt(model.events, 'other:w', 0), true, 'no mount in the calls: always shown')
})

test('innerCommand: a plain workspace exec shows the command it ran; anything else stays as typed', () => {
  assert.equal(innerCommand(`"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" 'ls' --stream`), 'ls')
  assert.equal(innerCommand(`"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" 'mkdir -p notes && echo "a b" > notes/x.md' --stream`), 'mkdir -p notes && echo "a b" > notes/x.md')
  assert.equal(innerCommand(`layerfs workspace exec sbx:main -- 'it'\\''s'`), "it's")
  assert.equal(innerCommand('npm test && npm run build'), 'npm test && npm run build')
  assert.equal(innerCommand(`"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" 'a' && echo done`), `"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" 'a' && echo done`)
})

test('sanitizeCommand and execWords: terminal lines without the plugin plumbing', () => {
  assert.equal(sanitizeCommand(`"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" 'npm test' --stream`, 'main'), 'npm test')
  assert.equal(sanitizeCommand(`cd x && "$DSH_LAYERFS_CLI" workspace commit "$DSH_LAYERFS_WS" --stream`, 'main'), 'cd x && layerfs workspace commit main')
  assert.equal(sanitizeCommand(`"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" 'ls'\n"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" 'pwd'`, 'w'), 'ls\npwd')
  assert.equal(sanitizeCommand(`test -n "$DSH_LAYERFS_WS" && "$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" 'ls' --stream`, 'main'), 'ls')
  assert.equal(sanitizeCommand(`test -n "$DSH_LAYERFS_WS" && "$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" 'mkdir -p a && echo "x && y" > a/b' --stream`, 'main'), 'mkdir -p a && echo "x && y" > a/b')
  assert.equal(execWords(['workspace', 'exec', 'sbx:main', '<65 bytes>', '--stream']), null)
  assert.equal(execWords(['workspace', 'exec', 'sbx:main', '--', 'npm', 'test']), 'npm test')
})
