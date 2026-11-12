/**
 * dsh-layerfs, host half: Machines, Storage, project-owned conversations and
 * stock workspace sessions. Project sessions use the selected folder as scratch,
 * native DSH logs, additive operation receipts, and saved file checkpoints.
 * The bundle's other rows live in session-persistence.ts and sandbox-policy.ts.
 *
 * Composition (each part registers operations on the `layerfs` Remote):
 *   remote.ts       the `layerfs` Remote namespace (call + events)
 *   service.ts      ctx.layerfs: pinned CLI/daemon, LAYERFS_HOME, state, events
 *   routes/         Connect's host HTTP API as the `http` operation (Machines, Storage, projects)
 *   sessions/       session binding, scratch folders, checkpoints, session store
 */
import type { Context } from '@deepseek-ai/cordis'
import { LayerfsRemote } from './remote.ts'
import { LayerfsService, type LayerfsConfig } from './service.ts'
import { children } from './layerfs/cli.ts'
import * as routes from './routes/index.ts'
import * as sessions from './sessions/index.ts'
import * as simulations from './simulations/index.ts'

export const name = 'dsh-layerfs'

export type Config = LayerfsConfig

export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(LayerfsRemote)
  ctx.plugin(LayerfsService, config)
  ctx.effect(() => () => { for (const child of children) child.kill('SIGTERM') }, 'dsh-layerfs: cli children')
  ctx.inject(['layerfsRemote', 'layerfs'], (ctx) => {
    ctx.layerfsRemote.operate(ctx, {
      'runtime.status': () => ctx.layerfs.status(),
      'runtime.save': (args: { cli: string | null, daemon: string | null, bundle?: string | null, cacheHome?: string | null }) => ctx.layerfs.savePin({ cli: args?.cli ?? null, daemon: args?.daemon ?? null, bundle: args?.bundle ?? null, ...(args && 'cacheHome' in args ? { cacheHome: args.cacheHome ?? null } : {}) }),
    })
    ctx.plugin(routes)
    ctx.plugin(sessions)
    ctx.plugin(simulations)
  })
}
