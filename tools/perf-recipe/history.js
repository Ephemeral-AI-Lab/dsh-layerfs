// The sample projects the perf fixture seeds (tools/perf-fixture.mjs,
// docs/specs/backend-e2e-tests.md §3.3): their source trees and a base history of
// plain CLI steps (branch fork / file write / merge / publish).
import { projectDefinition } from './projects.js'

export function sourceFiles(name) {
  return structuredClone(projectDefinition(name).files)
}

export function baseProjectHistorySteps(store, name) {
  const definition = projectDefinition(name)
  const project = `${store}/${name}`, steps = []
  const fork = (key, branch, from = 'main') => steps.push({ key, argv: ['branch', 'fork', project, branch, from], expect: { commit: true } })
  const writes = (key, branch, changes) => changes.forEach((change, index) => steps.push({ key: `${key}.${index + 1}`, argv: ['file', 'write', project, branch, `/${change.path}`, '--message', change.message], input: change.content, expect: { commit: true } }))
  // 2.0: `branch merge <project> <branch> <from> --into NEW` makes Branch NEW from merging `from` into `branch`
  const merge = (key, branch, left, right, message) => steps.push({ key, argv: ['branch', 'merge', project, left, right, '--into', branch, '--message', message], expect: { commit: true, divergent: true } })
  const publish = (key, branch) => steps.push({ key, argv: ['branch', 'publish', project, branch], expect: { commit: true, notForced: true } })
  const [a, b, c] = definition.features
  fork('foundation.fork', 'release-0.1')
  writes('foundation.write', 'release-0.1', definition.foundation)
  publish('foundation.publish', 'release-0.1')
  fork('feature-a.fork', a.name); writes('feature-a.write', a.name, a.commits)
  fork('feature-b.fork', b.name); writes('feature-b.write', b.name, b.commits)
  merge('release-a.merge', 'release-0.2', a.name, b.name, `Integrate ${a.title} and ${b.title}`)
  writes('release-a.write', 'release-0.2', [definition.releases[0]])
  publish('release-a.publish', 'release-0.2')
  // Both start at the same main Layer; publishing maintenance makes feature C stale.
  fork('maintenance.fork', definition.maintenance.name)
  fork('feature-c.fork', c.name)
  writes('maintenance.write', definition.maintenance.name, definition.maintenance.commits)
  publish('maintenance.publish', definition.maintenance.name)
  writes('feature-c.write', c.name, c.commits)
  merge('release-b.merge', 'release-0.3', 'main', c.name, `Integrate ${c.title} with the maintenance release`)
  writes('release-b.write', 'release-0.3', [definition.releases[1]])
  publish('release-b.publish', 'release-0.3')
  definition.explorations.forEach((item, index) => {
    fork(`exploration-${index + 1}.fork`, item.name)
    writes(`exploration-${index + 1}.write`, item.name, item.commits)
  })
  for (const [index, step] of steps.entries()) {
    step.dependsOn = index ? [steps[index - 1].key] : []
    step.lane = step.argv[3]
  }
  return steps
}

/** What a confirmed history step made, from its call and its answer: whether it made a Commit. */
export function stepEffect(step, result) {
  const call = `${step.argv[0]}.${step.argv[1]}`
  const commit = typeof result?.commit === 'string' && result.commit && result.unchanged !== true ? result.commit : null
  return { commit: ['file.write', 'workspace.commit', 'branch.merge'].includes(call) ? commit : null }
}
