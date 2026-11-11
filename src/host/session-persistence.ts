/**
 * DSH session persistence with the LayerFS session store behind it. Replaces
 * the `session-persistence-jsonl` row in place (bundle patch): DSH's stock
 * JSONL backend still runs, in an isolated `sessionPersistence` slot, and
 * stays the local write-ahead log every call is served from. On top of it:
 *
 *   stat(id), open(id)  a session missing locally is imported from the LayerFS
 *             project that stores it (found by discovery over the projects
 *             this DSH has workspaces for when it never saw it; a miss is not
 *             searched again for a while), then answered
 *
 * `local` exposes the inner backend, so the session store reads and writes
 * DSH's log without recursing through these lookups. Until the dsh-layerfs
 * sessions area is up (this row loads early), every call is the stock one.
 */
import type { Context } from '@deepseek-ai/cordis'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionPersistence, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'

export const name = 'dsh-layerfs-session-persistence'

export type Config = jsonl.Config
export const Config = jsonl.Config

/** The `sessionPersistence` service: DSH's JSONL backend (`local`) plus imports from LayerFS on a local miss. */
export class LayerfsSessionPersistence extends (SessionPersistence as any) {
  constructor(ctx: Context, readonly local: any) {
    super(ctx)
  }

  /** The LayerFS session store, once the sessions area is up. */
  private get store(): any { return (this as any).ctx.get('layerfsSessions')?.store }

  /** Import a locally missing session from the LayerFS project that stores it. */
  private async restore(id: string): Promise<boolean> {
    const store = this.store
    if (!store) return false
    try {
      const project = await store.locate(id)
      if (!project) return false
      return (await store.import(project, id)).imported
    } catch (error: any) {
      ;(this as any).ctx.logger('layerfs').warn('session %s: import from LayerFS failed: %s', id, error?.message ?? error)
      return false
    }
  }

  create(header: any, options?: any) { return this.local.create(header, options) }
  flush() { return this.local.flush() }
  list(options?: any) { return this.local.list(options) }

  async stat(id: any, options?: any) {
    const snapshot = await this.local.stat(id, options)
    if (snapshot || !(await this.restore(String(id)))) return snapshot
    return await this.local.stat(id, options)
  }

  async open(id: any, access: any, options?: any) {
    try {
      return await this.local.open(id, access, options)
    } catch (error: any) {
      if (!(error instanceof SessionPersistenceNotFoundError) || !(await this.restore(String(id)))) throw error
      return await this.local.open(id, access, options)
    }
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const inner = ctx.isolate('sessionPersistence')
  await inner.plugin(jsonl as any, config).await()
  const local = inner.get('sessionPersistence' as never)
  if (!local) throw new Error('dsh-layerfs: the inner JSONL session persistence did not start')
  await ctx.plugin({
    name: 'dsh-layerfs-session-persistence-service',
    apply(serviceCtx: Context) { new LayerfsSessionPersistence(serviceCtx, local) },
  }).await()
  ctx.logger('layerfs').info('session persistence: JSONL at %s, missing sessions imported from LayerFS', config.root)
}
