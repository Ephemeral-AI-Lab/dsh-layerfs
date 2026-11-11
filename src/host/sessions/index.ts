/**
 * Sessions area: sessions in a LayerFS project workspace work in that project
 * + their own scratch folder; sessions elsewhere run as stock DSH. Session
 * binding, trajectory checkpoints and the LayerFS session store, wired to
 * DSH's agent lifecycle.
 *
 *   agent/created        bind the session (fresh, resumed, forked, subagent). Binding
 *                        happens here, not lazily: DSH assembles the step's system prompt
 *                        (working directory, LayerFS section) before `agent/pre-step`;
 *                        a session in a folder workspace binds to nothing
 *   agent/pre-step       a bound session's step runs only in its mounted Workspace:
 *                        re-bind a failed/closed binding, else fail the turn
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
 *   sessions.forget {sessionId}         close, delete its scratch folder (branch stays)
 *   session.state {sessionId}           binding, checkpoints, Workspace status, store progress
 *   session.place {sessionId}           the project a live session works in (New Session control)
 *   checkpoints.create {sessionId, message?}
 *   checkpoints.diff {sessionId, from, to}
 *   checkpoints.restore {sessionId, commit}
 *   checkpoints.branch {sessionId, commit, turn}
 */
import type { Context } from '@deepseek-ai/cordis'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CliError, pages } from '../layerfs/cli.ts'
import { LayerfsSessions } from './service.ts'
import { localPersistence, SessionStore } from './store.ts'

export const name = 'dsh-layerfs-sessions'
export const inject = ['layerfs', 'layerfsRemote']

const need = (args: any, key: string): string => {
  const v = args?.[key]
  if (typeof v !== 'string' || !v) throw new CliError('InvalidInput', `${key} is required`)
  return v
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/**
 * `<root>/bin/layerfs`: the `layerfs` command agents get in bash. A thin wrapper
 * that exports this plugin's LayerFS home (and bundle) and execs the pinned
 * CLI — model shell calls get a scrubbed environment, so the home cannot come
 * from the host process's own env. Rewritten when the pin changes.
 */
function agentCli(ctx: Context): string | null {
  const cli = ctx.layerfs.cli
  if (!cli) return null
  const file = join(ctx.layerfs.root, 'bin', 'layerfs')
  const body = [
    '#!/bin/sh',
    `export LAYERFS_HOME=${q(ctx.layerfs.home)}`,
    ...(ctx.layerfs.bundle ? [`export LAYERFS_BUNDLE=${q(ctx.layerfs.bundle)}`] : []),
    `exec ${q(cli)} "$@"`,
    '',
  ].join('\n')
  if (!existsSync(file) || readFileSync(file, 'utf8') !== body) {
    mkdirSync(join(ctx.layerfs.root, 'bin'), { recursive: true })
    writeFileSync(file, body)
    chmodSync(file, 0o755)
  }
  return file
}

export function apply(ctx: Context): void {
  ctx.plugin(LayerfsSessions)
  ctx.inject(['layerfsSessions', 'layerfs', 'layerfsRemote'], (ctx) => {
    const sessions = ctx.layerfsSessions
    const store = new SessionStore(ctx, sessions)
    sessions.store = store
    ctx.effect(() => () => { store.dispose(); if (sessions.store === store) sessions.store = undefined }, 'dsh-layerfs: session store')
    // Sessions stored in known projects by another DSH appear here too.
    ctx.effect(() => {
      const timer = setTimeout(() => { void store.syncAll() }, 1500)
      return () => clearTimeout(timer)
    }, 'dsh-layerfs: session store sync')
    const idle = new Map<string, NodeJS.Timeout>()
    ctx.effect(() => () => { for (const t of idle.values()) clearTimeout(t); idle.clear() }, 'dsh-layerfs: idle timers')

    ctx.on('agent/created', async ({ agent, source }: any) => {
      clearTimeout(idle.get(String(agent.id)))
      await sessions.bindAgent(agent, String(source?.kind ?? source ?? 'create'))
      return undefined
    })

    ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
      clearTimeout(idle.get(String(payload.agent.id)))
      await sessions.ensureBound(payload.agent)
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

    // The LayerFS CLI and the session's Workspace coordinates reach bash
    // through the managed DSH_* namespace (remote-bound sessions drive their
    // project files through `$DSH_LAYERFS_CLI`).
    ctx.inject(['shellEnv' as never], (scope) => {
      const dispose = (scope as any).shellEnv.register({
        name: 'layerfs',
        variables: {
          DSH_LAYERFS_CLI: { description: 'The pinned LayerFS CLI for this session\'s project (already bound to this app\'s LayerFS home)' },
          DSH_LAYERFS_PROJECT: { description: 'The LayerFS project this session works in' },
          DSH_LAYERFS_BRANCH: { description: 'The session\'s private LayerFS branch' },
          DSH_LAYERFS_WS: { description: 'The session\'s mounted LayerFS Workspace handle (`<sandbox>:<name>`)' },
        },
        resolve: (execution: any) => {
          const agent = execution?.agent
          if (!agent) return {}
          let b = sessions.binding(String(agent.id))
          if (b?.kind === 'shared' && b.parent) b = sessions.binding(b.parent) ?? b
          if (!b || b.state !== 'bound') return {}
          const cli = agentCli(ctx)
          if (!cli) return {}
          return {
            DSH_LAYERFS_CLI: cli,
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
          const scratch = sessions.isScratch(b.project)
          if (b.state !== 'bound' || (!b.mount && !b.ws)) {
            return `## LayerFS project\nThis session belongs to LayerFS project ${JSON.stringify(b.project)}, but its Workspace is not ready${b.error ? ` (${b.error})` : ''}.`
          }
          return [
            '## LayerFS project Workspace',
            b.mount
              ? scratch
                ? `- Files: this session has no project of its own; it works in the Scratch project ${JSON.stringify(b.project)}, branch ${JSON.stringify(b.branch)}, mounted at ${JSON.stringify(b.mount)} (the working directory). It starts empty.`
                : `- Project files: LayerFS project ${JSON.stringify(b.project)}, branch ${JSON.stringify(b.branch)}, mounted at ${JSON.stringify(b.mount)} (the working directory). Work on the project there.`
              : [
                `- Project files: LayerFS project ${JSON.stringify(b.project)}, branch ${JSON.stringify(b.branch)}. Its Workspace is mounted in a Sandbox on machine ${JSON.stringify(b.machine ?? '?')}: no path on this host reaches it. Drive it through the LayerFS CLI \`$DSH_LAYERFS_CLI\`.`,
                '- Commands: `"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" \'<command>\' --stream` runs bash inside the Workspace root with live output (quote the command once). Read, search, edit and test files that way — only through `workspace exec`, never `file write`: those write the branch directly and bypass the mounted Workspace.',
                '- Saved history without a command: `"$DSH_LAYERFS_CLI" file read "$DSH_LAYERFS_PROJECT" "$DSH_LAYERFS_BRANCH" <path>`, `"$DSH_LAYERFS_CLI" branch commits "$DSH_LAYERFS_PROJECT" "$DSH_LAYERFS_BRANCH"`.',
                '- Never call `machine.*`, `store.*` or `backup.*`: machines, Stores and backups are the user\'s setup, not part of the task.',
              ].join('\n'),
            ctx.layerfs.checkpoints === 'turn'
              ? '- Checkpoints: at the end of every turn that changed files, the whole Workspace tree is committed to the branch as a checkpoint (including untracked files, build outputs and caches; .gitignore does not apply). The user can restore or branch from any checkpoint.'
              : '- Checkpoints are off: changes stay in the Workspace until saved.',
            b.mount
              ? `- Scratch folder: ${JSON.stringify(b.scratch)} is private to this session and never saved into the project. Put downloads, temporary files, logs and notes there instead of the Workspace.`
              : `- Scratch folder: ${JSON.stringify(b.scratch)} (the working directory) is private to this session on this host and never saved into the project. It is not inside the Workspace.`,
            '- The branch is never published to main automatically. Do not unmount the Workspace, close its Sandbox, or write `dsh.session.*` branches.',
          ].join('\n')
        },
      })
    })

    ctx.layerfsRemote.operate(ctx, {
      'sessions.choose': async (args: any) => {
        const sessionId = need(args, 'sessionId')
        const project = typeof args?.project === 'string' && args.project ? args.project : null
        await sessions.choose(sessionId, project)
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
        const state = sessions.state.read()
        const persistence = localPersistence(ctx)
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
        for (const s of await store.discover(project).catch(() => [])) {
          const row = rows.get(s.sessionId)
          rows.set(s.sessionId, {
            ...(row ?? { sessionId: s.sessionId, branch: s.codeBranch, state: 'stored', local: s.local, checkpoints: s.checkpoints, updatedAt: s.updatedAt }),
            title: s.title, stored: true,
          })
        }
        return { project, sessions: [...rows.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) }
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
      'session.place': (args: any) => ({ place: sessions.placeOfId(need(args, 'sessionId')) }),
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
