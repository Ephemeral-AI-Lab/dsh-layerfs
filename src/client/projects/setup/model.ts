/**
 * The Setup card's rules (docs/specs/layerfs-workspaces.md §1, §3): which
 * machines can run a Store kind, the default machine, where a project runs,
 * and the steps a Create takes. Pure; read from a `/api/storage` view.
 */
import type { MachinePlatformInfo } from '../../machines/model.ts'
import { engineStart, machineBlock, type HostOs } from '../../machines/needs.ts'
import { attachedMachines, pgDefaultMachine } from '../../storage/model.ts'
import type { StorageView, StoreRow } from '../../storage/types.ts'
import { hostOf, isHostName } from '../../../shared/host-machine.ts'

export type StoreKind = 'sqlite' | 'postgresql'
export type Machine = StorageView['machines'][number]

/** LayerFS 2.0: a machine that runs is `ready`. */
const RUNNING = new Set(['ready'])
export const isRunning = (m: Pick<Machine, 'name' | 'state'> | undefined) => !!m && RUNNING.has(m.state ?? '')

/** Machines that can run a project of this Store kind: docker first, then the host machine, then the rest by name. */
export function machinesFor(view: Pick<StorageView, 'machines'> | undefined, kind: StoreKind): Machine[] {
  const can = (m: Machine) => m.state !== 'unsupported'
    && (kind === 'sqlite' ? !m.supports || m.supports.includes('sqlite') : !m.supports || m.supports.includes('postgresql_sandbox'))
  const rank = (m: Machine) => (m.name === 'docker' ? 0 : isHostName(m.name) ? 1 : 2)
  return (view?.machines ?? []).filter(can).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * A machine whose platform is not ready here (needs.ts machineBlock): it
 * cannot run now whatever its record says. `startable`: only the Docker
 * Engine is down on macOS, which the machine's Start launches first, so it
 * stays pickable: the person picks it and presses its named Start first.
 */
export interface TileBlock { startable: boolean }

/** The machines that cannot run here now, by name; empty while the platforms are not read (an older host). */
export function tileBlocks(
  machines: readonly Pick<Machine, 'name' | 'platform'>[],
  platforms: readonly Pick<MachinePlatformInfo, 'platform' | 'ready' | 'missing' | 'socket' | 'candidates'>[] | undefined,
  os: HostOs | undefined,
): Map<string, TileBlock> {
  const out = new Map<string, TileBlock>()
  if (!platforms) return out
  const computer = { os: os ?? 'macos', name: null, arch: '' } as const
  for (const m of machines) {
    const block = machineBlock(m, { platforms, computer })
    if (block) out.set(m.name, { startable: engineStart(m, block, computer.os) })
  }
  return out
}

/**
 * The default machine (U10): the machine whose page the dialog was opened
 * from, else the host machine, else the first that runs. Never a machine that is
 * broken, blocked here, or not running: Create would have to start it, and a
 * start is only ever the person's own press on that machine (spec v21).
 */
export function defaultMachine(machines: readonly Machine[], blocks: ReadonlyMap<string, TileBlock> = new Map(), opened?: string | null): string {
  const ok = (m: Machine | undefined): boolean => !!m && m.state !== 'broken' && !blocks.has(m.name) && isRunning(m)
  const from = machines.find((m) => m.name === opened)
  if (from && ok(from)) return from.name
  const host = hostOf(machines)
  if (host && ok(host)) return host.name
  return machines.find((m) => ok(m))?.name ?? host?.name ?? machines[0]?.name ?? ''
}

/** Whether `name` can be picked: not blocked here, or only waiting on the Docker Engine its Start launches. */
export const pickable = (name: string, blocks: ReadonlyMap<string, TileBlock>): boolean => blocks.get(name)?.startable ?? true

/**
 * Where a project runs: its SQLite Store's machine; for a PostgreSQL Store
 * the machines attached to it (each session picks one of them).
 */
export function runsOn(store: Pick<StoreRow, 'kind' | 'machine' | 'attached'> | undefined): string[] {
  if (!store) return []
  return store.kind === 'postgresql' ? attachedMachines(store) : store.machine ? [store.machine] : []
}

/**
 * The machine a project's readiness follows (§8): a SQLite Store's machine;
 * for a PostgreSQL Store the machine a new session would run on
 * (`pgDefaultMachine`: never a broken or stopped one, none when the person
 * must pick), so it reads available while its Store is ready and some
 * machine can run it.
 */
export function primaryMachine(store: Pick<StoreRow, 'kind' | 'machine' | 'attached'> | undefined, machines: Pick<StorageView, 'machines'>['machines'] = []): string | null {
  if (!store) return null
  return store.kind === 'postgresql' ? pgDefaultMachine(store, machines) : store.machine ?? null
}

const MAX_STORE_NAME = 63

/** A free Store name from a project name: itself, else `<prefix>-2`, `<prefix>-3`, … within 63 chars. */
export function freeStoreName(base: string, view: Pick<StorageView, 'stores'> | undefined): string {
  const taken = new Set((view?.stores ?? []).map((s) => s.name))
  const root = (base || 'projects').slice(0, MAX_STORE_NAME).replace(/[^a-z0-9]+$/, '') || 'projects'
  if (!taken.has(root)) return root
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const maxPrefix = MAX_STORE_NAME - suffix.length
    const prefix = maxPrefix > 0 ? root.slice(0, maxPrefix).replace(/[^a-z0-9]+$/, '') : ''
    const candidate = prefix ? `${prefix}${suffix}` : String(n)
    if (!taken.has(candidate)) return candidate
  }
}

export interface NewStoreResolution {
  slugTaken: boolean
  autoName: string
  chosenName: string
  showField: boolean
  conflictNotice: boolean
}

/** Resolve the Store name for a new Store: follows `slug` quietly until `slug` collides with an existing Store, then suggests a free name and exposes the editable field + notice. */
export function resolveNewStoreName(
  slug: string,
  typedStoreName: string | null,
  view: Pick<StorageView, 'stores'> | undefined,
): NewStoreResolution {
  const slugTaken = !!slug && !!view?.stores.some((s) => s.name === slug)
  const autoName = slugTaken ? freeStoreName(slug, view) : slug
  const chosenName = (typedStoreName ?? autoName).trim()
  const showField = slugTaken || typedStoreName !== null
  return { slugTaken, autoName, chosenName, showField, conflictNotice: slugTaken && typedStoreName === null }
}

/** A new PostgreSQL Store's login: its user and password, saved by the host for this Store (`store connect --user … --password-stdin`). */
export interface PgLogin { user: string, password: string }

/** Why a login cannot be used yet, or null. */
export type PgLoginProblem = 'user' | 'password'
export function pgLoginProblem(login: PgLogin): PgLoginProblem | null {
  if (!login.user.trim()) return 'user'
  if (!login.password) return 'password'
  return null
}

/** The connect route's login fields (the password goes to LayerFS on stdin). */
export function pgLoginBody(login: PgLogin): { user: string, passwordValue: string } {
  return { user: login.user.trim(), passwordValue: login.password }
}

/** What a Create asks for. */
export interface CreatePlan {
  name: string
  kind: StoreKind
  /** An existing Store, or null for a new one. */
  store: StoreRow | null
  /** A new Store; a PostgreSQL one has its address (no user or password) and its login. */
  newStore?: { name: string, url?: string, login?: PgLogin }
  /** One machine: where a SQLite Store's file goes, or where this project's first PostgreSQL session runs. */
  machines: string[]
  /** An absolute folder the project starts from; empty when absent. */
  source?: string
}

export type StepId = 'check' | 'store' | 'connect' | 'init' | `place:${string}` | `attach:${string}` | 'open'
export interface Step { id: StepId, machine?: string }

/**
 * The steps a Create runs, in order (§3). A PostgreSQL Store is on no machine:
 * a new one is connected, and the machine picked is the first session's own
 * (`open` carries it); it is attached first when it is not yet (a Sandbox
 * runs only on an attached machine). Create starts no machine: a machine it needs that is
 * not running ({@link needsStart}) is started by the person's own press on
 * that machine's Start first (UI pass 2: no start without that press).
 */
export function createSteps(plan: CreatePlan, _view?: Pick<StorageView, 'machines'> | undefined): Step[] {
  // the folder is checked before anything is made, so a wrong one leaves no empty Store
  const steps: Step[] = plan.source ? [{ id: 'check' }] : []
  if (plan.kind === 'sqlite') {
    // a new Store is made on the host machine (`store create` without `--machine`)
    const at = plan.store?.machine ?? null
    const target = plan.machines[0] ?? at
    if (!plan.store) steps.push({ id: 'store' })
    steps.push({ id: 'init' })
    if (target && (at ? target !== at : !isHostName(target))) steps.push({ id: `place:${target}`, machine: target })
  } else {
    if (!plan.store) steps.push({ id: 'connect' })
    steps.push({ id: 'init' })
    // every machine the person checked that is not attached yet, the first session's machine first
    for (const m of [...new Set(plan.machines)]) {
      if (!(plan.store?.attached ?? []).some((a) => a.machine === m)) steps.push({ id: `attach:${m}`, machine: m })
    }
  }
  const first = plan.kind === 'postgresql' ? plan.machines[0] : undefined
  steps.push({ id: 'open', ...(first ? { machine: first } : {}) })
  return steps
}

/**
 * The machines a Create needs running that are not: a SQLite project's Store
 * machine (the host machine for a new Store) and the machine it moves to, a PostgreSQL project's
 * machine its session runs on. Each is started only by a press on its own
 * Start; Create waits until none is left.
 */
export function needsStart(plan: Pick<CreatePlan, 'kind' | 'store' | 'machines'>, view: Pick<StorageView, 'machines'> | undefined): string[] {
  const names = plan.kind === 'sqlite'
    ? [plan.store?.machine ?? hostOf(view?.machines)?.name, plan.machines[0]].filter((n): n is string => !!n)
    : plan.machines.slice(0, 1)
  return stoppedOf(names, view)
}

/**
 * Of these machines, the ones known and not running (the host machine too:
 * it can be stopped), each once. A broken machine is not one: Start is not its fix (F1),
 * LayerFS's refusal carries that.
 */
export function stoppedOf(names: readonly string[], view: Pick<StorageView, 'machines'> | undefined): string[] {
  return [...new Set(names)].filter((n) => {
    const m = view?.machines.find((x) => x.name === n)
    return !!m && m.state !== 'broken' && !isRunning(m)
  })
}

/** The Store a new project goes in: an existing one by name, a new SQLite Store, or a new PostgreSQL connection. */
export type StoreChoice = { kind: 'existing', store: string } | { kind: 'sqlite' } | { kind: 'pg' }

/**
 * The last-used Store: the Store of the newest project with sessions on this
 * DSH (`projects.recent`, newest first, keys `<store>/<project>`) that is still
 * one of `stores`. A Create opens a session, so the Store of the last project
 * made or worked in. Null when none is.
 */
export function lastUsedStore<S extends Pick<StoreRow, 'name'>>(recent: readonly { project: string }[], stores: readonly S[]): S | null {
  for (const r of recent) {
    const name = r.project.split('/')[0]
    const store = stores.find((s) => s.name === name)
    if (store) return store
  }
  return null
}

/**
 * The Create dialog's default Store: the last-used one when a new project can
 * use it (a SQLite Store whose machine is stopped stays: its Start is shown),
 * else a new SQLite Store. `fellBack`: there is a last-used Store, but not usable.
 */
export function defaultStoreChoice<S extends Pick<StoreRow, 'name'>>(last: S | null, usable: (s: S) => boolean): { choice: StoreChoice, fellBack: boolean } {
  if (last && usable(last)) return { choice: { kind: 'existing', store: last.name }, fellBack: false }
  return { choice: { kind: 'sqlite' }, fellBack: !!last }
}
