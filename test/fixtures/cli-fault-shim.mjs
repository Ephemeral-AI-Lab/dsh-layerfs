#!/usr/bin/env node
// A FAULT SHIM in front of a REAL LayerFS CLI, for the browser scripts
// (test/e2e-inspect-*.mjs) on a real build. It answers nothing itself: every
// call goes to $LFS_REAL_CLI unchanged, except a monitoring read that
// <LFS_INSPECT_DIR>/control.json names, which first waits, or is refused, or
// (a folder page) ends early as a page cut short by time does. A row that
// needed one of these is "real build, fault injected by shim", never a plain
// real-build pass; a row that needed none ran on the real answers only.
//
//   DSH_LAYERFS_CLI=test/fixtures/cli-fault-shim.mjs
//   LFS_REAL_CLI=<the real CLI>     LFS_INSPECT_DIR=<a folder for control.json and spawns.log>
//
// control.json (written by test/fixtures/inspect-hook-real.sh), every key optional:
//   { "delay_ms": { "<key>": <ms> },                    wait, then go on (to the refusal, or the real CLI)
//     "refuse":   { "<key>": { "code", "message" } },   refuse as LayerFS does: one JSON line on stderr, exit 125
//     "deadline": { "files-<kind>:<name>:<path>": <n> } read that folder with `--limit n`; the real page that
//                                                       comes back is passed on with `reason: "deadline"`
//     "stopped":  { "<sandbox>": { "under": "<its run folder>", "message": "<LayerFS's words>" } }
//                                                       a files read of that Sandbox outside its run folder is
//                                                       refused `Unavailable`, as for a Sandbox whose daemon ended }
// Keys, as the stand-ins use them:
//   logs machine|sandbox <name>           machine:<name> | sandbox:<name>
//   machine|sandbox files <name> [path]   files-<kind>:<name>:<path, '' for the roots>, then files-<kind>:<name>
//   machine stats <name>                  stats:<name>
//   sandbox get <name>                    call:sandbox.get:<name>
// Every process adds one line `<epoch ms> <argv JSON>` to <LFS_INSPECT_DIR>/spawns.log (INSPECT_SPAWN_LOG).
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { args, ask, call, dir, emit, family, json, need, pass, positionals, refuse, sleep } from './cli-standin-lib.mjs'

need('cli-fault-shim')
try { appendFileSync(join(dir, 'spawns.log'), `${Date.now()} ${JSON.stringify(args)}\n`) } catch { /* the folder is gone: still pass the call on */ }

const control = json('control.json')
const name = positionals[0]
const files = (family === 'machine' || family === 'sandbox') && call === 'files'
const keys = family === 'logs' && (call === 'machine' || call === 'sandbox') ? [`${call}:${name}`]
  : files ? [`files-${family}:${name}:${positionals[1] ?? ''}`, `files-${family}:${name}`]
    : family === 'machine' && call === 'stats' ? [`stats:${name}`]
      : family === 'sandbox' && call === 'get' ? [`call:sandbox.get:${name}`]
        : []
if (keys.length && name) {
  const delay = keys.map((k) => Number(control.delay_ms?.[k])).find((ms) => Number.isFinite(ms) && ms > 0) ?? 0
  if (delay) await sleep(delay)
  const refusal = keys.map((k) => control.refuse?.[k]).find(Boolean)
  if (refusal) refuse(String(refusal.code), String(refusal.message ?? refusal.code))
  const path = positionals[1]
  const stopped = files && family === 'sandbox' ? control.stopped?.[name] : null
  if (stopped && path !== undefined && path !== stopped.under && !path.startsWith(`${stopped.under}/`)) refuse('Unavailable', String(stopped.message))
  const cut = files && path !== undefined ? Number(control.deadline?.[keys[0]]) : 0
  if (cut > 0) {
    // the same read with a smaller page: what comes back is LayerFS's own page, only its reason is changed
    const argv = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--limit') { i++; continue }
      if (args[i].startsWith('--limit=')) continue
      argv.push(args[i])
    }
    const dash = argv.indexOf('--')
    argv.splice(dash >= 0 ? dash : argv.length, 0, `--limit=${cut}`)
    const r = ask(argv)
    let out = r.stdout ?? ''
    if (r.status === 0) { try { const page = JSON.parse(out); if (page.kind === 'folder' && page.has_more) out = `${JSON.stringify({ ...page, reason: 'deadline' })}\n` } catch { /* not JSON: as it came */ } }
    emit(1, out)
    emit(2, r.stderr ?? '')
    process.exit(r.status ?? 1)
  }
}
pass()
