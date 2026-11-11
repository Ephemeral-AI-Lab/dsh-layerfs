/**
 * The Machines page's owner: the machines view (`GET /api/machines`), polled
 * while the page is shown; the machine startups (create and start progress,
 * kept across board and detail navigation); and the pinned LayerFS runtime.
 * The page reads these through the slot inject `hooks` (bound by the DSH
 * renderer as `useMachines`, `useStartups`, `useRuntime`) and acts through
 * the face's callbacks. One controller per registration; nothing here is a
 * module-level singleton.
 *
 * Power is manual: nothing here starts or stops a machine on its own, and no
 * read starts one. A Start, Stop, Create or Remove re-reads the view after
 * success and after refusal (a refusal can follow a real side effect).
 */
import { HostError, enc, q, type HostEvent, type LayerfsApi } from '../api.ts'
import {
  mergeStage, startupFailure,
  type MachineImages, type MachineStartup, type MachinesView, type NewMachine, type ProjectSummary, type RuntimeStatus, type SandboxInfo,
} from './model.ts'

/** A snapshot source the DSH slot renderer binds to a `use<Name>` hook. */
export interface Source<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

class Cell<T> implements Source<T> {
  private readonly listeners = new Set<() => void>()
  constructor(private value: T) {}
  getSnapshot = (): T => this.value
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(next: T): void {
    if (Object.is(next, this.value)) return
    this.value = next
    for (const l of [...this.listeners]) l()
  }
}

/** A read's state: the last observation stays while a refresh runs or fails. */
export interface ReadState<T> {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly data: T | null
  readonly error: unknown
  readonly observedAt: number | null
}

const idle = <T>(): ReadState<T> => ({ status: 'idle', data: null, error: null, observedAt: null })

/** A machine action, as the page asks it. */
export type MachineAction =
  | { kind: 'create', input: NewMachine }
  | { kind: 'remove', name: string }
  | { kind: 'start', name: string, platform: string }
  | { kind: 'stop', name: string }
  | { kind: 'update', name: string, changes: { image?: string, docker?: string, wsl?: string } }

/** What the page receives through its slot `inject`. */
export interface MachinesFace {
  hooks: {
    machines: Source<ReadState<MachinesView>>
    startups: Source<Readonly<Record<string, MachineStartup>>>
    runtime: Source<ReadState<RuntimeStatus>>
    connected: Source<boolean>
  }
  /** The page is shown: read now and poll every 5 s while the window is visible. Returns the release. */
  activate: () => () => void
  reload: () => void
  reloadRuntime: () => void
  act: (action: MachineAction) => Promise<void>
  inspectMachine: (name: string) => Promise<{ state?: string, observedAt?: number }>
  machineImages: (name: string) => Promise<MachineImages>
  projects: () => Promise<ProjectSummary[]>
  readSandbox: (name: string) => Promise<SandboxInfo>
  createSandbox: (project: string, input: { name: string, machine: string, image?: string | { archive: string, digest?: string } }) => Promise<unknown>
  closeSandbox: (name: string, force: boolean) => Promise<string[]>
  saveRuntime: (pin: { cli: string | null, daemon: string | null, bundle?: string | null }) => Promise<RuntimeStatus>
  clearStartup: (name: string) => void
  /** Open another dsh-layerfs page (Storage) by its panel id. */
  openPanel: (id: string) => void
}

const POLL_MS = 5000

export class MachinesController {
  readonly machines = new Cell<ReadState<MachinesView>>(idle())
  readonly startups = new Cell<Readonly<Record<string, MachineStartup>>>({})
  readonly runtime = new Cell<ReadState<RuntimeStatus>>(idle())
  readonly connected: Cell<boolean>
  private active = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private reading: Promise<void> | null = null
  private again = false
  private readonly off: (() => void)[] = []
  private seq = 0

  /**
   * @param api - the dsh-layerfs host API.
   * @param shown - whether the Machines panel is the page shown now (polls run only then).
   */
  constructor(private readonly api: LayerfsApi, private readonly shown: () => boolean = () => true) {
    this.connected = new Cell(api.connected())
    this.off.push(api.onEvent('connection', (e) => {
      const up = !!e.data?.connected
      this.connected.set(up)
      if (up && this.active) { this.reload(); this.reloadRuntime() }
    }))
    this.off.push(api.onEvent('runtime-changed', () => { this.reloadRuntime(); if (this.active) this.reload() }))
    this.off.push(api.onEvent('machine-progress', (e) => this.progress(e)))
  }

  /** The face handed to the page; callbacks are stable for the controller's life. */
  face(): MachinesFace {
    const api = this.api
    return {
      hooks: { machines: this.machines, startups: this.startups, runtime: this.runtime, connected: this.connected },
      activate: () => this.activate(),
      reload: () => this.reload(),
      reloadRuntime: () => this.reloadRuntime(),
      act: (action) => this.act(action),
      inspectMachine: (name) => api.call('GET', `/api/machines/${enc(name)}/inspect`),
      machineImages: (name) => api.call('GET', `/api/machines/${enc(name)}/images`),
      projects: () => api.call('GET', '/api/projects'),
      readSandbox: (name) => api.call('GET', `/api/sandboxes/${enc(name)}`),
      createSandbox: async (project, input) => {
        try { return await api.call('POST', `/api/projects/${enc(project)}/sandboxes`, input) } finally { this.reload() }
      },
      closeSandbox: async (name, force) => {
        try {
          const done = await api.call<{ unknown?: string[] }>('DELETE', `/api/sandboxes/${enc(name)}${q({ force: force ? '1' : undefined })}`)
          return done?.unknown ?? []
        } finally { this.reload() }
      },
      saveRuntime: async (pin) => {
        const status = await api.op<RuntimeStatus>('runtime.save', pin)
        this.runtime.set({ status: 'ready', data: status, error: null, observedAt: Date.now() })
        this.reload()
        return status
      },
      clearStartup: (name) => this.clearStartup(name),
      openPanel: (id) => api.openPanel(id),
    }
  }

  private activate(): () => void {
    this.active++
    if (this.active === 1) {
      this.reload()
      this.reloadRuntime()
      this.timer = setInterval(() => {
        if ((typeof document === 'undefined' || document.visibilityState === 'visible') && this.shown()) this.reload()
      }, POLL_MS)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      if (this.active === 0 && this.timer) { clearInterval(this.timer); this.timer = undefined }
    }
  }

  /** One read at a time; a reload asked during a read runs once after it. */
  reload(): void {
    if (this.reading) { this.again = true; return }
    const current = this.machines.getSnapshot()
    if (current.status === 'idle') this.machines.set({ ...current, status: 'loading' })
    this.reading = (async () => {
      try {
        const data = await this.api.call<MachinesView>('GET', '/api/machines')
        this.machines.set({ status: 'ready', data, error: null, observedAt: Date.now() })
      } catch (error) {
        const prev = this.machines.getSnapshot()
        this.machines.set({ status: prev.data ? 'ready' : 'error', data: prev.data, error, observedAt: prev.observedAt })
      } finally {
        this.reading = null
        if (this.again) { this.again = false; this.reload() }
      }
    })()
  }

  reloadRuntime(): void {
    const prev = this.runtime.getSnapshot()
    if (prev.status === 'idle') this.runtime.set({ ...prev, status: 'loading' })
    this.api.op<RuntimeStatus>('runtime.status').then(
      (data) => this.runtime.set({ status: 'ready', data, error: null, observedAt: Date.now() }),
      (error) => { const p = this.runtime.getSnapshot(); this.runtime.set({ status: p.data ? 'ready' : 'error', data: p.data, error, observedAt: p.observedAt }) },
    )
  }

  private async act(action: MachineAction): Promise<void> {
    const api = this.api
    try {
      switch (action.kind) {
        case 'create':
          await this.startup({ kind: 'create', name: action.input.name, platform: action.input.platform }, () => api.call('POST', '/api/machines', action.input))
          break
        case 'start':
          await this.startup({ kind: 'start', name: action.name, platform: action.platform }, () => api.call('POST', `/api/machines/${enc(action.name)}/start`))
          break
        case 'stop':
          await api.call('POST', `/api/machines/${enc(action.name)}/stop`)
          this.clearStartup(action.name)
          break
        case 'remove':
          await api.call('DELETE', `/api/machines/${enc(action.name)}`)
          this.clearStartup(action.name)
          break
        case 'update':
          await api.call('POST', `/api/machines/${enc(action.name)}/update`, action.changes)
          break
      }
    } finally {
      this.reload()
    }
  }

  private publish(s: MachineStartup): void {
    this.startups.set({ ...this.startups.getSnapshot(), [s.name]: s })
  }

  private update(name: string, id: string, change: (s: MachineStartup) => MachineStartup): void {
    const current = this.startups.getSnapshot()[name]
    if (current?.id === id) this.publish(change(current))
  }

  /** A later Stop/Remove clears the retained result, but never hides active work. */
  private clearStartup(name: string): void {
    const all = this.startups.getSnapshot()
    if (!all[name] || all[name].status === 'running') return
    const { [name]: _gone, ...rest } = all
    this.startups.set(rest)
  }

  private async startup(input: Pick<MachineStartup, 'kind' | 'name' | 'platform'>, request: () => Promise<unknown>): Promise<void> {
    if (this.startups.getSnapshot()[input.name]?.status === 'running') {
      throw new HostError('Busy', 'This machine already has a startup operation in progress.', 409)
    }
    const id = `startup-${Date.now()}-${++this.seq}`
    this.publish({ ...input, id, startedAt: Date.now(), status: 'running', stages: [] })
    try {
      await request()
      this.update(input.name, id, (s) => ({ ...s, status: 'success', endedAt: Date.now() }))
    } catch (error) {
      this.update(input.name, id, (s) => ({ ...s, status: startupFailure(error), endedAt: Date.now(), error }))
      throw error
    }
  }

  /**
   * A `machine-progress` host event: `{ name, kind?, progress: { stage, state, elapsed_ms } }`
   * (or the progress fields at the top level). It updates the running startup of that machine.
   */
  private progress(event: HostEvent): void {
    const data = event.data ?? {}
    const name = typeof data.name === 'string' ? data.name : typeof data.machine === 'string' ? data.machine : null
    if (!name) return
    const current = this.startups.getSnapshot()[name]
    if (!current || current.status !== 'running') return
    if (typeof data.kind === 'string' && data.kind !== current.kind) return
    const progress = data.progress && typeof data.progress === 'object' ? data.progress : data
    const at = typeof data.at === 'number' ? data.at : Date.now()
    const stages = mergeStage(current.stages, progress, at)
    if (stages !== current.stages) this.publish({ ...current, stages })
  }

  dispose(): void {
    for (const off of this.off) off()
    if (this.timer) clearInterval(this.timer)
  }
}
