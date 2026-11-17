/**
 * The Docker Engine behind the built-in `docker` machine, started on demand.
 *
 * LayerFS's machine.platforms reports docker not ready with a need
 * `host:<socket>` when the Engine is installed but does not answer there
 * (Docker Desktop quit, colima stopped). On macOS that is one click away: the
 * Start of the docker machine launches the Engine that owns the socket, waits
 * until it answers `GET /_ping`, then starts the machine as before. Which
 * Engine owns the socket comes from where the socket links
 * (`/var/run/docker.sock` -> `~/.docker/run/docker.sock` is Docker Desktop's,
 * `~/.colima/…` colima's, `~/.orbstack/…` OrbStack's). Linux needs root to
 * start dockerd and Windows its own installer, so both stay as they were:
 * the machine is shown blocked with the commands to run.
 */
import { request } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve, join } from 'node:path'
import { refuse } from './util.ts'

/** How long the Engine has to answer after its launch. */
export const ENGINE_WAIT_MS = 120_000
/** How often the socket is asked while waiting. */
const POLL_MS = 1_000

/** A need that names the docker socket (`host:/var/run/docker.sock`), not a host fact such as `/dev/fuse`. */
export const isSocketNeed = (need: string): boolean => need.startsWith('host:/') && need !== 'host:/dev/fuse'

/**
 * The socket to start the Engine behind, when the docker platform is not
 * ready only because its socket does not answer; null otherwise (ready, or
 * something else missing that starting the Engine does not fix).
 */
export function engineSocket(row: { platform: string, ready: boolean, missing: readonly string[], socket?: { state?: string | null } } | null | undefined): string | null {
  if (!row || row.platform !== 'docker' || row.ready || row.missing.length === 0) return null
  // the Engine answers but refuses this user (EACCES): launching it fixes nothing
  if (row.socket?.state === 'denied') return null
  if (!row.missing.every(isSocketNeed)) return null
  return row.missing[0].slice('host:'.length)
}

/** One way to start an Engine: what it is called and the command that starts it. */
export interface Launcher { name: string, command: string, args: string[] }

/** What startEngine reaches outside itself (fakes in tests). */
export interface EngineDeps {
  exists(path: string): boolean
  /** The link's target, or null when `path` is no symlink. */
  readlink(path: string): string | null
  /** Runs a command to its end; rejects on a non-zero exit. */
  run(command: string, args: string[], timeoutMs: number): Promise<void>
  /** Whether the Engine answers `GET /_ping` on the socket. */
  ping(socket: string): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
  home: string
  /** PATH's folders, searched after Homebrew's for a launcher's command. */
  path: string[]
}

/** A progress report as `machine-progress` stages ({ stage, state }). */
export type EngineReport = (progress: { stage: 'docker-engine', state: 'started' | 'completed' | 'failed', engine?: string, message?: string }) => void

/** Where the socket finally points, following up to eight links. */
export function socketTarget(socket: string, deps: Pick<EngineDeps, 'readlink'>): string {
  let at = socket
  for (let i = 0; i < 8; i++) {
    const next = deps.readlink(at)
    if (!next) break
    at = isAbsolute(next) ? next : resolve(dirname(at), next)
  }
  return at
}

/** The first `name` found in Homebrew's folders or PATH, or null. */
function command(name: string, deps: Pick<EngineDeps, 'exists' | 'path'>): string | null {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', ...deps.path]) {
    if (!dir) continue
    const file = join(dir, name)
    if (deps.exists(file)) return file
  }
  return null
}

/** The app bundle `name` in /Applications or ~/Applications, or null. */
function app(name: string, deps: Pick<EngineDeps, 'exists' | 'home'>): string | null {
  for (const dir of ['/Applications', join(deps.home, 'Applications')]) {
    const bundle = join(dir, `${name}.app`)
    if (deps.exists(bundle)) return bundle
  }
  return null
}

/** The Engine that owns `socket` on macOS and how to start it, or null when none is installed. */
export function launcherOf(socket: string, deps: Pick<EngineDeps, 'exists' | 'readlink' | 'home' | 'path'>): Launcher | null {
  const target = socketTarget(socket, deps)
  if (target.includes('/.colima/')) {
    const colima = command('colima', deps)
    // the profile is the folder under ~/.colima (default, or a named one)
    const profile = /\/\.colima\/([^/]+)\//.exec(target)?.[1]
    return colima ? { name: 'colima', command: colima, args: ['start', ...(profile && profile !== 'default' ? ['--profile', profile] : [])] } : null
  }
  if (target.includes('/.orbstack/')) return app('OrbStack', deps) ? { name: 'OrbStack', command: 'open', args: ['-g', '-a', 'OrbStack'] } : null
  if (app('Docker', deps)) return { name: 'Docker Desktop', command: 'open', args: ['-g', '-a', 'Docker'] }
  // no Docker Desktop and the socket names no other Engine: colima is the last one that can serve it
  const colima = target.includes('/.docker/') ? null : command('colima', deps)
  return colima ? { name: 'colima', command: colima, args: ['start'] } : null
}

/**
 * Starts the Engine behind `socket` and waits until it answers. Answers at
 * once (`started: false`) when it already does. Refuses Unsupported when no
 * Engine for the socket is installed, Timeout when it does not answer within
 * `waitMs`, and passes a launcher's own failure on as Unavailable.
 */
export async function startEngine(socket: string, deps: EngineDeps, report: EngineReport, waitMs = ENGINE_WAIT_MS): Promise<{ started: boolean, engine: string | null }> {
  if (await deps.ping(socket)) return { started: false, engine: null }
  const launcher = launcherOf(socket, deps)
  if (!launcher) {
    throw refuse(null, 'Unsupported', `The Docker Engine at ${socket} does not answer, and no Docker Desktop, OrbStack or colima is installed to start it. Install Docker Desktop, or point the docker machine at another socket.`)
  }
  report({ stage: 'docker-engine', state: 'started', engine: launcher.name })
  const fail = (code: string, message: string) => { report({ stage: 'docker-engine', state: 'failed', engine: launcher.name, message }); return refuse(null, code, message) }
  const started = deps.now()
  // colima start runs until its VM is up; `open` returns at once and the app starts behind it
  const launching = deps.run(launcher.command, launcher.args, waitMs).then(() => null, (e: any) => e)
  let launchError: any = null
  let launched = false
  launching.then((e) => { launched = true; launchError = e })
  while (deps.now() - started < waitMs) {
    if (await deps.ping(socket)) {
      report({ stage: 'docker-engine', state: 'completed', engine: launcher.name })
      return { started: true, engine: launcher.name }
    }
    if (launched && launchError) {
      const detail = String(launchError?.stderr || launchError?.message || launchError).trim().split('\n').slice(-3).join(' ')
      throw fail('Unavailable', `${launcher.name} did not start: ${detail}`)
    }
    await deps.sleep(POLL_MS)
  }
  throw fail('Timeout', `${launcher.name} did not come up in ${Math.round(waitMs / 1000)} s (the Docker Engine at ${socket} still does not answer).`)
}

/** `GET /_ping` on a unix socket, true on 200 within 2 s. */
export function pingSocket(socket: string): Promise<boolean> {
  return new Promise((done) => {
    const req = request({ socketPath: socket, path: '/_ping', method: 'GET', timeout: 2000 }, (res) => {
      res.resume()
      done(res.statusCode === 200)
    })
    req.on('timeout', () => { req.destroy(); done(false) })
    req.on('error', () => done(false))
    req.end()
  })
}

/** The real machine: this user's home, Homebrew and PATH, `open` and colima as child processes. */
export const realEngineDeps = (): EngineDeps => ({
  exists: (path) => existsSync(path),
  readlink: (path) => { try { return readlinkSync(path) } catch { return null } },
  run: (cmd, args, timeoutMs) => new Promise((ok, no) => {
    execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(':') } }, (error, _stdout, stderr) => (error ? no(Object.assign(error, { stderr })) : ok()))
  }),
  ping: pingSocket,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  home: homedir(),
  path: (process.env.PATH ?? '').split(':'),
})
