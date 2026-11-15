#!/Users/yifanxu/.nvm/versions/node/v24.21.0/bin/node
// STAND-IN, not LayerFS: a pinned-CLI wrapper that ANSWERS the observed values
// of layerfs-project#164 and the Doctor leftovers of #180 for a CLI built
// before them, so the Machines, Sandbox and Doctor pages can be checked before
// a real build is driven. A run against it shows that the UI follows the
// answer SHAPES of the merged build as read on 2026-11-16 (LayerFS
// docs/architecture/api/sdk/machine.md and sandbox.md, docs/versioned/2.0.0/
// calls.md, control doctor/leftover_report.rs); it is never a pass on a real
// machine. A real build does not use it: the same scripts run with the real CLI.
//
// What it adds:
//   help --json            the calls `machine stats` and `doctor fix`, and the option `live` of `sandbox list`
//   machine stats <m>      { machine, platform, observed_at, worker | null,
//                            resources { cpus, memory_total, memory_used, disk_total, disk_used, disk_free, scope [, reason] },
//                            data_disk { path, fs, scope, volume, inodes_free },
//                            stores [{ name, bytes, allocated }], sandboxes { recorded, live }, complete [, reason] }
//                          as declared for <m>; `observed_at` is now unless declared. A machine declared
//                          stopped is refused `Unavailable`; one with no declaration `NotFound`.
//   sandbox list --live    every item gains `live` (true | false | null) and, when null, `live_reason`
//                          (default: true for a Sandbox recorded running, else false)
//   sandbox get <name>     gains `daemon` ({ pid, started_at } | null), `usage`
//                          ({ cpu_usec, memory_current, memory_peak, pids } | null) and `usage_reason`
//                          (default: the record's daemon, no usage, `host_process`)
//   doctor                 the home sweep's report gains the declared leftover findings (each with
//                          `leftover` { machine, kind, path, bytes | null, age, id, fixable [, not_before] }
//                          and LayerFS's `fix` sentence) and `leftovers` [{ machine, complete, image_locks, unmount_markers }]
//   doctor fix <id>        NEVER answered: the UI must not run it. The call is written to
//                          <LFS_INSPECT_DIR>/doctor-fix.log and refused `InvalidInput`.
// and, so a page has machines of every kind to show without starting one:
//   machine list / get / status / images   rows declared in observe.json replace fields of a real
//                          machine's row (`"state": "running"` for the built-in docker machine) or, with
//                          `"add": true`, are machines that exist only here.
// Everything else passes to $LFS_REAL_CLI (cli-standin-lib.mjs: the chain; this wrapper goes first).
//
//   LFS_REAL_CLI      the next CLI (required)
//   LFS_INSPECT_DIR   the fixture folder (required):
//     observe.json    read on every call (all keys optional):
//       { "calls": ["machine.stats", "doctor.fix", "sandbox.list.live"],     what help lists and this answers (default: all three)
//         "machines": { "<name>": { "add": true, "platform", "backend", "state", "cpus", "memory", "disk",
//                                   "free_disk", "tool_version", "down_reason", "stores": [], "sandboxes": [] } },
//         "stats": { "<machine>": <the answer> },
//         "sandboxes": { "<name>": { "machine": "<another machine>", "live": true | false | null, "live_reason": "…",
//                                    "daemon": {…} | null, "usage": {…} | null, "usage_reason": "…" } },
//         "doctor": { "findings": [ … ], "leftovers": [ … ] } }
//     control.json    (shared with the other stand-ins) delays and refusals of `machine stats`,
//                     keyed `stats:<machine>` or `stats:*`:
//       { "delay_ms": { "stats:docker": 60000 }, "refuse": { "stats:*": { "code": "Busy", "message": "…" } } }
// Each `machine stats` adds `<epoch ms> <argv JSON>` to spawns.log.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, args, ask, call, dir, emit, family, flags, json, logSpawn, need, pass, positionals, refuse, relay, sleep } from './cli-standin-lib.mjs'

need('cli-inspect-observe')
const config = json('observe.json')
const control = json('control.json')
const answered = new Set(Array.isArray(config.calls) ? config.calls : ['machine.stats', 'doctor.fix', 'sandbox.list.live'])
const declared = config.machines ?? {}
const boxes = config.sandboxes ?? {}

/** A machine's row as `machine list` and `machine get` give it. */
const rowOf = (name, d, base = null) => {
  const { add, free_disk, tool_version, down_reason, ...fields } = d
  return {
    ...(base ?? { name, platform: 'lima', backend: 'namespaces', supports: { sqlite: true, postgresql_sandbox: true, reason: null, log: true }, state: 'stopped', cpus: null, memory: null, disk: null, stores: [], postgresql: [], sandboxes: [] }),
    ...fields, name,
  }
}

// ---------------------------------------------------------------- help

if (family === 'help' && args.includes('--json') && args.length === 2) {
  relay(args, (help) => {
    const calls = (help.calls ?? []).map((c) => (
      c.family === 'sandbox' && c.call === 'list' && answered.has('sandbox.list.live') && !(c.options ?? []).some((o) => o.name === 'live')
        ? { ...c, options: [...(c.options ?? []), { name: 'live', kind: 'bool', optional: true }] }
        : c))
    const has = (f, c) => calls.some((x) => x.family === f && x.call === c)
    if (answered.has('machine.stats') && !has('machine', 'stats')) calls.push({ family: 'machine', call: 'stats', args: [{ name: 'machine', kind: 'name', optional: false }], options: [], help: 'STAND-IN: what a machine observes of itself now' })
    if (answered.has('doctor.fix') && !has('doctor', 'fix')) calls.push({ family: 'doctor', call: 'fix', args: [{ name: 'id', kind: 'text', optional: false }], options: [], help: 'STAND-IN: listed only; never run by the UI' })
    return { ...help, calls }
  })
}

// ---------------------------------------------------------------- machine stats

if (family === 'machine' && call === 'stats' && answered.has('machine.stats')) {
  const name = positionals[0]
  if (!name) { process.stderr.write('usage: layerfs machine stats <machine>\n'); process.exit(2) }
  logSpawn()
  const delay = [control.delay_ms?.[`stats:${name}`], control.delay_ms?.['stats:*']].map(Number).find((ms) => Number.isFinite(ms) && ms > 0)
  if (delay) await sleep(delay)
  const refusal = control.refuse?.[`stats:${name}`] ?? control.refuse?.['stats:*']
  if (refusal) refuse(String(refusal.code), String(refusal.message ?? refusal.code))
  if (declared[name]?.state === 'stopped') refuse('Unavailable', `machine ${name} is not running; start it with \`layerfs machine start ${name}\``, { what: 'machine' })
  const stats = config.stats?.[name]
  if (!stats) refuse('NotFound', `no machine named ${name}`)
  answer({ machine: name, observed_at: Date.now(), ...stats })
}

// ---------------------------------------------------------------- machines that exist only here, or run only here

if (family === 'machine' && call === 'list' && Object.keys(declared).length) {
  relay(args, (listed) => {
    const rows = (listed.machines ?? []).map((m) => (declared[m.name] && !declared[m.name].add ? rowOf(m.name, declared[m.name], m) : m))
    for (const [name, d] of Object.entries(declared)) if (d.add && !rows.some((m) => m.name === name)) rows.push(rowOf(name, d))
    return { ...listed, machines: rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }
  })
}
if (family === 'machine' && declared[positionals[0]]) {
  const name = positionals[0], d = declared[name]
  if (call === 'get') { if (d.add) answer(rowOf(name, d)); relay(args, (m) => rowOf(name, d, m)) }
  if (call === 'status') {
    // a real machine that only runs here: its own status, with what is declared in place
    if (!d.add) relay(args, (s) => ({ ...s, state: d.state ?? s.state, free_disk: d.free_disk ?? s.free_disk, tool_version: d.tool_version ?? s.tool_version, down_reason: d.down_reason ?? ((d.state ?? s.state) === 'stopped' ? s.down_reason : null) }))
    const row = rowOf(name, d)
    answer({ name, platform: row.platform, state: row.state, free_disk: d.free_disk ?? null, tool_version: d.tool_version ?? null, down_reason: d.down_reason ?? (row.state === 'stopped' ? 'the machine is stopped' : null), stores: row.stores })
  }
  if (call === 'images') {
    if ((d.state ?? 'stopped') !== 'running') refuse('Unavailable', `machine ${name} is not running; start it with \`layerfs machine start ${name}\``, { what: 'machine' })
    answer({ images: [], free: null, default: null, architecture: 'arm64' })
  }
}

// ---------------------------------------------------------------- sandbox list --live, sandbox get

if (family === 'sandbox' && call === 'list') {
  // the SDK writes a bool option as `--live=true`; a person types `--live`
  const asked = flags.live !== undefined && answered.has('sandbox.list.live')
  const live = asked && flags.live !== 'false'
  const end = args.indexOf('--') < 0 ? args.length : args.indexOf('--')
  const argv = asked ? args.filter((a, i) => !(i < end && (a === '--live' || a.startsWith('--live=')))) : args
  if (live || Object.values(boxes).some((b) => b.machine)) {
    relay(argv, (listed) => ({
      ...listed,
      items: (listed.items ?? []).map((item) => {
        const b = boxes[item.name] ?? {}
        const out = { ...item, ...(b.machine ? { machine: b.machine } : {}) }
        if (!live) return out
        const value = 'live' in b ? b.live : item.state === 'running'
        return { ...out, live: value, ...(value === null ? { live_reason: b.live_reason ?? 'not_answered' } : {}) }
      }),
    }))
  }
}

if (family === 'sandbox' && call === 'get' && positionals[0]) {
  const b = boxes[positionals[0]] ?? {}
  relay(args, (record) => {
    const usage = 'usage' in b ? b.usage : null
    return {
      ...record, ...(b.machine ? { machine: b.machine } : {}),
      daemon: 'daemon' in b ? b.daemon : (record.daemon?.pid ? { pid: record.daemon.pid, started_at: record.created ?? null } : null),
      usage,
      // with no usage: why; beside a usage (LayerFS 73d824ec64): `no_controller` when its memory or process counts are null
      ...(usage ? (b.usage_reason ? { usage_reason: b.usage_reason } : {}) : { usage_reason: b.usage_reason ?? 'host_process' }),
    }
  })
}

// ---------------------------------------------------------------- doctor

if (family === 'doctor' && call === 'fix') {
  try { appendFileSync(join(dir, 'doctor-fix.log'), `${Date.now()} ${JSON.stringify(args)}\n`) } catch { /* the fixture folder is gone */ }
  refuse('InvalidInput', 'STAND-IN: `doctor fix` is never answered here; the UI does not run it')
}
if (family === 'doctor' && args.length === 1 && answered.has('doctor.fix') && config.doctor) {
  const r = ask(args)
  let out = r.stdout ?? ''
  // the sweep exits 1 when it has findings; its report is on stdout either way
  try {
    const report = JSON.parse(out)
    const findings = [...(report.findings ?? []), ...(config.doctor.findings ?? [])]
    out = `${JSON.stringify({ ...report, findings, leftovers: config.doctor.leftovers ?? [] })}\n`
  } catch { /* not JSON: as it came */ }
  emit(1, out)
  emit(2, r.stderr ?? '')
  process.exit(r.status ?? 1)
}

pass()
