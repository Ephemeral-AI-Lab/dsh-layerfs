/**
 * dsh-layerfs, host half: Machines, Storage, project-owned conversations and
 * stock workspace sessions. Project sessions use the selected folder as scratch,
 * native DSH logs, additive operation receipts, and saved file checkpoints.
 * The bundle's other rows live in session-persistence.ts and sandbox-policy.ts.
 *
 * Composition (each part registers operations on the `layerfs` Remote):
 *   remote.ts       the `layerfs` Remote namespace (call + events)
 *   service.ts      ctx.layerfs: pinned CLI/daemon, the LayerFS folder and home, state, events
 *   routes/         Connect's host HTTP API as the `http` operation (Machines, Storage, projects)
 *   sessions/       session binding, scratch folders, checkpoints, session store
 *   logs/           LayerFS's own call log labelled with sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import { LayerfsRemote } from './remote.ts'
import { LayerfsService, type LayerfsConfig } from './service.ts'
import { children } from './layerfs/cli.ts'
import * as routes from './routes/index.ts'
import * as sessions from './sessions/index.ts'
import * as simulations from './simulations/index.ts'
import * as logs from './logs/index.ts'

export const name = 'dsh-layerfs'

export type Config = LayerfsConfig

export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(LayerfsRemote)
  ctx.plugin(LayerfsService, config)
  ctx.effect(() => () => { for (const child of children) child.kill('SIGTERM') }, 'dsh-layerfs: cli children')
  ctx.inject(['layerfsRemote', 'layerfs'], (ctx) => {
    // the setup check's background parts: pin lease, runtime watch, the first check (creates a missing folder)
    ctx.layerfs.startSetup()
    ctx.layerfsRemote.operate(ctx, {
      'runtime.status': () => ctx.layerfs.status(),
      'runtime.save': (args: { cli: string | null, daemon: string | null, bundle?: string | null, cacheHome?: string | null, runtime?: string | null }) => ctx.layerfs.savePin({ cli: args?.cli ?? null, daemon: args?.daemon ?? null, bundle: args?.bundle ?? null, ...(args?.runtime ? { runtime: args.runtime } : {}), ...(args && 'cacheHome' in args ? { cacheHome: args.cacheHome ?? null } : {}) }),
      // the setup check (docs/specs/layerfs-setup.md §3): runtime, LayerFS folder, one build
      'setup.status': () => ctx.layerfs.setup(),
      // a refusal's `layerfs home init` fix (a missing folder); an older LayerFS's folder is never converted
      'setup.init': () => ctx.layerfs.initHome(),
      'setup.recordDaemon': () => ctx.layerfs.recordDaemon(),
      // the setup modal's Open (the LayerFS folder, a home, or a home's listed folder by name) and Change… on the folder row
      'setup.open': (args: { which?: string, part?: string }) => ctx.layerfs.openFolder(args?.which, args?.part),
      // the setup modal's folder tree: what each home holds (one listing per listed folder)
      'setup.contents': () => ctx.layerfs.folderContents(),
      'setup.folder': (args: { path?: string }) => ({ next: ctx.layerfs.saveFolder(args?.path) }),
      'runtime.installed': () => ctx.layerfs.installed(),
    })
    ctx.plugin(routes)
    ctx.plugin(sessions)
    ctx.plugin(simulations)
    ctx.plugin(logs)
  })
}
