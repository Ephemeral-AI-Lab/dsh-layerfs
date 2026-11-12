// @ts-nocheck
/** Assistant prose for script replies. Everything here is derived from the
 * immutable plan (what the next commands will do) or from confirmed receipts
 * (what they did); nothing claims work that no command performed. */
import { savedVersions } from '../layerfs/tracing.ts'

const code = value => `\`${value}\``
const path = value => String(value).replace(/^\/+/, '')
const short = id => String(id).slice(0, 12)
const unique = values => [...new Set(values)]

/** "a", "a and b", "a, b and c", "a, b and 3 others" (noun: [singular, plural]). */
export function list(items, max = 3, noun = ['other', 'others']) {
  const values = unique(items.filter(Boolean))
  if (values.length <= 1) return values[0] ?? ''
  if (values.length > max) {
    const rest = values.length - max
    return `${values.slice(0, max).join(', ')} and ${rest} ${typeof noun === 'string' ? noun : noun[rest === 1 ? 0 : 1]}`
  }
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`
}
const BRANCHES = ['more branch', 'more branches']

const workspaceName = handle => String(handle).split(':').slice(1).join(':') || String(handle)
const written = command => String(command).match(/>\s*'?([^'\s>]+)'?\s*$/)?.[1]

/** A short bash description from the resolved argv: "Fork feature-x from main". */
export function describeCommand(argv) {
  const [family, verb] = argv
  if (family === 'branch' && verb === 'fork') return `Fork ${argv[3]} from ${argv[4]}`
  if (family === 'branch' && verb === 'publish') return `Publish ${argv[3]} to main`
  if (family === 'branch' && verb === 'merge') {
    const sources = argv.slice(4).filter((word, index, all) => !String(word).startsWith('--') && !String(all[index - 1] ?? '').startsWith('--'))
    return `Merge ${list(sources, 4)} into ${argv[3]}`
  }
  if (family === 'file' && verb === 'write') return `Write ${path(argv[4])} on ${argv[3]}`
  if (family === 'sandbox' && verb === 'create') return `Create sandbox ${argv[3]}${argv[4] ? ` on ${argv[4]}` : ''}`
  if (family === 'workspace' && verb === 'mount') {
    const name = argv[argv.indexOf('--name') + 1]
    return `Mount ${argv[3]} in ${argv[2]}${argv.includes('--name') && name ? ` as ${name}` : ''}`
  }
  if (family === 'workspace' && verb === 'exec') {
    const file = written(argv[3])
    return file ? `Write ${file} in workspace ${workspaceName(argv[2])}` : `Run a command in workspace ${workspaceName(argv[2])}`
  }
  if (family === 'workspace' && verb === 'commit') return `Commit workspace ${workspaceName(argv[2])}`
  if (family === 'workspace' && verb === 'unmount') return `Unmount workspace ${workspaceName(argv[2])}`
  return `Run layerfs ${[family, verb].filter(Boolean).join(' ')}`
}

/** The branch a step changes; workspace steps resolve through their mount. */
function branchOf(step, steps) {
  const [family, verb] = step.argv
  if (family === 'workspace') {
    if (verb === 'mount') return step.argv[3]
    const mount = String(step.argv[2]).match(/^<ws:(.+)>$/)?.[1]
    return mount ? steps.get(mount)?.argv[3] : undefined
  }
  return step.argv[3]
}

/** What a task is, as a noun phrase: "the tokens revisions", "release 2". */
export function taskPhrase(task) {
  const title = String(task?.title ?? '')
  let match
  if ((match = title.match(/^Revise (.+) for release (\d+)$/))) return `the ${match[1]} revisions`
  if ((match = title.match(/^Maintain (.+) for release (\d+)$/))) return `the ${match[1]} maintenance`
  if ((match = title.match(/^Prepare release (\d+)/))) return `the release ${match[1]} branches`
  if ((match = title.match(/^Integrate .+ for release (\d+)$/))) return `the release ${match[1]} integration`
  if ((match = title.match(/^Publish release (\d+)/))) return `release ${match[1]}`
  if (!task?.cycle) return 'the project foundation'
  return title ? title[0].toLowerCase() + title.slice(1) : 'the earlier work'
}

/** Who is doing a task, relative to the script that is waiting for it. */
function owned(task, script) {
  if (task.conversationId !== script.conversationId) return `${taskPhrase(task)} in another conversation`
  if (task.agentId && task.agentId !== script.agentId) return `${taskPhrase(task)} (${task.agentId})`
  return taskPhrase(task)
}

/** Plan facts of a task's commands, in first-appearance order. */
function facts(task, plan) {
  const steps = new Map((plan.steps ?? []).map(step => [step.key, step]))
  const own = task.stepKeys.map(key => steps.get(key)).filter(Boolean)
  const forks = new Map(), writes = new Map(), merges = [], publishes = [], mounted = new Set()
  for (const step of own) {
    const [family, verb] = step.argv
    const branch = branchOf(step, steps)
    if (family === 'branch' && verb === 'fork') forks.set(step.argv[4], [...(forks.get(step.argv[4]) ?? []), step.argv[3]])
    else if (family === 'branch' && verb === 'publish') publishes.push(step.argv[3])
    else if (family === 'branch' && verb === 'merge') merges.push({ target: step.argv[3], sources: step.argv.slice(4).filter((word, index, all) => !String(word).startsWith('--') && !String(all[index - 1] ?? '').startsWith('--')), key: step.key })
    else if (family === 'file' && verb === 'write') writes.set(branch, [...(writes.get(branch) ?? []), path(step.argv[4])])
    else if (family === 'workspace' && verb === 'mount') mounted.add(branch)
    else if (family === 'workspace' && verb === 'exec' && written(step.argv[3])) writes.set(branch, [...(writes.get(branch) ?? []), path(written(step.argv[3]))])
  }
  return { own, steps, forks, writes, merges, publishes: unique(publishes), mounted }
}

/** First-person intent for a task, read from its planned commands. */
export function narrateTask(task, plan) {
  const { forks, writes, merges, publishes, mounted } = facts(task, plan)
  const sentences = []
  for (const [from, branches] of forks) sentences.push(`Forking ${list(branches.map(code), 4, BRANCHES)} from ${code(from)}.`)
  const branches = [...writes.keys()].filter(Boolean)
  if (branches.length === 1) {
    const files = unique(writes.get(branches[0]))
    sentences.push(`I'll revise ${list(files.map(code), 3, ['other file', 'other files'])} on ${code(branches[0])}.`)
  } else if (branches.length > 1) sentences.push(`I'll write the files for ${list(branches.map(code), 3, BRANCHES)}.`)
  if (mounted.size) sentences.push(`Some of those edits go through a mounted workspace and are committed from there.`)
  if (merges.length) {
    const targets = unique(merges.map(merge => merge.target))
    const merged = targets.length === 1
      ? `${list(unique(merges.flatMap(merge => merge.sources)).map(code))} into ${code(targets[0])}`
      : `into ${list(targets.map(code), 3, BRANCHES)}`
    sentences.push(`${sentences.length ? 'Then I\'ll merge' : 'Merging'} ${merged}${publishes.length ? `, and publish ${list(publishes.map(code), 3, BRANCHES)} to main` : ''}.`)
  } else if (publishes.length) sentences.push(`${sentences.length ? 'Then I\'ll publish' : 'Publishing'} ${list(publishes.map(code), 3, BRANCHES)} to main.`)
  return sentences.join(' ') || `Starting on ${taskPhrase(task)}.`
}

/** Confirmed results of some tasks, from journal receipts only. */
function confirmed(tasks, plan, receipts) {
  const steps = new Map((plan.steps ?? []).map(step => [step.key, step]))
  const forked = [], changed = new Map(), merged = new Map(), published = new Map()
  for (const task of tasks) for (const key of task.stepKeys) {
    const step = steps.get(key), receipt = receipts[key]
    if (!step || !receipt) continue
    const [family, verb] = step.argv
    const branch = branchOf(step, steps)
    const version = savedVersions(`${family}.${verb}`, receipt)[0]
    if (family === 'branch' && verb === 'fork') forked.push(step.argv[3])
    else if (family === 'branch' && verb === 'publish') { if (version) published.set(step.argv[3], version) }
    else if (family === 'branch' && verb === 'merge') {
      const sources = step.argv.slice(4).filter((word, index, all) => !String(word).startsWith('--') && !String(all[index - 1] ?? '').startsWith('--'))
      merged.set(`${step.argv[3]}|${sources.join('|')}`, { target: step.argv[3], sources, version })
    }
    else if (family === 'file' && verb === 'write' || family === 'workspace' && verb === 'commit') {
      const entry = changed.get(branch) ?? { files: new Set(), version: undefined }
      if (family === 'file') entry.files.add(path(step.argv[4]))
      if (version) entry.version = version
      changed.set(branch, entry)
    } else if (family === 'workspace' && verb === 'exec' && written(step.argv[3])) {
      const entry = changed.get(branch) ?? { files: new Set(), version: undefined }
      entry.files.add(path(written(step.argv[3])))
      changed.set(branch, entry)
    }
  }
  const lines = []
  if (forked.length) lines.push(`Forked ${list(forked.map(code), 4, BRANCHES)}.`)
  const branches = [...changed].filter(([branch]) => branch)
  if (branches.length > 4) {
    const files = new Set(branches.flatMap(([branch, entry]) => [...entry.files].map(file => `${branch}:${file}`)))
    lines.push(`Committed ${files.size ? `${files.size} files` : 'changes'} across ${list(branches.map(([branch]) => code(branch)), 3, BRANCHES)}.`)
  } else for (const [branch, entry] of branches) {
    const files = [...entry.files]
    const what = files.length ? `${files.length === 1 ? code(files[0]) : `${files.length} files`}` : 'changes'
    lines.push(`Committed ${what} on ${code(branch)}${entry.version ? ` (latest commit ${code(short(entry.version.id))})` : ''}.`)
  }
  const merges = [...merged.values()]
  if (merges.length > 3) lines.push(`Merged into ${list(unique(merges.map(merge => merge.target)).map(code), 3, BRANCHES)}.`)
  else for (const merge of merges) lines.push(`Merged ${list(merge.sources.map(code))} into ${code(merge.target)}${merge.version ? ` (${code(short(merge.version.id))})` : ''}.`)
  const publications = [...published]
  if (publications.length > 3) {
    const [branch, version] = publications.at(-1)
    lines.push(`Published ${list(publications.map(([name]) => code(name)), 3, BRANCHES)} to main; the last one, ${code(branch)}, is Layer ${code(short(version.id))}.`)
  } else for (const [branch, version] of publications) lines.push(`Published ${code(branch)} to main${version.effect === 'unchanged' ? ' (already up to date)' : ''} as Layer ${code(short(version.id))}.`)
  return lines
}

/** A short past-tense line after a task's own commands. */
export function reportTask(task, plan, receipts) {
  return confirmed([task], plan, receipts).join(' ')
}

/** The reply that ends a turn: what this request changed, from receipts. */
export function summarizeTurn({ script, turn, plan, receipts, target }) {
  const tasks = (turn.taskIds ?? []).map(id => plan.tasks?.find(task => task.id === id)).filter(Boolean)
  const lines = confirmed(tasks, plan, receipts)
  const cycles = unique(tasks.map(task => task.cycle))
  const published = lines.some(line => line.startsWith('Published'))
  let lead
  if (script.agentId) lead = `Done with ${list(tasks.map(taskPhrase))}${cycles[0] ? ` for release ${cycles[0]}` : ''}.`
  else if (cycles.length === 1 && cycles[0]) lead = published ? `Release ${cycles[0]} is published.` : `Release ${cycles[0]} work is finished.`
  else lead = 'The project foundation is in place.'
  const parts = [lead]
  if (lines.length) parts.push(lines.map(line => `- ${line}`).join('\n'))
  if (target) parts.push(`Latest saved version on main: ${target.kind} ${code(target.id)}.`)
  if (!script.agentId) parts.push('These are saved file changes only; no application build or tests were run.')
  return parts.join('\n\n')
}

/** "Delegating the tokens revisions to a01-worker and the components revisions to a02-worker." */
export function narrateDelegation(assignments) {
  const children = new Map()
  for (const { phrase, agentId } of assignments) children.set(agentId, [...(children.get(agentId) ?? []), phrase])
  if (!children.size) return ''
  return `Delegating ${list([...children].map(([agentId, phrases]) => `${list(phrases)} to ${agentId}`), 4, ['more assignment', 'more assignments'])}.`
}

export function narrateWait(tasks, script) {
  // "the tokens and components revisions (a01-worker)": one owner, one phrase.
  const groups = new Map()
  for (const task of tasks) {
    const owner = task.conversationId !== script.conversationId ? ' in another conversation' : task.agentId && task.agentId !== script.agentId ? ` (${task.agentId})` : ''
    groups.set(owner, [...(groups.get(owner) ?? []), taskPhrase(task)])
  }
  const phrases = [...groups].map(([owner, names]) => {
    const kinds = names.map(name => name.match(/^the (.+) (revisions|maintenance)$/))
    const combined = names.length > 1 && kinds.every(kind => kind && kind[2] === kinds[0][2]) ? `the ${list(kinds.map(kind => kind[1]))} ${kinds[0][2]}` : list(names)
    return `${combined}${owner}`
  })
  return `Waiting for ${list(phrases, 3, ['other task', 'other tasks'])} to finish first.`
}

export function narrateFailure({ argv, output }) {
  const what = argv ? `The last command (${describeCommand(argv)})` : 'The last project command'
  const tail = String(output ?? '').trim().split('\n').slice(-8).join('\n').slice(-800)
  return [
    `${what} failed.${tail ? ' Its output ended with:' : ''}`,
    tail ? `\`\`\`\n${tail}\n\`\`\`` : '',
    'I\'m stopping here: work that depends on this step cannot continue until it is reconciled.',
  ].filter(Boolean).join('\n\n')
}

export function narrateBlocked(tasks, script) {
  return `I can't continue: ${list(tasks.map(task => owned(task, script)))} did not complete, and the next step depends on it.`
}
