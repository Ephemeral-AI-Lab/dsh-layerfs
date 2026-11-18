// The Doctor page's STAND-IN world: a home with four machines, nine Stores,
// fourteen projects, seven Sandboxes and three buckets (the world of the
// Doctor page mock, core/docs/issues/call-surface-2-0/doctor-page/index.html in
// LayerFS), and what the 2.0 calls answer about it in each scenario.
//
// Every answer is built in the long form of the frozen call surface: the key
// sets, check ids, messages and fix lines come from the spec's own long
// examples (doctor-examples.json, copied from calls.json), so a fixture cannot
// drift from the spec. The freeze's exit review (REVIEW-FIXES.md items 5, 7, 13,
// 14, 15) is applied: one closed check list per kind, run wherever that kind is
// checked (`project.data` only by a Full check); "Backup behind" is the Store's
// `store.backups` notice; an outdated worker's fix stops by force when Sandboxes
// are on the machine; tree nodes carry only what records hold, with a Sandbox's
// Workspaces as `{ workspace, branch }`.
//
// Pure: `treeAnswer`, `doctorAnswer` and `fixAnswer` take the scenario and a
// small mutable `state` (what fixes changed, which one-time failures were
// used) and return what the CLI prints. doctor-cli.mjs is the process around them.
import { readFileSync } from 'node:fs'

export const EXAMPLES = JSON.parse(readFileSync(new URL('./doctor-examples.json', import.meta.url), 'utf8'))

const GB = 1024 ** 3
const ws = (sandbox, branch) => ({ workspace: `${sandbox}:${branch}`, branch })
const MACHINES = [
  { machine: 'native', platform: 'native', cpus: null, memory_bytes: null, stores: ['2026-08-16', 'demo-studio', 'qv2-store', 'sim-website-c69'],
    sandboxes: [{ sandbox: 'tests', project: 'demo-studio/website', workspaces: [ws('tests', 'agent'), ws('tests', 'main')] }, { sandbox: 'metrics', project: 'analytics/events', workspaces: [ws('metrics', 'main')] }] },
  { machine: 'demo-build', platform: 'lima', cpus: 4, memory_bytes: 8 * GB, stores: ['demo-build-cache'],
    sandboxes: [{ sandbox: 'build-1', project: 'demo-build-cache/compiler', workspaces: [ws('build-1', 'main')] }, { sandbox: 'build-2', project: 'demo-build-cache/sdk', workspaces: [] }] },
  { machine: 'docker', platform: 'docker', cpus: 4, memory_bytes: 8 * GB, stores: ['sim-website-0ce'], sandboxes: [] },
  { machine: 'dev', platform: 'lima', cpus: 4, memory_bytes: 8 * GB, stores: ['shop'],
    sandboxes: [{ sandbox: 'sdk-1', project: 'shop/api', workspaces: [ws('sdk-1', 'agent')] }, { sandbox: 'exp-1', project: 'demo-experiments/abc', workspaces: [ws('exp-1', 'agent')] }, { sandbox: 'funnels', project: 'analytics/funnels', workspaces: [ws('funnels', 'main')] }] },
]
const IMAGE = 'ubuntu:24.04'
const PG_STORES = ['demo-experiments', 'analytics']
const PROJECTS = {
  '2026-08-16': ['2026-08-16'], 'demo-studio': ['website', 'design'], 'qv2-store': ['qv2-strata', 'qv2-probe'], 'sim-website-c69': ['website-c69'],
  'demo-build-cache': ['compiler', 'sdk'], 'sim-website-0ce': ['website-0ce'], shop: ['api', 'web'], 'demo-experiments': ['abc'], analytics: ['events', 'funnels'],
}
const BUCKETS = [{ bucket: 'r2-main', provider: 'r2' }, { bucket: 'minio-local', provider: 'minio' }, { bucket: 'r2-old', provider: 'r2' }]
export const HOME = '/Users/me/.layerfs'

/** The scenarios of the mock's strip, by id. `fail` names one-time failures: `timeout` (LayerFS's own budget ran out: a report with `reason`), `busy` (refused Busy), `lost` (the process ends without a result), `hang` (it never answers: the host's budget ends it). */
export const SCENARIOS = {
  healthy: {},
  stopped: { stopped: ['docker'] },
  outdated0: { outdated: ['demo-build'], noSandboxes: ['demo-build'] },
  outdated2: { outdated: ['demo-build'] },
  timeout: { fail: { 'store:qv2-store': 'timeout', 'sandbox:sdk-1': 'busy', 'bucket:minio-local': 'lost' } },
  refused: { stopped: ['docker'], refuse: true },
  slowfull: { slowFull: true },
  // notices: qv2-store/qv2-probe is on record but not in its Store; shop's backup in r2-old is behind
  mixed: { stopped: ['docker'], outdated: ['demo-build'], lost: ['exp-1'], notices: true },
}

/** A fresh mutable state for a scenario (doctor-cli.mjs keeps it in state.json). */
export function freshState(id) {
  const sc = SCENARIOS[id]
  if (!sc) throw new Error(`no Doctor scenario ${id}`)
  return {
    scenario: id, stopped: [...(sc.stopped ?? [])], outdated: [...(sc.outdated ?? [])], lost: [...(sc.lost ?? [])],
    fail: { ...(sc.fail ?? {}) }, refuse: sc.refuse === true, deleted: [], backedUp: [],
  }
}

const sc = (state) => SCENARIOS[state.scenario]
const machines = (state) => MACHINES.map((m) => ({ ...m, sandboxes: (sc(state).noSandboxes ?? []).includes(m.machine) ? [] : m.sandboxes }))
const projectsOf = (state, store) => (PROJECTS[store] ?? []).map((p) => `${store}/${p}`).filter((p) => !state.deleted.includes(p))
/** What a machine is blocked by, for what lives on it: `{ machine, reason }` or null. */
const blockOf = (state, machine) => (state.stopped.includes(machine) ? { machine, reason: 'stopped' } : state.outdated.includes(machine) ? { machine, reason: 'outdated' } : null)

// ---------------------------------------------------------------- home get --with tree --detail

/** `layerfs home get --with tree --detail`: the long form of calls.json `home.get`, its `tree` from records only. */
export function treeAnswer(state) {
  const long = EXAMPLES.calls['home.get'].long
  const storeNode = (store, machine) => {
    // records know a stopped machine; an outdated worker is only found by a doctor
    const block = machine && state.stopped.includes(machine) ? { machine, reason: 'stopped' } : null
    return { store, engine: machine ? 'sqlite' : 'postgresql', ...(machine ? {} : { connections: [] }), state: block ? 'blocked' : 'ready', op: null, blocked_by: block, reason: null, fix: null, projects: projectsOf(state, store).map((p) => p.slice(p.indexOf('/') + 1)) }
  }
  return {
    ...long, home: HOME,
    tree: {
      machines: machines(state).map((m) => {
        const stopped = state.stopped.includes(m.machine)
        return {
          machine: m.machine, platform: m.platform, cpus: m.cpus, memory_bytes: m.memory_bytes, state: stopped ? 'stopped' : 'ready', op: null, reason: null, fix: null,
          stores: m.stores.map((s) => storeNode(s, m.machine)),
          sandboxes: m.sandboxes.map((b) => ({
            sandbox: b.sandbox, project: b.project, image: IMAGE, state: stopped ? 'blocked' : 'ready', op: null, blocked_by: stopped ? { machine: m.machine, reason: 'stopped' } : null, reason: null, fix: null,
            // the home records Workspaces only on native; elsewhere the machine's worker keeps them (C10)
            workspaces: m.machine === 'native' ? b.workspaces : null, workspaces_not_listed: m.machine !== 'native' && !stopped,
          })),
        }
      }),
      stores: PG_STORES.map((s) => storeNode(s, null)),
      buckets: BUCKETS.map((b) => ({ ...b })),
    },
  }
}

// ---------------------------------------------------------------- the doctors

const pass = (check, from = null) => ({ check, outcome: 'pass', from })
const node = (kind, name, checks, more = {}) => {
  const worst = ['error', 'warning', 'not_checked', 'notice'].find((o) => checks.some((c) => c.outcome === o))
  return { [kind]: name, status: worst ?? 'ok', coverage: 'shallow', checks, blocked_by: null, reason: null, ...more }
}
const blocked = (kind, name, by) => ({ [kind]: name, status: 'not_checked', coverage: 'none', checks: [], blocked_by: by, reason: null })
/** A thing whose check was tried and gave no verdict (R3): every check not checked, with the reason. */
const could = (kind, name, checks, reason) => ({ [kind]: name, status: 'not_checked', coverage: 'none', checks: checks.map((c) => ({ ...c, outcome: 'not_checked' })), blocked_by: null, reason })

// One closed, ordered check list per kind, run wherever a thing of that kind is checked (its own doctor or a
// parent's shallow check); the ids are the spec examples', plus the review's `store.backups` and `project.data`.
export const CHECKS = {
  home: EXAMPLES.calls['home.doctor'].long.tree.checks.map((c) => c.check),
  machine: EXAMPLES.calls['machine.doctor'].long.tree.checks.map((c) => c.check),
  store: [...EXAMPLES.calls['store.doctor'].long.tree.checks.map((c) => c.check), 'store.backups'],
  project: EXAMPLES.calls['project.doctor'].long.tree.checks.map((c) => c.check),
  projectFull: [...EXAMPLES.calls['project.doctor'].long.tree.checks.map((c) => c.check), 'project.data'],
  sandbox: EXAMPLES.calls['sandbox.doctor'].long.tree.checks.map((c) => c.check),
  workspace: EXAMPLES.calls['sandbox.doctor'].long.tree.workspaces[0].checks.map((c) => c.check),
  bucket: EXAMPLES.calls['home.doctor'].long.tree.buckets[0].checks.map((c) => c.check),
  bucketFull: EXAMPLES.calls['backup.doctor'].long.tree.checks.map((c) => c.check),
}
const OUTDATED = EXAMPLES.calls['machine.doctor'].long.findings[0]
const UNLISTED = EXAMPLES.calls['store.doctor'].long.findings[0]

/** One report under construction: nodes are made here so their findings and not_checked entries land in the report. */
function builder(state) {
  const findings = [], notChecked = []
  // inside another thing's doctor, or from LayerFS's own budget: the thing comes back not_checked with the reason (a hang reads as its budget running out)
  const takeFail = (key) => { const reason = state.fail[key]; if (reason) delete state.fail[key]; return reason === 'hang' ? 'timeout' : reason ?? null }
  const b = {
    findings, notChecked,
    miss(kind, name, more) { notChecked.push({ [kind]: name, check: null, blocked_by: null, reason: null, ...more }) },
    /** A thing that lives on a machine that is not ready: one not_checked entry, never a finding. */
    blockedNode(kind, name, by) { b.miss(kind, name, { blocked_by: by }); return blocked(kind, name, by) },
    couldNode(kind, name, checks, reason) { b.miss(kind, name, { reason }); return could(kind, name, checks.map((c) => pass(c)), reason) },
    machine(m) {
      const name = m.machine
      // a machine stopped on purpose: its record and state are read, its worker is not asked
      if (state.stopped.includes(name)) return node('machine', name, ['machine.record', 'machine.state'].map((c) => pass(c)))
      if (!state.outdated.includes(name)) return node('machine', name, CHECKS.machine.map((c) => pass(c)))
      // review item 5: with Sandboxes on the machine the fix stops it by force, and the message names the count
      const n = m.sandboxes.length
      findings.push({
        ...OUTDATED, machine: name,
        message: n ? `${OUTDATED.message}; ${n} ${n === 1 ? 'Sandbox is' : 'Sandboxes are'} on it` : OUTDATED.message,
        fix: `layerfs machine stop ${name}${n ? ' --force' : ''} && layerfs machine start ${name}`,
      })
      return node('machine', name, CHECKS.machine.map((c) => (c === 'machine.worker.compatibility' ? { check: c, outcome: 'error', from: null } : pass(c))))
    },
    store(store, machine) {
      const by = machine ? blockOf(state, machine) : null
      if (by) return b.blockedNode('store', store, by)
      const ids = CHECKS.store
      const reason = takeFail(`store:${store}`)
      if (reason) return b.couldNode('store', store, ids, reason)
      let checks = ids.map((c) => pass(c))
      if (!machine) {
        // R9: a PostgreSQL Store is probed from each machine that has a Sandbox of it; each probe is one check with `from`
        const from = machines(state).filter((m) => m.sandboxes.some((x) => x.project.startsWith(`${store}/`)))
        checks = checks.filter((c) => c.check !== 'store.connection').concat(from.length ? from.map((m) => {
          const block = blockOf(state, m.machine)
          if (block) notChecked.push({ store, check: 'store.connection', blocked_by: block, reason: null })
          return { check: 'store.connection', outcome: block ? 'not_checked' : 'pass', from: m.machine }
        }) : [pass('store.connection')])
      }
      // review item 13: "Backup behind" is the Store's own notice, naming the bucket in its message and fix
      if (sc(state).notices && store === 'shop' && !state.backedUp.includes('shop')) {
        findings.push({ store, check: 'store.backups', severity: 'notice', message: '2 Commits are newer than its backup in r2-old', fix: 'layerfs backup create shop r2-old', from: null, evidence: null })
        checks = checks.map((c) => (c.check === 'store.backups' ? { ...c, outcome: 'notice' } : c))
      }
      return node('store', store, checks)
    },
    project(project, full = false) {
      const ids = full ? CHECKS.projectFull : CHECKS.project
      if (sc(state).notices && project === 'qv2-store/qv2-probe') {
        findings.push({ ...UNLISTED, project, fix: `layerfs project delete ${project}` })
        return node('project', project, ids.map((c) => (c === 'project.listed' ? { check: c, outcome: 'notice', from: null } : pass(c))))
      }
      return node('project', project, ids.map((c) => pass(c)), full ? { coverage: 'full' } : {})
    },
    sandbox(x, machine) {
      const by = blockOf(state, machine)
      if (by) return b.blockedNode('sandbox', x.sandbox, by)
      const ids = CHECKS.sandbox
      const reason = takeFail(`sandbox:${x.sandbox}`)
      if (reason) return b.couldNode('sandbox', x.sandbox, ids, reason)
      if (!state.lost.includes(x.sandbox)) return node('sandbox', x.sandbox, ids.map((c) => pass(c)))
      findings.push({ sandbox: x.sandbox, check: 'sandbox.daemon_connect', severity: 'error', message: 'its daemon does not answer', fix: `layerfs sandbox remove ${x.sandbox}`, from: null, evidence: null })
      const at = ids.indexOf('sandbox.daemon_connect')
      for (const c of ids.slice(at + 1)) notChecked.push({ sandbox: x.sandbox, check: c, blocked_by: { sandbox: x.sandbox, reason: 'not_answering' }, reason: null })
      return node('sandbox', x.sandbox, ids.map((c, i) => (i < at ? pass(c) : { check: c, outcome: i === at ? 'error' : 'not_checked', from: null })))
    },
    bucket(x, full) {
      const ids = full ? CHECKS.bucketFull : CHECKS.bucket
      const reason = takeFail(`bucket:${x.bucket}`)
      if (reason) return b.couldNode('bucket', x.bucket, ids, reason)
      return node('bucket', x.bucket, ids.map((c) => pass(c)), full ? { coverage: 'full' } : {})
    },
  }
  return b
}

const LIST_OF = { machine: 'machines', store: 'stores', project: 'projects', sandbox: 'sandboxes', workspace: 'workspaces', bucket: 'buckets' }
const kindOf = (n) => Object.keys(LIST_OF).concat('home').find((k) => typeof n[k] === 'string')

/**
 * What one doctor call answers: `{ report, events }` (the long form and one
 * progress event per finished thing), `{ refuse: { code, message } }`, or
 * `{ lost: true }` / `{ hang: true }` for a reply that never arrives.
 */
export function doctorAnswer(state, kind, name, { full = false } = {}) {
  const all = machines(state)
  const b = builder(state)
  const home = (m) => all.find((x) => x.machine === m)
  const machineOfStore = (s) => all.find((m) => m.stores.includes(s))?.machine ?? null
  const fail = kind === 'home' ? null : state.fail[`${kind}:${name}`]
  if (fail === 'busy') { delete state.fail[`${kind}:${name}`]; return { refuse: { code: 'Busy', message: `another call holds ${name}` } } }
  if (fail === 'lost' || fail === 'hang') { delete state.fail[`${kind}:${name}`]; return { [fail]: true } }
  let tree
  const kids = []
  if (kind === 'home') {
    tree = node('home', HOME, CHECKS.home.map((c) => pass(c)))
    tree.machines = all.map((m) => b.machine(m))
    tree.stores = PG_STORES.map((s) => b.store(s, null))
    tree.buckets = BUCKETS.map((x) => b.bucket(x, false))
    kids.push(...tree.machines, ...tree.stores, ...tree.buckets)
  } else if (kind === 'machine') {
    const m = home(name)
    if (!m) return { refuse: { code: 'NotFound', message: `no machine ${name}` } }
    tree = b.machine(m)
    const by = blockOf(state, name)
    tree.stores = m.stores.map((s) => (by ? b.blockedNode('store', s, by) : b.store(s, name)))
    tree.sandboxes = m.sandboxes.map((x) => (by ? b.blockedNode('sandbox', x.sandbox, by) : b.sandbox(x, name)))
    kids.push(...tree.stores, ...tree.sandboxes)
  } else if (kind === 'store') {
    const machine = machineOfStore(name)
    if (!machine && !PG_STORES.includes(name)) return { refuse: { code: 'NotFound', message: `no Store ${name}` } }
    tree = b.store(name, machine)
    const by = machine ? blockOf(state, machine) : null
    const stuck = by ?? (tree.reason ? { store: name, reason: tree.reason } : null)
    tree.projects = projectsOf(state, name).map((p) => (by ? b.blockedNode('project', p, by) : stuck ? null : b.project(p))).filter(Boolean)
    kids.push(...tree.projects)
  } else if (kind === 'project') {
    const store = name.split('/')[0]
    if (!projectsOf(state, store).includes(name)) return { refuse: { code: 'NotFound', message: `no project ${name}` } }
    const by = machineOfStore(store) ? blockOf(state, machineOfStore(store)) : null
    tree = by ? b.blockedNode('project', name, by) : b.project(name, full)
  } else if (kind === 'sandbox') {
    const m = all.find((x) => x.sandboxes.some((s) => s.sandbox === name))
    if (!m) return { refuse: { code: 'NotFound', message: `no Sandbox ${name}` } }
    const x = m.sandboxes.find((s) => s.sandbox === name)
    tree = b.sandbox(x, m.machine)
    const by = blockOf(state, m.machine) ?? (state.lost.includes(name) ? { sandbox: name, reason: 'not_answering' } : null)
    tree.workspaces = tree.reason ? [] : x.workspaces.map((w) => (by ? b.blockedNode('workspace', w.workspace, by) : node('workspace', w.workspace, CHECKS.workspace.map((c) => pass(c)))))
    kids.push(...tree.workspaces)
  } else if (kind === 'bucket') {
    const x = BUCKETS.find((k) => k.bucket === name)
    if (!x) return { refuse: { code: 'NotFound', message: `no bucket ${name}` } }
    tree = b.bucket(x, full)
  } else return { refuse: { code: 'InvalidInput', message: `no doctor for ${kind}` } }

  const flat = [tree, ...kids]
  const counts = { ok: 0, notice: 0, warning: 0, error: 0, not_checked: 0 }
  for (const n of flat) counts[n.status] += 1
  const status = ['error', 'warning', 'not_checked', 'notice'].find((s) => counts[s]) ?? 'ok'
  const bare = (n) => Object.fromEntries(Object.entries(n).filter(([k]) => !Object.values(LIST_OF).includes(k)))
  const events = flat.map((n, i) => ({ phase: i === 0 ? 'self' : LIST_OF[kindOf(n)], done: i + 1, total: flat.length, node: bare(n) }))
  return {
    report: { ok: status === 'ok', findings: b.findings, not_checked: b.notChecked, status, counts, observed_at: new Date().toISOString(), tree },
    events,
  }
}

// ---------------------------------------------------------------- the calls behind the fix buttons

/** `machine start|stop`, `project delete`, `backup create` on the fixture world: `{ answer }` or `{ refuse }`. The answers are the spec's long examples. */
export function fixAnswer(state, family, call, args) {
  const [first, second] = args
  const long = (name, more) => ({ ...EXAMPLES.calls[name].long, ...more })
  if (family === 'machine' && (call === 'start' || call === 'stop')) {
    const m = machines(state).find((x) => x.machine === first)
    if (!m) return null
    if (state.refuse) {
      // the scenario's one refusal: nothing changes, the next press is a new call that works
      state.refuse = false
      return { refuse: call === 'stop' ? { code: 'Busy', message: `another call holds ${first}` } : { code: 'Unavailable', message: m.platform === 'docker' ? 'Docker Engine is not running' : 'the VM tool did not answer' } }
    }
    if (call === 'stop') {
      // the page never sends --force, so a stop with Sandboxes on the machine is refused, as LayerFS refuses it
      if (m.sandboxes.length) return { refuse: { code: 'InUse', message: `${m.sandboxes.length} Sandboxes are on ${first}` } }
      if (!state.stopped.includes(first)) state.stopped.push(first)
      return { answer: long('machine.stop', { machine: first }) }
    }
    state.stopped = state.stopped.filter((x) => x !== first)
    state.outdated = state.outdated.filter((x) => x !== first)
    return { answer: long('machine.start', { machine: first }) }
  }
  if (family === 'project' && call === 'delete') {
    if (!projectsOf(state, String(first).split('/')[0]).includes(first)) return null
    state.deleted.push(first)
    return { answer: long('project.delete') }
  }
  if (family === 'backup' && call === 'create') {
    if (!BUCKETS.some((x) => x.bucket === second)) return null
    state.backedUp.push(first)
    return { answer: long('backup.create', { store: first, bucket: second, file: first }) }
  }
  return null
}

/** Every thing of the world as `kind:name`, in tree order (tests count against it). */
export function thingKeys(state) {
  const keys = [`home:${HOME}`]
  for (const m of machines(state)) {
    keys.push(`machine:${m.machine}`)
    for (const s of m.stores) { keys.push(`store:${s}`); for (const p of projectsOf(state, s)) keys.push(`project:${p}`) }
    for (const x of m.sandboxes) { keys.push(`sandbox:${x.sandbox}`); for (const w of x.workspaces) keys.push(`workspace:${w.workspace}`) }
  }
  for (const s of PG_STORES) { keys.push(`store:${s}`); for (const p of projectsOf(state, s)) keys.push(`project:${p}`) }
  for (const x of BUCKETS) keys.push(`bucket:${x.bucket}`)
  return keys
}
