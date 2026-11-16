#!/usr/bin/env node
// A pinned-CLI wrapper that stands in for a CLI lacking some calls (a UI part
// that must hide when the pinned CLI has no such call, #178 scenario F6):
// `help --json` loses the calls named in $LFS_HIDE_CALLS (`family.call`, comma
// separated, e.g. `machine.images,machine.prune`), and a hidden call made anyway
// is refused as the real CLI refuses an unknown call (exit 2, "no call"), with a
// line appended to $LFS_HIDDEN_FILE when set, so a test can assert none was made.
// Everything else passes through to $LFS_REAL_CLI with the same arguments, stdin
// and environment. Point DSH_LAYERFS_CLI at it in a fresh dev dir.
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const real = process.env.LFS_REAL_CLI
const hidden = new Set((process.env.LFS_HIDE_CALLS ?? '').split(',').map((s) => s.trim()).filter(Boolean))
const args = process.argv.slice(2)
if (!real) { process.stderr.write('cli-hide-calls: set LFS_REAL_CLI\n'); process.exit(2) }

const [family, call] = args
if (family !== 'help' && call && hidden.has(`${family}.${call.replace(/-/g, '_')}`)) {
  if (process.env.LFS_HIDDEN_FILE) appendFileSync(process.env.LFS_HIDDEN_FILE, `${args.join(' ')}\n`)
  process.stderr.write(`layerfs: no call \`${family} ${call}\`; \`layerfs help ${family}\` lists them\n`)
  process.exit(2)
}
if (family === 'help' && args.includes('--json') && args.length === 2) {
  const r = spawnSync(real, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  let out = r.stdout
  try {
    const help = JSON.parse(out)
    out = JSON.stringify({ ...help, calls: (help.calls ?? []).filter((c) => !hidden.has(`${c.family}.${c.call}`)) })
  } catch { /* not JSON: pass through */ }
  process.stdout.write(out ?? '')
  process.stderr.write(r.stderr ?? '')
  process.exit(r.status ?? 1)
}
const r = spawnSync(real, args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
