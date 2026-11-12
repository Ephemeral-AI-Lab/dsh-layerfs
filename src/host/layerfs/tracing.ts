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
import { basename, dirname, join, resolve } from 'node:path'
import { OUTPUT_MAX, operationOf, type CallLine } from '../../shared/logs.ts'
import { appendCallLine, makeReceipt, renderCall, ROTATE_BYTES, savedFields } from './call-log.ts'
import { DEFAULT_BOUNDS, outputName, outputRecord, outputsDir, outputSink, writeOutput, type OutputBounds } from './call-output.ts'

export interface VersionLink { kind: 'Commit' | 'Layer'; id: string; effect: 'created' | 'unchanged' | 'referenced' }
/**
 * One receipt in a session sidecar (`layerfs.json`, `invocations[]`). Older
 * sidecars may also hold `arguments`, `source`, `startedAt`, `finishedAt` and
 * `error`; they are read as they are and never written any more.
 */
export interface Invocation {
  id: string; origin: 'tool' | 'host'; sessionId: string; project: string; turn?: number; toolCallId?: string
  operation: string; outcome: 'success' | 'refusal' | 'unknown'; versions: VersionLink[]; captureGap?: string
}
export interface TraceIdentity {
  origin: 'tool' | 'host'; sessionId: string; project: string; turn?: number; toolCallId?: string
  /** Machine-local execution handle, used only to verify workspace command targets. */
  workspace?: string
  /** Internal history writes are never project-file checkpoints. */
  internal?: boolean
  /** Prefix of this tool call's receipt ids (`<scope>.<random>`), see {@link toolScope}. */
  scope?: string
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

const portable = (identity: TraceIdentity, id: string, project: string): Pick<Invocation, 'id' | 'origin' | 'sessionId' | 'project' | 'turn' | 'toolCallId'> => ({
  id, origin: identity.origin === 'tool' ? 'tool' : 'host', sessionId: identity.sessionId, project,
  ...(Number.isInteger(identity.turn) ? { turn: identity.turn } : {}),
  ...(typeof identity.toolCallId === 'string' ? { toolCallId: identity.toolCallId } : {}),
})

/**
 * A receipt from a call log line made inside `identity`'s trace context.
 * `workspace commit` links versions only when its Workspace is the bound one.
 */
export function receiptFromLine(line: CallLine, identity: TraceIdentity, id: string): Invocation {
  const operation = operationOf(line.argv)
  const targetKnown = operation !== 'workspace.commit' || (!!identity.workspace && line.argv[2] === identity.workspace)
  const project = !targetKnown ? '' : ['file', 'branch'].includes(line.argv[0]) && line.argv[2] ? line.argv[2] : identity.project
  const outcome = line.outcome === 'ok' ? 'success' : line.outcome === 'Unknown' ? 'unknown' : 'refusal'
  const allowed: readonly string[] = CHECKPOINT_OPERATIONS
  const captureGap = !targetKnown ? 'target-workspace-unconfirmed'
    : outcome === 'success' && allowed.includes(operation) && !line.kind ? 'structured-result-unavailable' : undefined
  return {
    ...portable(identity, id, project), operation, outcome,
    versions: outcome === 'success' && targetKnown && !identity.internal ? lineVersions(line) : [],
    ...(captureGap ? { captureGap } : {}),
  }
}

/**
 * Capture an SDK invocation once, preserving result/throw behavior and async
 * caller identity. `run` gets the call's log tag (none outside a trace context).
 */
export async function traceInvocation<T>(operation: string, run: (tag?: string) => Promise<T>, targetProject?: string, targetWorkspace?: string): Promise<T> {
  const trace = context.getStore()
  if (!trace) return run(undefined)
  const { id, tag } = makeReceipt(trace.sessionId, trace.scope, randomUUID().replaceAll('-', ''))
  let result: T | undefined, error: any
  try { result = await run(tag); return result } catch (e) { error = e; throw e } finally {
    const targetKnown = operation !== 'workspace.commit' || !!trace.workspace && targetWorkspace === trace.workspace
    const receipt: Invocation = {
      ...portable(trace, id, !targetKnown ? '' : targetProject ?? trace.project), operation,
      outcome: error ? error.transport === 'refusal' ? 'refusal' : 'unknown' : 'success',
      versions: error || trace.internal || !targetKnown ? [] : savedVersions(operation, result),
      ...(!targetKnown ? { captureGap: 'target-workspace-unconfirmed' } : {}),
    }
    // The mutation has already run; never retry it. A tool call's receipt is
    // rebuilt from its tagged call log line when this write fails.
    try { await trace.record(receipt) } catch (recordError) { trace.onError?.(recordError) }
  }
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
