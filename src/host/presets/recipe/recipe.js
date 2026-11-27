import { MIXED_CAPACITY, MIXED_RECIPE_VERSION, MIXED_REVISIONS_PER_SESSION, mixedHistorySteps } from './mixed-recipe.js'
import { projectDefinition } from './projects.js'
import { denseHistoryExtension, denseHistorySteps } from './dense-recipe.js'

/** One shared command recipe drives execution and the command-plan viewer. */
export function baseProjectHistoryPlan(name) {
  const definition = projectDefinition(name)
  const [a, b, c] = definition.features
  const branches = ['release-0.1', a.name, b.name, 'release-0.2', definition.maintenance.name, c.name, 'release-0.3', ...definition.explorations.map(item => item.name)]
  const expectedMain = { ...definition.files }
  for (const writes of [definition.foundation, a.commits, b.commits, [definition.releases[0]], definition.maintenance.commits, c.commits, [definition.releases[1]]]) {
    for (const write of writes) expectedMain[write.path] = write.content
  }
  return { definition, branches, expectedMain, commits: 24, writes: 22, merges: 2, publications: 4, layers: 5, cliCalls: 35, commands: 35, density: 'base', tier: null, cycles: 0, history: { commits: 24, branches: 9, merges: 2, publishes: 4, layers: 5 } }
}

const plans = new Map()
/** Cached pure metadata; callers must not mutate the returned plan. */
export function projectHistoryPlan(name, { density = 'dense', cycles, executionMode = 'filesystem' } = {}) {
  if (!['dense', 'base'].includes(density)) throw new Error(`Unknown project density ${density}`)
  if (!['filesystem', 'mixed'].includes(executionMode)) throw new Error(`Unknown execution mode ${executionMode}`)
  if (executionMode === 'mixed' && density !== 'dense') throw new Error('Mixed mode requires dense project history.')
  const key = `${executionMode}:${density}:${name}:${cycles ?? "full"}`
  if (plans.has(key)) return plans.get(key)
  const base = baseProjectHistoryPlan(name)
  if (density === 'base') { Object.assign(base, { executionMode, authoredRevisions: base.writes, workspaceRevisions: 0, ...MIXED_CAPACITY }); plans.set(key, base); return base }
  const extension = denseHistoryExtension(name, base.definition, { cycles }), n = extension.cycles
  const counts = { commits: base.commits + 264 * n, writes: base.writes + 262 * n, merges: base.merges + 2 * n, publications: base.publications + 55 * n, layers: base.layers + 55 * n, cliCalls: base.cliCalls + 322 * n }
  const plan = { ...base, ...counts, density, tier: extension.tier, cycles: n, branches: [...base.branches, ...extension.branches], expectedMain: { ...base.expectedMain, ...extension.expectedMain } }
  plan.executionMode = executionMode
  plan.authoredRevisions = plan.writes
  plan.workspaceRevisions = executionMode === 'mixed' ? 96 * n : 0
  plan.workspaceSessions = executionMode === 'mixed' ? plan.workspaceRevisions / MIXED_REVISIONS_PER_SESSION : 0
  plan.revisionsPerWorkspace = executionMode === 'mixed' ? MIXED_REVISIONS_PER_SESSION : null
  plan.mixedRecipeVersion = executionMode === 'mixed' ? MIXED_RECIPE_VERSION : null
  Object.assign(plan, MIXED_CAPACITY)
  if (executionMode === 'mixed') plan.cliCalls += 192 * n + 1
  plan.commands = plan.cliCalls
  plan.history = { commits: plan.commits, branches: plan.branches.length, merges: plan.merges, publishes: plan.publications, layers: plan.layers }
  plans.set(key, plan)
  return plan
}

export function projectHistorySteps(store, name, { density = 'dense', cycles, executionMode = 'filesystem' } = {}) {
  const base = baseProjectHistorySteps(store, name)
  if (density === 'base') return base
  if (density !== 'dense') throw new Error(`Unknown project density ${density}`)
  const extension = denseHistorySteps(store, name, projectHistoryPlan(name, { density, cycles }).definition, { cycles })
  for (const step of extension) if (!step.dependsOn.length) step.dependsOn = [base.at(-1).key]
  const steps = [...base, ...extension]
  return executionMode === 'mixed' ? mixedHistorySteps(steps, name) : steps
}

export function baseProjectHistorySteps(store, name) {
  const { definition } = baseProjectHistoryPlan(name)
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

/**
 * Reject a successful transport result that did not make the intended history
 * (2.0 short forms: a Commit-making call answers `commit`, an unmount `ok`, an
 * exec `exit_code`; `unchanged` means nothing was made).
 */
export function assertProjectStep(step, result) {
  const expected = step.expect
  if (!expected) return
  const fail = reason => { throw Object.assign(new Error(`Preset step ${step.key}: ${reason}`), { code: 'PresetVerificationFailed' }) }
  if (expected.exitCode !== undefined && result?.exit_code !== expected.exitCode) fail(`expected exit code ${expected.exitCode}, received ${result?.exit_code}`)
  if (expected.commit && (typeof result?.commit !== 'string' || !result.commit)) fail('expected a Commit, LayerFS answered none')
  if (expected.commit && result.unchanged === true) fail('expected a new Commit, LayerFS answered unchanged')
  if (expected.ok && result?.ok !== true) fail('expected ok')
  if (expected.divergent && result.fast_forward === true) fail('expected a divergent merge with a new Commit')
  // Never forced: without --force LayerFS refuses Conflict when main gained a publication since the
  // Branch forked, so a newer head is never replaced. `previous` is no such sign: it names main's head
  // before whenever that was not the Branch's base, as after this Branch's own earlier publication.
  if (expected.notForced && step.argv.some((a) => a === '--force' || a === '--force=true')) fail('a publication must not be forced')
}

/** What a confirmed history step made, from its call and its 2.0 answer: the Commit, and whether it added a Branch or a publication. */
export function stepEffect(step, result) {
  const call = `${step.argv[0]}.${step.argv[1]}`
  const commit = typeof result?.commit === 'string' && result.commit && result.unchanged !== true ? result.commit : null
  return {
    commit: ['file.write', 'workspace.commit', 'branch.merge'].includes(call) ? commit : null,
    branch: !!commit && ['branch.fork', 'branch.merge'].includes(call),
    layer: !!commit && call === 'branch.publish',
    workspaceRevision: !!step.workspaceRevision && call === 'workspace.commit' && !!commit,
  }
}

export function machineCreateArgs(machine) {
  return ['machine', 'create', machine.name, machine.platform, '--cpus', String(machine.cpus), '--memory', machine.memory, '--disk', machine.disk]
}

/** Resolve preview receipt references only from confirmed immutable results. */
export function resolveHistoryStep(step, receipts) {
  if (!step.commitFrom) return step.argv
  const head = receipts[step.commitFrom]?.commit
  if (typeof head !== 'string' || !head) throw new Error(`Missing immutable Commit receipt for ${step.key}; no publication was attempted.`)
  return [...step.argv.slice(0, -1), head]
}
