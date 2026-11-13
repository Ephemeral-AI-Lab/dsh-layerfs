#!/Users/yifanxu/.nvm/versions/node/v24.21.0/bin/node
// A pinned-CLI wrapper for UI checks of a machine whose worker does not answer:
// `machine status|list|get` report $LFS_DOWN_MACHINE as stopped with LayerFS's
// down reason, and `doctor` adds the warning LayerFS gives for it (with its fix
// commands) plus an error about $LFS_DOWN_SANDBOX if set. Everything else
// passes through to $LFS_REAL_CLI unchanged. Starts, stops and closes run for real.
import { spawnSync } from 'node:child_process'
const real = process.env.LFS_REAL_CLI, machine = process.env.LFS_DOWN_MACHINE, sandbox = process.env.LFS_DOWN_SANDBOX
const args = process.argv.slice(2)
const r = spawnSync(real, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
let out = r.stdout
const reason = 'the machine runs but its worker does not answer'
try {
  if (machine && r.status === 0) {
    const j = JSON.parse(out)
    const [family, call] = args
    // LFS_DOWN_AS_VM=<store>: also show the machine as a Lima VM holding that Store (to see the guided Remove; do not run it)
    const asVm = process.env.LFS_DOWN_AS_VM
    const patch = (m) => (m && m.name === machine ? { ...m, state: 'stopped', ...(asVm ? { platform: 'lima', stores: [asVm] } : {}) } : m)
    if (family === 'machine' && call === 'status' && args.includes(machine)) out = JSON.stringify({ ...j, state: 'stopped', down_reason: reason })
    else if (family === 'machine' && call === 'list') out = JSON.stringify({ ...j, machines: (j.machines ?? []).map(patch) })
    else if (family === 'machine' && call === 'get' && args.includes(machine)) out = JSON.stringify(patch(j))
    else if (asVm && family === 'store' && call === 'list') out = JSON.stringify({ ...j, items: (j.items ?? []).map((st) => (st.name === asVm ? { ...st, machine } : st)) })
    else if (family === 'doctor') {
      const findings = [...(j.findings ?? []), { severity: 'warning', entity: { kind: 'machine', name: machine },
        message: `machine ${machine}'s recorded worker does not answer (worker connection: Connection reset by peer (os error 54))`,
        fix: `\`layerfs machine start ${machine}\` starts it again; \`layerfs machine stop ${machine}\` records it stopped` }]
      if (sandbox) findings.push({ severity: 'error', entity: { kind: 'sandbox', name: sandbox }, message: 'Saved forward process ended or its PID was reused', fix: null })
      out = JSON.stringify({ ...j, ok: false, findings })
    }
  }
} catch { /* not JSON: pass through */ }
process.stdout.write(out ?? '')
process.stderr.write(r.stderr ?? '')
process.exit(r.status ?? 1)
