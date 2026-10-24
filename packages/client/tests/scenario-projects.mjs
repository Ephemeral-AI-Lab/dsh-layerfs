import assert from 'node:assert/strict'
import { startRun, projectOf } from '../src/client/scenarios.ts'

const requests = []
const originalFetch = globalThis.fetch
let serial = 0
globalThis.fetch = async (path, options) => {
  const body = options.body ? JSON.parse(options.body) : null
  requests.push({ path, method: options.method, body })
  const data =
    path === '/layerfs/status'
      ? { configured: true, missing: [] }
      : path === '/layerfs/init'
        ? { job: { id: 'job', step: 'done' } }
        : {}
  return new Response(JSON.stringify(data), { status: 200 })
}
const ok = (value = {}) => Promise.resolve({ ok: true, value })
const services = {
  remote: {
    workspace: { create: () => ok({ workspace: { workspaceId: 'w', path: '/work' } }) },
    session: {
      create: () => ok({ sessionId: `session-${++serial}` }),
      rename: () => ok(),
      selectModel: () => ok(),
      prompt: () => ok(),
    },
  },
}
try {
  const scenario = { id: 'tour', title: 'Tour', fixture: '/fixture' }
  const info = { workspace: '/work', preset: 'p', provider: 'mock', prompt: 'Run' }
  await startRun(services, info, scenario, () => {}, false)
  await startRun(services, info, scenario, () => {}, false)
  const projects = requests.filter((r) => r.path === '/layerfs/init').map((r) => r.body.name)
  assert.equal(projects.length, 2)
  assert.notEqual(projects[0], projects[1])
  assert.ok(projects.every((p) => /^mock-tour-[0-9a-f-]{36}$/.test(p)))
  assert.ok(requests.every((r) => r.method !== 'DELETE'))
  assert.deepEqual(
    requests.filter((r) => r.path === '/layerfs-mock/tour/session').map((r) => r.body.project),
    projects,
  )
  assert.equal(projectOf('tour', { project: projects[0] }), projects[0])
  assert.equal(projectOf('tour'), 'mock-tour')
  console.log('scenario-projects: PASS (fresh Stores per run, previous projects retained, project recorded)')
} finally {
  globalThis.fetch = originalFetch
}
