#!/usr/bin/env node
// STAND-IN, not LayerFS: a pinned-CLI wrapper that ADDS the monitoring fields
// of layerfs-project#178 "Fields" to `sandbox get`, for a CLI built before
// them, so the Sandbox page's use of the fields can be checked before a build
// has them. A run against it shows that the UI follows the SPEC as read here;
// it is never a pass on a real machine. A real build with the fields does not
// use it: the same scripts then run with the real CLI.
//
// What it adds to `sandbox get <name>`:
//   workspace_capacity   16 (the control constant), top level
//   workspaces[].running [{ exec_id, started (epoch ms), tag, program }], oldest first: the
//                        commands that went through THIS wrapper as `workspace exec`
//                        and have not ended, whoever ran them (the host, or a second
//                        client that runs the same CLI path with the same LAYERFS_HOME);
//                        `tag` is the call's LAYERFS_LOGS_TAG, `program` the command's
//                        first word, `exec_id` the call's --exec-id (else one made here)
//   workspaces[].overlay_bytes   the size of <run folder>/overlay/<namespace>.sqlite, taken
//                        from the Workspace's mount path <run folder>/workspaces/<namespace>
//                        (what LayerFS stats); null when that file is not there
// and `workspace exec` records the command in <LFS_INSPECT_DIR>/execs/<exec id>.json
// while it runs. Everything else passes through to $LFS_REAL_CLI unchanged
// (cli-standin-lib.mjs: the chain).
//
//   LFS_REAL_CLI      the next CLI (required)
//   LFS_INSPECT_DIR   the fixture folder (required):
//     execs/            one file per running `workspace exec`
//     fields.json       read on every call (all keys optional):
//       { "workspace_capacity": 8 | "absent",      default 16
//         "running": "absent" | "null",            an older worker / records that could not be read
//         "overlay_bytes": "absent" | "null" | <n>,
//         "extra_running": { "<ws>": [{ "exec_id", "started", "tag", "program" }] } }   declared, not run
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { args, call, dir, family, flags, json, need, pass, positionals, relay } from './cli-standin-lib.mjs'

need('cli-inspect-fields')
const execs = join(dir, 'execs')

/** The commands recorded as running, without those whose wrapper process is gone. */
function recorded() {
  let names = []
  try { names = readdirSync(execs) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const r = JSON.parse(readFileSync(join(execs, name), 'utf8'))
      try { process.kill(r.pid, 0) } catch { rmSync(join(execs, name), { force: true }); continue }
      out.push(r)
    } catch { /* being written */ }
  }
  return out
}

if (family === 'sandbox' && call === 'get') {
  const config = json('fields.json')
  const sandbox = positionals[0]
  relay(args, (record) => {
    const running = recorded()
    const capacity = config.workspace_capacity ?? 16
    const out = { ...record, ...(capacity === 'absent' ? {} : { workspace_capacity: capacity }) }
    out.workspaces = (record.workspaces ?? []).map((w) => {
      const ids = new Set([w.ws, `${sandbox}:${w.name}`, `${sandbox}:${w.directory}`].filter(Boolean))
      const mine = [...running.filter((r) => ids.has(r.ws)), ...Object.entries(config.extra_running ?? {}).filter(([ws]) => ids.has(ws)).flatMap(([, list]) => list)]
        .map((r) => ({ exec_id: r.exec_id, started: r.started, tag: r.tag ?? null, program: r.program ?? null }))
        .sort((a, b) => a.started - b.started)
      let overlay = null
      if (typeof config.overlay_bytes === 'number') overlay = config.overlay_bytes
      else if (w.directory) { try { overlay = statSync(join(dirname(dirname(w.directory)), 'overlay', `${basename(w.directory)}.sqlite`)).size } catch { overlay = null } }
      return {
        ...w,
        ...(config.running === 'absent' ? {} : { running: config.running === 'null' ? null : mine }),
        ...(config.overlay_bytes === 'absent' ? {} : { overlay_bytes: config.overlay_bytes === 'null' ? null : overlay }),
      }
    })
    return out
  })
}

if (family === 'workspace' && call === 'exec' && positionals[0]) {
  const id = typeof flags['exec-id'] === 'string' ? flags['exec-id'] : `standin-${randomBytes(6).toString('hex')}`
  const file = join(execs, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  mkdirSync(execs, { recursive: true })
  writeFileSync(file, JSON.stringify({
    ws: positionals[0], exec_id: id, started: Date.now(), pid: process.pid,
    tag: process.env.LAYERFS_LOGS_TAG || null, program: String(positionals[1] ?? '').trim().split(/\s+/)[0] || null,
  }))
  pass(() => rmSync(file, { force: true }))
} else pass()
