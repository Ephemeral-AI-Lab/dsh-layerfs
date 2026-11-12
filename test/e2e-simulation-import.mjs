#!/usr/bin/env node
// Continue one completed scripted conversation on another private installation.
// Both dev homes may share the same LayerFS home; workspaces must remain separate.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDev, runTurn } from '../tools/e2e-lib.mjs'

const { A_DIR, B_DIR, SIMULATION_SESSION_ID: sessionId, SIMULATION_PROJECT: project } = process.env
assert.ok(A_DIR && B_DIR && sessionId && project, 'A_DIR, B_DIR, SIMULATION_SESSION_ID and SIMULATION_PROJECT are required')
const a = await openDev({ url: readFileSync(join(A_DIR, 'url.txt'), 'utf8').trim() })
const b = await openDev({ url: readFileSync(join(B_DIR, 'url.txt'), 'utf8').trim() })
const op = (page, name, args = {}) => page.evaluate(([name, args]) => window.__dshLayerfs.op(name, args), [name, args])
try {
  const before = await op(a.page, 'session.state', { sessionId })
  assert.equal((await op(a.page, 'simulation.script', { sessionId })).state, 'completed')
  const originalAnnotations = await op(a.page, 'session.annotations', { sessionId })
  await op(a.page, 'session.mirror', { sessionId })
  await op(b.page, 'sessions.open', { sessionId, project })
  const source = await op(b.page, 'simulation.script', { sessionId })
  assert.equal(source.script.source, null, 'the second installation does not need the private run package')
  const archivedAnnotations = await op(b.page, 'session.annotations', { sessionId })
  for (const row of originalAnnotations.invocations ?? []) assert.ok(archivedAnnotations.invocations?.some(imported => imported.id === row.id), 'the full annotation history survives import')
  const result = await runTurn(b.page, { newSession: false, model: 'Fake scripted', message: 'bash: test -n "$DSH_LAYERFS_WS" && "$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" \'ls\' --stream', expect: /done: 1 commands/, timeoutMs: 60000 })
  assert.ok(result.ok, result.error)
  assert.equal(result.sessionId, sessionId)
  const imported = await op(b.page, 'session.state', { sessionId })
  const after = await op(a.page, 'session.state', { sessionId })
  assert.notEqual(imported.binding.sandbox, before.binding.sandbox)
  assert.notEqual(imported.binding.branch, before.binding.branch)
  assert.equal(after.binding.ws, before.binding.ws, 'import must leave the first installation workspace untouched')
  assert.ok(!after.status?.error)
  assert.equal((await op(b.page, 'simulation.script', { sessionId })).state, 'completed', 'import does not replay the script')
  assert.deepEqual([...a.logs, ...b.logs].filter(line => line.startsWith('[pageerror]')), [])
  console.log('Simulation portability proof passed: native history, immutable pin, separate workspace and same-session ordinary tools.')
} finally {
  await a.browser.close()
  await b.browser.close()
}
