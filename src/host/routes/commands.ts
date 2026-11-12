/**
 * Commands a Sandbox page runs in a Workspace (`workspace.exec`), and the
 * short log of them LayerFS itself does not keep: LayerFS holds an exec
 * record only while the command runs and has no call that lists commands.
 *
 *   POST   /api/workspaces/<ws>/commands  { command } -> the entry (running); 409 CommandRunning if one runs there
 *   GET    /api/workspaces/<ws>/commands             -> { items } that Workspace's, newest first
 *   POST   /api/workspaces/<ws>/cancel    { id }      -> workspace.exec_cancel
 *   GET    /api/sandboxes/<name>/commands            -> { items } all its Workspaces', newest first (at most KEEP)
 *
 * A start answers at once; the command runs in the background and its end is
 * published as a `sandbox-command` event `{ type, sandbox, ws, id, state }`.
 * Only commands started here are listed: an agent's commands go through its
 * own CLI calls, and other clients' through theirs. One command runs per
 * Workspace at a time.
 *
 * The log is one file per Workspace,
 * `<home>/job/sandbox-commands/<sandbox>/<sha1(ws) 16 hex>.json`
 * `{ version: 2, ws, commands }` (client-neutral, next to storage-jobs.json):
 * the newest {@link KEEP} commands, each stream's last {@link TAIL} bytes, a
 * binary flag per stream (its text then empty). A Workspace's file goes on
 * unmount and a Sandbox's folder on close, because Workspace paths restart
 * with a new daemon. A v1 `<sandbox>.json` (one log per Sandbox) is split
 * into Workspace files the first time the Sandbox is read. A command still
 * running when this host stops is marked `unknown` the next time it is read.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { refuse, type RouteHost } from './util.ts'

/** Commands kept per Workspace (and listed per Sandbox). */
export const KEEP = 50
/** Bytes kept of each stream (the tail). */
export const TAIL = 64 * 1024
/** Longest command text accepted. */
const MAX_COMMAND = 8 * 1024

export type CommandState = 'running' | 'exited' | 'cancelled' | 'failed' | 'unknown'

export interface CommandEntry {
  id: string
  ws: string
  sandbox: string
  command: string
  state: CommandState
  startedAt: number
  finishedAt: number | null
  exitCode: number | null
  /** The kept tail as text ('' when the stream is binary). */
  stdout: string
  stderr: string
  /** Bytes each stream produced in all (the kept text is the tail). */
  stdoutBytes: number
  stderrBytes: number
  /** The kept bytes hold a NUL, or over 10% of them do not decode as UTF-8. */
  stdoutBinary: boolean
  stderrBinary: boolean
  /** The refusal when `workspace.exec` itself failed. */
  error: { code: string, message: string } | null
}

/** `<sandbox>:<name or path>` -> the Sandbox. */
export function sandboxOfWs(ws: unknown): string {
  const text = typeof ws === 'string' ? ws : ''
  const at = text.indexOf(':')
  if (at <= 0 || at === text.length - 1 || text.includes('\0')) throw refuse(400, 'InvalidInput', 'A Workspace is named <sandbox>:<name or path>.')
  return text.slice(0, at)
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const REPLACEMENT = /�/g

/** Text that reads as binary: a NUL, or more than 10% U+FFFD. */
function binaryText(text: string): boolean {
  if (text.includes('\0')) return true
  return (text.match(REPLACEMENT)?.length ?? 0) > text.length * 0.1
}

/** A stream's kept bytes as `{ text, binary }`. */
export function decodeTail(bytes: Buffer, cut: boolean): { text: string, binary: boolean } {
  let kept = bytes
  // the cut may split a UTF-8 sequence: drop its leading continuation bytes
  if (cut) {
    let i = 0
    while (i < 3 && i < kept.length && (kept[i] & 0xc0) === 0x80) i++
    kept = kept.subarray(i)
  }
  if (kept.includes(0)) return { text: '', binary: true }
  const text = kept.toString('utf8')
  return binaryText(text) ? { text: '', binary: true } : { text, binary: false }
}

/** A bounded tail of one output stream. */
class Tail {
  private chunks: Buffer[] = []
  private kept = 0
  total = 0
  push(chunk: Buffer): void {
    this.total += chunk.length
    this.chunks.push(chunk)
    this.kept += chunk.length
    while (this.kept - (this.chunks[0]?.length ?? 0) >= TAIL) this.kept -= this.chunks.shift()!.length
  }
  read(): { text: string, binary: boolean } {
    const all = Buffer.concat(this.chunks)
    const kept = all.subarray(Math.max(0, all.length - TAIL))
    return decodeTail(kept, this.total > kept.length)
  }
}

interface Run { entry: CommandEntry, out: Tail, err: Tail }

/** The entry's output fields from a run's tails. */
function output(run: Run): Pick<CommandEntry, 'stdout' | 'stderr' | 'stdoutBytes' | 'stderrBytes' | 'stdoutBinary' | 'stderrBinary'> {
  const out = run.out.read()
  const err = run.err.read()
  return {
    stdout: out.text, stderr: err.text, stdoutBytes: run.out.total, stderrBytes: run.err.total,
    stdoutBinary: out.binary, stderrBinary: err.binary,
  }
}

/** Newest first: by start time, ties kept in order. */
const newestFirst = (a: CommandEntry, b: CommandEntry) => b.startedAt - a.startedAt

export class SandboxCommands {
  private readonly live = new Map<string, Run>()
  /** Each Workspace's log as read or written, keyed by ws. */
  private readonly loaded = new Map<string, CommandEntry[]>()
  /** Sandboxes whose v1 log has been looked for. */
  private readonly migrated = new Set<string>()

  constructor(private readonly host: RouteHost) {}

  private base(): string { return join(this.host.jobs, 'sandbox-commands') }

  private dir(sandbox: string): string {
    if (!SAFE_NAME.test(sandbox)) throw refuse(400, 'InvalidInput', `${JSON.stringify(sandbox)} is not a Sandbox name.`)
    return join(this.base(), sandbox)
  }

  private file(ws: string): string {
    const dir = this.dir(sandboxOfWs(ws))
    return join(dir, `${createHash('sha1').update(ws).digest('hex').slice(0, 16)}.json`)
  }

  /** Atomically writes a Workspace's log. */
  private put(ws: string, commands: CommandEntry[]): void {
    const file = this.file(ws)
    mkdirSync(this.dir(sandboxOfWs(ws)), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 2, ws, commands }, null, 1))
    renameSync(temp, file)
  }

  /** A Workspace's log file as stored (no live overlay, no caching). */
  private load(ws: string): CommandEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file(ws), 'utf8'))
      if (parsed?.ws !== ws || !Array.isArray(parsed?.commands)) return []
      return (parsed.commands as CommandEntry[]).filter((c) => c?.ws === ws)
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      return []
    }
  }

  /** Splits a v1 `<sandbox>.json` into Workspace logs, once per Sandbox. */
  private migrate(sandbox: string): void {
    if (this.migrated.has(sandbox)) return
    const v1 = join(this.base(), `${sandbox}.json`)
    let old: CommandEntry[]
    try {
      const parsed = JSON.parse(readFileSync(v1, 'utf8'))
      old = Array.isArray(parsed?.commands) ? parsed.commands as CommandEntry[] : []
    } catch (error: any) {
      if (error?.code === 'ENOENT') { this.migrated.add(sandbox); return }
      if (!(error instanceof SyntaxError)) throw error
      old = []
    }
    try {
      const byWs = new Map<string, CommandEntry[]>()
      for (const c of old) {
        if (typeof c?.ws !== 'string' || typeof c?.id !== 'string') continue
        try { if (sandboxOfWs(c.ws) !== sandbox) continue } catch { continue }
        const list = byWs.get(c.ws)
        if (list) list.push(c)
        else byWs.set(c.ws, [c])
      }
      for (const [ws, commands] of byWs) {
        const have = this.load(ws)
        const ids = new Set(have.map((c) => c.id))
        const merged = [...have, ...commands.filter((c) => !ids.has(c.id))].sort(newestFirst).slice(0, KEEP)
        this.put(ws, merged)
        this.loaded.delete(ws)
      }
      rmSync(v1, { force: true })
      this.migrated.add(sandbox)
    } catch (error: any) {
      // left for the next read
      this.host.log(`sandbox-commands ${sandbox}: v1 log not migrated: ${error?.message ?? error}`)
    }
  }

  /** A Workspace's log, newest first (cached; entries normalized). */
  private read(ws: string): CommandEntry[] {
    let all = this.loaded.get(ws)
    if (all) return all
    this.migrate(sandboxOfWs(ws))
    all = this.load(ws)
    for (const c of all) {
      // a command this host was running when it stopped: its outcome is not known here
      if (c.state === 'running' && !this.live.has(c.id)) c.state = 'unknown'
      if (typeof c.stdoutBinary !== 'boolean') c.stdoutBinary = binaryText(c.stdout ?? '')
      if (typeof c.stderrBinary !== 'boolean') c.stderrBinary = binaryText(c.stderr ?? '')
      if (c.stdoutBinary) c.stdout = ''
      if (c.stderrBinary) c.stderr = ''
    }
    this.loaded.set(ws, all)
    return all
  }

  private save(ws: string): void {
    try {
      const all = this.read(ws).slice(0, KEEP)
      this.loaded.set(ws, all)
      this.put(ws, all)
    } catch (error: any) { this.host.log(`sandbox-commands ${ws}: ${error?.message ?? error}`) }
  }

  /** Entries with live runs' output so far. */
  private view(entries: CommandEntry[]): CommandEntry[] {
    return entries.map((c) => {
      const run = this.live.get(c.id)
      return run ? { ...c, ...output(run) } : c
    })
  }

  /** One Workspace's commands, newest first (running ones with their output so far). */
  listWorkspace(ws: string): { items: CommandEntry[] } {
    this.file(ws)
    return { items: this.view(this.read(ws)) }
  }

  /** The Sandbox's commands across its Workspaces, newest first, at most {@link KEEP}. */
  list(sandbox: string): { items: CommandEntry[] } {
    const dir = this.dir(sandbox)
    this.migrate(sandbox)
    const workspaces = new Set<string>()
    for (const ws of this.loaded.keys()) if (sandboxOfWs(ws) === sandbox) workspaces.add(ws)
    let names: string[] = []
    try { names = readdirSync(dir) } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    for (const name of names) {
      if (!/^[0-9a-f]{16}\.json$/.test(name)) continue
      try {
        const ws = JSON.parse(readFileSync(join(dir, name), 'utf8'))?.ws
        if (typeof ws === 'string' && sandboxOfWs(ws) === sandbox) workspaces.add(ws)
      } catch { /* unreadable: skipped */ }
    }
    const all = [...workspaces].flatMap((ws) => this.read(ws)).sort(newestFirst).slice(0, KEEP)
    return { items: this.view(all) }
  }

  /** Whether this host runs a command in Workspace `ws`. */
  running(ws: string): boolean {
    for (const run of this.live.values()) if (run.entry.ws === ws) return true
    return false
  }

  /** Refuses 409 CommandRunning while this host runs a command in `ws`. */
  assertIdle(ws: string, doing = 'Wait for it to end or cancel it first.'): void {
    if (this.running(ws)) throw refuse(409, 'CommandRunning', `A command is running in ${ws}. ${doing}`)
  }

  /** Start `command` in Workspace `ws`; answers the running entry. */
  start(ws: string, body: any): CommandEntry {
    const sandbox = sandboxOfWs(ws)
    this.file(ws)
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    if (!command) throw refuse(400, 'InvalidInput', 'Enter a command.')
    if (command.length > MAX_COMMAND) throw refuse(400, 'InvalidInput', `A command is at most ${MAX_COMMAND} characters.`)
    this.assertIdle(ws)
    const entry: CommandEntry = {
      id: `dsh-${randomBytes(8).toString('hex')}`, ws, sandbox, command, state: 'running',
      startedAt: Date.now(), finishedAt: null, exitCode: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
      stdoutBinary: false, stderrBinary: false, error: null,
    }
    const run: Run = { entry, out: new Tail(), err: new Tail() }
    this.read(ws).unshift(entry)
    this.live.set(entry.id, run)
    this.save(ws)
    const finish = (patch: Partial<CommandEntry>) => {
      Object.assign(entry, patch, { finishedAt: Date.now() }, output(run))
      this.live.delete(entry.id)
      // an unmount or close dropped this Workspace's log meanwhile: do not bring it back
      if (this.loaded.get(ws)?.includes(entry)) this.save(ws)
      this.host.emit('sandbox-command', { type: 'sandbox-command', sandbox, ws, id: entry.id, state: entry.state })
    }
    const chunk = (c: Buffer | string) => Buffer.isBuffer(c) ? c : Buffer.from(String(c))
    let exec: Promise<any>
    try {
      exec = Promise.resolve(this.host.lfs().workspace.exec(ws, command, {
        exec_id: entry.id,
        stdout: (c: Buffer | string) => run.out.push(chunk(c)),
        stderr: (c: Buffer | string) => run.err.push(chunk(c)),
      }))
    } catch (error) { exec = Promise.reject(error) }
    void exec.then(
      (result: any) => {
        // output the CLI answered inline rather than as events
        if (!run.out.total && typeof result?.stdout === 'string') run.out.push(Buffer.from(result.stdout))
        if (!run.err.total && typeof result?.stderr === 'string') run.err.push(Buffer.from(result.stderr))
        const code = typeof result?.exit_code === 'number' ? result.exit_code : null
        finish({ state: result?.kind === 'cancelled' ? 'cancelled' : 'exited', exitCode: code })
      },
      (error: any) => finish({ state: error?.code === 'Unknown' ? 'unknown' : 'failed', error: { code: String(error?.code ?? 'Failed'), message: String(error?.message ?? error) } }),
    )
    return { ...entry }
  }

  /** workspace.exec_cancel for one of this host's running commands. */
  async cancel(ws: string, body: any): Promise<unknown> {
    sandboxOfWs(ws)
    const id = typeof body?.id === 'string' ? body.id : ''
    const run = this.live.get(id)
    if (!run || run.entry.ws !== ws) throw refuse(404, 'NotFound', 'That command is not running.')
    return this.host.lfs().workspace.exec_cancel(ws, id, {})
  }

  /** After a successful unmount: drops the Workspace's log and tells clients to re-read. */
  unmounted(ws: string): void {
    const sandbox = sandboxOfWs(ws)
    this.loaded.delete(ws)
    try { rmSync(this.file(ws), { force: true }) } catch (error: any) { this.host.log(`sandbox-commands ${ws}: ${error?.message ?? error}`) }
    this.host.emit('sandbox-command', { type: 'sandbox-command', sandbox, ws, id: null, state: 'unmounted' })
  }

  /** After a successful close: drops the Sandbox's logs (v2 folder and any v1 file). */
  closed(sandbox: string): void {
    if (!SAFE_NAME.test(sandbox)) return
    for (const ws of [...this.loaded.keys()]) if (sandboxOfWs(ws) === sandbox) this.loaded.delete(ws)
    this.migrated.delete(sandbox)
    try {
      rmSync(this.dir(sandbox), { recursive: true, force: true })
      rmSync(join(this.base(), `${sandbox}.json`), { force: true })
    } catch (error: any) { this.host.log(`sandbox-commands ${sandbox}: ${error?.message ?? error}`) }
  }

  /** Commands still running here. */
  busy(): boolean { return this.live.size > 0 }
}
