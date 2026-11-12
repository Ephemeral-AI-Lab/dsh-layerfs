import { verifyProject } from '../presets/recipe/project-verification.js'
import { storeBranchOf } from '../sessions/store.ts'
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
    const positions = new Set<number>()
    let position: number | null = 0
    while (position !== null) {
      if (positions.has(position)) throw new Error('Simulation branch pagination did not advance')
      positions.add(position)
      const result = await query(['branch', 'list', manifest.projectRef, '--page-size', '20', '--page-pos', String(position)])
      if (!Array.isArray(result?.items)) throw new Error('Invalid simulation branch inventory')
      items.push(...result.items)
      if (result.has_more && result.next_page_pos == null) throw new Error('Incomplete simulation branch inventory')
      const next = result.next_page_pos ?? null
      if (next !== null && (!Number.isInteger(next) || !result.items.length)) throw new Error('Invalid simulation branch pagination')
      position = next
    }
    return items.filter(branch => !excluded.has(branch.name))
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
    const start = option('--page-pos', 0), size = option('--page-size', 20)
    if (!size) throw new Error('Invalid verification page size')
    const next = start + size < all.length ? start + size : null
    return { items: all.slice(start, start + size), has_more: next !== null, next_page_pos: next }
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
