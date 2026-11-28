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
 *   metrics.ts              the metrics sampler (one machine.stats at a time, an hour in memory) behind /api/metrics
 *   inspect.ts              monitoring reads: /api/machines/:id/log and /files, /api/sandboxes/:name/log and /files (one read per key, last good answer kept)
 *   storage.ts, jobs.ts     /api/storage…, /api/stores…, /api/buckets…, /api/storage-jobs…
 *   doctor.ts               /api/doctor/… (the Doctor page: tree, runs, fixes)
 *   projects.ts             /api/status, /api/projects…, /api/sandboxes…, /api/workspaces…, /api/project-inits…
 *   storage-observations.ts Store statistics journals
 *   ../presets/manager.ts   /api/demo-presets… (Presets: build the Studio library, reset the home)
 *
 * Storage state lives in the LayerFS home, in client-neutral folders
 * (docs/specs/homes.md §5): buckets are LayerFS's records (`<home>/backup/`),
 * storage-jobs.json and doctor-jobs.json are in `<home>/job`, and
 * storage-observations/ and project-storage/ in `<home>/stat`. Entered keys and passwords go to `ctx.layerfs.secrets`
 * (default `<home>/secret`). `ctx.layerfs.state` keeps tmp/sources/.
 *
 * Events, published with `ctx.layerfs.emit(type, data)`; `data` is Connect's
 * whole HostEvent object (its `type` included), so a client handler written
 * for Connect's event stream takes `event.data` unchanged:
 *   storage-job  { type: 'storage-job', job: StorageJob }  a push/pull/move/backup/restore/compact job moved
 *   storage      { type: 'storage' }                       the Storage view changed (read it again)
 *   doctor       { type: 'doctor', id, state }             a Doctor job changed
 *   doctor-run   a DoctorRun (shared/doctor.ts)            a doctor call of the Doctor page moved (progress, report, failure)
 *   doctor-fix   a DoctorFixRun                            a fix of the Doctor page moved
 *   demo-preset  { jobId, preset, state }                  a preset build or reset moved
 * (Connect's projects and machines emitted no events; their pages poll.)
 *
 * Not ported: agents/chat, demos, runs, simulations, preset homes and
 * environment switching, demo-runtime, cli-activity, layerfs-runtime (ops `runtime.status` /
 * `runtime.save`), terminal CLI install, and the HTTP server, bearer token,
 * CORS and `/api/events` stream (the `layerfs/events` Remote replaces it).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CallLabel, CallLine } from '../../shared/logs.ts'
import { label } from '../logs/index.ts'
import { PresetManager } from '../presets/manager.ts'
import { presetStateFor } from '../presets/state-dir.ts'
import { createGroups, handle } from './router.ts'
import { sessionOfSandbox } from './projects.ts'
import type { RouteHost } from './util.ts'

export const name = 'dsh-layerfs-routes'
export const inject = ['layerfs', 'layerfsRemote']

export function apply(ctx: Context): void {
  const logger = ctx.logger('layerfs-routes')
  const host: RouteHost = {
    lfs: () => ctx.layerfs.lfs,
    home: ctx.layerfs.home,
    root: ctx.layerfs.state,
    folder: ctx.layerfs.folder,
    secrets: ctx.layerfs.secrets,
    jobs: ctx.layerfs.jobDir,
    stats: ctx.layerfs.statDir,
    cli: () => ctx.layerfs.cli,
    daemon: () => ctx.layerfs.daemon,
    bundle: () => ctx.layerfs.bundle,
    discover: () => ctx.layerfs.discovery(),
    ensureHostDaemon: () => ctx.layerfs.ensureHostDaemon(),
    emit: (type, data) => ctx.layerfs.emit(type, data),
    assertProjectIdentity: async (project, projectId) => {
      const persistence = ctx.get('sessionPersistence' as never) as any
      if (!persistence?.catalog) throw new Error('Project identity service is unavailable')
      // A read or project action checks the identity; it never claims an unclaimed project.
      return persistence.catalog.assert(project, projectId, { claim: false })
    },
    projectRemoving: async (project) => { await (ctx.get('layerfsSessions' as never) as any)?.closeProject(project) },
    projectRemoved: async (project) => { await (ctx.get('layerfsSessions' as never) as any)?.forgetProject(project) },
    machinesStopped: async (machines) => { (ctx.get('layerfsSessions' as never) as any)?.machinesStopped(machines) },
    sandboxClosed: async (name) => { (ctx.get('layerfsSessions' as never) as any)?.sandboxClosed(name) },
    sessionOf: (name) => sessionOfSandbox(name, (ctx.get('layerfsSessions' as never) as any)?.state?.read?.()?.sessions),
    closeSessionSandbox: async (name) => {
      const sessions = ctx.get('layerfsSessions' as never) as any
      const owner = sessions && Object.values(sessions.state.read().sessions as Record<string, any>).find((b) => b.sandbox === name && b.state === 'bound')
      if (!owner) return false
      await sessions.close(owner.sessionId, 'user')
      return true
    },
    labelTags: async (tags) => {
      const out: Record<string, CallLabel> = {}
      for (const line of await label(ctx, tags.map((tag) => ({ tag }) as CallLine))) if (line.tag && line.dsh) out[line.tag] = line.dsh
      return out
    },
    log: (line) => logger.warn(line),
  }
  const groups = createGroups(host, () => ctx.layerfs.status())
  const sessions = () => ctx.get('layerfsSessions' as never) as any
  // each LayerFS home has its own presets state: a manifest names the home it built in
  const presetState = presetStateFor(ctx.layerfs.migratedFrom ?? ctx.layerfs.state, ctx.layerfs.home)
  const presets = new PresetManager({
    spec: () => {
      const { cli, home, bundle, cacheHome, callLog, gate } = ctx.layerfs.lfs.spec
      return { cli, home, bundle, cacheHome, callLog, gate, daemon: ctx.layerfs.daemon, state: presetState }
    },
    busy: () => [
      ...(groups.storage.busy() ? ['a storage job'] : []),
      ...(groups.projects.busy() ? ['a project import'] : []),
      ...(groups.exports.busy() ? ['a project export'] : []),
      ...(groups.checks.busy() ? ['a doctor run'] : []),
      ...(groups.commands.busy() ? ['a Sandbox command'] : []),
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
    homeStores: async (also) => sessions()?.homeStores(also) ?? also.map((name) => ({ name })),
    projectConversations: (stores) => sessions()?.projectConversations(stores) ?? [],
    deleteProjectConversations: async (stores) => (await sessions()?.deleteProjectConversations(stores)) ?? [],
    machinesStopped: async (machines) => { sessions()?.machinesStopped(machines) },
    emit: (type, data) => ctx.layerfs.emit(type, data),
  }, presetState, ctx.layerfs.home)
  groups.presets = presets
  ctx.layerfs.exclusive = () => presets.exclusive() ? 'A preset build or reset is changing this LayerFS home; the session gets its Sandbox when it finishes. Send the message again then.' : null
  // the metrics sampler runs as long as dsh does, whether a page is open or not (layerfs-project#182 D1)
  groups.machines.metrics.start()
  ctx.effect(() => () => {
    groups.machines.metrics.stop()
    ctx.layerfs.exclusive = undefined
    groups.storage.close()
    groups.checks.close()
    groups.exports.close()
    void groups.projects.close()
  }, 'dsh-layerfs: routes state')
  ctx.layerfsRemote.operate(ctx, {
    http: (args: { method: string, path: string, body?: unknown }, signal: AbortSignal) => handle(groups, args ?? {}, signal),
    // The page stopped waiting for a monitoring read it named with `?rid=` (a left tab, a collapsed folder):
    // queued, the read leaves the inspect lane without a process; running, its process is ended.
    // Not a route: a POST would mark the machines view changed and drop its shared read.
    'inspect.cancel': (args: { rid?: unknown }) => ({ cancelled: groups.machines.reads.cancel(args?.rid) }),
  })
}
