/** Additive invocation receipts. Original DSH events and CLI streams are never rewritten. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface VersionLink { kind: 'Commit' | 'Layer'; id: string; effect: 'created' | 'unchanged' | 'referenced' }
export interface TargetArguments { paths?: string[]; workspace?: string; mode?: string; force?: boolean; truncated?: true }
export interface Invocation {
  id: string; origin: 'tool' | 'host'; sessionId: string; project: string; turn?: number; toolCallId?: string
  operation: string; arguments?: TargetArguments; source: 'sdk' | 'cli'; startedAt: number; finishedAt: number
  outcome: 'success' | 'refusal' | 'unknown'; versions: VersionLink[]; error?: string; captureGap?: string
}
export interface TraceIdentity {
  origin: 'tool' | 'host'; sessionId: string; project: string; turn?: number; toolCallId?: string
  /** Machine-local execution handle, used only to verify workspace command targets. */
  workspace?: string
  /** Internal history writes are never project-file checkpoints. */
  internal?: boolean
}
export interface TraceContext extends TraceIdentity {
  /** Private local spool for retrying annotation writes, never part of portable identity. */
  receiptRoot?: string
  record: (invocation: Invocation) => Promise<void>
  onError?: (error: unknown) => void
}
const context = new AsyncLocalStorage<TraceContext>()
export const withTraceContext = <T>(value: TraceContext, run: () => T): T => context.run(value, run)
/** Archive writes are session persistence, not project-file activity. */
export const withoutTraceContext = <T>(run: () => T): T => context.exit(run)

/** Exact allowlist; matching a family prefix would mislabel exec/read/lifecycle calls. */
export const CHECKPOINT_OPERATIONS = ['file.write', 'file.edit', 'file.apply', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp', 'workspace.commit', 'branch.fork', 'branch.merge', 'branch.publish'] as const

/** Resolve only known project-bearing CLI grammar. Unknown flags never guess a target. */
export function firstPositional(argv: readonly string[]): string | undefined {
  // These eligible commands have only value options; accept the common JSON/progress switches.
  const values = ['--message', '--mode', '--units', '--scope', '--scope-project', '--scope-branch']
  for (let at = 2; at < argv.length; at++) {
    const word = argv[at]
    if (word === '--') return argv[at + 1]
    if (!word.startsWith('-')) return word
    if (word === '--json' || word === '--progress' || /^--force(?:=(?:true|false))?$/.test(word)) continue
    const [flag] = word.split('=')
    if (!values.includes(flag)) return undefined
    if (!word.includes('=')) { if (!argv[at + 1]) return undefined; at++ }
  }
  return undefined
}

export function invocationProject(argv: readonly string[]): string | undefined {
  return ['file', 'branch'].includes(argv[0]) ? firstPositional(argv) : undefined
}

/** Minimal non-content targets, not a duplicate of tool input or stdin payloads. */
export function operationArguments(argv: readonly string[]): TargetArguments {
  const result: TargetArguments = {}, positionals: string[] = []
  const valueFlags = ['--message', '--mode', '--units', '--scope', '--scope-project', '--scope-branch']
  for (let at = 2; at < argv.length; at++) {
    const word = argv[at]
    if (word === '--') { positionals.push(...argv.slice(at + 1)); break }
    if (!word.startsWith('-')) { positionals.push(word); continue }
    if (word === '--json' || word === '--progress' || word === '--stream' || word === '--events') continue
    if (/^--force(?:=(?:true|false))?$/.test(word)) { result.force = word !== '--force=false'; continue }
    const equal = word.indexOf('='), flag = equal < 0 ? word : word.slice(0, equal)
    if (!valueFlags.includes(flag)) return {}
    const value = equal < 0 ? argv[++at] : word.slice(equal + 1)
    if (flag === '--mode' && /^\d{1,10}$/.test(value ?? '')) result.mode = value
  }
  const bounded = (value: string): string => {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2048) return value
    result.truncated = true
    // At most 512 UTF-16 units, keeping the encoded receipt below 8 KiB.
    return value.slice(0, 512) + '[truncated]'
  }
  const counts: Record<string, number> = { write: 1, edit: 1, rm: 1, mkdir: 1, mv: 2, cp: 2, read: 1, stat: 1 }
  if (argv[0] === 'file' && counts[argv[1]]) {
    const paths = positionals.slice(2, 2 + counts[argv[1]])
    if (paths.length) result.paths = paths.map(bounded)
  }
  if (argv[0] === 'workspace' && ['commit', 'exec', 'status', 'unmount'].includes(argv[1]) && positionals[0]) result.workspace = bounded(positionals[0])
  return result
}

/** Decode verified CLI receipt shapes only. A bare successful exit or current head is insufficient. */
export function savedVersions(operation: string, result: any): VersionLink[] {
  const allowed = ['file.write', 'file.edit', 'file.apply', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp', 'workspace.commit', 'branch.fork', 'branch.merge', 'branch.publish']
  if (!allowed.includes(operation) || !result || typeof result !== 'object') return []
  const link = (kind: 'Commit' | 'Layer', id: unknown, effect: VersionLink['effect']): VersionLink[] =>
    typeof id === 'string' && /^[a-f0-9]{66}$/.test(id) ? [{ kind, id, effect }] : []
  if (operation === 'branch.publish') {
    if (result.kind === 'Added') return link('Layer', (result.published_layer ?? result.publishedLayer)?.id, 'created')
    if (result.kind === 'UpToDate') return link('Layer', result.layer, 'unchanged')
    if (result.kind === 'NoChanges') return link('Layer', result.head_layer ?? result.headLayer, 'unchanged')
    return []
  }
  if (operation === 'branch.fork') return result.kind === 'Forked'
    ? result.head ? link('Commit', result.head, 'referenced') : link('Layer', result.base, 'referenced') : []
  if (operation === 'branch.merge') {
    const fastForward = result.fast_forward ?? result.fastForward
    return result.kind === 'Merged' && typeof fastForward === 'boolean'
      ? link('Commit', result.head, fastForward ? 'referenced' : 'created') : []
  }
  if (result.kind === 'Committed') return link('Commit', result.commit?.id ?? result.head, 'created')
  if (result.kind === 'UpToDate') return result.head ? link('Commit', result.head, 'unchanged') : link('Layer', result.base, 'unchanged')
  return []
}

/** Capture an SDK invocation once, preserving result/throw behavior and async caller identity. */
export async function traceInvocation<T>(operation: string, run: () => Promise<T>, targetProject?: string, targetWorkspace?: string, argv?: readonly string[]): Promise<T> {
  const trace = context.getStore()
  if (!trace) return run()
  const startedAt = Date.now(), id = randomUUID()
  let result: T | undefined, error: any
  try { result = await run(); return result } catch (e) { error = e; throw e } finally {
    const { record, onError, internal, workspace, receiptRoot, ...identity } = trace
    const targetKnown = operation !== 'workspace.commit' || !!workspace && targetWorkspace === workspace
    const receipt: Invocation = {
      ...identity, ...(targetProject ? { project: targetProject } : {}), ...(!targetKnown ? { project: '', captureGap: 'target-workspace-unconfirmed' } : {}), id, operation, ...(argv ? { arguments: operationArguments(argv) } : {}), source: 'sdk', startedAt, finishedAt: Date.now(),
      outcome: error ? error.transport === 'refusal' ? 'refusal' : 'unknown' : 'success',
      versions: error || internal || !targetKnown ? [] : savedVersions(operation, result),
      ...(error ? { error: String(error.code ?? error.message ?? error) } : {}),
    }
    try { await record(receipt) } catch (error) {
      // The mutation has already run. Retain its exact receipt rather than
      // retrying the operation or losing attribution when sidecar persistence fails.
      let reportedError: unknown = error
      if (receiptRoot) {
        try { spoolInvocation(receiptRoot, receipt) } catch (spoolError) {
          reportedError = new AggregateError([error, spoolError], 'The invocation could not be saved to its sidecar or recovery spool')
        }
      }
      onError?.(reportedError)
    }
  }
}

/** Atomically retain a completed invocation for the ordinary durable drain. */
function spoolInvocation(root: string, receipt: Invocation): void {
  const directory = join(root, 'invocation-receipts')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, `${receipt.id}.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

/** Only serializable provenance crosses into a shell. No shared current-tool variable. */
export function traceEnvironment(identity: TraceIdentity): string { return JSON.stringify(identity) }

/**
 * Generate the managed CLI. It forwards stdin/stdout/stderr and signals while
 * collecting only a bounded JSON receipt, atomically written to a private spool.
 * Bypassing this entry point is outside capture coverage.
 */
export function managedCli(options: { root: string; cli: string; home: string; bundle?: string | null; cacheHome?: string | null }): string {
  const directory = join(options.root, 'invocation-receipts')
  const file = join(options.root, 'agent-bin', 'layerfs')
  const implementation = `${file}.mjs`
  const pinned = canonicalPath(options.cli)
  // Never overwrite or recursively invoke the pin, even through a symlinked
  // root, output directory, CLI alias, or existing hardlink. Refuse before writes.
  for (const output of [file, implementation]) {
    const samePath = canonicalPath(output) === pinned
    const sameInode = existsSync(options.cli) && existsSync(output) && (() => {
      const source = statSync(options.cli), destination = statSync(output)
      return source.dev === destination.dev && source.ino === destination.ino
    })()
    if (samePath || sameInode) throw new Error('Managed CLI self-reference: select the installed LayerFS binary instead of the managed CLI entry point')
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  mkdirSync(join(options.root, 'agent-bin'), { recursive: true })
  const body = `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {writeFileSync,renameSync} from 'node:fs';\nimport {randomUUID} from 'node:crypto';\nconst savedVersions = ${savedVersions.toString()};\nconst operationArguments = ${operationArguments.toString()};\nconst firstPositional = ${firstPositional.toString()};\nconst invocationProject = ${invocationProject.toString()};\nconst config=${JSON.stringify({ ...options, directory })};\nlet identity; try { identity=JSON.parse(process.env.DSH_LAYERFS_TRACE_CONTEXT || 'null') } catch {}\nconst argv=process.argv.slice(2), operation=argv.slice(0,2).join('.').replaceAll('-','_'), id=randomUUID(), startedAt=Date.now();\nconst project=invocationProject(argv), projectScoped=['file','branch'].includes(argv[0]), workspaceCommit=operation==='workspace.commit', workspaceKnown=!workspaceCommit||!!identity?.workspace&&firstPositional(argv)===identity.workspace, targetKnown=workspaceKnown&&(!projectScoped||!!project);\nlet stdout='', overflow=false, spawnError=false;\nconst child=spawn(config.cli,argv,{stdio:['inherit','pipe','pipe'],env:{...process.env,LAYERFS_HOME:config.home,...(config.bundle?{LAYERFS_BUNDLE:config.bundle}:{}),...(config.cacheHome?{XDG_CACHE_HOME:config.cacheHome}:{})}});\nchild.stdout.on('data',chunk=>{if(!process.stdout.write(chunk))child.stdout.pause();if(stdout.length+chunk.length<4194304)stdout+=chunk.toString();else overflow=true});\nprocess.stdout.on('drain',()=>child.stdout.resume());\nchild.stderr.on('data',chunk=>{if(!process.stderr.write(chunk))child.stderr.pause()});\nprocess.stderr.on('drain',()=>child.stderr.resume());\nfor(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));\nchild.on('error',()=>{spawnError=true});\nchild.on('close',(code,signal)=>{\n if(identity && typeof identity.sessionId==='string' && typeof identity.project==='string'){\n  let result,valid=false;\n  if(!overflow)try{const frames=stdout.trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));\n   if(argv.includes('--events')){const finals=frames.filter(frame=>Object.hasOwn(frame,'result'));if(finals.length===1){result=finals[0].result;valid=true}}\n   else if(frames.length===1){result=frames[0];valid=true}\n  }catch{}\n  const completed=code===0&&!signal&&!spawnError;\n  const eligible=['file.write','file.edit','file.apply','file.rm','file.mkdir','file.mv','file.cp','workspace.commit','branch.fork','branch.merge','branch.publish'].includes(operation);\n  const success=completed&&(valid||!eligible);\n  const receipt={id,origin:identity.origin==='tool'?'tool':'host',sessionId:identity.sessionId,project:!workspaceKnown?'':projectScoped?(project||''):identity.project,...(!targetKnown?{captureGap:workspaceKnown?'target-project-unconfirmed':'target-workspace-unconfirmed'}:completed&&!valid&&eligible?{captureGap:'structured-result-unavailable'}:{}),...(Number.isInteger(identity.turn)?{turn:identity.turn}:{}),...(typeof identity.toolCallId==='string'?{toolCallId:identity.toolCallId}:{}),source:'cli',operation,arguments:operationArguments(argv),startedAt,finishedAt:Date.now(),outcome:success?'success':code===125?'refusal':'unknown',versions:success&&targetKnown&&!identity.internal?savedVersions(operation,result):[]};\n  try{const path=config.directory+'/'+id+'.json';writeFileSync(path+'.tmp',JSON.stringify(receipt),{mode:0o600});renameSync(path+'.tmp',path)}catch{process.stderr.write('LayerFS invocation receipt could not be recorded\\n')}\n }\n if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal)}else process.exitCode=code??1;\n});\n`
  // A .mjs implementation preserves the invoked command's stdin (no heredoc).
  const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(implementation)} "$@"\n`
  if (!existsSync(implementation) || readFileSync(implementation, 'utf8') !== body) writeFileSync(implementation, body, { mode: 0o700 })
  if (!existsSync(file) || readFileSync(file, 'utf8') !== script) writeFileSync(file, script, { mode: 0o700 })
  chmodSync(file, 0o700)
  return file
}
/** Resolve existing aliases and missing output leaves without hiding broken symlinks. */
function canonicalPath(value: string, depth = 0): string {
  if (depth > 40) throw new Error('The managed CLI path contains a symlink cycle')
  const path = resolve(value)
  try { return realpathSync(path) } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
    try {
      if (lstatSync(path).isSymbolicLink()) return canonicalPath(resolve(dirname(path), readlinkSync(path)), depth + 1)
    } catch (linkError: any) { if (linkError?.code !== 'ENOENT') throw linkError }
    const parent = dirname(path)
    return parent === path ? path : join(canonicalPath(parent, depth + 1), basename(path))
  }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/** Remove a spooled receipt only after durable sidecar recording succeeds. */
const draining = new Map<string, Promise<void>>()
export async function drainInvocations(root: string, record: (invocation: Invocation) => Promise<void>, sessionId?: string): Promise<void> {
  const previous = draining.get(root) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(() => drainReceipts(root, record, sessionId))
  draining.set(root, pending)
  try { await pending } finally { if (draining.get(root) === pending) draining.delete(root) }
}
async function drainReceipts(root: string, record: (invocation: Invocation) => Promise<void>, sessionId?: string): Promise<void> {
  const directory = join(root, 'invocation-receipts')
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue
    const path = join(directory, name)
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as Invocation
    if (sessionId && receipt.sessionId !== sessionId) continue
    await record(receipt)
    unlinkSync(path)
  }
}
