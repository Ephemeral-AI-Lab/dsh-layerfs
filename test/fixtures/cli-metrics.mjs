#!/usr/bin/env node
// STAND-IN, not LayerFS: a pinned-CLI wrapper that ANSWERS `machine stats`
// with the fields of layerfs-project#182 (L1 processor counters, L2 one row
// per recorded Sandbox, L3 `memory_file` and `oom_kills`), for machines and
// Sandboxes declared in a fixture file, so the metrics views can be checked
// before a LayerFS build has the fields. A run against it shows that the UI
// follows the field CONTRACT of the #182 plan; it is never a pass on a real
// machine. A real build does not use it.
//
// What it answers (everything else passes to $LFS_REAL_CLI, cli-standin-lib.mjs):
//   help --json             adds `machine stats` when the next CLI lacks it
//   machine list/get/status machines declared with "add": true (and fields of real ones replaced)
//   machine stats <m>       for a declared machine with "stats": counters that grow with time
//                           (cpu_busy_usec, cpu_total_usec), memory that moves, the rows of the
//                           declared Sandboxes on it; refusals and delays from "refuse" / "delay_ms"
//   sandbox list            the declared Sandboxes added to the next CLI's rows
//   sandbox get <name>      a record for a declared Sandbox (Workspaces, daemon, usage)
//
//   LFS_REAL_CLI      the next CLI (required)
//   LFS_INSPECT_DIR   the fixture folder (required), holding metrics.json, read on every call:
//     { "machines": { "<name>": { "add": true, "platform", "backend", "state", "cpus", "memory", "disk",
//                                 "stats": { "cpus", "memory_total", "memory_used", "disk_total", "disk_used",
//                                            "inodes_free", "scope", "data_scope", "load" (0..1),
//                                            "cpu": "ok" | "unsupported" | "not_read", "items": true | false,
//                                            "worker": true | false, "boot": <epoch ms> } } },
//       "sandboxes": { "<name>": { "machine", "project", "state", "live": true | false | null, "live_reason",
//                                  "started_at": <epoch ms>, "cpu" (processors), "memory", "peak", "file",
//                                  "pids", "oom_kills", "usage": "ok" | "null" | "no_controller",
//                                  "usage_reason", "deadline": true, "workspaces": [ … ] } },
//       "refuse": { "<machine>": { "code", "message" } }, "delay_ms": { "<machine>": <ms> } }
// Each `machine stats` adds `<epoch ms> <argv JSON>` to spawns.log.
import { answer, args, call, family, json, logSpawn, need, pass, positionals, refuse, relay, sleep } from './cli-standin-lib.mjs'

need('cli-metrics')
const config = json('metrics.json')
const machines = config.machines ?? {}
const boxes = config.sandboxes ?? {}
const now = Date.now()
// a boot time that stays put between calls (counters must grow between samples)
const BOOT = Math.floor(now / 86_400_000) * 86_400_000 - 86_400_000

const rowOf = (name, d, base = null) => {
  const { add, stats, ...fields } = d
  return {
    ...(base ?? { name, platform: 'lima', backend: 'namespaces', supports: { sqlite: true, postgresql_sandbox: false, reason: null, log: false }, state: 'stopped', cpus: null, memory: null, disk: null, stores: [], postgresql: [], sandboxes: [] }),
    ...fields, name, sandboxes: Object.entries(boxes).filter(([, b]) => b.machine === name).map(([n]) => n),
  }
}

if (family === 'help' && args.includes('--json') && args.length === 2) {
  relay(args, (help) => {
    const calls = [...(help.calls ?? [])]
    if (!calls.some((c) => c.family === 'machine' && c.call === 'stats')) calls.push({ family: 'machine', call: 'stats', args: [{ name: 'machine', kind: 'name', optional: false }], options: [], help: 'STAND-IN' })
    return { ...help, calls }
  })
}

/** A cumulative counter that grows at `rate` per second plus a slow wave (never down). */
const counter = (seconds, rate, wave = 0.1, period = 300) => rate * seconds + wave * rate * (period / (2 * Math.PI)) * (1 - Math.cos((2 * Math.PI * seconds) / period))

function usageOf(b) {
  const kind = b.usage ?? 'ok'
  if (kind === 'null') return { usage: null, usage_reason: b.usage_reason ?? 'not_observed' }
  const started = b.started_at ?? now - 3_600_000
  const s = Math.max(0, (now - started) / 1000)
  const cpu = Math.round(counter(s, (b.cpu ?? 0.2) * 1e6, 0.3, 120))
  if (kind === 'no_controller') return { usage: { cpu_usec: cpu, memory_current: null, memory_peak: null, memory_file: null, pids: null, oom_kills: null }, usage_reason: 'no_controller' }
  const memory = Math.round((b.memory ?? 100e6) * (1 + 0.15 * Math.sin(s / 90)))
  return { usage: { cpu_usec: cpu, memory_current: memory, memory_peak: Math.max(memory, b.peak ?? memory), memory_file: b.file ?? Math.round(memory / 5), pids: b.pids ?? 4, oom_kills: b.oom_kills ?? 0 } }
}

function itemOf(name, b) {
  if (b.deadline) return { name, live: null, live_reason: 'deadline', started_at: null, usage: null, usage_reason: 'deadline' }
  const live = 'live' in b ? b.live : (b.state ?? 'running') === 'running'
  return { name, live, ...(live === null ? { live_reason: b.live_reason ?? 'not_answered' } : {}), started_at: live ? b.started_at ?? now - 3_600_000 : null, ...(live ? usageOf(b) : { usage: null, usage_reason: 'not_observed' }) }
}

if (family === 'machine' && call === 'stats' && machines[positionals[0]]?.stats) {
  const name = positionals[0], d = machines[name], st = d.stats
  logSpawn()
  const delay = Number(config.delay_ms?.[name])
  if (Number.isFinite(delay) && delay > 0) await sleep(delay)
  const refusal = config.refuse?.[name]
  if (refusal) refuse(String(refusal.code), String(refusal.message ?? refusal.code))
  // a real machine whose stats are declared keeps its own state (macos-host: ready) unless one is declared
  if (d.state === 'stopped' || (d.add && !d.state)) refuse('Unavailable', `machine ${name} is not running; start it with \`layerfs machine start ${name}\``, { what: 'machine' })
  const cpus = st.cpus ?? 4
  const up = Math.max(0, (now - (st.boot ?? BOOT)) / 1000)
  const cpuMode = st.cpu ?? 'ok'
  const reasons = cpuMode === 'unsupported' ? ['cpu_unsupported'] : cpuMode === 'not_read' ? ['cpu_not_read'] : []
  const total = Math.round(up * cpus * 1e6)
  const busy = Math.round(counter(up, (st.load ?? 0.3) * cpus * 1e6, 0.4, 240))
  const memoryUsed = Math.round((st.memory_used ?? 2e9) * (1 + 0.1 * Math.sin(up / 200)))
  const rows = Object.entries(boxes).filter(([, b]) => b.machine === name).map(([n, b]) => itemOf(n, b))
  answer({
    machine: name, platform: d.platform ?? 'lima', observed_at: now,
    worker: st.worker === false ? null : { version: '2.0.0-standin', pid: 41, started_at: st.boot ?? BOOT, protocol: 7, bundle: 'standin' },
    resources: {
      cpus, memory_total: st.memory_total ?? 8e9, memory_used: memoryUsed, disk_total: st.disk_total ?? 1e11, disk_used: st.disk_used ?? 4e10,
      disk_free: (st.disk_total ?? 1e11) - (st.disk_used ?? 4e10),
      cpu_busy_usec: reasons.length ? null : busy, cpu_total_usec: reasons.length ? null : total,
      scope: st.scope ?? 'vm', ...(reasons.length ? { reason: reasons.join(', ') } : {}),
    },
    data_disk: { path: '/layerfs/data', fs: 'ext4', scope: st.data_scope ?? 'volume', volume: null, inodes_free: st.inodes_free ?? 6_000_000 },
    stores: [],
    sandboxes: { recorded: rows.length, live: rows.some((r) => r.live === null) ? null : rows.filter((r) => r.live === true).length, ...(st.items === false ? {} : { items: rows }) },
    complete: !rows.some((r) => r.live_reason === 'deadline'), ...(rows.some((r) => r.live_reason === 'deadline') ? { reason: 'deadline' } : {}),
  })
}

if (family === 'machine' && call === 'list' && Object.keys(machines).length) {
  relay(args, (listed) => {
    const rows = (listed.machines ?? []).map((m) => (machines[m.name] && !machines[m.name].add ? rowOf(m.name, machines[m.name], m) : m))
    for (const [name, d] of Object.entries(machines)) if (d.add && !rows.some((m) => m.name === name)) rows.push(rowOf(name, d))
    return { ...listed, machines: rows }
  })
}
if (family === 'machine' && machines[positionals[0]]?.add) {
  const name = positionals[0], d = machines[name], row = rowOf(name, d)
  if (call === 'get') answer(row)
  if (call === 'status') answer({ name, platform: row.platform, state: row.state, free_disk: null, tool_version: null, down_reason: row.state === 'stopped' ? 'the machine is stopped' : null, stores: [] })
  if (call === 'images') answer({ images: [], free: null, default: null, architecture: 'arm64' })
}

if (family === 'sandbox' && call === 'list' && Object.keys(boxes).length) {
  relay(args, (listed) => ({
    ...listed,
    items: [...(listed.items ?? []), ...Object.entries(boxes).map(([name, b]) => ({ name, machine: b.machine, project: b.project ?? 'm182/app', state: b.state ?? 'running', backend: 'namespaces', route: 'fuse', image: null }))],
  }))
}

if (family === 'sandbox' && call === 'get' && boxes[positionals[0]]) {
  const name = positionals[0], b = boxes[name], item = itemOf(name, b)
  answer({
    name, state: b.state ?? 'running', project: b.project ?? 'm182/app', machine: b.machine, backend: 'namespaces', route: 'fuse', runtime: 'namespaces', platform: 'lima',
    workspaces: b.workspaces ?? [], next_page_pos: null, workspace_capacity: 8,
    daemon_capacity: { retained: { count: b.failures ?? 0, failures: [] } },
    daemon: item.live ? { pid: 100, started_at: item.started_at } : null,
    usage: item.usage, ...(item.usage_reason ? { usage_reason: item.usage_reason } : {}),
  })
}

pass()
