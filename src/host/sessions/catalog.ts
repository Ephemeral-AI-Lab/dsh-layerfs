import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError, pages, type Lfs } from '../layerfs/cli.ts'

/**
 * A project's permanent identity: a UUID this plugin mints and keeps inside the
 * project itself, as the branch `dsh.project.<uuid>` (docs/specs/project-sessions.md,
 * "Project identity"). LayerFS has no project id, and its `store stats` reports no
 * Store identity, so the branch is the identity: it travels with the project's
 * history (Store move, push/pull, backup and restore), while a project recreated
 * under the same name has none or another one.
 */
export interface ProjectIdentity {
  /** The UUID. */
  id: string
  name: string
  created: number
  /** Store identity, kept only on rows recorded by older builds. */
  storeId?: string
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

export const PROJECT_BRANCH_PREFIX = 'dsh.project.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Rows of a project nobody has claimed yet carry this id until a conversation attaches. */
export const UNCLAIMED = 'unclaimed:'

export const identityBranch = (id: string): string => `${PROJECT_BRANCH_PREFIX}${id}`

/**
 * The UUID among a project's branch names. Two installations claiming at once
 * can leave two identity branches; the smallest UUID wins everywhere, so they agree.
 */
export function uuidOfBranches(names: readonly string[]): string | null {
  const ids = names.filter((name) => name.startsWith(PROJECT_BRANCH_PREFIX))
    .map((name) => name.slice(PROJECT_BRANCH_PREFIX.length)).filter((id) => UUID.test(id)).sort()
  return ids[0] ?? null
}

const keyOf = (info: any): string => info.project ?? `${info.store}/${info.name}`
const changed = () => new CliError('ProjectIdentityChanged', 'This name now refers to another project. The original conversation remains available; recover its original project before continuing.')

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

  /** The UUID on the project's branches, or null when it has none. */
  async uuidOf(project: string): Promise<string | null> {
    const branches = await pages((paging) => this.lfs().branch.list(project, paging))
    return uuidOfBranches(branches.map((b: any) => String(b?.name ?? b)))
  }

  /**
   * The project's UUID, minting it (forking `dsh.project.<uuid>` from main) when
   * `claim` and the project has none. A lost race reads back the winner.
   */
  async identify(project: string, claim: boolean): Promise<string | null> {
    const found = await this.uuidOf(project)
    if (found || !claim) return found
    const id = randomUUID()
    try { await this.lfs().branch.fork(project, identityBranch(id), 'main') } catch (error) {
      const winner = await this.uuidOf(project).catch(() => null)
      if (winner) return winner
      throw error
    }
    return (await this.uuidOf(project)) ?? id
  }

  private observe(info: any, id: string): CatalogProject {
    const key = keyOf(info)
    const name = info.name ?? key.split('/')[1]
    return this.remember({ projectId: id, identity: { id, name, created: info.created }, key, name, store: info.store ?? key.split('/')[0],
      kind: info.kind ?? null, machine: info.machine ?? null, created: info.created ?? null, lastSeen: Date.now() })
  }

  /**
   * The live project at `project` with its UUID. `claim` (default) mints one for
   * a project nobody has claimed; without it an unclaimed project is refused.
   */
  async resolve(project: string, { claim = true }: { claim?: boolean } = {}): Promise<CatalogProject> {
    const info = await this.lfs().project.get(project)
    const id = await this.identify(project, claim)
    if (!id) throw changed()
    return this.observe(info, id)
  }

  /**
   * The project at `project` must still be `expected`. An `unclaimed:` id from a
   * listing is honoured by claiming the project, unless someone claimed it since.
   */
  async assert(project: string, expected: string): Promise<CatalogProject> {
    if (expected.startsWith(UNCLAIMED)) {
      const live = await this.resolve(project)
      if (expected !== `${UNCLAIMED}${project}` && expected !== live.projectId) throw changed()
      return live
    }
    const live = await this.resolve(project, { claim: false }).catch((error: any) => { throw error?.code === 'ProjectIdentityChanged' ? changed() : error })
    if (live.projectId !== expected) throw changed()
    return live
  }

  /**
   * Every live project with its UUID, plus remembered projects that are gone,
   * moved or replaced. Listing never claims: a project nobody has attached a
   * conversation to is listed as `unclaimed:<store>/<project>`. A remembered
   * `(address, created)` pair reuses its UUID without reading branches again.
   */
  async list(): Promise<CatalogProject[]> {
    const retained = this.retained()
    let live: any[]
    try { live = await pages((paging) => this.lfs().project.list(paging)) }
    catch (error: any) {
      if (!retained.length) throw error
      return retained.map((row) => ({ ...row, catalogState: 'unavailable', catalogError: String(error?.message ?? error), storeState: null }))
    }
    const statuses = new Map<string, Promise<any>>()
    const rows: CatalogProject[] = []
    const seen = new Map<string, string>()
    for (const info of live) {
      const key = keyOf(info)
      const store = info.store ?? key.split('/')[0]
      if (!statuses.has(store)) statuses.set(store, this.lfs().store.status(store).catch(() => null))
      const known = retained.find((row) => row.key === key && row.created === info.created && !row.projectId.startsWith(UNCLAIMED))
      let id: string | null = known?.projectId ?? null
      let failure: any
      if (!id) id = await this.uuidOf(key).catch((error) => { failure = error; return null })
      const storeState = (await statuses.get(store))?.state ?? null
      const base = { key, name: info.name ?? key.split('/')[1], store, kind: info.kind ?? null, machine: info.machine ?? null, created: info.created ?? null, lastSeen: Date.now(), storeState }
      if (!id) {
        rows.push({ ...base, projectId: `${UNCLAIMED}${key}`, catalogState: failure ? 'unavailable' : 'available', ...(failure ? { catalogError: String(failure?.message ?? failure) } : {}) })
        continue
      }
      const row = known && known.projectId === id ? { ...known, ...base } : this.observe(info, id)
      // A restored copy beside its original carries the same UUID: only the first address owns it.
      if (seen.has(id)) {
        rows.push({ ...row, ...base, catalogState: 'identity-mismatch', catalogError: `This project carries the same identity as ${seen.get(id)} (a restored copy?). Conversations stay with ${seen.get(id)}.` })
        continue
      }
      seen.set(id, key)
      rows.push({ ...row, ...base, catalogState: 'available' })
    }
    for (const row of retained) {
      if (row.projectId.startsWith(UNCLAIMED) || seen.has(row.projectId)) continue
      const replaced = live.some((info) => keyOf(info) === row.key)
      if (replaced) {
        rows.push({ ...row, storeState: null, catalogState: 'identity-mismatch', catalogError: 'This name now refers to a different project.' })
        continue
      }
      try {
        await this.lfs().project.get(row.key)
        rows.push({ ...row, storeState: null, catalogState: 'identity-mismatch', catalogError: 'This name now refers to a different project.' })
      } catch (error: any) {
        const removed = ['NoSuchStore', 'NoSuchProject', 'NotFound'].includes(error?.code)
        rows.push({ ...row, storeState: null, catalogState: removed ? 'removed' : 'unavailable', catalogError: String(error?.message ?? error) })
      }
    }
    return rows
  }
}
