/**
 * The machine page's Stores tab, as data (MachineStores.tsx draws it):
 *
 * - `machineStores`: a machine's SQLite Stores (the file lives on its disk)
 *   and the PostgreSQL Stores attached to it (or with a Sandbox on it now; the
 *   data stays on its server), with why the machine takes neither kind when
 *   it cannot;
 * - `parsePgUrl`: a connection URL's parts;
 * - `projectSplit`: a Store card's project rows, by the bytes their Commits
 *   packed, each with its share.
 */
import type { StorageT } from './locale.ts'
import { pgStoresOn } from './model.ts'
import { hueOf, type StoreProject } from './store-page.ts'
import type { StorageView, StoreRow } from './types.ts'

export type StoreKind = 'sqlite' | 'postgresql'

export interface MachineStores {
  sqlite: StoreRow[]
  /** Their total size; null when no size is known. */
  sqliteBytes: number | null
  postgresql: StoreRow[]
  /** Why the machine holds no SQLite Store, or null when it can. */
  noSqlite: string | null
  /** Why the machine runs no PostgreSQL Sandbox, or null when it can. */
  noPostgresql: string | null
}

/** `busy`: the PostgreSQL Stores with a Sandbox on `machine` now (the Machines view knows; absent, only the defaults show). */
export function machineStores(view: StorageView, machine: string, t: StorageT, busy?: ReadonlySet<string>): MachineStores {
  const m = view.machines.find((x) => x.name === machine)
  const sqlite = view.stores.filter((s) => s.kind === 'sqlite' && s.machine === machine).sort((a, b) => a.name.localeCompare(b.name))
  const sizes = sqlite.map((s) => s.size?.bytes ?? null).filter((n): n is number => n != null)
  return {
    sqlite,
    sqliteBytes: sizes.length ? sizes.reduce((a, n) => a + n, 0) : null,
    postgresql: pgStoresOn(view, machine, busy),
    noSqlite: m?.supports && !m.supports.includes('sqlite') ? t('msNoSqlite') : null,
    noPostgresql: m?.supports && !m.supports.includes('postgresql_sandbox') ? t('msNoPostgresql') : null,
  }
}

/** The kind the tab opens on: the one asked for when the machine takes it, else the one with Stores here, else SQLite. */
export function startKind(stores: Pick<MachineStores, 'noSqlite' | 'noPostgresql'> & { sqlite: readonly unknown[], postgresql: readonly unknown[] }, asked: StoreKind | null): StoreKind {
  const takes = (k: StoreKind) => (k === 'sqlite' ? !stores.noSqlite || stores.sqlite.length > 0 : !stores.noPostgresql || stores.postgresql.length > 0)
  if (asked && takes(asked)) return asked
  if (stores.sqlite.length) return 'sqlite'
  if (stores.postgresql.length) return 'postgresql'
  return takes('sqlite') ? 'sqlite' : 'postgresql'
}

/** A connection URL's parts: `postgresql://user@host:port/database`. */
export interface PgParts { user: string, host: string, database: string }

/** The parts of a PostgreSQL URL or target (`user@host:port/database`), or null when it is neither. */
export function parsePgUrl(text: string | null | undefined): PgParts | null {
  const value = (text ?? '').trim()
  if (!value) return null
  const withScheme = /^postgres(?:ql)?:\/\//i.test(value) ? value : `postgresql://${value}`
  try {
    const u = new URL(withScheme)
    if (!u.host) return null
    return { user: decodeURIComponent(u.username), host: u.host, database: decodeURIComponent(u.pathname.replace(/^\//, '')) }
  } catch {
    return null
  }
}

/**
 * One project on a Store card: its packed bytes, its share of the bar, its
 * color and its newest Commit; `counting` while its ledger is being read, and
 * `error` when it could not be read (null bytes and not counting: unknown).
 */
export interface ProjectSlice { name: string, bytes: number | null, share: number, hue: number, at: number | null, counting: boolean, error: string | null }

export interface ProjectSplit {
  rows: ProjectSlice[]
  /** The newest Commit of any project. */
  lastWrite: number | null
}

/**
 * A Store's projects by the bytes their Commits packed, most first. Against a
 * file size (`total`, SQLite) each share is of the file (content projects
 * share, metadata and free pages are in no project's bytes); without one
 * (PostgreSQL), or when the projects count more than the file holds, the
 * shares are of the projects' sum. A project not yet counted stays in the
 * rows with no share.
 */
export function projectSplit(projects: readonly StoreProject[], total: number | null): ProjectSplit {
  const counted = projects.reduce((a, p) => a + (p.totals?.stored ?? 0), 0)
  const base = total && total >= counted ? total : counted
  const rows = projects.map((p) => {
    const bytes = p.totals ? p.totals.stored : null
    return { name: p.name, bytes, share: base > 0 && bytes ? bytes / base : 0, hue: hueOf(p.name, projects), at: p.last?.time ?? null, counting: !!p.building, error: p.error?.message ?? null }
  }).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name))
  const times = rows.map((r) => r.at).filter((n): n is number => n !== null)
  return { rows, lastWrite: times.length ? Math.max(...times) : null }
}
