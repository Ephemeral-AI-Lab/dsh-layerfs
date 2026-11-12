/**
 * Additive invocation receipts. Original DSH events and CLI streams are never
 * rewritten. Every CLI call made inside a project session's trace context gets
 * one receipt id and carries it to LayerFS as `LAYERFS_LOGS_TAG=dsh:<sessionId>:<receiptId>`
 * (docs/specs/layerfs-logs.md §4); the call log line with that tag is the
 * record a receipt is built from when the host did not see the result itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { OUTPUT_MAX, operationOf, type CallLine, type CallOutput, type SimulationStep } from '../../shared/logs.ts'
import { appendCallLine, makeReceipt, renderCall, ROTATE_BYTES, savedFields } from './call-log.ts'
import { DEFAULT_BOUNDS, outputName, outputRecord, outputsDir, outputSink, writeOutput, type OutputBounds } from './call-output.ts'

export interface VersionLink { kind: 'Commit' | 'Layer'; id: string; effect: 'created' | 'unchanged' | 'referenced' }
/**
 * One receipt in a session sidecar (`layerfs.json`, `invocations[]`). It is
 * self-sufficient: the Logs page renders a call from it alone when this
 * machine's call log has no line for it (a session imported from another
 * machine, docs/specs/layerfs-logs.md §4). Older sidecars may lack the call
 * fields (`at` … `exit`) or hold `arguments`, `source`, `startedAt`,
 * `finishedAt` and `error`; they are read as they are and never written any more.
 */
export interface Invocation {
  id: string; origin: 'tool' | 'host'; sessionId: string; project: string; turn?: number; toolCallId?: string
  operation: string; outcome: 'success' | 'refusal' | 'unknown'; versions: VersionLink[]; captureGap?: string
  /** Wall-clock start (ms since the epoch) and duration (ms), as on the call log line. */
  at?: number; ms?: number
  /** The call as redacted CLI words ({@link portableArgv}): no secrets, no machine-local paths, bounded. */
  argv?: string[]
  /** The `LAYERFS_LOGS_TAG` the call carried (`dsh:<sessionId>:<id>`). */
  tag?: string
  /** The line's outcome code when not `ok` (refusal code, `Failed` or `Unknown`). */
  code?: string
  /** The result's `kind` (the line's `kind`). */
  kind?: string
  /** `workspace exec`: the exec id and the command's exit code (null: killed), when known. */
  execId?: string; exit?: number | null
  /** The simulation script step this tool call ran (`stepOfCall`). */
  step?: SimulationStep
  /** Arrived through a session store import: never in this machine's call log. */
  imported?: true
}
export interface TraceIdentity {
  origin: 'tool' | 'host'; sessionId: string; project: string; turn?: number; toolCallId?: string
  /** Machine-local execution handle, used only to verify workspace command targets. */
  workspace?: string
  /** Internal history writes are never project-file checkpoints. */
  internal?: boolean
  /** Prefix of this tool call's receipt ids (`<scope>.<random>`), see {@link toolScope}. */
  scope?: string
  /** The simulation script step this tool call runs, when scripted. */
  step?: SimulationStep
}
export interface TraceContext extends TraceIdentity {
  record: (invocation: Invocation) => Promise<void>
  onError?: (error: unknown) => void
}
const context = new AsyncLocalStorage<TraceContext>()
export const withTraceContext = <T>(value: TraceContext, run: () => T): T => context.run(value, run)
/** Archive writes are session persistence, not project-file activity. */
export const withoutTraceContext = <T>(run: () => T): T => context.exit(run)

/** Exact allowlist; matching a family prefix would mislabel exec/read/lifecycle calls. */
export const CHECKPOINT_OPERATIONS = ['file.write', 'file.edit', 'file.apply', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp', 'workspace.commit', 'branch.fork', 'branch.merge', 'branch.publish'] as const

/** The receipt-id prefix of one tool call: stable for (session, call), so the shell and the host agree. */
export function toolScope(sessionId: string, callId: string): string {
  return createHash('sha256').update(`${sessionId}\0${callId}`).digest('hex').slice(0, 8)
}

/** Decode verified CLI result shapes only. A bare successful exit or current head is insufficient. */
export function savedVersions(operation: string, result: any): VersionLink[] {
  const allowed: readonly string[] = CHECKPOINT_OPERATIONS
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

/**
 * Versions a call log line names. A line has no `fast_forward`, so `Merged`
 * counts as referenced; `Committed`/`Added` created; `UpToDate`/`NoChanges`
 * unchanged; `Forked` referenced.
 */
export function lineVersions(line: Pick<CallLine, 'argv' | 'kind' | 'commit' | 'layer'>): VersionLink[] {
  const allowed: readonly string[] = CHECKPOINT_OPERATIONS
  if (!allowed.includes(operationOf(line.argv))) return []
  const effects: Record<string, VersionLink['effect']> = { Committed: 'created', Added: 'created', UpToDate: 'unchanged', NoChanges: 'unchanged', Forked: 'referenced', Merged: 'referenced' }
  const effect = line.kind ? effects[line.kind] : undefined
  const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{66}$/.test(value)
  if (!effect) return []
  if (hex(line.commit)) return [{ kind: 'Commit', id: line.commit, effect }]
  if (hex(line.layer)) return [{ kind: 'Layer', id: line.layer, effect }]
  return []
}

const portable = (identity: TraceIdentity, id: string, project: string): Pick<Invocation, 'id' | 'origin' | 'sessionId' | 'project' | 'turn' | 'toolCallId' | 'step'> => ({
  id, origin: identity.origin === 'tool' ? 'tool' : 'host', sessionId: identity.sessionId, project,
  ...(Number.isInteger(identity.turn) ? { turn: identity.turn } : {}),
  ...(typeof identity.toolCallId === 'string' ? { toolCallId: identity.toolCallId } : {}),
  ...(typeof identity.step?.runId === 'string' && typeof identity.step?.stepKey === 'string' ? { step: { runId: identity.step.runId, stepKey: identity.step.stepKey } } : {}),
})

/** Receipt argv bounds: words kept, and the JSON size past which long words are cut to 40 characters. */
export const RECEIPT_ARGV_WORDS = 32
export const RECEIPT_ARGV_BYTES = 1024
/** Options whose value names a file or folder on the calling machine. */
const LOCAL_OPTIONS = ['from', 'source', 'dir', 'path', 'file', 'out', 'output', 'cwd', 'root']
const LOCAL_PATH = '<local path>'
let localRoots: string[] | undefined
/** An absolute path on this machine (home, temp, user and volume folders), never a project path. */
function isLocalPath(word: string): boolean {
  if (word.startsWith('~/') || word.startsWith('file://')) return true
  if (!word.startsWith('/')) return false
  localRoots ??= [...new Set([homedir(), tmpdir(), (() => { try { return realpathSync(tmpdir()) } catch { return tmpdir() } })(), '/private/', '/tmp/', '/var/folders/', '/Users/', '/home/', '/Volumes/', '/root/']
    .filter((root) => root && root !== '/').map((root) => root.endsWith('/') ? root : `${root}/`))]
  return localRoots.some((root) => word.startsWith(root) || `${word}/` === root)
}

/**
 * Call log words (already redacted by {@link renderCall}) made portable for a
 * receipt that travels with the session: values naming local files
 * (`--from`, `project init|import` sources, absolute home/temp paths) become
 * `<local path>`; at most {@link RECEIPT_ARGV_WORDS} words (then `<N more>`);
 * past {@link RECEIPT_ARGV_BYTES} of JSON, words beyond 40 characters are cut.
 */
export function portableArgv(words: readonly string[]): string[] {
  const kept = words.slice(0, RECEIPT_ARGV_WORDS).map((raw, index, all) => {
    const word = String(raw)
    if (index < 2 || /^<\d+ bytes>$/.test(word)) return word
    const option = index > 2 && all[index - 1]!.startsWith('--') && !word.startsWith('--') ? all[index - 1]!.slice(2) : undefined
    const source = all[0] === 'project' && (all[1] === 'init' || all[1] === 'import') && index === 3 && !word.startsWith('--')
    return (option && LOCAL_OPTIONS.includes(option)) || source || isLocalPath(word) ? LOCAL_PATH : word
  })
  if (words.length > RECEIPT_ARGV_WORDS) kept.push(`<${words.length - RECEIPT_ARGV_WORDS} more>`)
  return Buffer.byteLength(JSON.stringify(kept), 'utf8') <= RECEIPT_ARGV_BYTES ? kept
    : kept.map((word, index) => index < 2 || Array.from(word).length <= 40 ? word : `${Array.from(word).slice(0, 40).join('')}…`)
}

/** `workspace exec` facts: the `--exec-id` of the words and an exit code, when known. */
function execFacts(operation: string, words: readonly string[], exit: unknown): Pick<Invocation, 'execId' | 'exit'> {
  if (operation !== 'workspace.exec') return {}
  const at = words.indexOf('--exec-id'), execId = at >= 0 ? words[at + 1] : undefined
  return {
    ...(execId && !execId.startsWith('<') && execId.length <= 128 ? { execId } : {}),
    ...(exit === null || (typeof exit === 'number' && Number.isInteger(exit)) ? { exit } : {}),
  }
}

/** The exec exit code from a stored output: the final `{result}` frame, the last stdout line. */
export function exitOfOutput(output: CallOutput | { missing: true } | undefined): number | undefined {
  if (!output || 'missing' in output || typeof output.stdout !== 'string') return undefined
  const last = output.stdout.trimEnd().split('\n').at(-1)
  try { const code = JSON.parse(last ?? '')?.result?.exit_code; return Number.isInteger(code) ? code : undefined } catch { return undefined }
}

const shortText = (value: unknown): string | undefined => typeof value === 'string' && value && value.length <= 64 ? value : undefined

/**
 * A receipt from a call log line made inside `identity`'s trace context.
 * `workspace commit` links versions only when its Workspace is the bound one.
 * `exit` is the exec exit code from the call's stored output, when the caller has it.
 */
export function receiptFromLine(line: CallLine, identity: TraceIdentity, id: string, exit?: number): Invocation {
  const operation = operationOf(line.argv)
  const targetKnown = operation !== 'workspace.commit' || (!!identity.workspace && line.argv[2] === identity.workspace)
  const project = !targetKnown ? '' : ['file', 'branch'].includes(line.argv[0]) && line.argv[2] ? line.argv[2] : identity.project
  const outcome = line.outcome === 'ok' ? 'success' : line.outcome === 'Unknown' ? 'unknown' : 'refusal'
  const allowed: readonly string[] = CHECKPOINT_OPERATIONS
  const captureGap = !targetKnown ? 'target-workspace-unconfirmed'
    : outcome === 'success' && allowed.includes(operation) && !line.kind ? 'structured-result-unavailable' : undefined
  const code = line.outcome === 'ok' ? undefined : shortText(line.outcome), kind = shortText(line.kind)
  return {
    ...portable(identity, id, project), operation, outcome,
    versions: outcome === 'success' && targetKnown && !identity.internal ? lineVersions(line) : [],
    ...(captureGap ? { captureGap } : {}),
    at: line.at, ms: line.ms, argv: portableArgv(line.argv),
    ...(line.tag ? { tag: line.tag } : {}), ...(code ? { code } : {}), ...(kind ? { kind } : {}),
    ...execFacts(operation, line.argv, exit),
  }
}

/** The call an SDK invocation makes, for its receipt (computed only inside a trace context). */
export interface CallDescription { argv: readonly string[], input?: string | Buffer | null, bools?: readonly string[], at?: number, ms?: number }

/**
 * Capture an SDK invocation once, preserving result/throw behavior and async
 * caller identity. `run` gets the call's log tag (none outside a trace context).
 */
export async function traceInvocation<T>(operation: string, run: (tag?: string) => Promise<T>, targetProject?: string, targetWorkspace?: string, describe?: () => CallDescription): Promise<T> {
  const trace = context.getStore()
  if (!trace) return run(undefined)
  const { id, tag } = makeReceipt(trace.sessionId, trace.scope, randomUUID().replaceAll('-', ''))
  const at = Date.now(), started = performance.now()
  let result: T | undefined, error: any
  try { result = await run(tag); return result } catch (e) { error = e; throw e } finally {
    const targetKnown = operation !== 'workspace.commit' || !!trace.workspace && targetWorkspace === trace.workspace
    let words: string[] | undefined, call: CallDescription | undefined
    try {
      call = describe?.()
      if (call) words = renderCall(call.argv, call.input === undefined || call.input === null ? null : Buffer.byteLength(call.input), call.bools)
    } catch { /* receipt argv is best effort */ }
    const code = error ? shortText(error.code) ?? 'Failed' : undefined, kind = error ? undefined : shortText((result as any)?.kind)
    const receipt: Invocation = {
      ...portable(trace, id, !targetKnown ? '' : targetProject ?? trace.project), operation,
      outcome: error ? error.transport === 'refusal' ? 'refusal' : 'unknown' : 'success',
      versions: error || trace.internal || !targetKnown ? [] : savedVersions(operation, result),
      ...(!targetKnown ? { captureGap: 'target-workspace-unconfirmed' } : {}),
      at: Number.isFinite(call?.at) ? call!.at! : at, ms: Number.isFinite(call?.ms) ? call!.ms! : Math.max(0, Math.round(performance.now() - started)),
      ...(words ? { argv: portableArgv(words) } : {}),
      ...(tag ? { tag } : {}), ...(code ? { code } : {}), ...(kind ? { kind } : {}),
      ...execFacts(operation, words ?? [], error ? undefined : (result as any)?.exit_code),
    }
    // The mutation has already run; never retry it. A tool call's receipt is
    // rebuilt from its tagged call log line when this write fails.
    try { await trace.record(receipt) } catch (recordError) { trace.onError?.(recordError) }
  }
}

/**
 * Receipts merged by id (a store import into an existing sidecar): local
 * receipts stay in order, an incoming receipt with a known id updates it
 * field by field, new ones are appended marked `imported`.
 */
export function mergeInvocations(local: unknown, incoming: unknown): any[] {
  const out: any[] = Array.isArray(local) ? local.filter((row) => row && typeof row === 'object') : []
  const index = new Map<string, number>()
  out.forEach((row, at) => { if (typeof row.id === 'string') index.set(row.id, at) })
  for (const row of Array.isArray(incoming) ? incoming : []) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue
    const at = index.get(row.id)
    if (at === undefined) { index.set(row.id, out.length); out.push({ ...row, imported: true }) } else out[at] = { ...out[at], ...row }
  }
  return out
}

/** Only serializable provenance crosses into a shell. No shared current-tool variable. */
export function traceEnvironment(identity: TraceIdentity): string { return JSON.stringify(identity) }

/** Calls whose content travels on stdin (`content`/`json` arguments), for the stand-in's `<N bytes>`. */
export const CONTENT_CALLS = ['file.write', 'file.apply', 'project.storage_report', 'store.storage_report']

export interface ManagedCliOptions {
  root: string; cli: string; home: string; bundle?: string | null; cacheHome?: string | null
  /** The stand-in call log; without it (or with `native`) the wrapper writes no line. */
  callLog?: string | null
  /** The pinned CLI writes its own call log (#659): only set the tag. */
  native?: boolean
  /** Bool option names from the call table (rendering only). */
  bools?: readonly string[]
  /** `family.call` names whose content travels on stdin. */
  content?: readonly string[]
  /** Stand-in rotation threshold (tests). */
  rotateBytes?: number
  /** Output store bounds (tests). */
  outputBounds?: OutputBounds
}

/**
 * Generate the managed CLI. It forwards stdin/stdout/stderr, exit status and
 * signals; sets `LAYERFS_LOGS_TAG` from the shell's `DSH_LAYERFS_TRACE_CONTEXT`
 * with a new receipt id per invocation (removing an inherited tag otherwise);
 * for a tagged call, tees the child's stdout/stderr into bounded buffers (still
 * passing every byte through, with backpressure) and writes the call's output
 * to `trace/outputs/` on close, in both modes; and, in stand-in mode, appends
 * the call log line itself. Bypassing this entry point is outside capture coverage.
 */
export function managedCli(options: ManagedCliOptions): string {
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
  const standIn = !!options.callLog && !options.native
  const outputs = options.callLog ? outputsDir(options.callLog) : null
  mkdirSync(join(options.root, 'agent-bin'), { recursive: true })
  if (options.callLog) mkdirSync(dirname(options.callLog), { recursive: true, mode: 0o700 })
  const config = {
    cli: options.cli, home: options.home, bundle: options.bundle ?? null, cacheHome: options.cacheHome ?? null,
    callLog: standIn ? options.callLog : null, bools: options.bools ?? [], content: options.content ?? CONTENT_CALLS, rotate: options.rotateBytes ?? ROTATE_BYTES,
    outputs, max: OUTPUT_MAX, bounds: options.outputBounds ?? DEFAULT_BOUNDS,
  }
  const prelude = [
    `#!${process.execPath}`,
    `import {spawn} from 'node:child_process';`,
    `import * as fs from 'node:fs';`,
    `import {randomUUID,createHash} from 'node:crypto';`,
    `const makeReceipt = ${makeReceipt.toString()};`,
    `const config=${JSON.stringify(config)};`,
    `let identity; try { identity=JSON.parse(process.env.DSH_LAYERFS_TRACE_CONTEXT || 'null') } catch {}`,
    `const argv=process.argv.slice(2);`,
    `const receipt=identity&&typeof identity.sessionId==='string'&&identity.sessionId?makeReceipt(identity.sessionId,typeof identity.scope==='string'&&/^[a-f0-9]{1,16}$/.test(identity.scope)?identity.scope:undefined,randomUUID().replaceAll('-','')):undefined;`,
    `const env={...process.env,LAYERFS_HOME:config.home,...(config.bundle?{LAYERFS_BUNDLE:config.bundle}:{}),...(config.cacheHome?{XDG_CACHE_HOME:config.cacheHome}:{})};`,
    `delete env.LAYERFS_LOGS_TAG; if(receipt&&receipt.tag)env.LAYERFS_LOGS_TAG=receipt.tag;`,
    `const finish=(code,signal)=>{if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal)}else process.exitCode=code??1};`,
    `const logged=argv.length>=2&&/^[a-z][a-z_]*$/.test(argv[0])&&/^[a-z][a-z_-]*$/.test(argv[1])&&argv[0]!=='help'&&argv[0]!=='logs';`,
    `const capture=!!(config.outputs&&logged&&receipt&&receipt.tag);`,
  ]
  const passthrough = [
    `const child=spawn(config.cli,argv,{stdio:'inherit',env});`,
    `for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));`,
    `child.on('error',()=>{process.stderr.write('The LayerFS CLI could not be started\\n');process.exitCode=127});`,
    `child.on('close',finish);`,
  ]
  // Piped: a stand-in line or a tagged call's output needs the child's streams.
  const piping = [
    `const renderCall = ${renderCall.toString()};`,
    `const savedFields = ${savedFields.toString()};`,
    `const appendCallLine = ${appendCallLine.toString()};`,
    `const outputSink = ${outputSink.toString()};`,
    `const outputRecord = ${outputRecord.toString()};`,
    `const outputName = ${outputName.toString()};`,
    `const writeOutput = ${writeOutput.toString()};`,
    `const operation=(argv[0]??'')+'.'+(argv[1]??'').replaceAll('-','_');`,
    `const piped=logged&&config.content.includes(operation)&&!argv.some(word=>word==='--from'||word.startsWith('--from='));`,
    `const at=Date.now(),started=performance.now();`,
    `let stdout='',stderr='',overflow=false,spawnError=false,inputBytes=0;`,
    `const sinks=capture?{stdout:outputSink(config.max,'head'),stderr:outputSink(config.max,'tail')}:undefined;`,
    `const child=spawn(config.cli,argv,{stdio:[piped?'pipe':'inherit','pipe','pipe'],env});`,
    `if(piped){child.stdin.on('error',()=>{});process.stdin.on('data',chunk=>{inputBytes+=chunk.length;if(!child.stdin.write(chunk))process.stdin.pause()});child.stdin.on('drain',()=>process.stdin.resume());process.stdin.on('end',()=>child.stdin.end());process.stdin.on('error',()=>child.stdin.end())}`,
    `child.stdout.on('data',chunk=>{if(!process.stdout.write(chunk))child.stdout.pause();if(sinks)sinks.stdout.push(chunk);if(!config.callLog)return;if(stdout.length+chunk.length<4194304)stdout+=chunk.toString();else overflow=true});`,
    `process.stdout.on('drain',()=>child.stdout.resume());`,
    `child.stderr.on('data',chunk=>{if(!process.stderr.write(chunk))child.stderr.pause();if(sinks)sinks.stderr.push(chunk);if(stderr.length<65536)stderr+=chunk.toString()});`,
    `process.stderr.on('drain',()=>child.stderr.resume());`,
    `for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));`,
    `child.on('error',()=>{spawnError=true;process.stderr.write('The LayerFS CLI could not be started\\n');process.exitCode=127});`,
    `child.on('close',(code,signal)=>{`,
    ` if(piped)process.stdin.destroy();`,
    ` if(spawnError){process.exitCode=127;return}`,
    ` if(logged&&code!==2&&(capture||config.callLog)){`,
    `  let result,valid=false,refusal;`,
    `  if(config.callLog&&!overflow)try{const frames=stdout.trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));`,
    `   if(argv.includes('--events')){const finals=frames.filter(frame=>frame&&(Object.hasOwn(frame,'result')||Object.hasOwn(frame,'refusal')));if(finals.length===1){result=finals[0].result;refusal=finals[0].refusal;valid=!refusal}}`,
    `   else if(frames.length===1){result=frames[0];valid=true}`,
    `  }catch{}`,
    `  if(!refusal)for(const line of stderr.trim().split('\\n').reverse()){try{const frame=JSON.parse(line);if(frame&&typeof frame.code==='string'){refusal=frame;break}}catch{}}`,
    // The output first, so a page reloading on the new line already sees it.
    `  if(capture)writeOutput(fs,config.outputs,outputName(createHash,receipt.tag),outputRecord({tag:receipt.tag,exit:signal?null:code,stdout:sinks.stdout,stderr:sinks.stderr,refusal,max:config.max}),config.bounds);`,
    `  if(config.callLog){`,
    `   const outcome=signal||(code!==0&&code!==125)?'Unknown':code===125?(refusal&&typeof refusal.code==='string'&&refusal.code.length<=64?refusal.code:'Failed'):'ok';`,
    `   const words=renderCall(argv,piped?inputBytes:null,config.bools);`,
    `   appendCallLine(fs,config.callLog,{v:1,at,ms:Math.max(0,Math.round(performance.now()-started)),client:'cli',argv:words,outcome,...(outcome==='ok'&&valid?savedFields(words,result):{}),...(receipt&&receipt.tag?{tag:receipt.tag}:{})},config.rotate);`,
    `  }`,
    ` }`,
    ` finish(code,signal);`,
    `});`,
  ]
  // Native mode spawns and pipes too (never exec) whenever the call is tagged, to capture it.
  const body = [...prelude, `if(config.callLog||capture){`, ...piping, `}else{`, ...passthrough, `}`, ''].join('\n')
  // A .mjs implementation preserves the invoked command's stdin (no heredoc).
  const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(implementation)} "$@"\n`
  const write = (path: string, text: string) => {
    if (existsSync(path) && readFileSync(path, 'utf8') === text) return
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, text, { mode: 0o700 })
    renameSync(tmp, path)
  }
  write(implementation, body)
  write(file, script)
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
