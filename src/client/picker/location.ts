/**
 * Where a new project can go (docs/specs/layerfs-workspaces.md §5): the Stores
 * this host can Init into, the default Store name when there is none, the
 * machines a PostgreSQL Store is connected from, and project-name slugs.
 */

/** One Store a project can be made in. */
export interface Location {
  store: string
  kind: 'sqlite' | 'postgresql'
  /** PostgreSQL: the server (`host:port/db`), else null. */
  server: string | null
  /** PostgreSQL: the machines its database is connected from (spec v23; each session picks its own), else empty. */
  connectedFrom: string[]
}

/** A project name from free text: lowercase, other runs become `-`, trimmed to 63. */
export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 63).replace(/[^a-z0-9]+$/, '')
}

/**
 * The Stores of a `/api/storage` view a project can be made in from this host:
 * SQLite Stores on native, then PostgreSQL Stores; never the Scratch Store.
 */
export function locationsOf(view: any, scratchStore?: string | null): Location[] {
  const stores: any[] = Array.isArray(view?.stores) ? view.stores : []
  const usable = stores.filter((s) => s?.name && s.name !== scratchStore)
  const sqlite = usable.filter((s) => (s.kind ?? 'sqlite') !== 'postgresql' && (s.machine ?? 'native') === 'native')
    .map((s): Location => ({ store: String(s.name), kind: 'sqlite', server: null, connectedFrom: [] }))
  const pg = usable.filter((s) => s.kind === 'postgresql')
    .map((s): Location => ({ store: String(s.name), kind: 'postgresql', server: s.postgresql?.target ?? null, connectedFrom: (Array.isArray(s.connectedFrom) ? s.connectedFrom : []).map((c: any) => (typeof c?.machine === 'string' && c.machine ? c.machine : 'native')) }))
  return [...sqlite, ...pg]
}

/** `projects`, or `projects-2`, … when a Store of that name exists anywhere. */
export function defaultStoreName(view: any): string {
  const taken = new Set<string>((Array.isArray(view?.stores) ? view.stores : []).map((s: any) => String(s?.name)))
  if (!taken.has('projects')) return 'projects'
  for (let n = 2; ; n++) if (!taken.has(`projects-${n}`)) return `projects-${n}`
}

const LAST = 'dsh-layerfs:last-store'
/** The Store last used for a new project in this browser. */
export function lastStore(): string | null { try { return localStorage.getItem(LAST) } catch { return null } }
export function rememberStore(store: string): void { try { localStorage.setItem(LAST, store) } catch {} }

/** The Store to preselect: the last one used when still offered, else the first. */
export function preferredStore(locations: readonly Location[], last: string | null): string {
  return locations.find((l) => l.store === last)?.store ?? locations[0]?.store ?? ''
}
