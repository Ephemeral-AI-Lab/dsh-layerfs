import { verifyProject } from '../presets/recipe/project-verification.js'
import { storeBranchOf } from '../sessions/store.ts'
import { identityBranch, uuidOfBranches } from '../sessions/catalog.ts'
import type { SimulationJournal } from './package.ts'

/** Exact local bindings identify archive branches; an unknown dsh.session.* branch remains a graph error. */
export function simulationArchiveBranches(journal: Pick<SimulationJournal, 'records'>): Set<string> {
  return new Set(journal.records.filter(record => record.type === 'binding' && typeof record.sessionId === 'string').map(record => storeBranchOf(record.sessionId)))
}

/** Adapt the unchanged recipe verifier to a uniquely named simulation project. */
export function simulationVerificationQuery(manifest: any, journal: Pick<SimulationJournal, 'records'>, query: (argv: string[]) => Promise<any>) {
  const recipeProject = `${manifest.store}/${manifest.project}`
  const excluded = simulationArchiveBranches(journal)
  let inventory: Promise<any[]> | undefined
  async function branches(): Promise<any[]> {
    const items: any[] = []
    const cursors = new Set<string>()
    let cursor: string | null = null, first = true
    while (first || cursor !== null) {
      first = false
      const result = await query(['branch', 'list', manifest.projectRef, '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])])
      if (!Array.isArray(result?.items)) throw new Error('Invalid simulation branch inventory')
      items.push(...result.items)
      const next: string | null = result.next_cursor ?? null
      if (next !== null && (cursors.has(next) || !result.items.length)) throw new Error('Simulation branch pagination did not advance')
      if (next !== null) cursors.add(next)
      cursor = next
    }
    // The project's identity branch (`dsh.project.<uuid>`, minted when sessions
    // claim the project) is internal, like session archives.
    const identity = uuidOfBranches(items.map(branch => branch.branch))
    return items.filter(branch => !excluded.has(branch.branch) && !(identity && branch.branch === identityBranch(identity)))
  }
  return async (argv: string[]): Promise<any> => {
    const resolved = argv.map(word => word === recipeProject ? manifest.projectRef : word)
    if (resolved[0] !== 'branch' || resolved[1] !== 'list') return query(resolved)
    inventory ??= branches()
    const all = await inventory
    const option = (name: string, fallback: number) => {
      const index = resolved.indexOf(name)
      const value = index === -1 ? fallback : Number(resolved[index + 1])
      if (!Number.isInteger(value) || value < 0) throw new Error('Invalid verification pagination')
      return value
    }
    // the verifier's pages over the filtered inventory: its cursor is the next row's index
    const at = resolved.indexOf('--cursor'), start = at === -1 ? 0 : Number(resolved[at + 1])
    if (!Number.isInteger(start) || start < 0) throw new Error('Invalid verification pagination')
    const size = option('--limit', 100)
    if (!size) throw new Error('Invalid verification page size')
    const next = start + size < all.length ? start + size : null
    return { items: all.slice(start, start + size), ...(next !== null ? { next_cursor: String(next) } : {}) }
  }
}

/** Verify real saved graph + files after all workload mutations settle and before LLM handoff. */
export async function verifySimulation(manifest: any, plan: any, journal: SimulationJournal, query: (argv: string[]) => Promise<any>): Promise<any> {
  for (const step of plan.steps) if (!Object.hasOwn(journal.receipts, step.key)) throw new Error(`Cannot verify incomplete simulation step: ${step.key}`)
  await journal.append({ type: 'verification.started', project: manifest.projectRef, origin: 'host' })
  try {
    const verdict = await verifyProject(simulationVerificationQuery(manifest, journal, query), manifest.store, manifest.project, journal.receipts, { cycles: manifest.cycles, executionMode: manifest.mixed ? 'mixed' : 'filesystem' })
    const result = { ...verdict, project: manifest.projectRef, excludedArchiveBranches: [...simulationArchiveBranches(journal)] }
    await journal.append({ type: 'verification.completed', origin: 'host', result })
    return result
  } catch (error: any) {
    await journal.append({ type: 'verification.failed', origin: 'host', error: String(error?.message ?? error) })
    throw error
  }
}
