import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError, pages, type Lfs } from '../layerfs/cli.ts'

export interface ProjectIdentity {
  id: string
  storeId: string
  storeGeneration: string
  name: string
  created: number
}
export interface CatalogProject {
  projectId: string
  identity?: ProjectIdentity
  key: string
  name: string
  store: string
  kind: string | null
  machine: string | null
  created: number | null
  lastSeen: number
  catalogState?: 'available' | 'unavailable' | 'removed' | 'identity-mismatch'
  catalogError?: string
  storeState?: string | null
}

export const identityHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** SDK project names have no UUID. The creation stamp identifies an incarnation
 * within the opaque Store identity/generation. Machine and home are excluded. */
export function projectIdentity(info: any, stats: any): ProjectIdentity {
  if (!stats?.store_id || stats.store_generation == null || !Number.isFinite(info?.created)) {
    throw new CliError('IdentityUnavailable', 'Store identity and project creation metadata are required before attaching conversation history')
  }
  const name = info.name ?? String(info.project).split('/')[1]
  const storeGeneration = String(stats.store_generation)
  return { id: identityHash([stats.store_id, storeGeneration, name, info.created]), storeId: stats.store_id, storeGeneration, name, created: info.created }
}

/** Durable inventory, independent of the current live LayerFS listing. */
export class ProjectCatalog {
  private readonly path: string
  constructor(private readonly lfs: () => Lfs, root: string) { this.path = join(root, 'project-catalog.json') }
  private read(): Record<string, CatalogProject> {
    if (!existsSync(this.path)) return {}
    const value = JSON.parse(readFileSync(this.path, 'utf8'))
    if (value.version !== 1 || !value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) throw new Error('Invalid project catalog')
    return value.projects
  }
  private write(projects: Record<string, CatalogProject>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, projects }, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
  retained(): CatalogProject[] { return Object.values(this.read()) }
  get(id: string): CatalogProject | undefined { return this.read()[id] }
  remember(row: CatalogProject): CatalogProject {
    const all = this.read()
    all[row.projectId] = row
    this.write(all)
    return row
  }
  observe(info: any, stats: any): CatalogProject {
    const identity = projectIdentity(info, stats)
    const key = info.project ?? `${info.store}/${info.name}`
    return this.remember({ projectId: identity.id, identity, key, name: identity.name, store: info.store ?? key.split('/')[0],
      kind: info.kind ?? null, machine: info.machine ?? null, created: identity.created, lastSeen: Date.now() })
  }
  async resolve(project: string): Promise<CatalogProject> {
    const [info, stats] = await Promise.all([this.lfs().project.get(project), this.lfs().store.stats(project.split('/')[0])])
    return this.observe(info, stats)
  }
  async assert(project: string, expected: string): Promise<CatalogProject> {
    const live = await this.resolve(project)
    if (live.projectId !== expected) throw new CliError('ProjectIdentityChanged', 'This name now refers to another Store or project. The original conversation remains available; recover its original project before continuing.')
    return live
  }
  async list(): Promise<CatalogProject[]> {
    const retained = this.retained()
    let live: any[]
    try { live = await pages((paging) => this.lfs().project.list(paging)) }
    catch (error: any) {
      if (!retained.length) throw error
      return retained.map((row) => ({ ...row, catalogState: 'unavailable', catalogError: String(error?.message ?? error), storeState: null }))
    }
    const stats = new Map<string, Promise<any>>()
    const statuses = new Map<string, Promise<any>>()
    const rows: CatalogProject[] = []
    const matched = new Set<string>()
    for (const info of live) {
      const key = info.project ?? `${info.store}/${info.name}`
      const store = info.store ?? key.split('/')[0]
      if (!stats.has(store)) stats.set(store, this.lfs().store.stats(store).then((value) => ({ value }), (error) => ({ error })))
      if (!statuses.has(store)) statuses.set(store, this.lfs().store.status(store).catch(() => null))
      const [observation, status] = await Promise.all([stats.get(store)!, statuses.get(store)!])
      if (observation.error) {
        const known = retained.filter((row) => row.key === key && row.created === info.created)
        for (const row of known) {
          matched.add(row.projectId)
          rows.push({ ...row, machine: info.machine ?? row.machine, storeState: status?.state ?? null, catalogState: 'unavailable', catalogError: String(observation.error?.message ?? observation.error) })
        }
        // An unverified address is visible but cannot acquire conversation ownership.
        if (!known.length) rows.push({ projectId: `unverified:${key}`, key, name: info.name, store, kind: info.kind, machine: info.machine, created: info.created,
          lastSeen: Date.now(), storeState: status?.state ?? null, catalogState: 'unavailable', catalogError: String(observation.error?.message ?? observation.error) })
        continue
      }
      const row = this.observe(info, observation.value)
      matched.add(row.projectId)
      rows.push({ ...row, catalogState: 'available', storeState: status?.state ?? null })
    }
    for (const row of retained) if (!matched.has(row.projectId)) {
      const replacement = live.some((info) => (info.project ?? `${info.store}/${info.name}`) === row.key)
      if (replacement) {
        rows.push({ ...row, storeState: null, catalogState: 'identity-mismatch', catalogError: 'This name now refers to a different Store or project.' })
        continue
      }
      // A successful list is not proof of deletion: verify the specific record.
      try {
        const verified = await this.resolve(row.key)
        if (verified.projectId !== row.projectId) rows.push({ ...row, storeState: null, catalogState: 'identity-mismatch', catalogError: 'This name now refers to a different Store or project.' })
        else rows.push({ ...verified, catalogState: 'available', storeState: (await this.lfs().store.status(row.store).catch(() => null))?.state ?? null })
      } catch (error: any) {
        const removed = ['NoSuchStore', 'NoSuchProject', 'NotFound'].includes(error?.code)
        rows.push({ ...row, storeState: null, catalogState: removed ? 'removed' : 'unavailable', catalogError: String(error?.message ?? error) })
      }
    }
    return rows
  }
}
