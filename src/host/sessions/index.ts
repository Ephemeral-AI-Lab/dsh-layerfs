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
 *   sessions.choose {sessionId, project|null}  place the session in a LayerFS project (or clear it);
 *                                              it stays in whichever workspace it was selected in
 *   sessions.prepareScratch             the Scratch workspace (a plain folder workspace)
 *   sessions.list {project}             local bindings + sessions stored in the project (imports missing ones)
 *   sessions.open {sessionId, project?, workspaceId?} open a session, importing it from the project if missing locally
 *   sessions.close {sessionId}          save and close its Sandbox
 *   sessions.forget {sessionId}         close and forget the binding; preserve scratch and history
 *   session.state {sessionId}           binding, checkpoints, Workspace status, store progress
 *   sessions.availability               poll Store health now (deactivating as needed); last health per Store
 *   session.place {sessionId}           the project a live session works in (New Session control)
 *   session.trajectory {sessionId}      the Trajectory tab's records, LayerFS calls and checkpoints by turn
 *   session.trajectory.record {sessionId, seq} one trajectory record in full (NotFound when not in the loaded log)
 *   checkpoints.create {sessionId, message?}
 *   checkpoints.diff {sessionId, from, to}
 *   checkpoints.restore {sessionId, commit}
 *   checkpoints.branch {sessionId, commit, turn}
 */
import { projectContext } from './prompt.ts'
import type { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import { CliError, pages } from '../layerfs/cli.ts'
import { notifyCallLog } from '../layerfs/call-log.ts'
import { outputsDir, readOutput } from '../layerfs/call-output.ts'
import { exitOfOutput, fastForwardOfOutput, receiptFromLine, toolScope, traceEnvironment, withTraceContext, type Invocation, type TraceIdentity } from '../layerfs/tracing.ts'
import { callsSince } from '../logs/source.ts'
import { parseTag, TAG_PREFIX } from '../../shared/logs.ts'
import { UNCLAIMED } from './catalog.ts'
import { LayerfsSessions } from './service.ts'
import { localPersistence, SessionStore } from './store.ts'
import { buildTrajectory, trajectoryDetail, type TrajectoryInput } from './trace.ts'

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
        const fastForward = line.argv[0] === 'branch' && line.argv[1] === 'merge' && line.kind === 'Merged' && line.tag ? fastForwardOfOutput(readOutput(outputsDir(ctx.layerfs.callLog), line.tag)) : undefined
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

    /** The DSH session log of a loaded session, or undefined when it is not loaded. */
    const sessionEvents = (id: string): any[] | undefined => {
      try {
        const events = (ctx.get('sessions' as never) as any)?.get?.(id)?.snapshotEvents?.(0)
        return Array.isArray(events) ? events : undefined
      } catch { return undefined }
    }
    /** What `buildTrajectory` reads: the log, receipts and checkpoints (shared subagents follow their parent's binding). */
    const trajectoryInput = async (id: string): Promise<TrajectoryInput> => {
      const persistence = ctx.get('sessionPersistence' as never) as any
      const sidecar = await Promise.resolve(persistence?.readSidecar?.(id)).catch(() => undefined)
      let binding = sessions.binding(id)
      if (binding?.kind === 'shared' && binding.parent) binding = sessions.binding(binding.parent) ?? binding
      const local = sessions.checkpoints(id)
      const events = sessionEvents(id)
      return {
        sessionId: id,
        project: binding?.project ?? persistence?.ownerOf?.(id)?.project ?? null,
        branch: binding?.branch ?? (typeof sidecar?.codeBranch === 'string' ? sidecar.codeBranch : null),
        ...(events ? { events } : {}),
        invocations: Array.isArray(sidecar?.invocations) ? sidecar.invocations : [],
        checkpoints: local.length ? local : Array.isArray(sidecar?.checkpoints) ? sidecar.checkpoints : [],
      }
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
        const add = (id: string, project: string | undefined, at: number, created = at) => {
          if (!project || project === scratch) return
          const projectId = provider?.projectIdOf?.(id) as string | undefined
          const key = projectId ?? project
          const row = rows.get(key) ?? { project, ...(projectId ? { projectId } : {}), lastActivity: 0, newestSession: 0, sessionIds: [] }
          if (!row.sessionIds.includes(id)) row.sessionIds.push(id)
          row.lastActivity = Math.max(row.lastActivity, at || 0)
          row.newestSession = Math.max(row.newestSession, created || 0)
          rows.set(key, row)
        }
        const seen = new Set<string>()
        for (const b of Object.values(state.sessions)) {
          if (b.kind === 'shared' || !b.project) continue
          seen.add(b.sessionId)
          add(b.sessionId, b.project, b.updatedAt ?? b.createdAt, b.createdAt)
        }
        const local = async (id: string) => {
          const snap = await persistence?.stat(id).catch(() => undefined)
          return snap && snap.header?.origin !== 'subagent' ? snap : undefined
        }
        for (const [id, pending] of Object.entries(state.pending)) {
          if (seen.has(id)) continue
          seen.add(id)
          const snap = await local(id)
          if (snap) add(id, pending.project, snap.header.createdAt)
        }
        for (const id of provider?.ownedSessionIds?.() ?? []) {
          if (seen.has(id)) continue
          const snap = await local(id)
          if (!snap) continue
          const sidecar = await provider.readSidecar?.(id).catch(() => undefined)
          if (sidecar?.bindingKind === 'shared') continue
          add(id, provider.ownerOf?.(id)?.project, snap.header.createdAt)
        }
        return { projects: [...rows.values()].sort((a, b) => b.lastActivity - a.lastActivity) }
      },
      'sessions.choose': async (args: any) => {
        const sessionId = need(args, 'sessionId')
        const project = typeof args?.project === 'string' && args.project ? args.project : null
        await sessions.choose(sessionId, project, args?.projectId)
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
        const localTitle = async (id: string) => {
          const live = (ctx.get('sessions' as never) as any)?.get(id as never) as any
          const titles = live?.snapshotEvents(0).filter((event: any) => event.type === 'session/title' && typeof event.data?.title === 'string') ?? []
          return titles.at(-1)?.data.title ?? (await provider?.readSidecar?.(id).catch(() => undefined))?.title ?? null
        }
        for (const b of Object.values(state.sessions)) {
          if (b.project !== project || b.kind === 'shared' || !belongs(b.sessionId)) continue
          const snap = await persistence?.stat(b.sessionId).catch(() => undefined)
          rows.set(b.sessionId, {
            sessionId: b.sessionId, title: snap ? await localTitle(b.sessionId) : null, branch: b.branch ?? null, state: b.state, local: !!snap,
            executionState: b.executionState ?? (b.state === 'bound' ? 'active' : 'inactive'), error: b.error ?? null,
            checkpoints: (state.checkpoints[b.sessionId] ?? []).filter((c) => c.commit && c.changed > 0).length,
            updatedAt: b.updatedAt, stored: !!state.mirror[b.sessionId] && !state.mirror[b.sessionId].error,
          })
        }
        for (const [id, pending] of Object.entries(state.pending)) {
          if (pending.project !== project || rows.has(id) || !belongs(id)) continue
          const snap = await persistence?.stat(id)
          if (snap) rows.set(id, { sessionId: id, title: await localTitle(id), state: 'pending', local: true, checkpoints: 0, updatedAt: snap.header.createdAt, stored: false })
        }
        for (const id of provider?.ownedSessionIds?.(project, unclaimed ? undefined : liveId) ?? []) {
          if (rows.has(id) || !belongs(id)) continue
          const snap = await persistence?.stat(id)
          if (!snap || snap.header.origin === 'subagent') continue
          const sidecar = await provider.readSidecar(id)
          if (sidecar?.bindingKind === 'shared') continue
          rows.set(id, {
            sessionId: id, title: await localTitle(id), state: 'local', local: true,
            checkpoints: (sidecar?.checkpoints ?? []).filter((c: any) => c.commit && c.changed > 0).length,
            updatedAt: snap.header.createdAt, stored: !!sidecar?.archive && !sidecar.archive.error,
          })
        }
        let discoveryError: { code: string, message: string } | null = null
        const discover = async () => {
          if (identityError) throw identityError
          return store.discover(project)
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
        return { project, discoveryError, sessions: [...rows.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) }
      },
      'sessions.open': async (args: any) => {
        const sessionId = need(args, 'sessionId')
        const workspaceId = typeof args?.workspaceId === 'string' && args.workspaceId ? args.workspaceId : undefined
        if (await localPersistence(ctx)?.stat(sessionId).catch(() => undefined)) {
          await sessions.attach(workspaceId, sessionId)
          return { sessionId, imported: false, navigate: { sessionId } }
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
        await sessions.attach(workspaceId, sessionId)
        return { ...out, navigate: { sessionId } }
      },
      'sessions.close': async (args: any) => { await sessions.close(need(args, 'sessionId'), 'user'); return { ok: true } },
      'sessions.forget': async (args: any) => { await sessions.forget(need(args, 'sessionId')); return { ok: true } },
      'session.state': (args: any) => sessions.view(need(args, 'sessionId')),
      'sessions.availability': async () => { await sessions.refreshAvailability(); return { stores: sessions.availability() } },
      'session.annotations': async (args: any) => {
        const id = need(args, 'sessionId')
        const persistence = ctx.get('sessionPersistence' as never) as any
        return await persistence?.readSidecar?.(id) ?? { invocations: [] }
      },
      'session.trajectory': async (args: any) => buildTrajectory(await trajectoryInput(need(args, 'sessionId'))),
      'session.trajectory.record': async (args: any) => {
        const id = need(args, 'sessionId')
        const seq = Number(args?.seq)
        if (!Number.isInteger(seq)) throw new CliError('InvalidInput', 'seq must be an integer')
        const detail = trajectoryDetail(sessionEvents(id), seq)
        if (!detail) throw new CliError('NotFound', `No trajectory record ${seq} in this session's loaded log`)
        return detail
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
        return await ctx.layerfs.lfs.commit.diff(b.project, from, to, { ...(args?.paths_only ? { paths_only: true } : {}) })
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
      'projects.branches': async (args: any) => ({ items: await pages((p) => ctx.layerfs.lfs.branch.list(need(args, 'project'), p)) }),
    })
  })
}
