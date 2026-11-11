/**
 * dsh-layerfs, host half.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LayerfsRemote } from './remote.ts'

export const name = 'dsh-layerfs'

export function apply(ctx: Context): void {
  ctx.plugin(LayerfsRemote)
  ctx.inject(['layerfsRemote'], (ctx) => {
    ctx.layerfsRemote.operate(ctx, {
      ping: () => ({ pong: true, at: new Date().toISOString() }),
    })
  })
}
