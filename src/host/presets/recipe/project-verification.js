import { projectHistoryPlan, projectHistorySteps, assertProjectStep } from './recipe.js'

const fail = message => { throw Object.assign(new Error(message), { code: 'PresetVerificationFailed' }) }
const PAGE_SIZE = 20
const idOf = value => typeof value === 'string' ? value : value?.id

/**
 * Fully read one immutable saved history (2.0 `commit list --detail`, newest
 * first, by cursor: the cursor pins the Commit the first page read). Small
 * pages preserve complete activity output.
 */
export async function savedHistory(query, project, branch) {
  const items = [], ids = new Set(); let cursor = null
  do {
    const result = await query(['commit', 'list', project, branch, '--detail', '--limit', String(PAGE_SIZE), ...(cursor ? ['--cursor', cursor] : [])])
    if (!Array.isArray(result?.items)) fail(`${project}/${branch}: incomplete saved history page`)
    for (const item of result.items) {
      const id = item.commit
      if (!id || ids.has(id)) fail(`${project}/${branch}: duplicate or missing saved history ID`)
      ids.add(id); items.push({ ...item, id })
    }
    const next = result.next_cursor ?? null
    if (next !== null && (next === cursor || !result.items.length)) fail(`${project}/${branch}: saved history pagination did not advance`)
    cursor = next
  } while (cursor !== null)
  return items
}

/** A history step's Branch and its sources: a 2.0 merge is `branch merge <p> <left> <right> --into <branch>`. */
function stepBranches(argv) {
  const [, call, , a, b] = argv
  if (call === 'merge') return { branch: argv[argv.indexOf('--into') + 1], left: a, right: b }
  return { branch: a, left: b, right: argv[5] }
}

/** Read actual saved files and graph records. Does not execute application code. */
export async function verifyProject(query, store, name, receipt, options = {}) {
  const project = `${store}/${name}`, plan = projectHistoryPlan(name, options), receipts = receipt?.steps ?? receipt
  // a 2.0 list read whole by cursor (the cursor pins the Commit the first page read)
  const list = async argv => {
    const items = []; let cursor = null
    do {
      const result = await query([...argv, '--limit', String(PAGE_SIZE), ...(cursor ? ['--cursor', cursor] : [])])
      if (!Array.isArray(result?.items)) fail(`${project}: invalid list response for ${argv.join(' ')}`)
      items.push(...result.items)
      const next = result.next_cursor ?? null
      if (next !== null && (next === cursor || !result.items.length)) fail(`${project}: resource pagination did not advance`)
      cursor = next
    } while (cursor !== null)
    return items
  }
  const branches = []
  for (let cursor = null, first = true; first || cursor !== null; first = false) {
    const result = await query(['branch', 'list', project, '--limit', String(PAGE_SIZE), ...(cursor ? ['--cursor', cursor] : [])])
    if (!Array.isArray(result?.items)) fail(`${project}: invalid list response for branch list`)
    branches.push(...result.items)
    const next = result.next_cursor ?? null
    if (next !== null && (next === cursor || !result.items.length)) fail(`${project}: resource pagination did not advance`)
    cursor = next
  }
  const byName = new Map(branches.map(branch => [branch.branch, branch]))
  const expectedNames = ['main', ...plan.branches]
  if (branches.length !== expectedNames.length || byName.size !== expectedNames.length || expectedNames.some(branch => !byName.has(branch))) fail(`${project}: expected ${expectedNames.length} retained branches`)
  const histories = new Map(), unique = new Map()
  for (const branch of plan.branches) {
    const commits = await savedHistory(query, project, branch)
    histories.set(branch, commits)
    for (const commit of commits) unique.set(commit.id, commit)
    if (commits[0]?.id !== byName.get(branch).commit) fail(`${project}/${branch}: saved head does not match history`)
  }
  if (unique.size !== plan.commits) fail(`${project}: expected ${plan.commits} distinct Commits, found ${unique.size}`)
  const main = await savedHistory(query, project, 'main')
  if (main.length !== plan.layers) fail(`${project}: expected ${plan.layers} complete main publication Layers, found ${main.length}`)

  // Assign each recipe mutation to its persisted own-branch Commit. Do not sum shared ancestry.
  const steps = projectHistorySteps(store, name, options).map(step => step.historyArgv ? { ...step, argv: step.historyArgv } : step), ownCounts = new Map()
  for (const step of steps) if (step.argv[1] === 'write' || step.argv[1] === 'merge') { const { branch } = stepBranches(step.argv); ownCounts.set(branch, (ownCounts.get(branch) ?? 0) + 1) }
  const own = new Map(), assignedIds = new Set()
  for (const [branch, count] of ownCounts) {
    const history = histories.get(branch)
    if (history.length < count) fail(`${project}/${branch}: missing own-branch saved Commits`)
    const records = history.slice(0, count).reverse()
    own.set(branch, { records, index: 0 })
    for (const record of records) {
      if (assignedIds.has(record.id)) fail(`${project}: distinct recipe mutations share a saved Commit`)
      assignedIds.add(record.id)
    }
  }
  if (assignedIds.size !== plan.commits || [...unique.keys()].some(id => !assignedIds.has(id))) fail(`${project}: saved graph does not match unique recipe mutations`)
  const heads = new Map(), bases = new Map(), publicationRows = [...main].reverse()
  let mainLayer = publicationRows.shift()?.id, publications = 0, merges = 0, writes = 0
  const receiptIds = new Set()
  for (const step of steps) {
    const call = step.argv[1], { branch, left, right } = stepBranches(step.argv), result = receipts?.[step.key]
    if (receipts) assertProjectStep(step, result)
    if (call === 'fork') {
      heads.set(branch, left === 'main' ? null : heads.get(left))
      bases.set(branch, left === 'main' ? mainLayer : bases.get(left))
      continue
    }
    if (call === 'write' || call === 'merge') {
      const sequence = own.get(branch), record = sequence.records[sequence.index++]
      if (call === 'merge') {
        merges++
        const expectedParent = left === 'main' ? null : heads.get(left)
        if ((idOf(record.parent) ?? null) !== (expectedParent ?? null) || idOf(record.second_parent) !== heads.get(right)) fail(`${project}/${branch}: merge did not preserve both expected parents`)
        bases.set(branch, left === 'main' ? mainLayer : bases.get(left))
      } else {
        writes++
        if ((idOf(record.parent) ?? null) !== (heads.get(branch) ?? null) || record.second_parent != null) fail(`${project}/${branch}: write Commit has unexpected ancestry`)
      }
      if (record.base && idOf(record.base) !== bases.get(branch)) fail(`${project}/${branch}: saved Commit has an unexpected base Layer`)
      heads.set(branch, record.id)
      if (receipts) {
        if (result.commit !== record.id) fail(`${project}/${branch}: successful mutation receipt does not match saved Commit history`)
        receiptIds.add(result.commit)
      }
      continue
    }
    if (call === 'publish') {
      const layer = publicationRows.shift(), source = heads.get(branch)
      if (!layer || layer.source_branch !== branch || layer.source_commit !== source) fail(`${project}/${branch}: publication provenance does not match the recipe`)
      if (layer.parent != null && idOf(layer.parent) !== mainLayer) fail(`${project}: main publication Layer chain is broken`)
      // the receipt is main's new head (2.0 `branch publish` answers `commit`)
      if (receipts && result.commit !== layer.id) fail(`${project}/${branch}: publication receipt has a different main Commit`)
      mainLayer = layer.id; publications++
    }
  }
  if (publicationRows.length || publications !== plan.publications || merges !== plan.merges || writes !== plan.writes) fail(`${project}: saved graph operation counts do not match the recipe`)
  if (receipts && receiptIds.size !== unique.size) fail(`${project}: successful mutation receipts do not match all saved Commits`)

  let files = 0
  // 2.0 `file read --detail` (an empty file's short form is `{}`): the whole text, no next_line, no cut line
  const readExact = async (branch, path, content) => {
    const result = await query(['file', 'read', project, branch, `/${path}`, '--detail'])
    if (result.text !== content || result.next_line != null || result.line_truncated) fail(`${project}/${branch}/${path}: saved content does not match the recipe`)
    files++
  }
  for (const [path, content] of Object.entries(plan.expectedMain)) await readExact('main', path, content)
  const mainPaths = new Set((await list(['file', 'glob', project, 'main', '**', '/'])).map(path => String(path).replace(/^\//, '')))
  const expectedPaths = new Set(Object.keys(plan.expectedMain))
  for (const path of Object.keys(plan.expectedMain)) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) expectedPaths.add(parts.slice(0, depth).join('/'))
  }
  if (mainPaths.size !== expectedPaths.size || [...mainPaths].some(path => !expectedPaths.has(path))) fail(`${project}: main file and directory inventory does not match the recipe`)
  for (const item of plan.definition.explorations) {
    const expected = new Map(item.commits.map(commit => [commit.path, commit.content]))
    for (const [path, content] of expected) await readExact(item.name, path, content)
    for (const path of expected.keys()) if (!Object.hasOwn(plan.expectedMain, path) && mainPaths.has(path)) fail(`${project}: unfinished ${item.name}/${path} was unexpectedly published`)
  }
  return { project, tier: plan.tier, cycles: plan.cycles, branches: branches.length, commits: unique.size, merges, publications, layers: main.length, filesVerified: files, publicationReceiptsVerified: !!receipts }
}

/** First-page read plan; execution follows every immutable continuation. */
export function projectVerificationSteps(store, name, options = {}) {
  const project = `${store}/${name}`, plan = projectHistoryPlan(name, options), commands = []
  const add = argv => commands.push({ argv })
  add(['branch', 'list', project, '--limit', String(PAGE_SIZE)])
  for (const branch of [...plan.branches, 'main']) add(['commit', 'list', project, branch, '--detail', '--limit', String(PAGE_SIZE)])
  for (const path of Object.keys(plan.expectedMain)) add(['file', 'read', project, 'main', `/${path}`, '--detail'])
  add(['file', 'glob', project, 'main', '**', '/', '--limit', String(PAGE_SIZE)])
  for (const item of plan.definition.explorations) for (const path of new Set(item.commits.map(commit => commit.path))) add(['file', 'read', project, item.name, `/${path}`, '--detail'])
  return commands
}
