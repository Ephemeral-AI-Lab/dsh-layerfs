import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { DEFAULT_HISTORY_LIMITS, runHistoryDAG } from '../src/host/presets/recipe/history-scheduler.js'

function task(store, name) {
  return { store, project: `${store}/${name}`, steps: [
    ...Array.from({ length: 5 }, (_, index) => ({ key: `write${index}`, dependsOn: [] })),
    { key: 'publish', dependsOn: Array.from({ length: 5 }, (_, index) => `write${index}`) },
  ] }
}

test('default history admission fills the 12/3/3 budgets and preserves dependencies', async () => {
  assert.deepEqual(DEFAULT_HISTORY_LIMITS, { concurrency: 12, perStore: 3, perProject: 3 })
  const stores = new Map(), projects = new Map(), finished = new Set(), attempts = new Map()
  let active = 0, peak = 0, peakStore = 0, peakProject = 0
  const execute = async (task, step) => {
    const key = `${task.project}:${step.key}`
    attempts.set(key, (attempts.get(key) ?? 0) + 1)
    for (const parent of step.dependsOn) assert.ok(finished.has(`${task.project}:${parent}`), `${key} ran before ${parent}`)
    stores.set(task.store, (stores.get(task.store) ?? 0) + 1)
    projects.set(task.project, (projects.get(task.project) ?? 0) + 1)
    active++
    peak = Math.max(peak, active)
    peakStore = Math.max(peakStore, stores.get(task.store))
    peakProject = Math.max(peakProject, projects.get(task.project))
    assert.ok(active <= 12)
    assert.ok(stores.get(task.store) <= 3)
    assert.ok(projects.get(task.project) <= 3)
    try {
      await setImmediate()
      finished.add(key)
    } finally {
      active--
      stores.set(task.store, stores.get(task.store) - 1)
      projects.set(task.project, projects.get(task.project) - 1)
    }
  }
  const tasks = Array.from({ length: 5 }, (_, index) => [task(`store${index}`, 'first'), task(`store${index}`, 'second')]).flat()
  await runHistoryDAG(tasks, execute)
  assert.equal(peak, 12, 'independent Stores fill the global budget')
  assert.equal(peakStore, 3, 'a Store can use its full budget')
  // A single project also fills, and never exceeds, its own budget.
  await runHistoryDAG([task('isolated', 'project')], execute)
  assert.equal(peakProject, 3)
  assert.equal(finished.size, 66)
  assert.ok([...attempts.values()].every(count => count === 1), 'each command runs exactly once')
  assert.equal(active, 0)
  assert.ok([...stores.values(), ...projects.values()].every(count => count === 0))
})

test('a failed mutation is not replayed and dispatched commands settle before rejection', async () => {
  const failure = Object.assign(new Error('busy'), { code: 'Busy' })
  const attempts = new Map(), settled = []
  const work = { store: 'studio', project: 'studio/website', steps: [
    { key: 'failed-write', dependsOn: [] },
    { key: 'other-write', dependsOn: [] },
    { key: 'third-write', dependsOn: [] },
    { key: 'undispatched-write', dependsOn: [] },
    { key: 'publish', dependsOn: ['failed-write'] },
  ] }
  await assert.rejects(runHistoryDAG([work], async (_task, step) => {
    attempts.set(step.key, (attempts.get(step.key) ?? 0) + 1)
    if (step.key === 'failed-write') throw failure
    await setImmediate()
    settled.push(step.key)
  }), error => error === failure)
  assert.deepEqual([...attempts.keys()], ['failed-write', 'other-write', 'third-write'])
  assert.ok([...attempts.values()].every(count => count === 1))
  assert.deepEqual(settled.sort(), ['other-write', 'third-write'])
})
