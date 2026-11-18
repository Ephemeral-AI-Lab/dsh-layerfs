/**
 * The Doctor page's host half (`/api/doctor/…`): the home's tree from records,
 * the 2.0 doctors, and the fixes a finding names. Shapes: `src/shared/doctor.ts`.
 *
 *   GET  /api/doctor/tree            `layerfs home get --with tree --detail`: records only, no doctor runs
 *   GET  /api/doctor/results         the last outcome per doctor call, and what runs now (a page that opens or reconnects)
 *   POST /api/doctor/runs            { runs: [{ id, kind, name?, full? }], group? } -> 202 { runs, already }
 *   POST /api/doctor/runs/:id/stop   ends that call's CLI process (a doctor writes nothing) -> { stopped }
 *   POST /api/doctor/fixes           { id, kind, name, fix } -> 202 { fix }
 *
 * Events: `doctor-run` (a DoctorRun: queued, running with one `progress` per
 * finished thing, then done with its `report`, failed with its `failure`, or
 * stopped) and `doctor-fix` (a DoctorFixRun: each step, then done, refused or lost).
 *
 * One attempt per call. Nothing here runs a doctor or a fix again: a call that
 * fails, times out or loses its reply is reported as could not check
 * (`timeout`, `busy` or `lost`), and the next try is a new call the person
 * starts. A fix is only ever a line this host itself produced (a finding's
 * `fix`, a broken record's `fix`, or Start for a machine the records say is
 * stopped), parsed by `parseFix` onto the allow list; it is never a shell line.
 *
 * Results are kept per target, one for each thing a doctor was run on (not in
 * the targeted panel's list of 40 jobs, `doctor-jobs.ts`), so a Check all on a
 * large home loses none; each also reaches the page in its `doctor-run` event.
 * They live in memory: after a host restart the page reads Not checked, which
 * is what opening the page means anyway.
 */
import { execute, type CliSpec, type Lane } from '../layerfs/cli.ts'
import {
  CHILD_LISTS, DOCTOR_KINDS, doctorArgv, hasTreeRead, isReport, parseFix, startLine, thingKey, thingOf,
  type CouldNotReason, type DoctorFixRun, type DoctorProgress, type DoctorReport, type DoctorResults, type DoctorRun, type Fix, type FixStep, type RunFailure, type ThingKind, type TreeAnswer, type TreeNode,
} from '../../shared/doctor.ts'
import { Answer, refuse, wire, type RouteHost } from './util.ts'

type Run = (spec: CliSpec, argv: readonly string[], options: {
  read?: boolean, timeout?: number, lane?: Lane, signal?: AbortSignal, storeRead?: string
  onSpawn?: (child: { pid?: number }) => void, onProgress?: (progress: unknown) => void
}) => Promise<any>

/** How a fix's calls reach LayerFS (the router passes the Machines and Projects groups' own, so their events and hooks run). */
export interface FixActions {
  machineStop(name: string): Promise<unknown>
  machineStart(name: string): Promise<unknown>
  projectDelete(project: string): Promise<unknown>
  backupCreate(store: string, bucket: string): Promise<unknown>
}

export interface DoctorOptions {
  /** The most a doctor call may take before it is stopped and reported `timeout`; a Full check has none. */
  budgetMs?: number
  /** How long a tree answer serves every reader. */
  treeKeepMs?: number
  actions?: Partial<FixActions>
}

/** Shallow doctors, side by side (Check all starts one per Store and Sandbox); the rest wait their turn. */
const CHECK_LANE: Lane = { name: 'doctor', limit: 4 }
/** Full checks run as long as their data is large: their own lane, so they never hold a Check back. */
const FULL_LANE: Lane = { name: 'doctor-full', limit: 2 }
const TREE_TIMEOUT_MS = 30_000
const MOST_RUNS = 2000
const MOST_KEPT = 5000

const invalid = (message: string) => refuse(400, 'InvalidInput', message)
const ID = /^[A-Za-z0-9_-]{8,64}$/
const HANDLE = /^[A-Za-z0-9][\w.:/-]{0,255}$/
const targetKey = (run: Pick<DoctorRun, 'kind' | 'name' | 'full'>) => `${thingKey(run.kind, run.name ?? '')}${run.full ? ':full' : ''}`

/** Why a doctor call gave no report (R3's three reasons; the refusal code rides along for the tip). */
export function failureOf(error: any): RunFailure {
  const code = typeof error?.code === 'string' ? error.code : null
  const reason: CouldNotReason = code === 'Timeout' || (error?.transport === 'transport-unknown' && error?.detail?.timeout) ? 'timeout'
    : code === 'Busy' && (error?.transport ?? 'refusal') === 'refusal' ? 'busy'
      : 'lost'
  return { reason, code }
}

interface Live { run: DoctorRun, stop: AbortController, stopped: boolean }

export class DoctorChecks {
  private readonly live = new Map<string, Live>()
  private readonly last = new Map<string, DoctorRun>()
  private readonly fixes = new Map<string, DoctorFixRun>()
  /** The fix lines this host produced, by the thing they are about: from reports, and from the last tree. */
  private readonly offeredByReport = new Map<string, Set<string>>()
  private offeredByTree = new Map<string, Set<string>>()
  private tree: { at: number, value?: TreeAnswer, pending?: Promise<TreeAnswer> } = { at: 0 }
  private readonly budgetMs: number
  private readonly treeKeepMs: number
  private readonly actions: FixActions

  constructor(private readonly host: RouteHost, private readonly run: Run = execute as never, options: DoctorOptions = {}) {
    this.budgetMs = options.budgetMs ?? 300_000
    this.treeKeepMs = options.treeKeepMs ?? 2000
    const lfs = () => this.host.lfs()
    this.actions = {
      machineStop: async (name) => { const result = await lfs().machine.stop(name); await this.host.machinesStopped?.([name]); return result },
      machineStart: (name) => lfs().machine.start(name),
      projectDelete: (project) => lfs().project.delete(project),
      // cs20: switch when the backup package merges (today's backup.create)
      backupCreate: (store, bucket) => lfs().backup.create(store, bucket),
      ...options.actions,
    }
  }

  /** Whether a doctor call or a fix runs now (a preset build waits for it). */
  busy(): boolean { return this.live.size > 0 || [...this.fixes.values()].some((f) => f.state === 'running') }

  /** Ends every running doctor call (host shutdown). */
  close(): void { for (const l of this.live.values()) { l.stopped = true; l.stop.abort() } }

  async route(method: string, parts: string[], body: any): Promise<unknown> {
    const [what, id, verb, ...rest] = parts
    if (rest.length) return undefined
    if (what === 'tree' && !id && method === 'GET') return this.readTree()
    if (what === 'results' && !id && method === 'GET') return this.results()
    if (what === 'runs' && !id && method === 'POST') return this.start(body ?? {})
    if (what === 'runs' && id && verb === 'stop' && method === 'POST') return this.stop(id)
    if (what === 'fixes' && !id && method === 'POST') return this.fix(body ?? {})
    return undefined
  }

  // ---------------------------------------------------------------- the tree

  /** The home's records as one tree: no doctor, no probe. One read at a time; its answer serves every reader for `treeKeepMs`. */
  readTree(): Promise<TreeAnswer> {
    if (this.tree.value && Date.now() - this.tree.at < this.treeKeepMs) return Promise.resolve(this.tree.value)
    if (this.tree.pending) return this.tree.pending
    const pending = (async () => {
      let answer: any
      // asked of the call table first: a runtime before 2.0 is never sent a call it does not have
      const hasTree = hasTreeRead((await this.host.discover()).calls)
      if (!hasTree) throw refuse(501, 'Unsupported', 'This LayerFS runtime has no `home get --with tree`; the Doctor page needs a 2.0 runtime.')
      try {
        answer = await this.run(this.host.lfs().spec, ['home', 'get', '--with', 'tree', '--detail'], { read: true, timeout: TREE_TIMEOUT_MS })
      } catch (error: any) {
        if (error?.transport === 'usage-incompatible') throw refuse(501, 'Unsupported', 'This LayerFS runtime has no `home get --with tree`; the Doctor page needs a 2.0 runtime.')
        throw error
      }
      const tree = answer?.tree
      if (!tree || typeof tree !== 'object') throw refuse(501, 'Unsupported', 'This LayerFS runtime answered `home get --with tree` without a tree; the Doctor page needs a 2.0 runtime.')
      const value: TreeAnswer = {
        at: Date.now(),
        home: {
          home: String(answer.home ?? this.host.home), state: String(answer.state ?? 'unknown'),
          version: typeof answer.version === 'string' ? answer.version : null,
          generation: typeof answer.generation === 'number' ? answer.generation : null,
          reason: typeof answer.reason === 'string' ? answer.reason : null,
          fix: typeof answer.fix === 'string' ? answer.fix : null,
        },
        tree: { machines: listOf(tree.machines), stores: listOf(tree.stores), buckets: listOf(tree.buckets) },
      }
      this.offeredByTree = offersOfTree(value)
      this.tree = { at: value.at, value }
      return value
    })()
    this.tree.pending = pending
    void pending.catch(() => {}).finally(() => { if (this.tree.pending === pending) delete this.tree.pending })
    return pending
  }

  results(): DoctorResults {
    return { last: [...this.last.values()], running: [...this.live.values()].map((l) => l.run), fixes: [...this.fixes.values()] }
  }

  // ---------------------------------------------------------------- doctor calls

  /** Starts each named doctor call once. A call whose target is already being checked is not started twice: its id comes back in `already`. */
  start(input: any): Answer {
    const list: any[] = Array.isArray(input?.runs) ? input.runs : []
    if (!list.length || list.length > MOST_RUNS) throw invalid(`Name 1 to ${MOST_RUNS} doctor calls.`)
    const group = input.group == null ? null : String(input.group)
    if (group !== null && !ID.test(group)) throw invalid('The group must be an id.')
    const seen = new Set<string>()
    const wanted = list.map((r) => {
      const kind = r?.kind as ThingKind
      const name = r?.name == null ? null : String(r.name)
      const full = r?.full === true
      if (typeof r?.id !== 'string' || !ID.test(r.id) || seen.has(r.id) || this.live.has(r.id)) throw invalid('Each doctor call needs its own id.')
      seen.add(r.id)
      if (!DOCTOR_KINDS.includes(kind)) throw invalid(`${String(r?.kind)} has no doctor.`)
      if (name !== null && !HANDLE.test(name)) throw invalid('That is not a handle.')
      const argv = doctorArgv({ kind, name: name ?? undefined, full })
      if (!argv) throw invalid(kind === 'home' ? 'The home doctor takes no name.' : full ? `${kind} has no Full check.` : `Name the ${kind} to check.`)
      return { id: r.id as string, kind, name, full, argv }
    })
    const busy = new Set([...this.live.values()].map((l) => targetKey(l.run)))
    const runs: DoctorRun[] = []
    const already: string[] = []
    for (const w of wanted) {
      const run: DoctorRun = { id: w.id, kind: w.kind, name: w.name, full: w.full, group, state: 'queued', started: Date.now(), ended: null }
      if (busy.has(targetKey(run))) { already.push(w.id); continue }
      busy.add(targetKey(run))
      const live: Live = { run, stop: new AbortController(), stopped: false }
      this.live.set(run.id, live)
      runs.push({ ...run })
      this.emit(run)
      void this.drive(live, w.argv)
    }
    return new Answer(202, { runs, already })
  }

  private emit(run: DoctorRun, more: Partial<DoctorRun> = {}): void {
    this.host.emit('doctor-run', wire({ type: 'doctor-run', ...run, ...more }))
  }

  private async drive(live: Live, argv: string[]): Promise<void> {
    const { run } = live
    // a Store's doctor opens the Store: one process per Store on this host, as every other Store call
    const storeRead = run.kind === 'store' ? run.name! : run.kind === 'project' ? run.name!.split('/')[0] : undefined
    let report: DoctorReport | undefined
    let failure: RunFailure | undefined
    try {
      const answer = await this.run(this.host.lfs().spec, argv, {
        read: true,
        lane: run.full ? FULL_LANE : CHECK_LANE,
        signal: live.stop.signal,
        ...(run.full ? {} : { timeout: this.budgetMs }),
        ...(storeRead ? { storeRead } : {}),
        onSpawn: () => { if (run.state === 'queued') { run.state = 'running'; this.emit(run) } },
        onProgress: (progress: any) => {
          // one event per finished thing; a frame that names no thing is not passed on
          if (!thingOf(progress?.node)) return
          const event: DoctorProgress = { phase: String(progress.phase ?? ''), done: Number(progress.done) || 0, total: Number(progress.total) || 0, node: progress.node }
          this.emit(run, { state: 'running', progress: event })
        },
      })
      if (isReport(answer)) report = answer
      else failure = { reason: 'lost', code: 'InvalidReport' }
    } catch (error: any) {
      if (!live.stopped) failure = failureOf(error)
    }
    run.ended = Date.now()
    run.state = live.stopped ? 'stopped' : report ? 'done' : 'failed'
    this.live.delete(run.id)
    if (run.state !== 'stopped') {
      // a stopped call reported nothing: the target keeps its last outcome
      const kept: DoctorRun = { ...run, ...(report ? { report } : {}), ...(failure ? { failure } : {}) }
      this.last.delete(targetKey(run))
      this.last.set(targetKey(run), kept)
      if (this.last.size > MOST_KEPT) this.last.delete(this.last.keys().next().value!)
      if (report) this.offer(report)
    }
    this.emit(run, { ...(report ? { report } : {}), ...(failure ? { failure } : {}) })
  }

  /** Remember the fix lines a report names, by the thing each is about; a thing the report covers starts clean. */
  private offer(report: DoctorReport): void {
    const walk = (node: any) => {
      const thing = thingOf(node)
      if (thing) this.offeredByReport.delete(thingKey(thing.kind, thing.name))
      for (const list of Object.keys(CHILD_LISTS)) for (const child of listOf(node?.[list])) walk(child)
    }
    walk(report.tree)
    for (const finding of report.findings) {
      const thing = thingOf(finding)
      if (!thing || typeof finding.fix !== 'string' || !finding.fix) continue
      const key = thingKey(thing.kind, thing.name)
      if (!this.offeredByReport.has(key)) this.offeredByReport.set(key, new Set())
      this.offeredByReport.get(key)!.add(finding.fix)
    }
  }

  stop(id: string): { stopped: boolean } {
    const live = this.live.get(id)
    if (!live) throw refuse(404, 'NotFound', 'That doctor call is not running.')
    live.stopped = true
    live.stop.abort()
    return { stopped: true }
  }

  // ---------------------------------------------------------------- fixes

  /** Runs a fix line this host produced for the named thing, when it is on the allow list. One attempt per step. */
  fix(input: any): Answer {
    const kind = input?.kind as ThingKind
    const name = String(input?.name ?? '')
    const line = typeof input?.fix === 'string' ? input.fix : ''
    if (typeof input?.id !== 'string' || !ID.test(input.id)) throw invalid('The fix needs an id.')
    if (!DOCTOR_KINDS.includes(kind) || kind === 'home' || !HANDLE.test(name)) throw invalid('Name the thing to fix.')
    const key = thingKey(kind, name)
    if (!this.offeredByReport.get(key)?.has(line) && !this.offeredByTree.get(key)?.has(line)) {
      throw refuse(409, 'Conflict', 'No report of this host offers that fix for it now. Check it again.')
    }
    const parsed = parseFix(line)
    if (!parsed || !aboutThing(parsed, kind, name)) throw invalid('That fix is not one this page runs; copy the command instead.')
    if (this.fixes.get(key)?.state === 'running') throw refuse(409, 'Busy', 'A fix is already running on it.')
    const fix: DoctorFixRun = { id: input.id, kind, name, fix: parsed.kind, step: 0, steps: parsed.steps.map((s) => s.call), state: 'running' }
    this.fixes.set(key, fix)
    this.emitFix(fix)
    void this.repair(key, fix, parsed)
    return new Answer(202, { fix: { ...fix } })
  }

  private emitFix(fix: DoctorFixRun): void { this.host.emit('doctor-fix', wire({ type: 'doctor-fix', ...fix })) }

  private step(step: FixStep): Promise<unknown> {
    const [first, second] = step.args
    if (step.family === 'machine' && step.call === 'stop') return this.actions.machineStop(first!)
    if (step.family === 'machine' && step.call === 'start') return this.actions.machineStart(first!)
    if (step.family === 'project' && step.call === 'delete') return this.actions.projectDelete(first!)
    if (step.family === 'backup' && step.call === 'create') return this.actions.backupCreate(first!, second!)
    return Promise.reject(invalid('That call is not on the allow list.'))
  }

  private async repair(key: string, fix: DoctorFixRun, parsed: Fix): Promise<void> {
    try {
      for (let i = 0; i < parsed.steps.length; i++) {
        if (i > 0) { fix.step = i; this.emitFix(fix) }
        await this.step(parsed.steps[i]!)
      }
      fix.state = 'done'
      // what the fix changed is read again; its line is no longer on offer
      this.offeredByReport.delete(key)
    } catch (error: any) {
      // a refusal is certain: nothing changed in that step. Anything else may have worked: never run again from here.
      const refused = typeof error?.code === 'string' && (error.transport ?? 'refusal') === 'refusal'
      fix.state = refused ? 'refused' : 'lost'
      if (refused) fix.refusal = { code: error.code, message: String(error.message ?? error.code) }
    } finally {
      this.tree = { at: 0 }
      this.emitFix(fix)
      if (this.fixes.get(key) === fix) this.fixes.delete(key)
    }
  }
}

const listOf = (value: unknown): any[] => (Array.isArray(value) ? value : [])

/** A fix must act on the thing it was offered for: the machine it restarts, the project it deletes, the Store it backs up. */
function aboutThing(fix: Fix, kind: ThingKind, name: string): boolean {
  const [step] = fix.steps
  if (fix.kind === 'restart' || fix.kind === 'start') return kind === 'machine' && fix.steps.every((s) => s.args[0] === name)
  if (fix.kind === 'delete') return kind === 'project' && step!.args[0] === name
  return kind === 'store' && step!.args[0] === name
}

/** The fix lines the records themselves offer: a broken thing's `fix`, and Start for a machine stopped on purpose. */
function offersOfTree(answer: TreeAnswer): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (kind: ThingKind, name: unknown, line: unknown) => {
    if (typeof name !== 'string' || typeof line !== 'string' || !line) return
    const key = thingKey(kind, name)
    if (!out.has(key)) out.set(key, new Set())
    out.get(key)!.add(line)
  }
  const store = (s: TreeNode) => add('store', s.store, s.fix)
  for (const m of listOf(answer.tree.machines) as TreeNode[]) {
    add('machine', m.machine, m.fix)
    if (m.state === 'stopped' && typeof m.machine === 'string') add('machine', m.machine, startLine(m.machine))
    for (const s of listOf(m.stores) as TreeNode[]) store(s)
    for (const b of listOf(m.sandboxes) as TreeNode[]) add('sandbox', b.sandbox, b.fix)
  }
  for (const s of listOf(answer.tree.stores) as TreeNode[]) store(s)
  return out
}
