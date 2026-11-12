/**
 * Connect's host HTTP API (Machines, Storage, projects) served as the
 * `http` operation: `{ method, path, body }` -> `{ status, body }`.
 *
 * The answers are Connect's (`host/server.js` and the managers behind it):
 * the same paths, bodies, refusal shape `{ code, transport?, message,
 * detail?, conversion? }` and refusal code -> HTTP status mapping (router.ts
 * STATUS). Integers outside JavaScript's safe range are sent as Connect sent
 * them, `{ $layerfs: 'i64-v1', decimal }` (renderer `exact-count.ts`).
 *
 *   router.ts               route table, status map, error answers
 *   machines.ts             /api/machines…, /api/platforms
 *   storage.ts, jobs.ts     /api/storage…, /api/stores…, /api/buckets…, /api/storage-jobs…, /api/doctor
 *   doctor.ts               /api/doctor-jobs…
 *   projects.ts             /api/status, /api/projects…, /api/sandboxes…, /api/workspaces…, /api/project-inits…
 *   storage-observations.ts Store statistics journals
 *   ../presets/manager.ts   /api/demo-presets… (Presets: build the Studio library, reset the home)
 *
 * Host state (Connect's `<state>` files) lives in `ctx.layerfs.root`:
 * buckets.json, secrets/, storage-jobs.json, doctor-jobs.json,
 * storage-observations/, project-sources/.
 *
 * Events, published with `ctx.layerfs.emit(type, data)`; `data` is Connect's
 * whole HostEvent object (its `type` included), so a client handler written
 * for Connect's event stream takes `event.data` unchanged:
 *   storage-job  { type: 'storage-job', job: StorageJob }  a push/pull/move/backup/restore job moved
 *   storage      { type: 'storage' }                       the Storage view changed (read it again)
 *   doctor       { type: 'doctor', id, state }             a Doctor job changed
 *   demo-preset  { jobId, preset, state }                  a preset build or reset moved
 * (Connect's projects and machines emitted no events; their pages poll.)
 *
 * Not ported: agents/chat, demos, runs, simulations, preset homes and
 * environment switching, demo-runtime, cli-activity, layerfs-runtime (ops `runtime.status` /
 * `runtime.save`), terminal CLI install, and the HTTP server, bearer token,
 * CORS and `/api/events` stream (the `layerfs/events` Remote replaces it).
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { PresetManager } from '../presets/manager.ts'
import { createGroups, handle } from './router.ts'
import type { RouteHost } from './util.ts'

export const name = 'dsh-layerfs-routes'
export const inject = ['layerfs', 'layerfsRemote']

export function apply(ctx: Context): void {
  const logger = ctx.logger('layerfs-routes')
  const host: RouteHost = {
    lfs: () => ctx.layerfs.lfs,
    home: ctx.layerfs.home,
    root: ctx.layerfs.root,
    cli: () => ctx.layerfs.cli,
    daemon: () => ctx.layerfs.daemon,
    discover: () => ctx.layerfs.discovery(),
    ensureNative: () => ctx.layerfs.ensureNative(),
    emit: (type, data) => ctx.layerfs.emit(type, data),
    assertProjectIdentity: async (project, projectId) => {
      const persistence = ctx.get('sessionPersistence' as never) as any
      if (!persistence?.catalog) throw new Error('Project identity service is unavailable')
      return persistence.catalog.assert(project, projectId)
    },
    projectRemoving: async (project) => { await (ctx.get('layerfsSessions' as never) as any)?.closeProject(project) },
    projectRemoved: async (project) => { await (ctx.get('layerfsSessions' as never) as any)?.forgetProject(project) },
    machinesStopped: async (machines) => { (ctx.get('layerfsSessions' as never) as any)?.machinesStopped(machines) },
    sandboxClosed: async (name) => { (ctx.get('layerfsSessions' as never) as any)?.sandboxClosed(name) },
    closeSessionSandbox: async (name) => {
      const sessions = ctx.get('layerfsSessions' as never) as any
      const owner = sessions && Object.values(sessions.state.read().sessions as Record<string, any>).find((b) => b.sandbox === name && b.state === 'bound')
      if (!owner) return false
      await sessions.close(owner.sessionId, 'user')
      return true
    },
    log: (line) => logger.warn(line),
  }
  const groups = createGroups(host, () => ctx.layerfs.status())
  const sessions = () => ctx.get('layerfsSessions' as never) as any
  const presets = new PresetManager({
    spec: () => {
      const { cli, home, bundle } = ctx.layerfs.lfs.spec
      return { cli, home, bundle, daemon: ctx.layerfs.daemon, state: join(ctx.layerfs.root, 'presets') }
    },
    busy: () => [
      ...(groups.storage.busy() ? ['a storage job'] : []),
      ...(groups.projects.busy() ? ['a project import'] : []),
      ...(groups.doctor.busy() ? ['a doctor run'] : []),
    ],
    boundSessions: () => Object.values((sessions()?.state.read().sessions ?? {}) as Record<string, any>)
      .filter((b) => b.kind === 'project' && b.state === 'bound' && b.sandbox)
      .map((b) => ({ id: String(b.sessionId), project: b.project ?? null })),
    dshProjects: () => {
      const state = sessions()?.state.read()
      if (!state) return []
      const all = Object.values(state.sessions as Record<string, any>)
      return Object.keys(state.projects).sort().map((project) => ({ project, sessions: all.filter((b) => b.project === project && b.kind !== 'shared').length }))
    },
    forgetProject: async (project) => { await sessions()?.forgetProject(project) },
    machinesStopped: async (machines) => { sessions()?.machinesStopped(machines) },
    emit: (type, data) => ctx.layerfs.emit(type, data),
  }, join(ctx.layerfs.root, 'presets'), ctx.layerfs.home)
  groups.presets = presets
  ctx.layerfs.exclusive = () => presets.exclusive() ? 'A preset build or reset is changing this LayerFS home; the session gets its Sandbox when it finishes. Send the message again then.' : null
  ctx.effect(() => () => {
    ctx.layerfs.exclusive = undefined
    groups.storage.close()
    void groups.projects.close()
  }, 'dsh-layerfs: routes state')
  ctx.layerfsRemote.operate(ctx, {
    http: (args: { method: string, path: string, body?: unknown }) => handle(groups, args ?? {}),
  })
}
