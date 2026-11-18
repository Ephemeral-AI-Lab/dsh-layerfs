/**
 * The Setup card's rules (docs/specs/layerfs-workspaces.md §1, §3): which
 * machines can run a Store kind, the default machine, where a project runs,
 * and the steps a Create takes. Pure; read from a `/api/storage` view.
 */
import type { MachinePlatformInfo } from '../../machines/model.ts'
import { engineStart, machineBlock, type HostOs } from '../../machines/needs.ts'
import type { StorageView, StoreRow } from '../../storage/types.ts'

export type StoreKind = 'sqlite' | 'postgresql'
export type Machine = StorageView['machines'][number]

/** LayerFS 2.0: a machine that runs is `ready`. */
const RUNNING = new Set(['ready'])
export const isRunning = (m: Pick<Machine, 'name' | 'state'> | undefined) => !!m && (m.name === 'native' || RUNNING.has(m.state ?? ''))

/** Machines that can run a project of this Store kind: docker first, then native, then the rest by name. */
export function machinesFor(view: Pick<StorageView, 'machines'> | undefined, kind: StoreKind): Machine[] {
  const can = (m: Machine) => m.state !== 'unsupported'
    && (kind === 'sqlite' ? !m.supports || m.supports.includes('sqlite') : !m.supports || m.supports.includes('postgresql_sandbox'))
  const rank = (m: Machine) => (m.name === 'docker' ? 0 : m.name === 'native' ? 1 : 2)
  return (view?.machines ?? []).filter(can).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * A machine whose platform is not ready here (needs.ts machineBlock): it
 * cannot run now whatever its record says. `startable`: only the Docker
 * Engine is down on macOS, which the machine's Start launches first, so it
 * stays pickable (Create starts it).
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
 * The default machine: docker when it can run the kind and nothing blocks it
 * here (`blocks`: tileBlocks), else native, else the first that can run,
 * else the first.
 */
export function defaultMachine(machines: readonly Machine[], blocks: ReadonlyMap<string, TileBlock> = new Map()): string {
  const docker = machines.find((m) => m.name === 'docker')
  if (docker && !blocks.has(docker.name)) return docker.name
  return machines.find((m) => m.name === 'native')?.name ?? machines.find((m) => !blocks.has(m.name))?.name ?? machines[0]?.name ?? 'native'
}

/** Whether `name` can be picked: not blocked here, or only waiting on the Docker Engine its Start launches. */
export const pickable = (name: string, blocks: ReadonlyMap<string, TileBlock>): boolean => blocks.get(name)?.startable ?? true

/**
 * The machine a PostgreSQL Store's sessions run on by default: the host's
 * answer (this install's saved choice, else docker when it can, else native).
 */
export function pgMachine(store: Pick<StoreRow, 'runsOn'>): string {
  return store.runsOn ?? 'native'
}

/** Where a project runs: its SQLite Store's machine, or the machine its PostgreSQL Store runs on. */
export function runsOn(store: Pick<StoreRow, 'kind' | 'machine' | 'runsOn'> | undefined): string[] {
  if (!store) return []
  return [store.kind === 'postgresql' ? pgMachine(store) : store.machine ?? 'native']
}

/** The machine a project's readiness follows (§8). */
export function primaryMachine(store: Pick<StoreRow, 'kind' | 'machine' | 'runsOn'> | undefined): string | null {
  if (!store) return null
  return store.kind === 'postgresql' ? pgMachine(store) : store.machine ?? 'native'
}

/** A free Store name from a project name: itself, else `-2`, `-3`, … */
export function freeStoreName(base: string, view: Pick<StorageView, 'stores'> | undefined): string {
  const taken = new Set((view?.stores ?? []).map((s) => s.name))
  const root = base || 'projects'
  if (!taken.has(root)) return root
  for (let n = 2; ; n++) if (!taken.has(`${root}-${n}`.slice(0, 63))) return `${root}-${n}`.slice(0, 63)
}

/** A password field's request body: a reference is sent as one, anything else as a typed password. */
export const PG_REFERENCE = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/.+)$/
export function passwordBody(value: string): { password: string } | { passwordValue: string } {
  return PG_REFERENCE.test(value.trim()) ? { password: value.trim() } : { passwordValue: value }
}

/** What a Create asks for. */
export interface CreatePlan {
  name: string
  kind: StoreKind
  /** An existing Store, or null for a new one. */
  store: StoreRow | null
  newStore?: { name: string, url?: string, password?: string }
  /** One machine: where a SQLite Store's file goes, or where a PostgreSQL Store's sessions run. */
  machines: string[]
  /** An absolute folder the project starts from; empty when absent. */
  source?: string
}

export type StepId = 'check' | 'store' | 'connect' | 'start-store' | 'init' | `start:${string}` | `place:${string}` | `runs-on:${string}` | 'open'
export interface Step { id: StepId, machine?: string }

/**
 * The steps a Create runs, in order (§3). `view` gives machine states, so a
 * running machine is not started again. A PostgreSQL Store is on no machine:
 * a new one is connected with the machine its sessions run on, an existing
 * one only has that choice changed (`runs-on:<m>`) when another is picked.
 * Nothing is attached; the machine is started last, because a session starts
 * none and the one Create opens runs there.
 */
export function createSteps(plan: CreatePlan, view: Pick<StorageView, 'machines'> | undefined): Step[] {
  const state = (name: string) => view?.machines.find((m) => m.name === name)
  const start = (name: string): Step[] => (isRunning(state(name)) ? [] : [{ id: `start:${name}`, machine: name }])
  // the folder is checked before anything is made, so a wrong one leaves no empty Store
  const steps: Step[] = plan.source ? [{ id: 'check' }] : []
  if (plan.kind === 'sqlite') {
    const target = plan.machines[0] ?? 'native'
    const at = plan.store?.machine ?? 'native'
    if (!plan.store) steps.push({ id: 'store' })
    else if (at !== 'native' && !isRunning(state(at))) steps.push({ id: 'start-store', machine: at })
    steps.push({ id: 'init' })
    if (target !== at) steps.push(...start(target), { id: `place:${target}`, machine: target })
  } else {
    const target = plan.machines[0]
    if (!plan.store) steps.push({ id: 'connect', ...(target ? { machine: target } : {}) })
    steps.push({ id: 'init' })
    if (plan.store && target && target !== pgMachine(plan.store)) steps.push({ id: `runs-on:${target}`, machine: target })
    if (target) steps.push(...start(target))
  }
  steps.push({ id: 'open' })
  return steps
}
