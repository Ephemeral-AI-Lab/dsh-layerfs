// Shared parts of the STAND-IN CLI wrappers in this folder
// (cli-inspect-fields.mjs, cli-inspect-files.mjs): argument parsing, the
// answer and refusal wire format, the fixture folder's control file, the
// spawn log, and passing a call on to the next CLI.
//
// The wrappers chain. Each passes what it does not answer to $LFS_REAL_CLI;
// when that is another wrapper, $LFS_REAL_CLI_REST names the CLIs after it,
// separated by `:`, the real pinned CLI last:
//
//   DSH_LAYERFS_CLI=test/fixtures/cli-inspect-files.mjs
//   LFS_REAL_CLI=test/fixtures/cli-inspect-fields.mjs
//   LFS_REAL_CLI_REST=test/fixtures/cli-inspect-logs.mjs:<pin>/bin/layerfs
//
// A wrapper hands the next one LFS_REAL_CLI=<first of the rest> and the
// remainder as LFS_REAL_CLI_REST, so cli-inspect-logs.mjs (which knows only
// LFS_REAL_CLI) can be anywhere in the chain.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const real = process.env.LFS_REAL_CLI
export const dir = process.env.LFS_INSPECT_DIR
export const args = process.argv.slice(2)

export function need(name) {
  if (!real || !dir) { process.stderr.write(`${name}: set LFS_REAL_CLI and LFS_INSPECT_DIR\n`); process.exit(2) }
}

export const [family, rawCall] = args
export const call = String(rawCall ?? '').replace(/-/g, '_')
const dash = args.indexOf('--')
export const positionals = dash >= 0 ? args.slice(dash + 1) : args.slice(2).filter((a) => !a.startsWith('--'))
export const flags = {}
for (let i = 2; i < (dash >= 0 ? dash : args.length); i++) {
  const word = args[i]
  if (!word.startsWith('--')) continue
  const eq = word.indexOf('=')
  if (eq > 0) flags[word.slice(2, eq)] = word.slice(eq + 1)
  else if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[word.slice(2)] = args[++i]
  else flags[word.slice(2)] = true
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Write all of `text` to `fd` before going on (process.exit drops what a pipe has not taken yet). */
export function emit(fd, text) {
  const data = Buffer.from(text)
  for (let done = 0; done < data.length;) {
    try { done += writeSync(fd, data, done) } catch (error) {
      if (error?.code !== 'EAGAIN') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}
/** Refuse as LayerFS does: one JSON line on stderr, exit 125. */
export const refuse = (code, message, detail = null) => { emit(2, `${JSON.stringify({ code, message, detail })}\n`); process.exit(125) }
export const answer = (value) => { emit(1, `${JSON.stringify(value)}\n`); process.exit(0) }

/** A JSON file of the fixture folder, read on every call; `{}` when absent or torn. */
export const json = (name) => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { return {} } }

/** One line `<epoch ms> <argv JSON>` in the fixture folder's spawns.log, for a call this wrapper answers itself. */
export function logSpawn() {
  try { appendFileSync(join(dir, 'spawns.log'), `${Date.now()} ${JSON.stringify(args)}\n`) } catch { /* the fixture folder is gone: still answer */ }
}

/** The environment the next CLI in the chain runs with. */
export function nextEnv() {
  const rest = (process.env.LFS_REAL_CLI_REST ?? '').split(':').filter(Boolean)
  if (!rest.length) return process.env
  return { ...process.env, LFS_REAL_CLI: rest[0], LFS_REAL_CLI_REST: rest.slice(1).join(':') }
}

/** Run the next CLI with `argv` and read what it printed. */
export function ask(argv, options = {}) {
  return spawnSync(real, argv, { encoding: 'utf8', maxBuffer: 1 << 28, env: nextEnv(), ...options })
}

/** Print what the next CLI answered to `argv`, its stdout through `patch` when it exited 0 with JSON, and exit as it did. */
export function relay(argv, patch) {
  const r = ask(argv)
  let out = r.stdout ?? ''
  if (r.status === 0) { try { out = `${JSON.stringify(patch(JSON.parse(out)))}\n` } catch { /* not JSON: as it came */ } }
  emit(1, out)
  emit(2, r.stderr ?? '')
  process.exit(r.status ?? 1)
}

/**
 * Hand this call to the next CLI with the same arguments, stdin, stdout and
 * stderr, and exit as it does. A signal that ends this process ends it too.
 * @param done - runs once when the next CLI has ended (or this process is told to end).
 */
export function pass(done = () => {}) {
  const child = spawn(real, args, { stdio: 'inherit', env: nextEnv() })
  let finished = false
  const finish = () => { if (!finished) { finished = true; try { done() } catch { /* best effort */ } } }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { finish(); try { child.kill(signal) } catch { /* already gone */ } })
  child.on('error', () => { finish(); process.exit(127) })
  child.on('exit', (code, signal) => { finish(); if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1) })
}
