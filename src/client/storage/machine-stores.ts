/**
 * The machine page's Stores tab, as data (MachineStores.tsx draws it):
 *
 * - `machineStores`: a machine's SQLite Stores (the file lives on its disk)
 *   and the PostgreSQL Stores attached to it (the data stays on its server),
 *   with why the machine takes neither kind when it cannot;
 * - `pgServers`: the PostgreSQL Stores connected anywhere, grouped by server,
 *   for Connect a database: each says whether it is on this machine already
 *   and, when it cannot be attached here, why;
 * - `parsePgUrl` / `pgUrl`: a connection URL from and to its parts (never a
 *   password: the host takes it apart from the URL).
 */
import type { StorageT } from './locale.ts'
import { attachmentsOf, attachRefusal } from './model.ts'
import type { PgAttachment, StorageView, StoreRow } from './types.ts'

export type StoreKind = 'sqlite' | 'postgresql'

export interface MachineStores {
  sqlite: StoreRow[]
  /** Their total size; null when no size is known. */
  sqliteBytes: number | null
  postgresql: { store: StoreRow, attachment: PgAttachment }[]
  /** Why the machine holds no SQLite Store, or null when it can. */
  noSqlite: string | null
  /** Why the machine runs no PostgreSQL Sandbox, or null when it can. */
  noPostgresql: string | null
}

export function machineStores(view: StorageView, machine: string, t: StorageT): MachineStores {
  const m = view.machines.find((x) => x.name === machine)
  const sqlite = view.stores.filter((s) => s.kind === 'sqlite' && s.machine === machine).sort((a, b) => a.name.localeCompare(b.name))
  const sizes = sqlite.map((s) => s.size?.bytes ?? null).filter((n): n is number => n != null)
  const postgresql = view.stores.filter((s) => s.kind === 'postgresql').flatMap((store) => {
    const attachment = attachmentsOf(store).find((a) => a.machine === machine)
    return attachment ? [{ store, attachment }] : []
  }).sort((a, b) => a.store.name.localeCompare(b.store.name))
  return {
    sqlite,
    sqliteBytes: sizes.length ? sizes.reduce((a, n) => a + n, 0) : null,
    postgresql,
    noSqlite: m?.supports && m.supports.sqlite === false ? m.supports.reason || t('noStoresHere') : null,
    noPostgresql: m?.supports && !m.supports.postgresql_sandbox ? m.supports.reason || t('postgresql') : null,
  }
}

/** The kind the tab opens on: the one asked for when the machine takes it, else the one with Stores here, else SQLite. */
export function startKind(stores: MachineStores, asked: StoreKind | null): StoreKind {
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

export interface PgServerGroup {
  /** `host:port`, or the whole target when it cannot be read. */
  server: string
  user: string
  stores: { store: StoreRow, database: string, here: boolean, why: string | null }[]
}

/**
 * Every PostgreSQL Store by its server (host and user), servers by name, the
 * Stores under each by name. `here`: attached to `machine` already; `why`:
 * why it cannot be attached to `machine` now (never "already attached",
 * which `here` says).
 */
export function pgServers(view: StorageView, machine: string, t: StorageT): PgServerGroup[] {
  const groups = new Map<string, PgServerGroup>()
  for (const store of view.stores) {
    if (store.kind !== 'postgresql') continue
    const parts = parsePgUrl(store.postgresql?.target)
    const server = parts?.host ?? store.postgresql?.target ?? '?'
    const user = parts?.user ?? ''
    const key = `${user}@${server}`
    const group = groups.get(key) ?? { server, user, stores: [] }
    const here = attachmentsOf(store).some((a) => a.machine === machine)
    group.stores.push({ store, database: parts?.database ?? store.name, here, why: here ? null : attachRefusal(view, store, machine, t) })
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((g) => ({ ...g, stores: g.stores.sort((a, b) => a.store.name.localeCompare(b.store.name)) }))
    .sort((a, b) => a.server.localeCompare(b.server) || a.user.localeCompare(b.user))
}

/** The address `machine` dials for a host-route attach: a loopback server becomes the machine's alias for the host. */
export function routedServer(server: string, alias: string | null): string {
  if (!alias) return server
  return server.replace(/^(localhost|127\.[0-9.]+|\[::1\])(?=:|$)/, alias)
}

/** The three things store.attach checks from the machine, in order. */
export type CheckStep = 'server' | 'store' | 'write'
export const CHECK_STEPS: readonly CheckStep[] = ['server', 'store', 'write']

/**
 * Which check a store.attach refusal failed, by LayerFS's documented
 * refusals (layerfs-store postgresql/attach.rs `check`): the server not
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
