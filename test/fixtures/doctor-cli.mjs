#!/usr/bin/env node
// A STAND-IN LayerFS CLI for the Doctor page: it answers the 2.0 calls the page
// uses on the stand-in world of doctor-scenarios.mjs, while no runtime has them:
//
//   home get --with tree --detail                     the records tree
//   home|machine|store|project|sandbox|backup doctor  the long form, with one `{phase, done, total, node}`
//                                                     line on stderr per finished thing when asked (--progress)
//   machine start|stop, project delete, backup create the calls behind the fix buttons (on the stand-in's things)
//
// Everything else goes to $LFS_REAL_CLI unchanged when it is set (a private dev
// server on a real build: the other pages keep working); without it the
// stand-in answers discovery itself and refuses the rest `Unsupported`.
//
//   DSH_LAYERFS_CLI=test/fixtures/doctor-cli.mjs  LFS_DOCTOR_DIR=<a folder>  [LFS_REAL_CLI=<the real CLI>]
//
// <LFS_DOCTOR_DIR>/control.json, read on every call, every key optional:
//   { "scenario": "mixed",            one of doctor-scenarios.mjs SCENARIOS (default healthy)
//     "epoch": 1,                     change it to start the scenario afresh
//     "timing": { "self": 0, "kid": 0, "full": 0, "slow": 120000, "fix": 0 } }   ms before a doctor's own thing, each
//                                     further thing, a Full check's end (`slow` in the slowfull scenario), a fix call
// state.json there holds what fixes changed and which one-time failures were used.
// Every process adds `<epoch ms> <argv JSON>` to spawns.log.
//
// Refusals are the 2.0 shape: `{ error, message, fix? }` on stderr, exit 125.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { doctorAnswer, fixAnswer, freshState, treeAnswer } from './doctor-scenarios.mjs'

const dir = process.env.LFS_DOCTOR_DIR
const real = process.env.LFS_REAL_CLI
const args = process.argv.slice(2)
if (!dir) { process.stderr.write('doctor-cli: set LFS_DOCTOR_DIR\n'); process.exit(2) }
try { appendFileSync(join(dir, 'spawns.log'), `${Date.now()} ${JSON.stringify(args)}\n`) } catch { /* the folder is gone: still answer */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function emit(fd, text) {
  const data = Buffer.from(text)
  for (let done = 0; done < data.length;) {
    try { done += writeSync(fd, data, done) } catch (error) {
      if (error?.code !== 'EAGAIN') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}
const answer = (value) => { emit(1, `${JSON.stringify(value)}\n`); process.exit(0) }
const refuse = (code, message) => { emit(2, `${JSON.stringify({ error: code, message })}\n`); process.exit(125) }
const json = (name) => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { return {} } }

/** Read the scenario's state, let `change` use and alter it, and save it: one process at a time. */
function withState(change) {
  const lock = join(dir, 'state.lock')
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break } catch (error) {
      if (error?.code !== 'EEXIST' || i > 2000) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  try {
    const control = json('control.json')
    const scenario = control.scenario ?? 'healthy', epoch = control.epoch ?? 0
    let state = json('state.json')
    if (state.scenario !== scenario || state.epoch !== epoch) state = { ...freshState(scenario), epoch }
    const result = change(state)
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
    return result
  } finally { rmdirSync(lock) }
}
const timing = () => ({ self: 0, kid: 0, full: 0, slow: 120_000, fix: 0, ...(json('control.json').timing ?? {}) })

function pass() {
  if (!real) refuse('Unsupported', `the Doctor stand-in does not answer \`${args.slice(0, 2).join(' ')}\`; set LFS_REAL_CLI to pass it on`)
  const child = spawn(real, args, { stdio: 'inherit' })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal) } catch { /* already gone */ } })
  child.on('error', () => process.exit(127))
  child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1) })
}

const [family, rawCall] = args
const call = String(rawCall ?? '').replace(/-/g, '_')
const dash = args.indexOf('--')
const positionals = dash >= 0 ? args.slice(dash + 1) : args.slice(2).filter((a) => !a.startsWith('--'))
const flag = (name) => args.slice(2, dash >= 0 ? dash : args.length).some((a) => a === `--${name}` || a === `--${name}=true`)
const withValue = () => { const i = args.indexOf('--with'); return i >= 0 ? String(args[i + 1] ?? '').split(',') : (args.find((a) => a.startsWith('--with='))?.slice(7).split(',') ?? []) }

/** The calls the host's SDK client needs in the table before it sends them. */
const entry = (name, argNames = [], options = []) => { const [f, c] = name.split('.'); return { family: f, call: c, args: argNames.map((n) => ({ name: n, kind: 'name' })), options: options.map((n) => ({ name: n, kind: n === 'on_progress' ? 'function' : 'bool' })) } }
const FIX_CALLS = [entry('machine.start', ['machine'], ['on_progress']), entry('machine.stop', ['machine'], ['force']), entry('project.delete', ['project']), entry('backup.create', ['store', 'bucket'], ['on_progress'])]
/** `home get` as the 2.0 table lists it: its `--with` values keyed by value under `form.with`. */
const HOME_FORM = { with: { platforms: { where: 'own', keys: ['host', 'items'] }, tree: { where: 'own', keys: ['machines', 'stores', 'buckets'] } } }
const HOME_GET = { ...entry('home.get'), form: HOME_FORM }
const REQUIRED = ['project.init', 'project.list', 'project.get', 'project.export', 'branch.fork', 'branch.list', 'branch.commits', 'commit.diff', 'file.read', 'file.list', 'file.apply', 'sandbox.create', 'sandbox.get', 'sandbox.close', 'workspace.mount', 'workspace.commit', 'workspace.status', 'workspace.unmount', 'workspace.exec', 'machine.list', 'machine.get', 'store.list', 'store.create']

if (family === '--version' || family === 'help') {
  if (!real) {
    if (family === '--version') answer({ version: '2.0.0-doctor-standin', commit: '0'.repeat(40), dirty: false, features: [] })
    answer({ calls: [...REQUIRED.map((n) => entry(n)), HOME_GET, ...FIX_CALLS], commands: [], switches: [] })
  } else if (family === 'help') {
    // the real table, plus the 2.0 calls it may not have yet: the fix calls, and `home get` with its `--with` values
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(real, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
    let out = r.stdout ?? ''
    if (r.status === 0) { try { const help = JSON.parse(out); out = `${JSON.stringify({ ...help, calls: [...help.calls.map((c) => (c.family === 'home' && c.call === 'get' ? { ...c, form: { ...c.form, with: { ...c.form?.with, ...HOME_FORM.with } } } : c)), ...[HOME_GET, ...FIX_CALLS].filter((f) => !help.calls.some((c) => c.family === f.family && c.call === f.call))] })}\n` } catch { /* as it came */ } }
    emit(1, out); emit(2, r.stderr ?? ''); process.exit(r.status ?? 1)
  } else pass()
} else if (family === 'home' && call === 'get' && withValue().includes('tree')) {
  answer(withState((state) => treeAnswer(state)))
} else if (call === 'doctor' && ['home', 'machine', 'store', 'project', 'sandbox', 'backup'].includes(family)) {
  const kind = family === 'backup' ? 'bucket' : family
  const full = flag('full')
  const t = timing()
  const result = withState((state) => ({ ...doctorAnswer(state, kind, positionals[0], { full }), slow: state.scenario === 'slowfull' }))
  if (result.refuse) { await sleep(t.self); refuse(result.refuse.code, result.refuse.message) }
  if (result.lost) { await sleep(t.self); process.exit(0) }
  if (result.hang) await sleep(600_000)
  if (full) await sleep(result.slow ? t.slow : t.full)
  for (const [i, event] of result.events.entries()) {
    await sleep(i === 0 ? t.self : t.kid)
    if (flag('progress')) emit(2, `${JSON.stringify(event)}\n`)
  }
  if (flag('detail')) answer(result.report)
  const { findings, not_checked: missed } = result.report
  const lean = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== null && k !== 'evidence'))
  answer(result.report.ok ? { ok: true } : { ...(findings.length ? { findings: findings.map(lean) } : {}), ...(missed.length ? { not_checked: missed.map(lean) } : {}) })
} else if ((family === 'machine' && (call === 'start' || call === 'stop')) || (family === 'project' && call === 'delete') || (family === 'backup' && call === 'create')) {
  const result = withState((state) => fixAnswer(state, family, call, positionals))
  if (!result) {
    if (real) pass()
    else refuse('NotFound', `the Doctor stand-in has no ${positionals.join(' ')}`)
  } else {
    await sleep(timing().fix)
    if (result.refuse) refuse(result.refuse.code, result.refuse.message)
    answer(flag('detail') ? result.answer : { ok: true })
  }
} else pass()
