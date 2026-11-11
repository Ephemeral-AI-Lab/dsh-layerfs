/**
 * Connect's host HTTP API (Machines, Storage, projects) served as the
 * `http` operation: `{ method, path, body }` -> `{ status, body }`.
 * STUB: ported by the routes workstream.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-layerfs-routes'
export const inject = ['layerfs', 'layerfsRemote']

export function apply(ctx: Context): void {
  ctx.layerfsRemote.operate(ctx, {
    http: async (args: { method: string, path: string, body?: unknown }) => ({ status: 501, body: { code: 'Unsupported', message: `not yet: ${args.method} ${args.path}` } }),
  })
}
