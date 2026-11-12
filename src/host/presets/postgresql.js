/*
 * The PostgreSQL server a preset's PostgreSQL Stores live on: one Docker
 * container the preset owns (`postgres:17`, published on 127.0.0.1 only, on a
 * port fixed when it is created), with a generated password kept in the
 * presets state folder (`<state>/postgresql/password`, 0600) and handed to
 * LayerFS as a `file:` reference. Each PostgreSQL Store gets a fresh database
 * right before `store connect`; machines then dial it through
 * `store attach <store> <machine>`, which LayerFS checks from that machine
 * (it rewrites 127.0.0.1 to what the machine reaches the host by).
 * The container is reused by later builds and is never removed here.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

export const POSTGRES_IMAGE = 'postgres:17'

export const isPostgresql = store => store?.kind === 'postgresql'
/** The machines a preset Store is placed on (a SQLite Store) or attached to (a PostgreSQL Store). */
export const storeMachines = store => isPostgresql(store) ? [...new Set([store.machine, ...(store.attach ?? [])])] : [store.machine]
export const usesMachine = (store, name) => storeMachines(store).includes(name)

const fail = (message, code = 'Failed') => { throw Object.assign(new Error(message), { code }) }
const DATABASE = /^[a-z_][a-z0-9_]{0,62}$/

/** The Docker CLI: DSH_LAYERFS_DOCKER, else the usual install places, else `docker` on PATH. */
export function dockerCli(env = process.env) {
  if (env.DSH_LAYERFS_DOCKER) return env.DSH_LAYERFS_DOCKER
  const home = env.HOME ?? ''
  return ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', join(home, '.docker/bin/docker')].find(path => existsSync(path)) ?? 'docker'
}

function run(file, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const PATH = [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean).join(':')
    execFile(file, args, { timeout, env: { ...process.env, PATH }, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${String(stderr || error.message).trim()}`), { code: 'Failed', exitCode: error.code }))
      else resolve(String(stdout))
    })
  })
}

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})

export class PresetPostgres {
  constructor({ state, docker = dockerCli(), exec = run, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    this.dir = join(state, 'postgresql')
    this.container = `dsh-layerfs-preset-pg-${createHash('sha256').update(state).digest('hex').slice(0, 10)}`
    this.docker = docker; this.exec = exec; this.sleep = sleep
  }
  get passwordFile() { return join(this.dir, 'password') }
  passwordRef() { return `file:${this.passwordFile}` }
  url(port, database) {
    if (!DATABASE.test(database)) fail(`Invalid preset database name ${database}.`, 'InvalidInput')
    return `postgresql://postgres@127.0.0.1:${port}/${database}`
  }
  /** The server this state folder recorded, without touching Docker (for the command plan). */
  recorded() {
    try { return JSON.parse(readFileSync(join(this.dir, 'server.json'), 'utf8')) } catch { return null }
  }
  async available() {
    try { await this.exec(this.docker, ['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 }); return null } catch (error) { return error.message || 'Docker is not running' }
  }
  dockerRun(args, options) { return this.exec(this.docker, args, options) }
  /** The container exists, runs and accepts connections; answers `{ container, port }`. */
  async ensure() {
    if (this.ready) return this.ready
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (!existsSync(this.passwordFile)) writeFileSync(this.passwordFile, randomBytes(18).toString('base64url'), { mode: 0o600 })
    const password = readFileSync(this.passwordFile, 'utf8').trim()
    let state = null
    try { state = (await this.dockerRun(['inspect', '--format', '{{.State.Status}}', this.container])).trim() } catch { state = null }
    if (state === null) {
      const envFile = join(this.dir, 'container.env')
      writeFileSync(envFile, `POSTGRES_PASSWORD=${password}\n`, { mode: 0o600 })
      const port = await freePort()
      await this.dockerRun(['run', '-d', '--name', this.container, '--label', 'dsh-layerfs.preset=postgresql', '--env-file', envFile, '-p', `127.0.0.1:${port}:5432`, POSTGRES_IMAGE], { timeout: 600_000 })
    } else if (state !== 'running') await this.dockerRun(['start', this.container])
    const published = (await this.dockerRun(['port', this.container, '5432/tcp'])).split('\n').map(line => /127\.0\.0\.1:(\d+)/.exec(line)?.[1]).find(Boolean)
    if (!published) fail(`PostgreSQL container ${this.container} publishes no 127.0.0.1 port. Remove it and build again.`)
    const port = Number(published)
    for (let tries = 0; ; tries++) {
      try { await this.dockerRun(['exec', this.container, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'], { timeout: 10_000 }); break } catch (error) {
        if (tries >= 90) fail(`PostgreSQL container ${this.container} did not become ready: ${error.message}`)
        await this.sleep(1000)
      }
    }
    writeFileSync(join(this.dir, 'server.json'), JSON.stringify({ container: this.container, port, image: POSTGRES_IMAGE }), { mode: 0o600 })
    this.ready = { container: this.container, port }
    return this.ready
  }
  /** An empty database `name`, dropping one left by an earlier build (only on the preset's own server). */
  async freshDatabase(name) {
    if (!DATABASE.test(name)) fail(`Invalid preset database name ${name}.`, 'InvalidInput')
    await this.ensure()
    await this.dockerRun(['exec', this.container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, '-c', `CREATE DATABASE "${name}"`])
  }
}
