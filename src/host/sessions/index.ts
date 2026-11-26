/**
 * Sessions area: project-owned conversations use LayerFS files and the selected
 * local folder as scratch; normal workspace sessions run as stock DSH. Session
 * binding, trajectory checkpoints and the LayerFS session store, wired to
 * DSH's agent lifecycle.
 *
 *   agent/created        hydrate local ownership and select the project preset;
 *                        opening a conversation never activates its workspace
 *                        (folder sessions retain stock DSH behavior)
 *   agent/pre-step       a bound session's step runs only in its mounted Workspace:
 *                        re-bind a failed/closed binding, else fail the turn
 *   tools/execute        the Workspace must still be bound; never re-binds mid-turn
 *   (timer)              Store health poll: deactivate conversations whose Store is gone
 *   agent/turn-stopping  checkpoint the turn (awaited before `turn/end`)
 *   session/event        `turn/end`: complete the checkpoint, schedule the store mirror
 *   agent/disposed       mirror now; close the Sandbox after `idleMinutes`
 *
 * Operations (the `layerfs` Remote):
 *   sessions.checkPlacement {project, projectId?, machine?}  read-only: would placing a new session there pass?
 *   sessions.choose {sessionId, project|null, machine?}  place the session in a LayerFS project (or clear it);
 *                    `machine`: where a PostgreSQL project's Sandbox runs (else placement.ts's default);
 *                                              it stays in whichever workspace it was selected in
 *   sessions.places {sessionIds}        the project of each of up to 200 sessions, in one read-only batch (ownership store)
 *   sessions.prepareScratch             the Scratch workspace (a plain folder workspace)
 *   sessions.list {project}             local bindings + sessions stored in the project (imports missing ones)
 *   sessions.open {sessionId, project?, workspaceId?} open a session, importing it from the project if missing locally
 *   sessions.close {sessionId}          save and close its Sandbox
 *   sessions.forget {sessionId}         close and forget the binding; preserve scratch and history
 *   session.state {sessionId, observe?, debug?} binding, checkpoints, Workspace status, store progress (observe: no interrupt or save)
 *   sessions.availability               poll Store health now (deactivating as needed); last health per Store
 *   session.place {sessionId}           the project a live session works in (New Session control)
 *   session.trajectory {sessionId, since?, before?}  the Trajectory tab's records, LayerFS calls and checkpoints by turn;
 *                    `since` answers `unchanged` when nothing moved, `before` reads the older page
 *   session.trajectory.record {sessionId, seq} one trajectory record in full (NotFound when not in the loaded log)
 *   session.trajectory.prompt-diff {sessionId, seq} a record's system/tools line diff (NotFound when it has none)
 *   checkpoints.create {sessionId, message?}
 *   checkpoints.diff {sessionId, from, to}
 *   checkpoints.restore {sessionId, commit}
 *   checkpoints.branch {sessionId, commit, turn}
 */
import { projectContext } from './prompt.ts'
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError, pages } from '../layerfs/cli.ts'
import { notifyCallLog } from '../layerfs/call-log.ts'
import { outputsDir, readOutput } from '../layerfs/call-output.ts'
import { exitOfOutput, fastForwardOfOutput, receiptFromLine, toolScope, traceEnvironment, withTraceContext, type Invocation, type TraceIdentity } from '../layerfs/tracing.ts'
import { callsSince } from '../logs/source.ts'
import { parseTag, TAG_PREFIX } from '../../shared/logs.ts'
import { branchFields } from '../../shared/session-branch.ts'
import { UNCLAIMED } from './catalog.ts'
import { LayerfsSessions } from './service.ts'
import { localPersistence, SessionStore } from './store.ts'
import { promptDiff } from './prompt-diff.ts'
import { normalizeKind } from '../../shared/trajectory.ts'
import { trajectoryDetail, trajectoryReader, type TrajectoryInput } from './trace.ts'

/** Stored session logs kept parsed for the Trajectory (finished subagents' logs, which DSH has unloaded). */
const STORED_LOGS = 16

export const name = 'dsh-layerfs-sessions'
export const inject = ['layerfs', 'layerfsRemote']

const need = (args: any, key: string): string => {
  const v = args?.[key]
  if (typeof v !== 'string' || !v) throw new CliError('InvalidInput', `${key} is required`)
  return v
}

/**
 * `<root>/agent-bin/layerfs`: the `layerfs` command agents get in bash. A thin wrapper
 * that exports this plugin's LayerFS home (and bundle) and execs the pinned
 * CLI — model shell calls get a scrubbed environment, so the home cannot come
 * from the host process's own env. Rewritten when the pin changes.
 */
function agentCli(ctx: Context): string | null {
  return ctx.layerfs.agentCli()
}

/** How often Store health is polled while a project conversation is active. */
const AVAILABILITY_POLL_MS = 10_000

/** The most session ids one `sessions.places` batch accepts. */
const PLACES_MAX = 200

/**
 * One recent-project row's per-session facts, kept while every value they were
 * read from holds: the log's stat identity, its sidecar's identity and the
 * binding activity. Any save, receipt, create, delete, import or migrate moves
 * one of those, so the next `projects.recent` recomputes that session instead
 * of answering a stale `lastActivity`.
 */
interface RecentFact {
  /** The values read for this row; a changed one is a miss. */
  key: string
  project: string
  projectId?: string
  lastActivity: number
  created: number
  /** When the facts were read: the memo is short-lived, never authoritative. */
  at: number
}

/** How long a recent-project fact may answer without re-reading its sidecar. */
const RECENT_FACT_MS = 10_000
/** The memo's bound: a long-lived host can see many project sessions. */
const RECENT_FACTS_MAX = 4096

/**
 * A session sidecar's file identity, as the persistence row computes it: the
 * same file, replaced by an atomic write, changes inode, size or times.
 */
function sidecarIdentity(path: string): string | undefined {
  try {
    const s = statSync(join(dirname(path), 'layerfs.json'), { bigint: true })
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  } catch { return undefined }
}

const turnOf = (session: any): number | undefined => {
  const events = session?.snapshotEvents(0) ?? []
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'turn/start') return Number(events[i].data?.turn)
  return undefined
}

export function apply(ctx: Context): void {
  ctx.plugin(LayerfsSessions)
  ctx.inject(['layerfsSessions', 'layerfs', 'layerfsRemote', 'workspaceRegistry'], (ctx) => {
    const sessions = ctx.layerfsSessions
    const record = async (invocation: Invocation): Promise<void> => {
      const persistence = ctx.get('sessionPersistence' as never) as any
      if (!persistence?.recordInvocation) throw new Error('Project session persistence is not available to record the invocation')
      await persistence.recordInvocation(invocation)
      ctx.layerfs.emit('layerfs-operation', { sessionId: invocation.sessionId })
    }
    /**
     * Receipts of calls the host did not see itself (agent shells' managed CLI):
     * the call log lines tagged `dsh:<sessionId>:<scope>.…` since each tool call
     * started, from whichever source is active, deduped by receipt id.
     */
    type ToolCall = { identity: TraceIdentity, since: number }
    const turnCalls = new Map<string, ToolCall[]>()
    const collect = async (sessionId: string, calls: readonly ToolCall[]): Promise<void> => {
      if (!calls.length) return
      const since = Math.min(...calls.map((c) => c.since)) - 1000
      const lines = await callsSince(ctx.layerfs, `${TAG_PREFIX}${sessionId}:`, since)
      if (!lines.length) return
      const persistence = ctx.get('sessionPersistence' as never) as any
      const sidecar = await Promise.resolve(persistence?.readSidecar?.(sessionId)).catch(() => undefined)
      const known = new Set<string>((sidecar?.invocations ?? []).map((i: any) => i?.id))
      for (const line of [...lines].reverse()) {
        const tag = parseTag(line.tag)
        if (!tag || tag.sessionId !== sessionId || known.has(tag.receiptId)) continue
        const call = calls.find((c) => c.identity.scope && tag.receiptId.startsWith(`${c.identity.scope}.`) && line.at >= c.since - 1000)
        if (!call) continue
        known.add(tag.receiptId)
        // The line has no exit code; a `workspace exec` call's stored output holds it in its final frame.
        const exit = line.argv[0] === 'workspace' && line.argv[1] === 'exec' && line.tag ? exitOfOutput(readOutput(outputsDir(ctx.layerfs.callLog), line.tag), line.argv.includes('--stream')) : undefined
        // Nor `fast_forward`: a merge's stored answer tells a new merge Commit from a moved pointer.
        const fastForward = line.argv[0] === 'branch' && line.argv[1] === 'merge' && normalizeKind(line.kind ?? '') === 'merged' && line.tag ? fastForwardOfOutput(readOutput(outputsDir(ctx.layerfs.callLog), line.tag)) : undefined
        await record(receiptFromLine(line, call.identity, tag.receiptId, exit, fastForward))
      }
    }
    const settle = async (sessionId: string): Promise<void> => {
      const calls = turnCalls.get(sessionId) ?? []
      turnCalls.delete(sessionId)
      await collect(sessionId, calls).catch((e) => ctx.logger('layerfs').warn('collect invocations: %s', String(e)))
    }
    ctx.on('tools/execute' as any, async (execution: any, next: () => Promise<any>) => {
      const agent = execution.agent
      if (!agent) return next()
      const id = String(agent.id)
      const place = sessions.placeOfId(id)
      if (!place?.project) return next()
      // A tool call never re-activates: access returning mid-turn waits for a new message.
      await sessions.ensureBound(agent, { rebind: false })
      let binding = sessions.binding(id)
      if (binding?.kind === 'shared' && binding.parent) binding = sessions.binding(binding.parent)
      const simulations = ctx.get('layerfsSimulations' as never) as any
      const scriptedWorkspace = simulations?.workspaceOfCall?.(id, String(execution.callId))
      // A scripted step's receipts name the run and step, so they join the script without its private journal.
      const step = simulations?.stepOfCall?.(id, String(execution.callId))
      const identity: TraceIdentity = { origin: 'tool', sessionId: id, project: place.project, workspace: scriptedWorkspace ?? binding?.ws, turn: turnOf(agent.session), toolCallId: execution.callId, scope: toolScope(id, String(execution.callId)), ...(step ? { step } : {}) }
      const call: ToolCall = { identity, since: Date.now() }
      const calls = turnCalls.get(id) ?? []
      calls.push(call)
      turnCalls.set(id, calls)
      try {
        return await withTraceContext({ ...identity, record, onError: (e) => ctx.logger('layerfs').warn('record invocation: %s', String(e)) }, next)
      } finally {
        await collect(id, [call]).catch((e) => ctx.logger('layerfs').warn('collect invocations: %s', String(e)))
        // Agent shells' wrappers append stand-in lines in their own processes.
        if (!(await ctx.layerfs.nativeLogs().catch(() => true))) notifyCallLog(ctx.layerfs.callLog)
      }
    })
    const store = new SessionStore(ctx, sessions)
    sessions.store = store
    ctx.effect(() => () => { store.dispose(); if (sessions.store === store) sessions.store = undefined }, 'dsh-layerfs: session store')
    // Sessions stored in known projects by another DSH appear here too.
    ctx.effect(() => {
      const timer = setTimeout(() => {
        void store.syncAll().then(async () => {
          const persistence = ctx.get('sessionPersistence' as never) as any
          const ids = new Set([...Object.keys(sessions.state.read().sessions), ...(persistence?.ownedSessionIds?.() ?? [])])
          for (const id of ids) await sessions.detach(id)
        }).catch((e) => ctx.logger('layerfs').warn('session recovery: %s', String(e)))
      }, 1500)
      return () => clearTimeout(timer)
    }, 'dsh-layerfs: session store sync')
    // LayerFS has no change events: poll Store health while any project
    // conversation is active (or waits to clear an availability error), and
    // deactivate those whose Store became unavailable. Read-only; starts nothing.
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (sessions.watchesAvailability()) void sessions.refreshAvailability().catch((e) => ctx.logger('layerfs').warn('availability: %s', String(e?.message ?? e)))
      }, AVAILABILITY_POLL_MS)
      return () => clearInterval(timer)
    }, 'dsh-layerfs: store availability')
    const idle = new Map<string, NodeJS.Timeout>()
    ctx.effect(() => () => { for (const t of idle.values()) clearTimeout(t); idle.clear() }, 'dsh-layerfs: idle timers')

    ctx.on('agent/created', async ({ agent, source }: any) => {
      clearTimeout(idle.get(String(agent.id)))
      await sessions.bindAgent(agent, String(source?.kind ?? source ?? 'create'))
      return undefined
    })

    // No project, no `layerfs` preset: a pick from the New Session row's preset
    // chip is moved back off it (DSH offers no per-session roster filter).
    ctx.on('agent-preset/selected' as any, (sessionId: any, preset: string) => {
      if (preset !== 'layerfs') return
      const agent = (ctx.get('agents' as never) as any)?.get?.(sessionId)
      if (agent) queueMicrotask(() => { void sessions.enforceFolderPreset(agent).catch(() => {}) })
    })

    ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
      clearTimeout(idle.get(String(payload.agent.id)))
      await sessions.ensureBound(payload.agent)
      return next()
    })

    ctx.on('agent/turn-stopping', async ({ agent, turn }: any) => {
      // Calls still running when their tool call returned (background shells).
      await settle(String(agent.id))
      if (ctx.layerfs.checkpoints === 'off') return
      const id = String(agent.id)
      const b = sessions.binding(id)
      if (!b || b.kind !== 'project') return
      await sessions.lane(id, () => sessions.checkpoint(id, 'turn', Number(turn), `dsh turn ${turn}`))
    })

    ctx.on('session/event', (session: any, event: any) => {
      if (event?.type !== 'turn/end') return
      const id = String(session.id)
      sessions.markTurnEnd(id, Number(event.data?.turn), Number(event.seq))
      store.schedule(id)
    })

    ctx.on('agent/disposed', ({ agent }: any) => {
      const id = String(agent.id)
      void settle(id)
      store.schedule(id, 0)
      const minutes = ctx.layerfs.idleMinutes
      const b = sessions.binding(id)
      if (!minutes || b?.kind !== 'project' || b.state !== 'bound') return
      clearTimeout(idle.get(id))
      idle.set(id, setTimeout(() => {
        idle.delete(id)
        void sessions.close(id, 'idle').catch((error) => ctx.logger('layerfs').warn('idle close %s: %s', id, error?.message ?? error))
      }, minutes * 60_000))
    })

    // The LayerFS CLI and the session's execution coordinates reach bash
    // through the managed DSH_* namespace (remote-bound sessions drive their
    // project files through `$DSH_LAYERFS_CLI`).
    ctx.inject(['shellEnv' as never], (scope) => {
      const dispose = (scope as any).shellEnv.register({
        name: 'layerfs',
        variables: {
          DSH_LAYERFS_CLI: { description: 'The pinned LayerFS CLI for this session\'s project (already bound to this app\'s LayerFS home)' },
          DSH_LAYERFS_PROJECT: { description: 'The LayerFS project this session works in' },
          DSH_LAYERFS_BRANCH: { description: 'The session Branch (`dsh.<id>[.rN]`): this conversation\'s saved history; it changes after a restore' },
          DSH_LAYERFS_WS: { description: 'The session\'s mounted LayerFS Workspace handle (`<sandbox>:<name>`)' },
          DSH_LAYERFS_TRACE_CONTEXT: { description: 'Invocation provenance for managed LayerFS commands; preserve unchanged' },
          DSH_LAYERFS_SDK: { description: 'File URL of the LayerFS Node SDK (`@layerfs/node`) bound to this app\'s LayerFS home: `const { default: layerfs } = await import(process.env.DSH_LAYERFS_SDK)`' },
        },
        resolve: (execution: any) => {
          const agent = execution?.agent
          if (!agent) return {}
          let b = sessions.binding(String(agent.id))
          if (b?.kind === 'shared' && b.parent) b = sessions.binding(b.parent) ?? b
          if (!b || b.state !== 'bound') return {}
          const cli = agentCli(ctx)
          if (!cli) return {}
          const sdk = ctx.layerfs.agentSdk()
          return {
            DSH_LAYERFS_CLI: cli,
            ...(sdk ? { DSH_LAYERFS_SDK: pathToFileURL(sdk).href } : {}),
            DSH_LAYERFS_TRACE_CONTEXT: traceEnvironment({ origin: 'tool', sessionId: String(agent.id), project: b.project!, workspace: (scope.get('layerfsSimulations' as never) as any)?.workspaceOfCall?.(String(agent.id), String(execution.callId)) ?? b.ws, turn: turnOf(agent.session), toolCallId: execution.callId, scope: toolScope(String(agent.id), String(execution.callId)) }),
            ...(b.project ? { DSH_LAYERFS_PROJECT: b.project } : {}),
            ...(b.branch ? { DSH_LAYERFS_BRANCH: b.branch } : {}),
            ...(b.ws ? { DSH_LAYERFS_WS: b.ws } : {}),
          }
        },
      })
      ctx.effect(() => () => dispose(), 'dsh-layerfs: shell env')
    })

    // What the agent is told about its LayerFS Workspace and scratch folder.
    ctx.inject(['systemPrompt'], (scope) => {
      const sp = scope.systemPrompt as any
      sp.context({
        name: 'layerfs:workspace',
        order: sp.getContextOrder('WORKING_DIRECTORY'),
        interpolate: false,
        text: (context: any) => {
          const id = context.agent?.id
          if (!id) return ''
          let b = sessions.binding(String(id))
          if (b?.kind === 'shared' && b.parent) b = sessions.binding(b.parent) ?? b
          if (!b) return ''
          if (sessions.isSimulationManaged(String(id))) {
            return `## LayerFS project\nProject files belong to ${JSON.stringify(b.project)}. The active model supplies explicit LayerFS commands and manages their saved contexts. Local commands run in scratch ${JSON.stringify(b.scratch)}; scratch is never checkpointed. Preserve actual tool results and report only confirmed changes.`
          }

          return projectContext(b, { checkpoints: ctx.layerfs.checkpoints === 'turn', subagent: String(id) !== b.sessionId })
        },
      })
    })

    /** Stored logs read for sessions DSH has not loaded, by id, kept while the file's size and mtime hold. */
    const storedLogs = new Map<string, { key: string, events: any[] }>()
    /** A loaded session's title, keyed by its log length: the scan is only redone when the log grows. */
    const titles = new Map<string, { seq: number, title: string | null }>()
    /**
     * The trajectory memo: one built answer per session keyed by its revision,
     * so a tab opening without `since` builds at most once between changes, and
     * an unchanged `since` costs bytes. Bounded by `trajectoryReader`.
     */
    const readTrajectory = trajectoryReader()
    /**
     * Recent-project facts, one per session, keyed by the log and sidecar
     * identities and the binding activity the row reads. A hit skips the
     * sidecar read; a miss (or a fact older than {@link RECENT_FACT_MS}) reads
     * it again, so a changed session shows its new row on the very next call.
     */
    const recentFacts = new Map<string, RecentFact>()
    /**
     * A session's DSH log: the loaded session's, else its stored log (a finished
     * subagent is unloaded, but its log stays on disk). Undefined when neither exists.
     */
    const sessionEvents = async (id: string): Promise<any[] | undefined> => {
      try {
        const events = (ctx.get('sessions' as never) as any)?.get?.(id)?.snapshotEvents?.(0)
        if (Array.isArray(events)) return events
      } catch { /* not loaded */ }
      try {
        const persistence = localPersistence(ctx)
        const snapshot = await persistence?.stat(id)
        if (!snapshot) return undefined
        const path = snapshot.location?.path
        const info = path && existsSync(path) ? statSync(path) : undefined
        const key = info ? `${info.size}:${info.mtimeMs}` : ''
        const kept = storedLogs.get(id)
        if (key && kept?.key === key) return kept.events
        const reader = await persistence.open(id, 'read')
        let read: any[]
        try { read = (await reader.read()).events } finally { await reader.close() }
        if (!Array.isArray(read)) return undefined
        if (key) {
          storedLogs.delete(id)
          storedLogs.set(id, { key, events: read })
          while (storedLogs.size > STORED_LOGS) storedLogs.delete(storedLogs.keys().next().value!)
        }
        return read
      } catch { return undefined }
    }
    /** What `buildTrajectory` reads: the log, receipts and checkpoints (shared subagents follow their parent's binding). */
    const trajectoryInput = async (id: string): Promise<TrajectoryInput> => {
      const persistence = ctx.get('sessionPersistence' as never) as any
      // Cached by the sidecar's file identity: this read runs on every event and
      // poll, and a long session's receipts are large (the unchanged check must
      // not re-parse them). Only the trajectory path shares the parsed value.
      const sidecar = await Promise.resolve(persistence?.readSidecar?.(id, { cached: true })).catch(() => undefined)
      let binding = sessions.binding(id)
      if (binding?.kind === 'shared' && binding.parent) binding = sessions.binding(binding.parent) ?? binding
      const local = sessions.checkpoints(id)
      const events = await sessionEvents(id)
      return {
        sessionId: id,
        project: binding?.project ?? persistence?.ownerOf?.(id)?.project ?? null,
        branch: binding?.branch ?? (typeof sidecar?.codeBranch === 'string' ? sidecar.codeBranch : null),
        ...(events ? { events } : {}),
        invocations: Array.isArray(sidecar?.invocations) ? sidecar.invocations : [],
        checkpoints: local.length ? local : Array.isArray(sidecar?.checkpoints) ? sidecar.checkpoints : [],
      }
    }

    /**
     * Publish one opened Session to clients exactly as DSH's own list does.
     *
     * `api-session/added` is only emitted by DSH's Session controller from
     * `session/created` (a cold resume) and `agent/created`/`agent/disposed`
     * (only while the Agent's Session is the published one). An open that
     * resolves an Agent which is *already live* therefore announces nothing,
     * and an announcement the client's event stream lost leaves its catalog
     * without the id — navigating to it is then refused (`sessions.retain:
     * unknown session`) and the pane stays on New Session. Rebuild the summary
     * from the same list state the controller publishes and emit it (an
     * idempotent upsert by session id), and hand it back in the open's answer
     * so the client can seed its catalog even when the event was lost.
     * @param sessionId - Session just opened.
     * @param agent - its resolved live Agent, when the open resolved one.
     * @returns the current list summary, when one can be built.
     */
    const publishSession = (sessionId: string, agent?: any): any => {
      const sessionsService = ctx.get('sessions' as never) as any
      const session = agent?.session ?? sessionsService?.get?.(sessionId)
      const controller = ctx.get('sessionController' as never) as any
      let summary: any
      try { summary = session && controller?.listState?.summaryFor?.(session) } catch (error: any) {
        ctx.logger('layerfs').warn('session %s: could not build its catalog summary: %s', sessionId, String(error?.message ?? error))
      }
      summary ??= {
        sessionId,
        updatedAt: Number(session?.header?.createdAt ?? Date.now()),
        agentAvailable: !!agent,
        running: String(agent?.status ?? '') === 'running',
        blank: false,
      }
      try { ctx.emit('api-session/added' as never, summary as never) } catch (error: any) {
        ctx.logger('layerfs').warn('session %s: could not announce it to clients: %s', sessionId, String(error?.message ?? error))
      }
      return summary
    }

    ctx.layerfsRemote.operate(ctx, {
      'projects.catalog': async () => {
        const provider = ctx.get('sessionPersistence' as never) as any
        return { rows: await provider.catalogProjects(), scratchKey: ctx.layerfs.scratchProject }
      },
      // Projects with sessions on this DSH, newest activity first (docs/specs/layerfs-workspaces.md §4).
      // Local records only: no LayerFS call, so listing never resolves or claims a project.
      'projects.recent': async () => {
        const provider = ctx.get('sessionPersistence' as never) as any
        const persistence = localPersistence(ctx)
        const state = sessions.state.read()
        const scratch = ctx.layerfs.scratchProject
        const rows = new Map<string, { project: string, projectId?: string, lastActivity: number, newestSession: number, sessionIds: string[] }>()
        const add = (id: string, project: string | undefined, at: number, created = at, projectId = provider?.projectIdOf?.(id) as string | undefined) => {
          if (!project || project === scratch) return
          const key = projectId ?? project
          const row = rows.get(key) ?? { project, ...(projectId ? { projectId } : {}), lastActivity: 0, newestSession: 0, sessionIds: [] }
          if (!row.sessionIds.includes(id)) row.sessionIds.push(id)
          row.lastActivity = Math.max(row.lastActivity, at || 0)
          row.newestSession = Math.max(row.newestSession, created || 0)
          rows.set(key, row)
        }
        /**
         * What one session's row reads, from its log, its sidecar and the owner
         * index. The sidecar is read only on a memo miss: its identity is part of
         * the key, so a rewrite (a save, a receipt, a migrate) is a miss and an
         * unchanged one costs one stat, not a parse of a long session's sidecar.
         */
        const factsOf = async (id: string, hinted: string | undefined): Promise<RecentFact | undefined> => {
          const snap = await persistence?.stat(id).catch(() => undefined)
          if (!snap || snap.header?.origin === 'subagent') { recentFacts.delete(id); return undefined }
          const project = hinted ?? provider?.ownerOf?.(id)?.project as string | undefined
          if (!project) { recentFacts.delete(id); return undefined }
          const projectId = provider?.projectIdOf?.(id) as string | undefined
          const path = snap.location?.path as string | undefined
          const sidecar = path ? sidecarIdentity(path) : undefined
          const createdAt = Number(snap.header?.createdAt ?? 0)
          const stat = typeof snap.revision === 'string' && snap.revision ? snap.revision : `${snap.sizeBytes ?? ''}:${createdAt}`
          const key = `${stat}|${sidecar ?? ''}|${projectId ?? ''}|${project}|${createdAt}`
          const kept = recentFacts.get(id)
          if (kept && kept.key === key && Date.now() - kept.at < RECENT_FACT_MS) return kept
          const value = await provider?.readSidecar?.(id, { cached: true, snapshot: snap }).catch(() => undefined)
          if (value?.bindingKind === 'shared') { recentFacts.delete(id); return undefined }
          const fact: RecentFact = { key, project, ...(projectId ? { projectId } : {}), lastActivity: createdAt, created: createdAt, at: Date.now() }
          // Without a sidecar file there is no identity to trust: no memo, so a
          // sidecar written later is read on the very next call.
          if (path && sidecar) {
            recentFacts.delete(id)
            recentFacts.set(id, fact)
            while (recentFacts.size > RECENT_FACTS_MAX) recentFacts.delete(recentFacts.keys().next().value!)
          } else recentFacts.delete(id)
          return fact
        }
        const seen = new Set<string>()
        for (const b of Object.values(state.sessions)) {
          if (b.kind === 'shared' || !b.project) continue
          seen.add(b.sessionId)
          // A binding's activity is in memory: read it fresh every call, so a
          // save's new `updatedAt` orders the rows on the very next read.
          add(b.sessionId, b.project, b.updatedAt ?? b.createdAt, b.createdAt)
        }
        for (const [id, pending] of Object.entries(state.pending)) {
          if (seen.has(id)) continue
          seen.add(id)
          const fact = await factsOf(id, pending.project)
          if (fact) add(id, fact.project, fact.lastActivity, fact.created, fact.projectId)
        }
        for (const id of provider?.ownedSessionIds?.() ?? []) {
          if (seen.has(id)) continue
          const fact = await factsOf(id, provider.ownerOf?.(id)?.project)
          if (fact) add(id, fact.project, fact.lastActivity, fact.created, fact.projectId)
        }
        return { projects: [...rows.values()].sort((a, b) => b.lastActivity - a.lastActivity) }
      },
      // A new conversation's placement, checked before the client creates its blank session.
      'sessions.checkPlacement': async (args: any) => {
        const projectId = typeof args?.projectId === 'string' && args.projectId ? args.projectId : undefined
        const machine = typeof args?.machine === 'string' && args.machine ? args.machine : undefined
        return await sessions.checkPlacement(need(args, 'project'), projectId, machine)
      },
      'sessions.choose': async (args: any) => {
        const sessionId = need(args, 'sessionId')
        const project = typeof args?.project === 'string' && args.project ? args.project : null
        const machine = typeof args?.machine === 'string' && args.machine ? args.machine : undefined
        await sessions.choose(sessionId, project, args?.projectId, machine)
        if (project) void store.sync(project).catch(() => {})
        return { sessionId, project }
      },
      'sessions.prepareScratch': async (args: any) => {
        const out = await sessions.ensureScratchWorkspace()
        void store.sync(ctx.layerfs.scratchProject).catch(() => {})
        return { ...out, ...(args?.navigate === false ? {} : { navigate: { workspaceId: out.workspaceId } }) }
      },
      'sessions.list': async (args: any) => {
        const project = need(args, 'project')
        const projectId = typeof args?.projectId === 'string' ? args.projectId : undefined
        const provider = ctx.get('sessionPersistence' as never) as any
        // The live identity at this address, read only (listing never claims): an
        // `unclaimed:` id from a listing may have been claimed since, and the
        // sessions placed then carry the new UUID. Local-only reads skip the CLI.
        let liveId = projectId
        let identityError: unknown
        if (projectId && !args?.localOnly) {
          liveId = await provider.catalog.assert(project, projectId, { claim: false })
            .then((row: any) => row.projectId as string, (error: unknown) => { identityError = error; return projectId })
        }
        const unclaimed = !!liveId?.startsWith(UNCLAIMED)
        // Still unclaimed: only sessions with no owner identity can be its own.
        const belongs = (id: string) => !liveId || (unclaimed ? !provider?.projectIdOf?.(id) : provider?.projectIdOf?.(id) === liveId)
        const state = sessions.state.read()
        const persistence = localPersistence(ctx)
        const rows = new Map<string, any>()
        const debug = args?.debug === true ? { t0: performance.now(), phases: {} as Record<string, number> } : undefined
        const mark = (name: string) => { if (debug) debug.phases[name] = +(performance.now() - debug.t0).toFixed(1) }
        /** Accumulate one step across sessions (stat vs sidecar vs title). */
        const add = (name: string, ms: number) => { if (debug) debug.phases[name] = +((debug.phases[name] ?? 0) + ms).toFixed(1) }
        // One list call reads each session's log once and its sidecar once: the
        // three loops overlap (an owned session may be pending), and a sidecar
        // read used to stat the same log again to find its folder.
        const snapshots = new Map<string, Promise<any>>()
        const statted = new Set<string>()
        const localIds = new Set<string>()
        const snapshotOf = (id: string) => {
          let snapshot = snapshots.get(id)
          if (!snapshot) {
            // Listing never imports: a pending session has no log yet, and a Store
            // import per session on every read made the expand slow.
            snapshot = Promise.resolve(persistence?.stat(id, { restore: false }))
            snapshots.set(id, snapshot)
            statted.add(id)
            void snapshot.then((snap) => { if (snap) localIds.add(id) }, () => {})
          }
          return snapshot
        }
        /** A stored row the list already stat'ed answers locally; an id it never saw is left to discovery. */
        const knownLocal = (id: string): boolean | undefined => statted.has(id) ? localIds.has(id) : undefined
        const sidecars = new Map<string, Promise<any>>()
        const sidecarOf = (id: string) => {
          let sidecar = sidecars.get(id)
          if (!sidecar) {
            // `cached`: the list only reads title/checkpoints/archive from the
            // sidecar, and a non-cached read structuredClones it — 52 MB of
            // receipts for a long session, ~500 ms per list.
            sidecar = snapshotOf(id).then((snap) => provider?.readSidecar?.(id, { snapshot: snap, cached: true }))
            sidecars.set(id, sidecar)
          }
          return sidecar
        }
        // A loaded session's title is its newest `session/title` event; scanning a
        // long log's events for it on every list made a 32-session project cost
        // ~5 ms a session. `seq` is the log length: while it holds, the title holds.
        const liveTitle = (id: string): string | null => {
          const live = (ctx.get('sessions' as never) as any)?.get?.(id as never) as any
          if (!live) return null
          const seq = typeof live.seq === 'number' ? live.seq : -1
          const kept = titles.get(id)
          if (kept && kept.seq === seq) return kept.title
          const tSnap = performance.now()
          const events: readonly any[] = live.snapshotEvents?.(0) ?? []
          add('title.snapshot', performance.now() - tSnap)
          const tScan = performance.now()
          let title: string | null = null
          for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i]
            if (event?.type === 'session/title' && typeof event.data?.title === 'string') { title = event.data.title; break }
          }
          add('title.scan', performance.now() - tScan)
          titles.set(id, { seq, title })
          while (titles.size > 1024) titles.delete(titles.keys().next().value!)
          return title
        }
        /** A loaded session's title, else its sidecar's; `sidecar` when the caller already read one. */
        const titleOf = async (id: string, sidecar?: any): Promise<string | null> => {
          const live = liveTitle(id)
          if (typeof live === 'string') return live
          const value = sidecar !== undefined ? sidecar : await sidecarOf(id).catch(() => undefined)
          return value?.title ?? null
        }
        /** Time one awaited step into the opt-in phase totals. */
        const timed = async <T,>(name: string, run: () => Promise<T> | T): Promise<T> => {
          if (!debug) return await run()
          const t = performance.now()
          try { return await run() } finally { add(name, performance.now() - t) }
        }
        for (const b of Object.values(state.sessions)) {
          if (b.project !== project || b.kind === 'shared' || !belongs(b.sessionId)) continue
          const snap = await timed('stat', () => snapshotOf(b.sessionId).catch(() => undefined))
          rows.set(b.sessionId, {
            sessionId: b.sessionId, title: snap ? await timed('title', () => titleOf(b.sessionId)) : null, branch: b.branch ?? null, state: b.state, local: !!snap,
            executionState: b.executionState ?? (b.state === 'bound' ? 'active' : 'inactive'), error: b.error ?? null, failure: b.failure ?? null,
            checkpoints: (state.checkpoints[b.sessionId] ?? []).filter((c) => c.commit && c.changed > 0).length,
            updatedAt: b.updatedAt, stored: !!state.mirror[b.sessionId] && !state.mirror[b.sessionId].error,
          })
        }
        for (const [id, pending] of Object.entries(state.pending)) {
          if (pending.project !== project || rows.has(id) || !belongs(id)) continue
          const snap = await timed('stat', () => snapshotOf(id))
          if (!snap) continue
          const sidecar = await timed('sidecar', () => sidecarOf(id).catch(() => undefined))
          rows.set(id, { sessionId: id, title: await timed('title', () => titleOf(id, sidecar)), state: 'pending', local: true, checkpoints: 0, updatedAt: snap.header.createdAt, stored: false })
        }
        for (const id of provider?.ownedSessionIds?.(project, unclaimed ? undefined : liveId) ?? []) {
          if (rows.has(id) || !belongs(id)) continue
          const snap = await timed('stat', () => snapshotOf(id))
          if (!snap || snap.header.origin === 'subagent') continue
          const sidecar = await timed('sidecar', () => sidecarOf(id))
          if (sidecar?.bindingKind === 'shared') continue
          rows.set(id, {
            sessionId: id, title: await timed('title', () => titleOf(id, sidecar)), state: 'local', local: true,
            checkpoints: (sidecar?.checkpoints ?? []).filter((c: any) => c.commit && c.changed > 0).length,
            updatedAt: snap.header.createdAt, stored: !!sidecar?.archive && !sidecar.archive.error,
          })
        }
        mark('owned')
        mark('pending')
        let discoveryError: { code: string, message: string } | null = null
        const discover = async () => {
          if (identityError) throw identityError
          return store.discover(project, { identity: liveId, local: knownLocal })
        }
        const discovered = args?.localOnly ? [] : await discover().catch((error: any) => {
          discoveryError = { code: error?.code ?? 'Unavailable', message: String(error?.message ?? error) }
          return []
        })
        for (const s of discovered) {
          if (s.shared) continue
          if (liveId && s.projectId && s.projectId !== liveId) {
            discoveryError = { code: 'BindingRequired', message: 'This restored copy contains conversations owned by another project identity. The original histories remain separate.' }
            continue
          }
          const row = rows.get(s.sessionId)
          rows.set(s.sessionId, {
            ...(row ?? { sessionId: s.sessionId, branch: s.codeBranch, state: 'stored', local: s.local, checkpoints: s.checkpoints, updatedAt: s.updatedAt }),
            title: s.title, stored: true,
          })
        }
        mark('discover')
        // a conversation archived in DSH (its row's Archive, or DSH's own) leaves the project's list until it is unarchived
        const archived = new Set<string>(ctx.workspaceRegistry?.archivedSessionIds ?? [])
        const listed = [...rows.values()].filter((r) => !archived.has(r.sessionId)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        // The same annotation `session.state` gives: the host says which branch each row is on.
        mark('rows')
        return { project, discoveryError, ...(debug ? { timing: debug.phases } : {}), sessions: listed.map((row) => ({ ...row, ...branchFields(row.sessionId, row.branch) })) }
      },
      'sessions.open': async (args: any) => {
        const sessionId = need(args, 'sessionId')
        const workspaceId = typeof args?.workspaceId === 'string' && args.workspaceId ? args.workspaceId : undefined
        const local = await localPersistence(ctx)?.stat(sessionId).catch(() => undefined)
        if (local) {
          // Opening a session DSH has not loaded (closed, or restored after a
          // restart) must announce it to clients: navigating to an id their
          // catalog does not list is refused (`sessions.retain: unknown session`).
          const open = ctx.get('sessionController' as never) as any
          const resolved = open?.resolveAgent ? await open.resolveAgent(sessionId) : undefined
          if (resolved && 'error' in resolved && resolved.error?.code === 'session/not-found') {
            throw new CliError('NotFound', 'This session is not stored locally or in any LayerFS project this DSH knows')
          }
          const summary = publishSession(sessionId, resolved?.agent)
          // DSH's client catalog lists the sessions of a workspace. A project
          // session is kept out of the folder workspaces (`attach` would detach
          // it), so the row's open attaches it to the workspace the person is in,
          // without the project guard: the catalog's list read then includes it.
          if (sessions.placeOfId(sessionId)?.project) {
            if (workspaceId) {
              try { await ctx.workspaceRegistry?.get?.(workspaceId as never)?.attachSession?.(sessionId as never) } catch (error: any) {
                ctx.logger('layerfs').warn('session %s not listed in workspace %s: %s', sessionId, workspaceId, error?.message ?? error)
              }
            }
          } else {
            await sessions.attach(workspaceId, sessionId)
          }
          return { sessionId, imported: false, navigate: { sessionId }, ...(summary ? { session: summary } : {}) }
        }
        // A project hint imports from that project; otherwise DSH's resume reaches the
        // session persistence row, which finds and imports the session itself.
        // Opening a session explicitly lifts a Presets Reset deletion record.
        ;(ctx.get('sessionPersistence' as never) as any)?.undelete?.(sessionId)
        const out = args?.project ? await store.import(String(args.project), sessionId, workspaceId) : { sessionId, imported: true }
        // Resuming the session announces it to every client (api-session/added) and binds its Workspace.
        const controller = ctx.get('sessionController' as never) as any
        if (!controller?.resolveAgent) throw new CliError('Unavailable', 'DSH\'s session controller is not available')
        const resolved = await controller.resolveAgent(sessionId)
        if (resolved && 'error' in resolved) {
          if (resolved.error?.code === 'session/not-found') throw new CliError('NotFound', 'This session is not stored locally or in any LayerFS project this DSH knows')
          throw resolved.error
        }
        const summary = publishSession(sessionId, resolved?.agent)
        await sessions.attach(workspaceId, sessionId)
        return { ...out, navigate: { sessionId }, ...(summary ? { session: summary } : {}) }
      },
      'sessions.close': async (args: any) => { await sessions.close(need(args, 'sessionId'), 'user'); return { ok: true } },
      'sessions.forget': async (args: any) => { await sessions.forget(need(args, 'sessionId')); return { ok: true } },
      // `observe: true` (the views' polls and effect reads): a read that changes nothing
      'session.state': (args: any) => sessions.view(need(args, 'sessionId'), { observe: args?.observe === true, debug: args?.debug === true }),
      'sessions.availability': async () => { await sessions.refreshAvailability(); return { stores: sessions.availability() } },
      'session.annotations': async (args: any) => {
        const id = need(args, 'sessionId')
        const persistence = ctx.get('sessionPersistence' as never) as any
        return await persistence?.readSidecar?.(id) ?? { invocations: [] }
      },
      'session.trajectory': async (args: any) => {
        const id = need(args, 'sessionId')
        const since = typeof args.since === 'string' ? args.since : undefined
        let before: number | undefined
        if (args.before !== undefined) {
          if (!Number.isSafeInteger(args.before) || args.before < 0) throw new CliError('InvalidInput', 'before must be a record seq')
          before = args.before
        }
        return readTrajectory(await trajectoryInput(id), { ...(since ? { since } : {}), ...(before !== undefined ? { before } : {}) })
      },
      'session.trajectory.record': async (args: any) => {
        const id = need(args, 'sessionId')
        const seq = Number(args?.seq)
        if (!Number.isInteger(seq)) throw new CliError('InvalidInput', 'seq must be an integer')
        const detail = trajectoryDetail(await sessionEvents(id), seq)
        if (!detail) throw new CliError('NotFound', `No trajectory record ${seq} in this session's log`)
        return detail
      },
      'session.trajectory.prompt-diff': async (args: any) => {
        const id = need(args, 'sessionId')
        const seq = Number(args?.seq)
        if (!Number.isInteger(seq)) throw new CliError('InvalidInput', 'seq must be an integer')
        const diff = promptDiff(await sessionEvents(id), seq)
        if (!diff) throw new CliError('NotFound', `No recorded prompt change at trajectory record ${seq}`)
        return diff
      },
      // B2 #7: a project session row's one action, Archive (DSH's own archive set; Unarchive in DSH brings it back)
      'sessions.archive': async (args: any) => {
        const id = need(args, 'sessionId')
        await ctx.workspaceRegistry.archiveSession(id as never)
        ctx.layerfs.emit('layerfs-session', { sessionId: id })
        return { sessionId: id, archived: true }
      },
      // One batch for every row mark and chip (the client's ownership store):
      // the same read-only lookups `session.place` uses, no mutation, no observe.
      'sessions.places': (args: any) => {
        const ids = args?.sessionIds
        if (!Array.isArray(ids) || ids.length > PLACES_MAX) {
          throw new CliError('InvalidInput', `sessionIds must be an array of at most ${PLACES_MAX} session ids`)
        }
        const values = [...new Set(ids.map((id: unknown) => {
          if (typeof id !== 'string' || !id) throw new CliError('InvalidInput', 'each session id must be a non-empty string')
          return id
        }))]
        const persistence = ctx.get('sessionPersistence' as never) as any
        const known = new Set<string>()
        let allKnown = true
        if (typeof sessions.knows === 'function') for (const id of values) {
          if (sessions.knows(id)) known.add(id)
          else allKnown = false
        }
        // Only when an id is not known in memory is the ownership index read, once
        // for the whole batch: an id no binding, pending choice, live session or
        // route names has no place and is answered null without a per-id read.
        const owned = !allKnown && typeof persistence?.ownedSessionIds === 'function'
          ? new Set<string>(persistence.ownedSessionIds()) : undefined
        const places: Record<string, { project: string, projectId?: string, scratch?: string } | null> = {}
        for (const id of values) {
          if (owned && !known.has(id) && !owned.has(id)) { places[id] = null; continue }
          const place = sessions.placeOfId(id)
          if (!place?.project) { places[id] = null; continue }
          // The project id is local routing metadata; a second batch inside the
          // service's window reuses it instead of re-reading the owner index per id.
          const projectId = typeof sessions.projectIdFor === 'function' ? sessions.projectIdFor(id) : persistence?.projectIdOf?.(id) as string | undefined
          places[id] = { project: place.project, ...(projectId ? { projectId } : {}), ...(place.scratch ? { scratch: place.scratch } : {}) }
        }
        return { places }
      },
      'session.place': (args: any) => {
        const id = need(args, 'sessionId')
        const place = sessions.placeOfId(id)
        const projectId = (ctx.get('sessionPersistence' as never) as any)?.projectIdOf?.(id)
        return { place: place ? { ...place, projectId } : null }
      },
      'sessions.scratch': async (args: any) => {
        const id = need(args, 'sessionId')
        const workspace = args?.workspaceId ? ctx.workspaceRegistry.get(String(args.workspaceId) as never) : undefined
        if (args?.workspaceId && !workspace) throw new CliError('NotFound', 'This local workspace no longer exists')
        await sessions.selectScratch(id, workspace?.path ?? need(args, 'cwd'))
        return { place: sessions.placeOfId(id) }
      },
      'sessions.scratchOptions': () => ({ workspaces: ctx.workspaceRegistry.list().map((w) => ({ workspaceId: String(w.id), title: w.title, path: w.path })) }),
      // Retire only generated legacy registrations. Registry deletion preserves
      // directories, logs, and project bindings; recorded anchor identities stay
      // available to migrate old conversation headers when they are resumed.
      'sessions.retireLegacyWorkspaces': async (args: any) => {
        const state = sessions.state.read()
        const root = `${ctx.layerfs.root}/projects`
        const candidates = ctx.workspaceRegistry.list().flatMap((workspace) => {
          const entry = Object.values(state.projects).find((p) => p.anchor === workspace.path)
          if (workspace.path !== root && (!entry || !workspace.path.startsWith(`${root}/`))) return []
          const unknown = workspace.sessionIds.filter((id) => !entry?.project && !sessions.placeOfId(String(id))?.project)
          return [{ workspaceId: String(workspace.id), title: workspace.title, path: workspace.path,
            project: entry?.project ?? null, sessions: [...workspace.sessionIds],
            unplacedSessions: unknown, retired: false }]
        })
        const before = new Map<string, boolean>()
        if (args?.apply === true) for (const candidate of candidates) {
          for (const id of candidate.sessions) before.set(String(id), !!await localPersistence(ctx)?.stat(String(id)))
          // Unplaced conversations in the old root group become ordinary
          // Ungrouped sessions. Deleting a registration never deletes its logs.
          candidate.retired = await ctx.workspaceRegistry.delete(candidate.workspaceId as never)
        }
        if (candidates.some((c) => c.retired)) ctx.layerfs.emit('layerfs-workspaces-changed', {})
        const preservedSessions = []
        for (const [sessionId, localBefore] of before) preservedSessions.push({ sessionId, localBefore, localAfter: !!await localPersistence(ctx)?.stat(sessionId) })
        return { candidates, preservedSessions }
      },
      'session.mirror': async (args: any) => { await store.mirror(need(args, 'sessionId')); return { ok: true } },
      'checkpoints.create': async (args: any) => {
        const id = need(args, 'sessionId')
        const checkpoint = await sessions.lane(id, () => sessions.checkpoint(id, 'manual', Number(args?.turn ?? 0), String(args?.message ?? 'Checkpoint')))
        store.schedule(id)
        return { checkpoint: checkpoint ?? null }
      },
      'checkpoints.diff': async (args: any) => {
        const id = need(args, 'sessionId')
        const b = sessions.binding(id)
        if (!b?.project) throw new CliError('InvalidInput', 'This session has no LayerFS project')
        const to = need(args, 'to')
        const from = typeof args?.from === 'string' && args.from ? args.from : null
        if (!from) return { files: [], from, to }
        // 2.0 `commit diff <to> --from <from>`: paths by default, each text file's lines `--with patch`
        return await ctx.layerfs.lfs.commit.diff(b.project, to, { from, ...(args?.paths_only ? {} : { with: ['patch'] }) })
      },
      'checkpoints.restore': async (args: any) => {
        const id = need(args, 'sessionId')
        const binding = await sessions.restore(id, need(args, 'commit'))
        store.schedule(id)
        return { binding }
      },
      'checkpoints.branch': async (args: any) => {
        const out = await sessions.branchAt(need(args, 'sessionId'), typeof args?.commit === 'string' ? args.commit : null, Number(args?.turn ?? 0))
        return { ...out, navigate: { sessionId: out.sessionId } }
      },
      'projects.branches': async (args: any) => ({ items: await pages((p) => ctx.layerfs.lfs.branch.list(need(args, 'project'), { ...p, detail: true })) }),
    })
  })
}
