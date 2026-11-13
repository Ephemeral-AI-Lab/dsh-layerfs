/**
 * The Setup card's rules (docs/specs/layerfs-workspaces.md §1, §3): which
 * machines can run a Store kind, the default machine, where a project runs,
 * and the steps a Create takes. Pure; read from a `/api/storage` view.
 */
import type { StorageView, StoreRow } from '../../storage/types.ts'

export type StoreKind = 'sqlite' | 'postgresql'
export type Machine = StorageView['machines'][number]

const RUNNING = new Set(['running', 'ready'])
export const isRunning = (m: Pick<Machine, 'name' | 'state'> | undefined) => !!m && (m.name === 'native' || RUNNING.has(m.state ?? ''))

/** Machines that can run a project of this Store kind: docker first, then native, then the rest by name. */
export function machinesFor(view: Pick<StorageView, 'machines'> | undefined, kind: StoreKind): Machine[] {
  const can = (m: Machine) => m.state !== 'unsupported'
    && (kind === 'sqlite' ? m.supports?.sqlite !== false : m.supports?.postgresql_sandbox !== false)
  const rank = (m: Machine) => (m.name === 'docker' ? 0 : m.name === 'native' ? 1 : 2)
  return (view?.machines ?? []).filter(can).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** The default machine: docker when it can run the kind, else native, else the first. */
export function defaultMachine(machines: readonly Machine[]): string {
  return machines.find((m) => m.name === 'docker')?.name ?? machines.find((m) => m.name === 'native')?.name ?? machines[0]?.name ?? 'native'
}

/** A PostgreSQL Store's attached machines (native when the CLI predates attachments). */
export function attachedMachines(store: Pick<StoreRow, 'attachments'>): string[] {
  return store.attachments ? store.attachments.map((a) => a.machine) : ['native']
}

/** The machine the host runs a PostgreSQL project's sessions on (`pgMachineOf`). */
export function pgMachine(store: Pick<StoreRow, 'attachments'>): string | null {
  if (!store.attachments) return 'native'
  const names = store.attachments.map((a) => a.machine)
  if (names.includes('native')) return 'native'
  return store.attachments.find((a) => a.checked)?.machine ?? names[0] ?? null
}

/** Where a project runs: its SQLite Store's machine, or its PostgreSQL Store's attached machines. */
export function runsOn(store: Pick<StoreRow, 'kind' | 'machine' | 'attachments'> | undefined): string[] {
  if (!store) return []
  return store.kind === 'postgresql' ? attachedMachines(store) : [store.machine ?? 'native']
}

/** The machine a project's readiness follows (§8). */
export function primaryMachine(store: Pick<StoreRow, 'kind' | 'machine' | 'attachments'> | undefined): string | null {
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
  /** SQLite: one machine. PostgreSQL: every ticked machine. */
  machines: string[]
  source?: string
}

export type StepId = 'store' | 'connect' | 'start-store' | 'init' | `start:${string}` | `place:${string}` | `attach:${string}` | 'detach:native' | 'open'
export interface Step { id: StepId, machine?: string }

/**
 * The steps a Create runs, in order (§3). `view` gives machine states, so a
 * running machine is not started again.
 */
export function createSteps(plan: CreatePlan, view: Pick<StorageView, 'machines'> | undefined): Step[] {
  const state = (name: string) => view?.machines.find((m) => m.name === name)
  const start = (name: string): Step[] => (isRunning(state(name)) ? [] : [{ id: `start:${name}`, machine: name }])
  const steps: Step[] = []
  if (plan.kind === 'sqlite') {
    const target = plan.machines[0] ?? 'native'
    const at = plan.store?.machine ?? 'native'
    if (!plan.store) steps.push({ id: 'store' })
    else if (at !== 'native' && !isRunning(state(at))) steps.push({ id: 'start-store', machine: at })
    steps.push({ id: 'init' })
    if (target !== at) steps.push(...start(target), { id: `place:${target}`, machine: target })
  } else {
    if (!plan.store) steps.push({ id: 'connect' })
    steps.push({ id: 'init' })
    const attached = plan.store ? attachedMachines(plan.store) : ['native']
    for (const m of plan.machines) {
      if (attached.includes(m)) continue
      steps.push(...start(m), { id: `attach:${m}`, machine: m })
    }
    if (!plan.store && !plan.machines.includes('native')) steps.push({ id: 'detach:native', machine: 'native' })
  }
  steps.push({ id: 'open' })
  return steps
}
