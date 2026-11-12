// @ts-nocheck
// Ported from Connect simulation compiler; execution uses the native DSH tool pipeline.
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { DENSE_TIERS, denseCycleBranches } from '../presets/recipe/dense-recipe.js'
import { projectHistoryPlan, projectHistorySteps, resolveHistoryStep } from '../presets/recipe/recipe.js'

export const SIMULATION_VERSION = 1
export const SIMULATION_PROFILES = Object.freeze(Object.fromEntries(
  Object.keys(DENSE_TIERS).map((name, index) => [name, { conversations: [2, 3, 4, 4, 5, 6, 7, 8][index], children: [[1, 2], [1, 3], [2, 4], [2, 4], [2, 5], [3, 6], [3, 7], [3, 8]][index] }]),
))
const json = value => JSON.stringify(value, null, 2) + '\n'
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const hash = value => createHash('sha256').update(value).digest('hex')

const validName = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(value)

/** Pure compiler. cycles is an internal test fixture bound, never a public command flag. */
export function compileSimulation({ project, machine = 'native', mixed = false, runId = randomUUID(), cycles, createdAt = new Date().toISOString() } = {}) {
  if (!Object.hasOwn(SIMULATION_PROFILES, project)) throw new Error(`Unknown simulation project: ${project}`)
  if (!validName(machine) || !validName(runId)) throw new Error('Simulation machine and run ID must be valid LayerFS names.')
  if (typeof mixed !== 'boolean') throw new Error('Simulation mixed must be a boolean.')
  const profile = SIMULATION_PROFILES[project]
  const options = { cycles, executionMode: mixed ? 'mixed' : 'filesystem' }
  const history = projectHistoryPlan(project, options)
  const tag = hash(runId).slice(0, 20)
  const store = `sim-${project}-${tag}`, projectName = `${project}-${tag}`, projectRef = `${store}/${projectName}`
  const files = {}, steps = [], tasks = []
  const put = (path, value) => { files[path] = typeof value === 'string' ? value : json(value) }
  for (const [path, content] of Object.entries(history.definition.files)) put(`source/${path}`, content)
  const setup = [
    { key: 'setup.machine', argv: ['machine', 'get', machine], dependsOn: [] },
    { key: 'setup.store', argv: ['store', 'create', store], dependsOn: ['setup.machine'] },
    { key: 'setup.project', argv: ['project', 'init', projectRef, '<source>'], dependsOn: ['setup.store'] },
  ]
  if (machine !== 'native') setup.push({ key: 'setup.push', argv: ['store', 'push', store, machine], dependsOn: ['setup.project'] })
  for (const step of setup) steps.push({ ...step, phase: 'setup' })
  const conversations = Array.from({ length: Math.min(profile.conversations, history.cycles) }, (_, index) => {
    const topic = DENSE_TIERS[project].topics[index % 3], id = `c${String(index + 1).padStart(2, '0')}-${topic}`
    const count = profile.children[0] + index % (profile.children[1] - profile.children[0] + 1)
    return { id, title: `${history.definition.title}: ${topic} objective ${index + 1}`, project: projectRef, cycles: [], maxTurns: 10, subagents: Array.from({ length: count }, (_, child) => ({ id: `a${String(child + 1).padStart(2, '0')}-worker`, role: 'project-worker', maxTurns: 10 })) }
  })
  for (let cycle = 1; cycle <= history.cycles; cycle++) conversations[Math.min(conversations.length - 1, Math.floor((cycle - 1) * conversations.length / history.cycles))].cycles.push(cycle)
  const raw = projectHistorySteps(store, project, options)
  // A simulation has unique sandboxes, even when several simulations share a home.
  const originalSandbox = `demo-mix-${project}-1`, sandbox = `sim-${hash(runId).slice(0, 20)}-1`
  const wsMounts = new Map(), branchHeads = new Map()
  for (const step of raw) {
    step.argv = step.argv.map(word => typeof word === 'string' ? word.replaceAll(originalSandbox, sandbox).replaceAll(`${store}/${project}`, projectRef) : word)
    if (step.argv[0] === 'sandbox' && step.argv[1] === 'create') {
      step.argv.push(machine)
      step.resource = { family: 'sandbox', name: sandbox }
    }
    if (step.argv[0] === 'workspace' && step.argv[1] === 'mount') wsMounts.set(`${sandbox}:${step.argv.at(-1)}`, step.key)
    else if (step.argv[0] === 'workspace') step.argv[2] = `<ws:${wsMounts.get(step.argv[2])}>`
    if (step.argv[0] === 'branch' && step.argv[1] === 'publish' && !step.commitFrom) {
      step.commitFrom = branchHeads.get(step.argv[3])
      if (!step.commitFrom) throw new Error(`Missing branch head source for ${step.key}`)
      step.argv.push(`<commit:${step.commitFrom}>`)
    }
    if (step.argv[0] === 'file' && step.argv[1] === 'write' || step.argv[0] === 'branch' && step.argv[1] === 'merge') branchHeads.set(step.argv[3], step.key)
    if (!step.dependsOn.length) step.dependsOn = [setup.at(-1).key]
  }
  const taskGroups = new Map()
  for (const step of raw) {
    const dense = step.key.match(/^dense\.(\d+)\.([^.]+)\./), cycle = dense ? Number(dense[1]) : 0
    const conversation = cycle ? conversations.find(item => item.cycles.includes(cycle)) : conversations[0]
    const lane = dense?.[2]
    const group = !cycle ? 'foundation' : step.argv[0] === 'branch' && step.argv[1] === 'fork' ? 'prepare' : lane
    const id = cycle ? `cycle-${String(cycle).padStart(3, '0')}-${group}` : 'foundation'
    if (!taskGroups.has(id)) {
      const delegated = ['a', 'b', 'maintenance'].includes(group)
      const workerIndex = ((cycle - conversation.cycles[0]) * 3 + ['a', 'b', 'maintenance'].indexOf(group)) % conversation.subagents.length
      const agentId = delegated ? conversation.subagents[workerIndex].id : null
      const folder = `agents/${conversation.id}-${agentId ?? 'main'}`
      const scriptPath = `${folder}/commands/${id}.sh`
      const task = { id, conversationId: conversation.id, agentId, cycle, lane: group, title: cycle ? `Release ${cycle}: ${group}` : 'Prepare initial project history', prompt: cycle ? `Complete the ${group} work for release cycle ${cycle}. Preserve dependencies and report only confirmed CLI results.` : 'Prepare the project foundation and retained exploration branches.', scriptPath, stepKeys: [], dependsOn: [] }
      tasks.push(task); taskGroups.set(id, task)
    }
    const task = taskGroups.get(id)
    task.stepKeys.push(step.key)
    steps.push({ ...step, phase: 'conversation', conversationId: conversation.id, agentId: task.agentId, taskId: task.id, scriptPath: task.scriptPath })
  }
  for (const task of tasks) {
    const own = steps.filter(step => step.taskId === task.id)
    const writes = own.map(step => step.historyArgv ?? step.argv).filter(argv => argv[0] === 'file' && argv[1] === 'write')
    const paths = [...new Set(writes.map(argv => argv[4]))]
    task.files = paths
    if (!task.cycle) {
      task.title = `Establish ${history.definition.title} base releases and exploration branches`
      task.prompt = `Prepare the reference ${project} project foundation, integrate its initial features and maintenance, and retain unfinished exploration branches. Work only in ${projectRef}. Follow the compiled dependency order. Save the real CLI receipts for every mutation and publication; these fixture files do not prove an application test ran.`
      continue
    }
    const branch = denseCycleBranches(project, task.cycle), topics = DENSE_TIERS[project].topics
    const descriptions = {
      prepare: [`Prepare release ${task.cycle} feature and maintenance work`, `Fork ${branch.a}, ${branch.b} and ${branch.maintenance} from the current published main. These branches must share the intended release base before their independent writers begin.`],
      a: [`Revise ${topics[0]} for release ${task.cycle}`, `Update ${branch.a} for the ${topics[0]} feature stream. Author the specification, examples, policy and review revisions in their prescribed order.`],
      b: [`Revise ${topics[1]} for release ${task.cycle}`, `Update ${branch.b} for the independent ${topics[1]} feature stream. Keep its changes on that branch until integration.`],
      maintenance: [`Maintain ${topics[2]} for release ${task.cycle}`, `Revise ${branch.maintenance} for ${topics[2]}. Preserve its earlier main base while feature integration proceeds; the release agent will merge this maintenance history afterward.`],
      integration: [`Integrate ${topics[0]} and ${topics[1]} for release ${task.cycle}`, `Wait for ${branch.a} and ${branch.b}, then merge them into ${branch.integration}. Preserve both source histories and publish each planned integration revision using its exact confirmed Commit head.`],
      release: [`Publish release ${task.cycle} with ${topics[2]} maintenance`, `Wait for the completed feature integration and ${branch.maintenance}. Merge current main with that maintenance branch into ${branch.release}; publish its planned revisions without overwriting newer main Layers.`],
    }
    const [title, description] = descriptions[task.lane]
    task.title = title
    task.prompt = `${description} Project: ${projectRef}.${paths.length ? ` Files: ${paths.join(', ')}.` : ''} Execute the compiled CLI tasks and report confirmed branch/Commit/publication receipts. ${mixed && ['a', 'b'].includes(task.lane) ? 'For selected workspace revisions, mount, execute and commit twice, then unmount cleanly; reuse this agent session for later assignments.' : 'Reuse this conversation context for related follow-up assignments.'} Do not claim the application was built or tested.`
  }
  const owners = new Map(steps.filter(step => step.taskId).map(step => [step.key, step.taskId]))
  const byKey = new Map(steps.map(step => [step.key, step]))
  for (const task of tasks) task.dependsOn = [...new Set(task.stepKeys.flatMap(key => byKey.get(key).dependsOn.map(dep => owners.get(dep)).filter(dep => dep && dep !== task.id)))]
  const turns = []
  for (const conversation of conversations) {
    for (const agentId of [null, ...conversation.subagents.map(child => child.id)]) {
      const ownTasks = tasks.filter(task => task.conversationId === conversation.id && task.agentId === agentId)
      const folder = `agents/${conversation.id}-${agentId ?? 'main'}`
      const visibleTasks = agentId ? ownTasks : tasks.filter(task => task.conversationId === conversation.id)
      const cycleGroups = [...new Set(visibleTasks.map(task => task.cycle))]
      const agentTurns = cycleGroups.map((cycle, index) => {
        const cycleTasks = visibleTasks.filter(task => task.cycle === cycle)
        const topics = DENSE_TIERS[project].topics
        const branches = cycle ? denseCycleBranches(project, cycle) : null
        const request = cycle === 0
          ? `Set up the initial ${history.definition.title} releases, incorporate the reference features and maintenance, and keep unfinished exploration work available for later. Work in ${projectRef}; report the actual committed and published results when this foundation is ready.`
          : agentId
            ? `For release ${cycle}, complete your assigned ${[...new Set(cycleTasks.map(task => ({ a: topics[0], b: topics[1], maintenance: topics[2] }[task.lane])))].join(' and ')} changes. Work through all revisions and follow-up assignments for this request, then return the confirmed saved file versions and a concise summary.`
            : `Prepare release ${cycle} of ${history.definition.title}. Delegate the ${topics[0]} and ${topics[1]} feature updates and ${topics[2]} maintenance, collect their confirmed results, integrate the feature branches, and publish the release with maintenance preserved. Work in ${projectRef} and summarize the real publications when this release is complete.`
        // A parent delegates each worker task as soon as the own work it depends on
        // is done, so independent delegations leave together in one message.
        const ordered = [], waiting = cycleTasks.filter(task => task.agentId && !agentId), placed = new Set()
        const ready = task => task.dependsOn.every(dep => placed.has(dep) || !cycleTasks.some(item => item.id === dep))
        const release = () => {
          for (let task = waiting.find(ready); task; task = waiting.find(ready)) {
            ordered.push(task); placed.add(task.id); waiting.splice(waiting.indexOf(task), 1)
          }
        }
        release()
        for (const task of cycleTasks) {
          if (task.agentId && !agentId) continue
          ordered.push(task); placed.add(task.id)
          release()
        }
        ordered.push(...waiting)
        const actions = ordered.flatMap(task => task.agentId && !agentId
          ? [{ type: 'delegate', taskId: task.id, agentId: task.agentId, reuse: true, dependsOn: task.dependsOn }]
          : [{ type: 'assignment', taskId: task.id, text: task.prompt }, { type: 'wait', tasks: task.dependsOn }, ...task.stepKeys.map(stepKey => ({ type: 'tool', tool: 'bash', taskId: task.id, stepKey, argv: byKey.get(stepKey).argv })), { type: 'report', taskId: task.id, from: 'confirmed-receipts' }])
        const turn = { conversationId: conversation.id, agentId, id: `turn-${String(index + 1).padStart(2, '0')}`, request, taskIds: cycleTasks.map(task => task.id), actions }
        turns.push(turn)
        return turn
      })
      if (agentTurns.length > 10) throw new Error(`Simulation exceeds ten turns for ${conversation.id}/${agentId ?? 'main'}`)
      const agentKey = `${conversation.id}-${agentId ?? 'main'}`
      const script = { agentKey, scriptId: `${runId}-${agentKey}`, name: agentId ? `${history.definition.title}: ${agentId}` : conversation.title, conversationId: conversation.id, agentId, maxTurns: 10, turns: agentTurns }
      put(`${folder}/script.json`, script)
    }
  }
  const expectations = { project: projectRef, recipe: options, branches: ['main', ...history.branches], files: history.expectedMain, history: history.history, workspaceRevisions: history.workspaceRevisions, workspaceSessions: history.workspaceSessions ?? 0, applicationTestsExecuted: false }
  const resources = { runId, store: { name: store, kind: 'sqlite', machine, owned: true, status: 'planned' }, project: projectRef, sandboxes: [], workspaces: [], branches: [] }
  const sessions = { conversations: {}, subagents: {} }
  const plan = { version: SIMULATION_VERSION, steps, tasks, conversations, turns, limits: { maxTurnsPerAgent: 10, conversations: 8, subagentsPerConversation: 8, concurrency: 12, perConversation: 3, sandboxes: 3, workspacesPerSandbox: 16 }, counts: { setupCommands: setup.length, historyCommands: raw.length, commands: steps.length, tasks: tasks.length, conversations: conversations.length, subagents: conversations.reduce((sum, item) => sum + item.subagents.length, 0) } }
  plan.agents = Object.entries(files).filter(([path]) => path.endsWith('/script.json')).map(([path, content]) => ({ ...JSON.parse(content), path, hash: hash(content) }))
  plan.expectations = expectations
  plan.source = 'source'
  plan.continuationTargets = Object.fromEntries(conversations.map(conversation => {
    const published = steps.filter(step => step.conversationId === conversation.id && !step.agentId && step.argv[0] === 'branch' && step.argv[1] === 'publish')
    const last = published.at(-1)
    return [conversation.id, { receipt: last?.key, project: projectRef, branch: 'main', type: 'Layer', fallbacks: [...published].reverse().map(step => ({ receipt: step.key, project: projectRef, branch: 'main', type: 'Layer' })).concat([{ receipt: 'setup.project', project: projectRef, branch: 'main', type: 'Layer', initial: true }]) }]
  }))
  plan.stopContinuationTargets = Object.fromEntries(Object.entries(plan.continuationTargets).map(([id, target]) => [id, target.fallbacks]))
  put('plan.json', plan)
  const manifest = { version: SIMULATION_VERSION, runId, createdAt, project, template: project, projectName, projectRef, store, machine, mixed, cycles: history.cycles, recipeVersion: 3, maxTurnsPerAgent: 10, status: 'prepared', hashes: Object.fromEntries(Object.entries(files).filter(([path]) => !['journal.jsonl'].includes(path)).map(([path, content]) => [path, hash(content)])) }
  put('manifest.json', manifest)
  return { manifest, plan, resources, sessions, expectations, files }
}

/** The managed CLI as bound project shells name it (sessions shell env). */
export const SIMULATION_CLI = '"$DSH_LAYERFS_CLI"'
/** Quote a shell word only when it needs quoting. */
export const shellWord = value => {
  const word = String(value)
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : quote(word)
}
/** A quoted here-document delimiter that no content line equals. */
const delimiter = input => {
  const lines = new Set(input.split('\n'))
  let name = 'EOF'
  for (let index = 2; lines.has(name); index++) name = `EOF${index}`
  return name
}

/** Each agent bash call contains the real CLI operation, never a whole-task launcher.
 * It reads as typed: minimal quoting and file content as a quoted here-document
 * when that is byte-exact. */
export function renderSimulationCommand(step, argv = step.argv, cli = SIMULATION_CLI) {
  if (argv.some(word => /^<(?:source|ws:|commit:)/.test(String(word)))) throw new Error(`Resolve confirmed references before rendering ${step.key}`)
  const command = `${cli === SIMULATION_CLI ? cli : shellWord(cli)} ${argv.map(shellWord).join(' ')}`
  if (step.input === undefined) return command
  const input = String(step.input)
  // A here-document always ends its body with a newline; use it only when exact.
  if (input.endsWith('\n') && !input.includes('\r')) {
    const end = delimiter(input)
    return `${command} <<'${end}'\n${input}${end}`
  }
  return `printf '%s' ${quote(input)} | ${command}`
}

export function resolveSimulationStep(step, receipts, runDirectory) {
  return resolveHistoryStep(step, receipts).map(word => {
    if (word === '<source>') {
      if (!runDirectory) throw new Error('Missing simulation run directory for project initialization.')
      return join(runDirectory, 'source')
    }
    const match = typeof word === 'string' && word.match(/^<ws:(.+)>$/)
    if (!match) return word
    const ws = receipts[match[1]]?.ws
    if (typeof ws !== 'string' || !ws) throw new Error(`Missing confirmed workspace receipt for ${step.key}`)
    return ws
  })
}

