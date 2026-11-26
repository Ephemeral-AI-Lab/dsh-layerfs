/**
 * The Doctor page's model: the home's things as rows (from `home get --with
 * tree`), what the doctors last said about each, the calls that run now, and
 * what every row shows and offers. Pure: no React, no host call, no words —
 * the page maps the codes here to its locale.
 *
 * A thing is filed under `kind:name` (`machine:dev`, `project:shop/api`,
 * `workspace:tests:agent`). A row reads one of five states: ok, run
 * (Checking), nc (Not checked), notice, problem; `why` says which kind of
 * Not checked it is.
 */
import {
  CHILD_LISTS, DOCTOR_KINDS, FULL_KINDS, fixCommands, forcedRestart, parseFix, startLine, thingKey, thingOf,
  type CouldNotReason, type DoctorCall, type DoctorFinding, type DoctorFixRun, type DoctorNode, type DoctorReport, type DoctorResults, type DoctorRun,
  type Fix, type NotChecked, type Outcome, type Status, type ThingKind, type TreeAnswer, type TreeNode,
} from '../../shared/doctor.ts'

// ---------------------------------------------------------------- the world

export interface Thing {
  key: string
  kind: ThingKind
  /** Its handle: what a call takes (a project is `store/project`, a Workspace `sandbox:workspace`). */
  name: string
  /** Its own name, shown under its parent. */
  label: string
  parent: string | null
  /** The machine it lives on (its key), for what lives on one. */
  machine: string | null
  platform?: string | null
  cpus?: number | null
  memoryBytes?: number | null
  engine?: string | null
  provider?: string | null
  /** A Sandbox's project and image; a Workspace's Branch. */
  project?: string | null
  image?: string | null
  branch?: string | null
  /** A project's Store, a Workspace's Sandbox. */
  store?: string
  sandbox?: string
  version?: string | null
  /** From records: ready, busy, stopped, blocked, broken, unknown (null: not said, read as ready). */
  state: string | null
  op: { name: string, phase: string | null } | null
  blockedBy: { key: string, name: string, reason: string } | null
  reason: string | null
  fix: string | null
  /** A Sandbox whose Workspaces the home does not record: they appear when it is checked. */
  notListed?: boolean
}

export interface World {
  things: Thing[]
  by: Record<string, Thing>
  kids: Record<string, string[]>
  homeKey: string
  at: number
}

const blockOf = (value: unknown): Thing['blockedBy'] => {
  const thing = thingOf(value)
  if (!thing) return null
  return { key: thingKey(thing.kind, thing.name), name: thing.name, reason: String((value as { reason?: unknown }).reason ?? '') }
}

/** The rows of a tree answer, parents before what is on them; `discovered` adds the Workspaces a Sandbox's doctor named. */
export function buildWorld(answer: TreeAnswer, discovered: Readonly<Record<string, readonly string[]>> = {}): World {
  const things: Thing[] = []
  const by: Record<string, Thing> = {}
  const kids: Record<string, string[]> = {}
  const add = (t: Omit<Thing, 'key' | 'state' | 'op' | 'blockedBy' | 'reason' | 'fix'> & { node?: TreeNode | undefined }): Thing => {
    const { node, ...rest } = t
    const thing: Thing = {
      ...rest, key: thingKey(t.kind, t.name),
      state: typeof node?.state === 'string' ? node.state : null,
      op: node?.op ? { name: String(node.op.name), phase: node.op.phase ?? null } : null,
      blockedBy: blockOf(node?.blocked_by),
      reason: typeof node?.reason === 'string' ? node.reason : null,
      fix: typeof node?.fix === 'string' && node.fix ? node.fix : null,
    }
    if (by[thing.key]) return by[thing.key]!
    things.push(thing); by[thing.key] = thing
    if (thing.parent) (kids[thing.parent] ??= []).push(thing.key)
    return thing
  }
  const home = add({ kind: 'home', name: answer.home.home, label: answer.home.home, parent: null, machine: null, version: answer.home.version, node: { state: answer.home.state, reason: answer.home.reason, fix: answer.home.fix } })
  const store = (s: TreeNode, parent: Thing, machine: Thing | null) => {
    if (typeof s.store !== 'string') return
    const sx = add({ kind: 'store', name: s.store, label: s.store, parent: parent.key, machine: machine?.key ?? null, engine: s.engine ?? (machine ? 'sqlite' : 'postgresql'), node: s })
    for (const p of s.projects ?? []) {
      if (typeof p !== 'string' || !p) continue
      const name = p.includes('/') ? p : `${s.store}/${p}`
      add({ kind: 'project', name, label: name.slice(name.indexOf('/') + 1), parent: sx.key, machine: machine?.key ?? null, store: s.store })
    }
  }
  const workspace = (w: unknown, sandbox: Thing) => {
    const name = typeof w === 'string' ? w : typeof (w as { workspace?: unknown })?.workspace === 'string' ? (w as { workspace: string }).workspace : ''
    if (!name) return
    const branch = typeof w === 'object' && w && typeof (w as { branch?: unknown }).branch === 'string' ? (w as { branch: string }).branch : null
    add({ kind: 'workspace', name, label: name.startsWith(`${sandbox.name}:`) ? name.slice(sandbox.name.length + 1) : name, parent: sandbox.key, machine: sandbox.machine, sandbox: sandbox.name, branch })
  }
  for (const m of answer.tree.machines ?? []) {
    if (typeof m.machine !== 'string') continue
    const mx = add({ kind: 'machine', name: m.machine, label: m.machine, parent: home.key, machine: null, platform: m.platform ?? null, cpus: typeof m.cpus === 'number' ? m.cpus : null, memoryBytes: typeof m.memory_bytes === 'number' ? m.memory_bytes : null, node: m })
    for (const s of m.stores ?? []) store(s, mx, mx)
    for (const b of m.sandboxes ?? []) {
      if (typeof b.sandbox !== 'string') continue
      const bx = add({ kind: 'sandbox', name: b.sandbox, label: b.sandbox, parent: mx.key, machine: mx.key, project: b.project ?? null, image: b.image ?? null, notListed: b.workspaces_not_listed === true || b.workspaces == null, node: b })
      for (const w of b.workspaces ?? []) workspace(w, bx)
      for (const w of discovered[bx.key] ?? []) workspace(w, bx)
    }
  }
  for (const s of answer.tree.stores ?? []) store(s, home, null)
  for (const b of answer.tree.buckets ?? []) {
    if (typeof b.bucket === 'string') add({ kind: 'bucket', name: b.bucket, label: b.bucket, parent: home.key, machine: null, provider: b.provider ?? null })
  }
  return { things, by, kids, homeKey: home.key, at: answer.at }
}

export const kidsOf = (world: World, thing: Thing): Thing[] => (world.kids[thing.key] ?? []).map((k) => world.by[k]!)
export function ancestors(world: World, thing: Thing): Thing[] {
  const out: Thing[] = []
  for (let p = thing.parent ? world.by[thing.parent] : undefined; p; p = p.parent ? world.by[p.parent] : undefined) out.push(p)
  return out
}

// ---------------------------------------------------------------- results

/** One check as a mark: passed, failed, notice, or not checked. */
export interface Mark {
  check: string
  from: string | null
  r: 'ok' | 'bad' | 'warn' | 'nc'
  /** LayerFS's sentence for a failed check or a notice. */
  message: string | null
  /** Why it was not checked: a reason code, or the blocker's reason. */
  reason: string | null
}

export interface Result {
  status: Status
  coverage: 'none' | 'shallow' | 'full'
  /** null: a status known without this thing's own doctor (nothing to draw as marks). */
  checks: Mark[] | null
  blockedBy: Thing['blockedBy']
  /** The whole thing could not be checked. */
  reason: CouldNotReason | null
  /** The refusal code of a call that failed, for the tip. */
  code: string | null
  findings: DoctorFinding[]
  at: number
  /** Not checked because the call on this thing (its key) gave no report. */
  parent?: string
}

const MARK: Record<Outcome, Mark['r']> = { pass: 'ok', notice: 'warn', warning: 'bad', error: 'bad', not_checked: 'nc' }
const RANK: Record<string, number> = { error: 0, warning: 1, notice: 2 }
const bySeverity = (a: DoctorFinding, b: DoctorFinding) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3)

function resultOfNode(node: DoctorNode, findings: readonly DoctorFinding[], notChecked: readonly NotChecked[], at: number): Result {
  const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null)
  const whole = notChecked.find((n) => !n.check)
  const why = (n: NotChecked | undefined): string | null => n?.reason ?? (n?.blocked_by ? String(n.blocked_by.reason ?? '') : null)
  const checks: Mark[] = (node.checks ?? []).map((c) => {
    const finding = findings.find((f) => f.check === c.check && same(f.from, c.from))
    return {
      check: c.check, from: c.from ?? null, r: MARK[c.outcome] ?? 'nc',
      message: finding?.message ?? null,
      // its own entry says why; else the whole thing's reason
      reason: c.outcome === 'not_checked' ? (why(notChecked.find((n) => n.check === c.check)) ?? node.reason ?? why(whole)) : null,
    }
  })
  // a check the report names as not checked without listing it on the node still gets its mark
  for (const n of notChecked) {
    if (n.check && !checks.some((c) => c.check === n.check)) checks.push({ check: n.check, from: null, r: 'nc', message: null, reason: why(n) })
  }
  return {
    status: node.status, coverage: node.coverage ?? 'shallow', checks,
    blockedBy: blockOf(node.blocked_by) ?? blockOf(whole?.blocked_by),
    reason: node.reason ?? (node.status === 'not_checked' ? (whole?.reason ?? (!checks.some((c) => c.r !== 'nc') ? notChecked.find((n) => n.reason)?.reason ?? null : null)) : null),
    code: null, findings: [...findings].sort(bySeverity), at,
  }
}

// ---------------------------------------------------------------- state

/** One running doctor call as the page follows it. */
export interface RunInfo {
  id: string
  kind: 'check' | 'full'
  /** The thing the call was started on. */
  target: string
  group: string | null
  started: number
  /** The things it owes an event for, and the ones that have landed. */
  covers: string[]
  landed: Record<string, true>
  /** The host started its CLI process (a `running` event); until then it waits for its turn there (UI pass 3 F12). */
  spawned?: boolean
}

export interface DoctorState {
  tree: TreeAnswer | null
  world: World | null
  discovered: Record<string, string[]>
  results: Record<string, Result>
  /** Findings about a thing from a report whose tree does not hold it (the home doctor's records check). */
  records: Record<string, DoctorFinding[]>
  runs: Record<string, RunInfo>
  /** Check all, while it runs: the things it covers and the ones that have landed. */
  /** Check all while it runs. `open`: the page may still add calls to it, so it is not over when its calls are. */
  all: { id: string, total: Record<string, true>, done: Record<string, true>, open?: boolean } | null
  /** A fix running on a thing: its id and the call word of the step it is at (null while its checks run). */
  fixes: Record<string, { id: string, step: string | null }>
  /** The last fix on a thing was refused: LayerFS's code and sentence. */
  refusals: Record<string, { code: string, message: string }>
  /** Full check coverage: when its data was last read, and how long a stopped one ran. */
  notes: Record<string, { fullAt?: number, stopped?: number }>
}

export const emptyState = (): DoctorState => ({ tree: null, world: null, discovered: {}, results: {}, records: {}, runs: {}, all: null, fixes: {}, refusals: {}, notes: {} })

export const isAllGroup = (group: string | null | undefined): boolean => !!group && group.startsWith('all-')

export function setTree(state: DoctorState, tree: TreeAnswer): DoctorState {
  return { ...state, tree, world: buildWorld(tree, state.discovered) }
}

/** The key a report node or a call names, in this world (any `home` node is this home). */
function keyIn(world: World | null, kind: ThingKind, name: string | null | undefined): string {
  return kind === 'home' && world ? world.homeKey : thingKey(kind, name ?? '')
}

/** What one doctor call covers: the thing, then what is directly on it; a Full check, the thing alone. */
export function covers(world: World, target: string, full: boolean): string[] {
  const thing = world.by[target]
  if (!thing) return [target]
  if (full || FULL_KINDS.includes(thing.kind)) return [target]
  return [target, ...(world.kids[target] ?? [])]
}

/** Follow calls the page just started (before their POST answers, so no event can outrun them). */
export function addRuns(state: DoctorState, runs: readonly Pick<DoctorRun, 'id' | 'kind' | 'name' | 'full' | 'group'>[], now: number): DoctorState {
  if (!state.world) return state
  const next = { ...state.runs }
  let all = state.all
  for (const r of runs) {
    if (next[r.id]) continue
    const target = keyIn(state.world, r.kind, r.name)
    const covered = covers(state.world, target, r.full)
    next[r.id] = { id: r.id, kind: r.full ? 'full' : 'check', target, group: r.group ?? null, started: now, covers: covered, landed: {} }
    if (isAllGroup(r.group)) {
      const total = { ...(all?.id === r.group ? all.total : {}) }
      for (const k of covered) total[k] = true
      all = { id: r.group!, total, done: all?.id === r.group ? all.done : {}, ...(all?.id === r.group && all.open ? { open: true } : {}) }
    }
  }
  return { ...state, runs: next, all }
}

/** Check all begins: it stays open until the page has added every call it will (`closeAll`). */
export const openAll = (state: DoctorState, id: string): DoctorState => (state.world ? { ...state, all: { id, total: {}, done: {}, open: true } } : state)

/** The page adds no more calls to this Check all: it is over when its calls are. */
export function closeAll(state: DoctorState, id: string): DoctorState {
  if (state.all?.id !== id) return state
  const { open: _open, ...all } = state.all
  return settleAll({ ...state, all })
}

/** Stop following calls the host did not start (their target was already being checked). */
export function dropRuns(state: DoctorState, ids: readonly string[]): DoctorState {
  if (!ids.length) return state
  const runs = { ...state.runs }
  for (const id of ids) delete runs[id]
  return settleAll({ ...state, runs })
}

function settleAll(state: DoctorState): DoctorState {
  if (!state.all || state.all.open) return state
  return Object.values(state.runs).some((r) => r.group === state.all!.id) ? state : { ...state, all: null }
}

function land(state: DoctorState, run: RunInfo, keys: readonly string[]): DoctorState {
  const landed = { ...run.landed }
  for (const k of keys) landed[k] = true
  let all = state.all
  if (all && all.id === run.group) {
    const done = { ...all.done }
    for (const k of keys) if (all.total[k]) done[k] = true
    all = { ...all, done }
  }
  return { ...state, runs: { ...state.runs, [run.id]: { ...run, landed } }, all }
}

/** Put a report's nodes on their rows; findings about things outside its tree go to `records`. */
function applyReport(state: DoctorState, run: RunInfo, report: DoctorReport, at: number): DoctorState {
  const world = state.world
  const results = { ...state.results }
  const records = { ...state.records }
  const notes = { ...state.notes }
  const discovered = { ...state.discovered }
  const keyOf = (value: unknown): string | null => { const t = thingOf(value); return t ? keyIn(world, t.kind, t.name) : null }
  const findings = new Map<string, DoctorFinding[]>()
  for (const f of report.findings) { const k = keyOf(f); if (k) findings.set(k, [...(findings.get(k) ?? []), f]) }
  const missed = new Map<string, NotChecked[]>()
  for (const n of report.not_checked) { const k = keyOf(n); if (k) missed.set(k, [...(missed.get(k) ?? []), n]) }
  const seen = new Set<string>()
  const walk = (node: DoctorNode, parent: string | null) => {
    const thing = thingOf(node)
    if (!thing) return
    const key = keyIn(world, thing.kind, thing.name)
    seen.add(key)
    results[key] = resultOfNode(node, findings.get(key) ?? [], missed.get(key) ?? [], at)
    delete records[key]
    if (node.coverage === 'full' && node.status !== 'not_checked') notes[key] = { fullAt: at }
    if (thing.kind === 'workspace' && parent && world && !world.by[key] && !(discovered[parent] ?? []).includes(thing.name)) discovered[parent] = [...(discovered[parent] ?? []), thing.name]
    for (const list of Object.keys(CHILD_LISTS)) for (const child of (Array.isArray(node[list]) ? node[list] as DoctorNode[] : [])) walk(child, key)
  }
  walk(report.tree, null)
  // the home doctor's records check may name a thing at any depth: shown on that thing's row
  const root = thingOf(report.tree)
  if (root?.kind === 'home') for (const k of Object.keys(records)) delete records[k]
  for (const [key, list] of findings) if (!seen.has(key)) records[key] = [...list].sort(bySeverity)
  // a thing the call covered that its report does not hold was not attempted: back to what the records say
  for (const k of run.covers) if (!seen.has(k) && !run.landed[k]) delete results[k]
  const changed = Object.keys(discovered).some((k) => discovered[k] !== state.discovered[k])
  return { ...state, results, records, notes, discovered, world: changed && state.tree ? buildWorld(state.tree, discovered) : world }
}

/** A doctor call that gave no report: its thing could not be checked; what it covered waits on it. */
function applyFailure(state: DoctorState, run: RunInfo, reason: CouldNotReason, code: string | null, at: number): DoctorState {
  const results = { ...state.results }
  const before = results[run.target]
  results[run.target] = {
    status: 'not_checked', coverage: 'none', checks: before?.checks ? before.checks.map((c) => ({ ...c, r: 'nc' as const, message: null, reason })) : null,
    blockedBy: null, reason, code, findings: [], at,
  }
  for (const k of run.covers) {
    if (k !== run.target && !run.landed[k]) results[k] = { status: 'not_checked', coverage: 'none', checks: null, blockedBy: null, reason: null, code: null, findings: [], at, parent: run.target }
  }
  return { ...state, results }
}

/** One `doctor-run` event (or a kept outcome): a run this page did not start is followed from its first event. */
export function onRun(state: DoctorState, event: DoctorRun, now: number): DoctorState {
  if (!state.world) return state
  let next = state.runs[event.id] ? state : addRuns(state, [event], event.started || now)
  const run = next.runs[event.id]
  if (!run) return state
  if (event.state === 'queued') return next
  if (event.state === 'running') {
    if (!run.spawned) next = { ...next, runs: { ...next.runs, [run.id]: { ...run, spawned: true } } }
    const thing = thingOf(event.progress?.node)
    if (!thing) return next
    const key = keyIn(next.world, thing.kind, thing.name)
    const results = { ...next.results, [key]: resultOfNode(event.progress!.node, next.results[key]?.findings ?? [], [], now) }
    return land({ ...next, results }, run, [key])
  }
  const at = event.ended ?? now
  if (event.state === 'done' && event.report) next = applyReport(next, run, event.report, Date.parse(event.report.observed_at) || at)
  else if (event.state === 'failed') next = applyFailure(next, run, event.failure?.reason ?? 'lost', event.failure?.code ?? null, at)
  else if (event.state === 'stopped' && run.kind === 'full') next = { ...next, notes: { ...next.notes, [run.target]: { ...next.notes[run.target], stopped: Math.max(0, at - run.started) } } }
  const runs = { ...next.runs }
  delete runs[event.id]
  // the whole call has landed: Check all counts it before the group is settled
  next = land({ ...next, runs: { ...runs, [run.id]: run } }, run, run.covers)
  return settleAll({ ...next, runs })
}

/** What the host holds, for a page that opens or reconnects: last outcomes oldest first, then what runs now. */
export function seed(state: DoctorState, held: DoctorResults, now: number): DoctorState {
  let next = state
  for (const run of [...held.last].sort((a, b) => (a.ended ?? 0) - (b.ended ?? 0))) {
    // never over a call this page still follows
    if (!Object.values(next.runs).some((r) => r.target === keyIn(next.world, run.kind, run.name))) next = onRun(next, run, now)
  }
  const live = new Set(held.running.map((r) => r.id))
  // a call this page followed that the host no longer runs ended while the page was away: its outcome is in `last`
  next = dropRuns(next, Object.keys(next.runs).filter((id) => !live.has(id)))
  // a held run keeps whether its process started (`running` marks it spawned)
  for (const run of held.running) next = onRun(next, { ...run, state: run.state === 'running' ? 'running' : 'queued' }, now)
  let fixes = next.fixes
  for (const f of held.fixes) if (f.state === 'running') fixes = { ...fixes, [thingKey(f.kind, f.name)]: { id: f.id, step: f.steps[f.step] ?? null } }
  return { ...next, fixes }
}

/** A fix the page starts (before its POST answers) or continues into its checks (`step` null). */
export function fixStep(state: DoctorState, key: string, id: string, step: string | null): DoctorState {
  const refusals = { ...state.refusals }
  delete refusals[key]
  return { ...state, fixes: { ...state.fixes, [key]: { id, step } }, refusals }
}

export function fixEnd(state: DoctorState, key: string, refusal?: { code: string, message: string } | null): DoctorState {
  const fixes = { ...state.fixes }
  delete fixes[key]
  return { ...state, fixes, refusals: refusal ? { ...state.refusals, [key]: refusal } : state.refusals }
}

/** A fix changed a thing: what the doctors last said about it no longer holds (its row reads from records until it is checked again). */
export function forget(state: DoctorState, key: string): DoctorState {
  const results = { ...state.results }
  const records = { ...state.records }
  delete results[key]; delete records[key]
  return { ...state, results, records }
}

/** One `doctor-fix` event while a fix runs: the step it is at. Its end is the page's to act on (`fixEnd`, then the checks). */
export function onFix(state: DoctorState, event: DoctorFixRun): DoctorState {
  if (event.state !== 'running') return state
  const key = thingKey(event.kind, event.name)
  const mine = state.fixes[key]
  if (mine && mine.id !== event.id) return state
  return { ...state, fixes: { ...state.fixes, [key]: { id: event.id, step: event.steps[event.step] ?? null } } }
}

// ---------------------------------------------------------------- what a row reads

export type RowState = 'ok' | 'run' | 'nc' | 'notice' | 'problem'
/**
 * Which Not checked: never checked; `stopped-self` a machine stopped on
 * purpose that no doctor has looked at yet (once one has, it reads what its
 * checks say, OK when they pass, with Stopped beside it); `stopped` its
 * machine is stopped; `waiting` on a root cause;
 * `could` could not be checked; `parent` the call on its parent gave no
 * report; `partial` some of its checks were made, the rest wait on something
 * else; `working` an operation holds it; `unknown` its state is not known.
 */
export type Why = 'never' | 'stopped-self' | 'stopped' | 'waiting' | 'could' | 'parent' | 'partial' | 'working' | 'unknown'

export interface Seen {
  st: RowState
  why: Why | null
  /** A machine the records say is stopped (on purpose): said beside whatever its checks read, with Start. */
  stopped: boolean
  /** The root cause, the stopped machine, or the parent that could not be checked. */
  by: Thing | null
  /** Its name when the records name a thing this page does not list. */
  byName: string | null
  reason: CouldNotReason | null
  code: string | null
  r: Result | null
  findings: DoctorFinding[]
  /** What the finding's own word is made from: a check id (`check:…`) or a reason code (`reason:…`). */
  word: string | null
  message: string | null
}

/**
 * The root cause a Not checked row links to: what it waits on, or the
 * stopped machine it is on (U10 add-on 8: named like a waiting row's cause,
 * never itself). Null when it waits on nothing the page lists.
 */
export const causeOf = (o: Pick<Seen, 'st' | 'why' | 'by'>, key: string): Thing | null =>
  (o.st === 'nc' && (o.why === 'waiting' || o.why === 'stopped') && o.by && o.by.key !== key ? o.by : null)

/** The running call that still owes an event for a thing. */
export const busyOn = (state: DoctorState, key: string): RunInfo | undefined => Object.values(state.runs).find((r) => r.covers.includes(key) && !r.landed[key])

/** Whether a thing itself is in error (what is on it is then not attempted). */
function inError(state: DoctorState, thing: Thing): boolean {
  const r = state.results[thing.key]
  if (r) return r.status === 'error'
  return thing.state === 'broken' || (state.records[thing.key] ?? []).some((f) => f.severity === 'error')
}

export function stateOf(state: DoctorState, thing: Thing, ignoreBusy = false): Seen {
  const world = state.world!
  const r = state.results[thing.key] ?? null
  const stopped = thing.kind === 'machine' && thing.state === 'stopped'
  const o: Seen = { st: 'nc', why: 'never', stopped, by: null, byName: null, reason: null, code: null, r, findings: [], word: null, message: null }
  if (!ignoreBusy && busyOn(state, thing.key)) { o.st = 'run'; o.why = null; return o }
  // stopped on purpose is not a finding: until a doctor has looked at it, it reads Not checked · Stopped
  if (stopped && !r && !(state.records[thing.key] ?? []).length) { o.why = 'stopped-self'; return o }
  const machine = thing.machine ? world.by[thing.machine] : undefined
  if (machine?.state === 'stopped') { o.why = 'stopped'; o.by = machine; return o }
  const blocker = ancestors(world, thing).find((a) => a.kind !== 'home' && inError(state, a))
  if (blocker) { o.why = 'waiting'; o.by = blocker; return o }
  const block = r ? (r.status === 'not_checked' ? r.blockedBy : null) : thing.state === 'blocked' ? thing.blockedBy : null
  if (block && block.key !== thing.key) {
    const by = world.by[block.key] ?? null
    // a later look at the blocker that found it working outranks the older answer that named it:
    // nothing is waiting on it any more, and this thing reads as never checked until it is checked again
    const later = r && by ? state.results[by.key] : undefined
    if (later && later.at > r!.at && later.status !== 'error' && later.status !== 'not_checked' && by!.state !== 'stopped') { o.r = null; return o }
    o.why = block.reason === 'stopped' ? 'stopped' : 'waiting'
    o.by = by
    o.byName = block.name
    return o
  }
  const records = state.records[thing.key] ?? []
  if (!r && !records.length) {
    if (thing.state === 'broken') { o.st = 'problem'; o.why = null; o.word = thing.reason ? `reason:${thing.reason}` : null; return o }
    if (thing.state === 'busy') o.why = 'working'
    else if (thing.state === 'unknown') o.why = 'unknown'
    return o
  }
  if (r && r.status === 'not_checked' && !records.length && !r.findings.length) {
    if (r.parent) { o.why = 'parent'; o.by = world.by[r.parent] ?? null }
    else if (r.reason) { o.why = 'could'; o.reason = r.reason; o.code = r.code }
    else if (r.checks?.some((c) => c.r !== 'nc')) o.why = 'partial'
    return o
  }
  const findings = [...(r?.findings ?? []), ...records].sort(bySeverity)
  // a status without a finding (a progress event lands before the report): the first check that did not pass names it
  const failed = r?.checks?.find((c) => c.r === 'bad') ?? r?.checks?.find((c) => c.r === 'warn')
  let status: Status = 'ok'
  for (const s of [r && r.status !== 'not_checked' ? r.status : 'ok', findings[0]?.severity ?? 'ok'] as Status[]) if ((RANK[s] ?? 3) < (RANK[status] ?? 3)) status = s
  o.st = status === 'ok' ? 'ok' : status === 'notice' ? 'notice' : 'problem'
  o.why = null
  o.findings = findings
  if (o.st !== 'ok') {
    o.word = findings[0] ? `check:${findings[0].check}` : failed ? `check:${failed.check}` : null
    o.message = findings[0]?.message ?? failed?.message ?? null
  }
  return o
}

// ---------------------------------------------------------------- fixes

export interface RowFix {
  /** The line as LayerFS gave it (what the host is asked to run), and its commands one per line. */
  line: string
  commands: string[]
  /** On the allow list: the page runs it behind a button. Otherwise it is text to copy. */
  fix: Fix | null
  /** The button the row shows. An outdated worker with Sandboxes on it shows Restart worker, off: its line stops by force, which the page never runs. */
  button: Fix['kind'] | null
}

/** The fix of a thing's own trouble: the worst finding's (or the broken record's) line; Start for a machine stopped on purpose. */
export function fixOf(thing: Thing, seen: Seen): RowFix | null {
  let line: string | null = null
  if (seen.st === 'problem' || seen.st === 'notice') line = seen.findings.find((f) => typeof f.fix === 'string' && f.fix)?.fix ?? (seen.r ? null : thing.fix)
  // a stopped machine with nothing wrong of its own: Start
  if (!line && seen.stopped && (seen.st === 'ok' || seen.st === 'nc')) line = startLine(thing.name)
  if (!line) return null
  const fix = parseFix(line)
  // a button only for a fix about this very thing: the machine it starts, the project it deletes, the Store it backs up
  const mine = fix && ((fix.kind === 'restart' || fix.kind === 'start') ? thing.kind === 'machine' && fix.steps.every((s) => s.args[0] === thing.name)
    : fix.kind === 'delete' ? thing.kind === 'project' && fix.steps[0]!.args[0] === thing.name
      : thing.kind === 'store' && fix.steps[0]!.args[0] === thing.name)
  const forced = thing.kind === 'machine' && forcedRestart(line) === thing.name
  return { line, commands: fixCommands(line), fix: mine ? fix : null, button: mine ? fix!.kind : forced ? 'restart' : null }
}

/** The Sandboxes on a machine, from records. */
export const sandboxesOn = (world: World, machine: Thing): Thing[] => kidsOf(world, machine).filter((k) => k.kind === 'sandbox')

// ---------------------------------------------------------------- buttons

/**
 * Whether a thing's row offers this fix line now, pressable (UI pass 3 F6): the
 * thing is still in the tree, its fix is that line and is about it, no fix,
 * check or Check all runs on it. A press from a stale render passes none of this.
 */
export function fixOffered(state: DoctorState, key: string, line: string): boolean {
  const thing = state.world?.by[key]
  if (!thing || state.fixes[key]) return false
  const v = viewOf(state, thing, 0, false)
  if (v.blocked || !v.fix?.fix || v.fix.line !== line) return false
  if (Object.values(state.runs).some((r) => r.target === key || r.covers.includes(key))) return false
  return offWhy(state, thing, 'fix', v.fix) === null
}

/** How long a run may wait for its turn at the host before its row says it waits (and offers Stop). */
export const WAIT_SHOWN_MS = 2000

/**
 * A row's call that the host has not started yet, after {@link WAIT_SHOWN_MS}
 * (UI pass 3 F12): the row must not read Checking with no call in flight; it
 * says it waits for its turn and offers Stop.
 */
export const waitingRun = (state: DoctorState, target: string, now: number): RunInfo | undefined =>
  Object.values(state.runs).find((r) => r.target === target && !isAllGroup(r.group) && !r.spawned && now - r.started >= WAIT_SHOWN_MS)

export const running = (state: DoctorState, kind: RunInfo['kind'], target?: string): RunInfo | undefined =>
  Object.values(state.runs).find((r) => r.kind === kind && !isAllGroup(r.group) && (target === undefined || r.target === target))

/** Why a row's button cannot be pressed now, or null. `sandboxes`: Sandboxes are on the machine of an outdated worker (R2), with their count from records (0: not recorded here, but the fix line stops by force). */
export type Off = { why: 'all' } | { why: 'fix' } | { why: 'busy' } | { why: 'sandboxes', n: number }

export function offWhy(state: DoctorState, thing: Thing, button: 'check' | 'full' | 'fix', fix?: RowFix | null): Off | null {
  if (state.all) return { why: 'all' }
  if (button === 'check' && (state.fixes[thing.key] || (thing.machine && state.fixes[thing.machine]))) return { why: 'fix' }
  if (busyOn(state, thing.key)) return { why: 'busy' }
  if (button === 'fix') {
    if (fix?.button === 'restart') { const n = sandboxesOn(state.world!, thing).length; if (n || !fix.fix) return { why: 'sandboxes', n } }
  }
  return null
}

/** Why Check all cannot be pressed now: a fix, a Full check or a row's check runs (nothing is discarded silently). */
export function allOffWhy(state: DoctorState): { why: 'fix' | 'full' | 'check', thing: Thing | null } | null {
  const world = state.world
  if (!world) return null
  const fix = Object.keys(state.fixes)[0]
  if (fix) return { why: 'fix', thing: world.by[fix] ?? null }
  const full = running(state, 'full')
  if (full) return { why: 'full', thing: world.by[full.target] ?? null }
  const one = running(state, 'check')
  if (one) return { why: 'check', thing: world.by[one.target] ?? null }
  return null
}

// ---------------------------------------------------------------- plans

const callOf = (thing: Thing, full = false): DoctorCall => ({ kind: thing.kind, ...(thing.kind === 'home' ? {} : { name: thing.name }), ...(full ? { full: true } : {}) })
export { callOf }

/**
 * What Check all runs: the home doctor, then one store doctor per Store and one
 * sandbox doctor per Sandbox, side by side. Left out: everything under a
 * stopped or failed machine, and all project data. A machine counts as failed
 * by what the page last heard, so when the home doctor of this very Check all
 * finds it working again, `allMore` gives what was left out because of it.
 */
export function allPlan(state: DoctorState): { home: Thing, stores: Thing[], sandboxes: Thing[] } | null {
  const world = state.world
  if (!world) return null
  const reach = (x: Thing) => { const m = x.machine ? world.by[x.machine] : undefined; return !(m && (m.state === 'stopped' || inError(state, m))) }
  return {
    home: world.by[world.homeKey]!,
    stores: world.things.filter((x) => x.kind === 'store' && reach(x)),
    sandboxes: world.things.filter((x) => x.kind === 'sandbox' && reach(x)),
  }
}

/** What a Check all that asked `asked` left out and can reach now. */
export function allMore(state: DoctorState, asked: readonly DoctorCall[]): DoctorCall[] {
  const plan = allPlan(state)
  if (!plan) return []
  const had = new Set(asked.map((c) => `${c.kind}:${c.name ?? ''}`))
  return [...plan.stores, ...plan.sandboxes].map((x) => callOf(x)).filter((c) => !had.has(`${c.kind}:${c.name ?? ''}`))
}

export const planCalls = (plan: NonNullable<ReturnType<typeof allPlan>>): DoctorCall[] => [plan.home, ...plan.stores, ...plan.sandboxes].map((x) => callOf(x))

/**
 * What a fix is followed by, in waves: the doctor of the thing it was on (of
 * its parent when the fix removed it), then the doctor of each thing on that.
 */
export function afterFix(world: World, key: string, fallbackParent: string | null): Thing[][] {
  const thing = world.by[key] ?? (fallbackParent ? world.by[fallbackParent] : undefined)
  if (!thing || !DOCTOR_KINDS.includes(thing.kind)) return []
  const on = kidsOf(world, thing).filter((k) => DOCTOR_KINDS.includes(k.kind) && !FULL_KINDS.includes(k.kind))
  return on.length ? [[thing], on] : [[thing]]
}

// ---------------------------------------------------------------- rows

export interface RowView {
  thing: Thing
  depth: number
  seen: Seen
  /** The state without the running call: what the buttons and the fix are decided on. */
  base: Seen
  kids: Thing[]
  fix: RowFix | null
  /** The row's own word beside its signal: a finding's check or reason code, `stopped`, `could`, or none. */
  word: string | null
  marks: Mark[] | null
  /** Waiting on something else: no buttons. */
  blocked: boolean
  folder: boolean
  /** Trouble inside a closed folder. */
  inside: { bad: number, warn: number }
  canCheck: boolean
  canFull: boolean
  /** Trouble of its own: its detail shows even while it is an open folder. */
  ownTrouble: boolean
}

function within(state: DoctorState, thing: Thing): { bad: number, warn: number } {
  const n = { bad: 0, warn: 0 }
  for (const kid of kidsOf(state.world!, thing)) {
    const o = stateOf(state, kid)
    if (o.st === 'problem') n.bad += 1
    if (o.st === 'notice') n.warn += 1
    const d = within(state, kid)
    n.bad += d.bad; n.warn += d.warn
  }
  return n
}

export function viewOf(state: DoctorState, thing: Thing, depth: number, open: boolean): RowView {
  const world = state.world!
  const seen = stateOf(state, thing)
  const base = stateOf(state, thing, true)
  const kids = thing.kind === 'home' ? [] : kidsOf(world, thing)
  const blocked = base.why === 'stopped' || base.why === 'waiting'
  const word = seen.st === 'notice' || seen.st === 'problem' ? seen.word
    : seen.st === 'nc' && seen.why === 'could' ? 'could'
      : seen.stopped && (seen.st === 'ok' || seen.st === 'nc') ? 'stopped' : null
  const marks = seen.st !== 'run' && seen.r?.checks?.length && (seen.st !== 'nc' || seen.why === 'could' || seen.why === 'stopped-self' || seen.why === 'partial') ? seen.r.checks : null
  return {
    thing, depth, seen, base, kids, word, marks, blocked,
    fix: blocked ? null : fixOf(thing, base),
    folder: kids.length > 0,
    inside: kids.length && !open ? within(state, thing) : { bad: 0, warn: 0 },
    canCheck: DOCTOR_KINDS.includes(thing.kind) && !blocked,
    canFull: FULL_KINDS.includes(thing.kind) && !blocked,
    ownTrouble: seen.st === 'notice' || seen.st === 'problem' || (seen.st === 'nc' && seen.why === 'could') || (seen.stopped && seen.st !== 'run') || !!state.refusals[thing.key],
  }
}

// ---------------------------------------------------------------- head and tabs

export interface Head {
  counts: Record<RowState, number>
  stopped: number
  total: number
  /** The headline: Check all's progress, the problems, nothing checked yet, the notices, no problems so far, or all clear. */
  headline: { kind: 'checking', done: number, total: number } | { kind: 'problems' | 'notices', n: number } | { kind: 'notChecked' | 'noProblems' | 'allClear' }
  state: RowState
}

export function headOf(state: DoctorState): Head {
  const world = state.world!
  const counts: Record<RowState, number> = { ok: 0, notice: 0, problem: 0, run: 0, nc: 0 }
  // a machine stopped on purpose reads Stopped on its row whether or not a doctor has looked (Row's stoppedNeutral):
  // the head counts it as stopped, and one not yet checked still keeps the headline at Not checked
  let stopped = 0
  let stoppedNc = 0
  for (const thing of world.things) {
    const o = stateOf(state, thing)
    if (o.stopped && (o.st === 'ok' || o.st === 'nc')) { stopped += 1; if (o.st === 'nc') stoppedNc += 1 }
    else counts[o.st] += 1
  }
  const total = world.things.length
  const unchecked = counts.nc + stoppedNc
  const headline: Head['headline'] = state.all ? { kind: 'checking', done: Object.keys(state.all.done).length, total: Object.keys(state.all.total).length }
    : counts.problem ? { kind: 'problems', n: counts.problem }
      : unchecked === total ? { kind: 'notChecked' }
        : counts.notice ? { kind: 'notices', n: counts.notice }
          : unchecked || counts.run ? { kind: 'noProblems' } : { kind: 'allClear' }
  const st: RowState = state.all || counts.run ? 'run' : counts.problem ? 'problem' : unchecked === total ? 'nc' : counts.notice ? 'notice' : unchecked ? 'nc' : 'ok'
  return { counts, stopped, total, headline, state: st }
}

export const TABS = [['machines', 'machine'], ['stores', 'store'], ['projects', 'project'], ['sandboxes', 'sandbox'], ['backups', 'bucket']] as const
export type TabKey = typeof TABS[number][0]

export interface TabView {
  key: TabKey
  kind: ThingKind
  count: number
  /** Trouble that starts in this tab only (a Workspace's counts with Sandboxes). `mark` is the worst of it: a stopped machine marks its tab while it reads Not checked. */
  bad: number
  running: number
  warn: number
  stopped: number
  could: number
  mark: 'bad' | 'run' | 'warn' | 'nc' | null
}

export function tabsOf(state: DoctorState): TabView[] {
  const world = state.world!
  return TABS.map(([key, kind]) => {
    const mine = world.things.filter((x) => x.kind === kind || (key === 'sandboxes' && x.kind === 'workspace')).map((x) => stateOf(state, x))
    const bad = mine.filter((o) => o.st === 'problem').length
    const run = mine.filter((o) => o.st === 'run').length
    const warn = mine.filter((o) => o.st === 'notice').length
    const stopped = mine.filter((o) => o.stopped && (o.st === 'nc' || o.st === 'ok')).length
    const could = mine.filter((o) => o.st === 'nc' && o.why === 'could').length
    return {
      key, kind, count: world.things.filter((x) => x.kind === kind).length, bad, running: run, warn, stopped, could,
      mark: bad ? 'bad' : run ? 'run' : warn ? 'warn' : could || mine.some((o) => o.st === 'nc' && o.why === 'stopped-self') ? 'nc' : null,
    }
  })
}

/** The tab a thing's row is on (a Workspace's is its Sandbox's). */
export const tabOf = (thing: Thing): TabKey => (TABS.find(([, kind]) => kind === (thing.kind === 'workspace' ? 'sandbox' : thing.kind))?.[0] ?? 'machines')

/** A check id as a short word when the locale has none for it: its last part, spaced (`sandbox.daemon_ready` -> `Daemon ready`). */
export function humanCheck(check: string): string {
  const tail = check.split('.').slice(1).join(' ') || check
  const words = tail.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
