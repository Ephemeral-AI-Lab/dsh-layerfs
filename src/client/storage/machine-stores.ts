/**
 * The Stores boards, as data (MachineStores.tsx draws them):
 *
 * - `machineStores`: a machine's SQLite Stores (the file lives on its disk)
 *   and the PostgreSQL Stores connected from it (its `connections` row, or a
 *   Sandbox on it now; the data stays on its server),
 *   with why the machine takes neither kind when it cannot;
 * - `loginGroups`: PostgreSQL Stores under their saved login (spec v23), the
 *   PostgreSQL tab's groups; `serverGroups`: the same Stores under their
 *   server, for Connect a database's list;
 * - `parsePgUrl` / `pgUrl`: a connection URL from and to its parts (never a
 *   password: the host takes it apart from the URL);
 * - `projectSplit`: a Store card's project rows, by the bytes their Commits
 *   packed, each with its share.
 */
import type { StorageT } from './locale.ts'
import { pgStoresOn } from './model.ts'
import { hueOf, type StoreProject } from './store-page.ts'
import type { PgAuth, PgServer, StorageView, StoreRow } from './types.ts'

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
    noSqlite: m?.supports && !m.supports.includes('sqlite') ? t('noStoresHere') : null,
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

/** A URL from its parts, without a password. */
export function pgUrl(p: PgParts): string {
  return `postgresql://${p.user ? `${encodeURIComponent(p.user)}@` : ''}${p.host}/${encodeURIComponent(p.database)}`
}

/** A PostgreSQL Store's server (`host:port`): the key its card is grouped by. */
export function serverKey(s: Pick<StoreRow, 'name' | 'postgresql'>): string {
  const pg = s.postgresql
  if (pg?.server) return pg.server
  return parsePgUrl(pg?.target)?.host ?? pg?.target ?? s.name
}

export interface PgServerGroup {
  /** `host:port`, or the whole target when it cannot be read. */
  server: string
  /** The user its Stores log in as (the first that names one). */
  user: string
  /** By name. */
  stores: StoreRow[]
  /**
   * The host's own check of the server (store.get): `ok` when any of its
   * Stores reached it, `failed` when none did and one was refused, `unknown`
   * while no status answered.
   */
  state: 'ok' | 'failed' | 'unknown'
  version: string | null
  latencyMs: number | null
  error: string | null
}

/** PostgreSQL Stores under their server, servers by address, Stores by name. */
export function serverGroups(stores: readonly StoreRow[]): PgServerGroup[] {
  const by = new Map<string, StoreRow[]>()
  for (const s of stores) {
    if (s.kind !== 'postgresql') continue
    by.set(serverKey(s), [...(by.get(serverKey(s)) ?? []), s])
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([server, list]) => {
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name))
    // 2.0: a ready Store reached its server; a broken one with reason `unreachable` did not (no version or latency on a list row)
    const reached = sorted.find((s) => s.state === 'ready')
    const failing = sorted.find((s) => s.state === 'broken' && s.reason === 'unreachable')
    return {
      server,
      // the saved login's name (2.0 keeps no user beside the Store)
      user: sorted.map((s) => s.postgresql?.auth ?? '').find(Boolean) ?? '',
      stores: sorted,
      state: reached ? 'ok' : failing ? 'failed' : 'unknown',
      version: null,
      latencyMs: null,
      error: reached ? null : failing?.reason ?? null,
    }
  })
}

/** One login group of the PostgreSQL tab (spec v23 V23-1): a saved login, or (`auth: null`) the Stores whose login is missing. */
export interface PgLoginGroup {
  /** The saved login's name; null for "No login". */
  auth: string | null
  user: string | null
  /** Its Stores, by name. */
  stores: StoreRow[]
  /** The worst state of its Stores, or the login's own when its file cannot be read. */
  state: string
  /** The servers its Stores are on (`host:port`), for the tip. */
  servers: string[]
  /** When the login was saved last. */
  saved: number | null
  /** The login's own fix, when its file cannot be read. */
  fix?: string | undefined
}

const WORST = ['broken', 'unknown', 'blocked', 'busy', 'stopped', 'ready']
const worst = (states: readonly string[]): string => WORST.find((w) => states.includes(w)) ?? 'ready'

/** Whether Store `s`'s login is missing: it names none, or one the home does not hold. */
const loginMissing = (s: StoreRow, saved: ReadonlySet<string>): boolean => !s.postgresql?.auth || !saved.has(s.postgresql.auth)

/**
 * PostgreSQL Stores under their saved login (spec v23 V23-1): every login the
 * home holds (one no Store names too, so it can be removed), each with its
 * Stores, then "No login" for Stores whose login is missing. Logins by name.
 */
export function loginGroups(stores: readonly StoreRow[], auths: readonly PgAuth[]): PgLoginGroup[] {
  const pg = stores.filter((s) => s.kind === 'postgresql').sort((a, b) => a.name.localeCompare(b.name))
  const saved = new Set(auths.map((a) => a.auth))
  const groups: PgLoginGroup[] = [...auths].sort((a, b) => a.auth.localeCompare(b.auth)).map((a) => {
    const mine = pg.filter((s) => s.postgresql?.auth === a.auth)
    return {
      auth: a.auth, user: a.user, stores: mine,
      state: (a.state ?? 'ready') !== 'ready' ? a.state! : worst(mine.map((s) => s.state)),
      servers: [...new Set(mine.map((s) => s.postgresql?.server).filter((x): x is string => !!x))].sort(),
      saved: a.updated ?? a.created ?? null,
      fix: a.fix,
    }
  })
  const lost = pg.filter((s) => loginMissing(s, saved))
  if (lost.length) groups.push({ auth: null, user: null, stores: lost, state: worst(lost.map((s) => s.state)), servers: [...new Set(lost.map((s) => s.postgresql?.server).filter((x): x is string => !!x))].sort(), saved: null })
  return groups
}

/** What the server header says of the host's check: unreachable, reachable (with its latency only when it was measured), or not checked. */
export function serverCheckWords(g: Pick<PgServerGroup, 'state' | 'latencyMs'>, t: StorageT): string {
  if (g.state === 'failed') return t('hsUnreachable')
  if (g.state !== 'ok') return t('msNotCheckedShort')
  return g.latencyMs != null && Number.isFinite(g.latencyMs) ? t('msReachableMs', { latency: g.latencyMs }) : t('msReachable')
}

/**
 * A Store's own trouble, when it is not its server's: the server answers
 * (another of its Stores reached it) but this database did not. Null when
 * the Store says what its server's header already says.
 */
export function storeOffServer(s: StoreRow, group: Pick<PgServerGroup, 'state'> | undefined): string | null {
  if (s.kind !== 'postgresql' || s.state !== 'broken') return null
  return group && group.state === 'failed' && s.reason === 'unreachable' ? null : s.reason ?? ''
}

/** The address `machine` dials for a server on this host: a loopback server becomes the machine's alias for the host. */
export function routedServer(server: string, alias: string | null): string {
  if (!alias) return server
  return server.replace(/^(localhost|127\.[0-9.]+|\[::1\])(?=:|$)/, alias)
}

/** The three things a check from a machine tries, in order (`store doctor <s> --machine M`). */
export type CheckStep = 'server' | 'store' | 'write'
export const CHECK_STEPS: readonly CheckStep[] = ['server', 'store', 'write']

/**
 * Which step a failed check stopped at, by LayerFS's documented refusals
 * (layerfs-store postgresql/check.rs): the server not
 * reached is `Unavailable`; another Store's schema is `Unavailable` naming
 * "holds another Store than"; a login refused is `Denied`; a privilege
 * missing is `Denied` "lacks …", on the schema (its Store cannot be read)
 * or on what a Sandbox writes. Any other refusal fails no step it can name:
 * null, and the path shows the refusal as it came.
 */
export function failedStep(code: string | undefined, message: string | undefined): CheckStep | null {
  const text = message ?? ''
  if (code === 'Unavailable') return text.includes('holds another Store than') ? 'store' : 'server'
  if (code === 'Denied') {
    if (!/\black(s)?\b/.test(text)) return 'server'
    return text.includes(' on schema ') ? 'store' : 'write'
  }
  return null
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
