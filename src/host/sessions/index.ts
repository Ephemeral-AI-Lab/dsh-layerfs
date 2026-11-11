/**
 * Sessions area: project + scratch-folder workspaces, session binding,
 * trajectory checkpoints and the LayerFS session store, wired to DSH's
 * agent lifecycle.
 *
 *   agent/created        bind the session (fresh, resumed, forked, subagent)
 *   agent/pre-step       retry a failed/closed binding before a step runs
 *   agent/turn-stopping  checkpoint the turn (awaited before `turn/end`)
 *   session/event        `turn/end`: complete the checkpoint, schedule the store mirror
 *   agent/disposed       mirror now; close the Sandbox after `idleMinutes`
 *
 * Operations (the `layerfs` Remote):
 *   sessions.prepare {project}          ensure the project's DSH workspace -> {workspaceId, navigate}
 *   sessions.create {project}           same, and ask the client to open a new session there
 *   sessions.prepareScratch             the Scratch workspace
 *   sessions.list {project}             local bindings + sessions stored in the project
 *   sessions.open {sessionId, project?} open a session, importing it from the project if missing locally
 *   sessions.close {sessionId}          save and close its Sandbox
 *   sessions.forget {sessionId}         close, delete its scratch folder (branch stays)
 *   session.state {sessionId}           binding, checkpoints, Workspace status, store progress
 *   checkpoints.create {sessionId, message?}
 *   checkpoints.diff {sessionId, from, to}
 *   checkpoints.restore {sessionId, commit}
 *   checkpoints.branch {sessionId, commit, turn}
 *   projects.workspaces                 the project workspaces this DSH knows
 */
import type { Context } from '@deepseek-ai/cordis'
import { CliError, pages } from '../layerfs/cli.ts'
import { LayerfsSessions } from './service.ts'
import { SessionStore } from './store.ts'

export const name = 'dsh-layerfs-sessions'
export const inject = ['layerfs', 'layerfsRemote']

const need = (args: any, key: string): string => {
  const v = args?.[key]
  if (typeof v !== 'string' || !v) throw new CliError('InvalidInput', `${key} is required`)
  return v
}

export function apply(ctx: Context): void {
  ctx.plugin(LayerfsSessions)
  ctx.inject(['layerfsSessions', 'layerfs', 'layerfsRemote'], (ctx) => {
    const sessions = ctx.layerfsSessions
    const store = new SessionStore(ctx, sessions)
    ctx.effect(() => () => store.dispose(), 'dsh-layerfs: session store timers')
    const idle = new Map<string, NodeJS.Timeout>()
    ctx.effect(() => () => { for (const t of idle.values()) clearTimeout(t); idle.clear() }, 'dsh-layerfs: idle timers')

    ctx.on('agent/created', async ({ agent, source }: any) => {
      clearTimeout(idle.get(String(agent.id)))
      await sessions.bindAgent(agent, String(source?.kind ?? source ?? 'create'))
      return undefined
    })

    ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
      const id = String(payload.agent.id)
      clearTimeout(idle.get(id))
      const b = sessions.binding(id)
      if (b && b.kind !== 'shared' && b.state !== 'bound') await sessions.bindAgent(payload.agent, 'pre-step')
      return next()
    })

    ctx.on('agent/turn-stopping', async ({ agent, turn }: any) => {
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
          if (b.kind === 'scratch') {
            return `## Scratch folder\nThis session has no LayerFS project. It works in its own scratch folder ${JSON.stringify(b.scratch)} (the working directory).`
          }
          if (b.state !== 'bound' || !b.mount) {
            return `## LayerFS project\nThis session belongs to LayerFS project ${JSON.stringify(b.project)}, but its Workspace is not mounted${b.error ? ` (${b.error})` : ''}.`
          }
          return [
            '## LayerFS project Workspace',
            `- Project files: LayerFS project ${JSON.stringify(b.project)}, branch ${JSON.stringify(b.branch)}, mounted at ${JSON.stringify(b.mount)} (the working directory). Work on the project there.`,
            ctx.layerfs.checkpoints === 'turn'
              ? '- Checkpoints: at the end of every turn that changed files, the whole Workspace tree is committed to the branch as a checkpoint (including untracked files, build outputs and caches; .gitignore does not apply). The user can restore or branch from any checkpoint.'
              : '- Checkpoints are off: changes stay in the Workspace until saved.',
            `- Scratch folder: ${JSON.stringify(b.scratch)} is private to this session and never saved into the project. Put downloads, temporary files, logs and notes there instead of the Workspace.`,
            '- The branch is never published to main automatically. Do not unmount the Workspace, close its Sandbox, or write `dsh.session.*` branches.',
          ].join('\n')
        },
      })
    })

    ctx.layerfsRemote.operate(ctx, {
      'sessions.prepare': async (args: any) => {
        const out = await sessions.ensureProjectWorkspace(need(args, 'project'))
        return { ...out }
      },
      'sessions.create': async (args: any) => {
        const out = await sessions.ensureProjectWorkspace(need(args, 'project'))
        return { ...out, navigate: { workspaceId: out.workspaceId } }
      },
      'sessions.prepareScratch': async () => {
        const out = await sessions.ensureScratchWorkspace()
        return { ...out, navigate: { workspaceId: out.workspaceId } }
      },
      'sessions.list': async (args: any) => {
        const project = need(args, 'project')
        const state = sessions.state.read()
        const persistence = ctx.get('sessionPersistence') as any
        const rows = new Map<string, any>()
        for (const b of Object.values(state.sessions)) {
          if (b.project !== project || b.kind === 'shared') continue
          const snap = await persistence?.stat(b.sessionId).catch(() => undefined)
          rows.set(b.sessionId, {
            sessionId: b.sessionId, title: null, branch: b.branch ?? null, state: b.state, local: !!snap,
            checkpoints: (state.checkpoints[b.sessionId] ?? []).filter((c) => c.kind !== 'base' && c.commit).length,
            updatedAt: b.updatedAt, stored: !!state.mirror[b.sessionId] && !state.mirror[b.sessionId].error,
          })
        }
        if (store.enabled) {
          for (const s of await store.discover(project).catch(() => [])) {
            const row = rows.get(s.sessionId)
            rows.set(s.sessionId, {
              ...(row ?? { sessionId: s.sessionId, branch: s.codeBranch, state: 'stored', local: s.local, checkpoints: s.checkpoints, updatedAt: s.updatedAt }),
              title: s.title, stored: true,
            })
          }
        }
        return { project, sessionStore: ctx.layerfs.sessionStore, sessions: [...rows.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) }
      },
      'sessions.open': async (args: any) => {
        const sessionId = need(args, 'sessionId')
        const persistence = ctx.get('sessionPersistence') as any
        if (await persistence?.stat(sessionId).catch(() => undefined)) return { sessionId, imported: false, navigate: { sessionId } }
        const project = args?.project ?? sessions.binding(sessionId)?.project
        if (!project) throw new CliError('NotFound', 'This session is not stored locally and no project names it')
        const out = await store.import(project, sessionId)
        return { ...out, navigate: { sessionId } }
      },
      'sessions.close': async (args: any) => { await sessions.close(need(args, 'sessionId'), 'user'); return { ok: true } },
      'sessions.forget': async (args: any) => { await sessions.forget(need(args, 'sessionId')); return { ok: true } },
      'session.state': (args: any) => sessions.view(need(args, 'sessionId')),
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
      'projects.workspaces': async () => ({ projects: Object.values(sessions.state.read().projects) }),
      'projects.branches': async (args: any) => ({ items: await pages((p) => ctx.layerfs.lfs.branch.list(need(args, 'project'), p)) }),
    })
  })
}
