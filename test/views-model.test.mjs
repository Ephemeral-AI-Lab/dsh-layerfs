import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTree, buildSandboxMap, packetAt, replayClock, rootOf, targetsOf, CALL_GAP_S, FLASH_S, LAP_S, MAX_CALL_S, MIN_CALL_S, RESULT_S } from '../src/client/views/model.ts'

const byId = {
  root: { running: false },
  kid: { origin: 'subagent', parentSessionId: 'root', running: true },
  grandkid: { origin: 'subagent', parentSessionId: 'kid' },
  fork: { parentSessionId: 'root' },
  orphan: { origin: 'subagent', parentSessionId: 'gone' },
}

test('rootOf walks subagent parents and stops at forks and orphans', () => {
  assert.equal(rootOf('grandkid', byId), 'root')
  assert.equal(rootOf('kid', byId), 'root')
  assert.equal(rootOf('fork', byId), 'fork')
  assert.equal(rootOf('orphan', byId), 'orphan')
  assert.equal(rootOf('unknown', byId), 'unknown')
  assert.ok(['a', 'b'].includes(rootOf('a', { a: { origin: 'subagent', parentSessionId: 'b' }, b: { origin: 'subagent', parentSessionId: 'a' } })), 'a cycle ends')
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
  assert.ok(Math.abs(model.duration - (exec.end + FLASH_S)) < 1e-9)
})

test('packetAt: a request loops forward over the chain, the result runs back once', () => {
  const e = { start: 10, end: 14 }
  assert.equal(packetAt(e, 9, 2), null)
  assert.deepEqual(packetAt(e, 10, 2), { hop: 0, at: 0, kind: 'request' })
  const mid = packetAt(e, 10 + LAP_S * 0.75, 2)
  assert.equal(mid.hop, 1); assert.ok(Math.abs(mid.at - 0.5) < 1e-9); assert.equal(mid.kind, 'request')
  const back = packetAt(e, 14 + RESULT_S * 0.25, 2)
  assert.equal(back.kind, 'result'); assert.equal(back.hop, 1); assert.ok(Math.abs(back.at - 0.5) < 1e-9)
  const home = packetAt(e, 14 + RESULT_S * 0.75, 2)
  assert.equal(home.hop, 0); assert.ok(Math.abs(home.at - 0.5) < 1e-9)
  assert.equal(packetAt(e, 14 + RESULT_S, 2), null)
  assert.equal(packetAt(e, 11, 0), null)
})
