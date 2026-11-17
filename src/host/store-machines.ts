/**
 * Where a PostgreSQL Store's sessions run by default. A PostgreSQL Store is on
 * no machine: LayerFS runs its Sandboxes on any machine whose platform runs
 * PostgreSQL Sandboxes, so "Runs on" is this DSH install's own choice, kept in
 * the plugin root (`<root>/store-machines.json`), never in a LayerFS record.
 *
 *   saved choice (a machine that still exists and still runs them)
 *   else docker, when it exists and runs PostgreSQL Sandboxes
 *   else native
 *
 * The file is read on every use (it is a few names), so the session service
 * and the Storage routes never hold different copies of it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A machine as `machine.list` names it, as far as the choice needs. */
export interface PgMachine { name: string, supports?: { postgresql_sandbox?: boolean } | null }

const runsPostgresql = (m: PgMachine): boolean => m.supports?.postgresql_sandbox !== false

/** The machine a PostgreSQL Store runs on when none was chosen: docker when it can, else native. */
export function defaultPgMachine(machines: readonly PgMachine[]): string {
  return machines.some((m) => m.name === 'docker' && runsPostgresql(m)) ? 'docker' : 'native'
}

/**
 * The machine a PostgreSQL Store's Sandboxes run on: `preferred` when one is
 * named (a session's own machine, a machine asked for), else the Store's
 * saved choice while that machine exists and runs PostgreSQL Sandboxes, else
 * {@link defaultPgMachine}.
 */
export function pgMachineOf(saved: string | null | undefined, machines: readonly PgMachine[], preferred?: string | null): string {
  if (preferred) return preferred
  if (saved && machines.some((m) => m.name === saved && runsPostgresql(m))) return saved
  return defaultPgMachine(machines)
}

/** The saved choices, by Store name. */
export class StoreMachines {
  readonly path: string
  /** @param root - the plugin root (`$DSH_HOME/layerfs`). */
  constructor(root: string) { this.path = join(root, 'store-machines.json') }

  private read(): Record<string, string> {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, m]) => typeof m === 'string' && m)) as Record<string, string> : {}
    } catch {
      return {}
    }
  }

  private write(next: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  /** The machine chosen for `store`, or null when none was. */
  get(store: string): string | null { return this.read()[store] ?? null }

  set(store: string, machine: string): void { this.write({ ...this.read(), [store]: machine }) }

  /** Forgets `store`'s choice (the Store was disconnected). */
  drop(store: string): void {
    const all = this.read()
    if (!(store in all)) return
    delete all[store]
    this.write(all)
  }
}
