/**
 * dsh-layerfs, host half: LayerFS Machines, Storage, project + scratch-folder
 * workspaces, the LayerFS session store and trajectory checkpoints for DSH.
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

export const name = 'dsh-layerfs'

export type Config = LayerfsConfig

export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(LayerfsRemote)
  ctx.plugin(LayerfsService, config)
  ctx.effect(() => () => { for (const child of children) child.kill('SIGTERM') }, 'dsh-layerfs: cli children')
  ctx.inject(['layerfsRemote', 'layerfs'], (ctx) => {
    ctx.layerfsRemote.operate(ctx, {
      'runtime.status': () => ctx.layerfs.status(),
      'runtime.save': (args: { cli: string | null, daemon: string | null }) => ctx.layerfs.savePin({ cli: args?.cli ?? null, daemon: args?.daemon ?? null }),
    })
    ctx.plugin(routes)
    ctx.plugin(sessions)
  })
}
