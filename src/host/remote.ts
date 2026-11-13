/**
 * Host face of the `layerfs` Remote namespace: a TypertRemoteService whose
 * `call` dispatches `{ op, args }` to registered operation handlers and whose
 * `events` stream forwards host events to each connected Client.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'
import { NAMESPACE, PACKAGE, SERVICE, remoteSpec, type LayerfsCall, type LayerfsEvent } from '../shared/remote-spec.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No operation of that name is registered. */
    'layerfs/unknown-op': { readonly op: string }
    /** An operation failed; LayerFS refusals keep their code and detail. */
    'layerfs/failed': { readonly op: string, readonly code?: string, readonly detail?: unknown }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    layerfsRemote: LayerfsRemote
  }
}

/** One operation handler. */
export type Operation = (args: any, signal: AbortSignal) => unknown

const info = createTypertRemoteInfo(remoteSpec(z) as never, z)

/** The `layerfs` namespace service. */
export class LayerfsRemote extends TypertRemoteService {
  static inject = ['typert']
  private readonly operations = new Map<string, Operation>()
  private readonly listeners = new Set<(event: LayerfsEvent) => void>()

  constructor(ctx: Context) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
    ctx.effect(() => (ctx.typert as any).register({
      package: PACKAGE,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      get invocations() { return info.descriptors },
    } as never), 'dsh-layerfs: typert')
  }

  /**
   * Register operations for the caller's lifetime.
   * @param ctx - owning context; its disposal removes the operations.
   * @param table - operation name to handler.
   */
  operate(ctx: Context, table: Record<string, Operation>): void {
    ctx.effect(() => {
      for (const [name, fn] of Object.entries(table)) {
        if (this.operations.has(name)) throw new Error(`dsh-layerfs: duplicate operation ${name}`)
        this.operations.set(name, fn)
      }
      return () => { for (const name of Object.keys(table)) this.operations.delete(name) }
    }, 'dsh-layerfs: operations')
  }

  /** Publish one event to every open `events` stream. */
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners) listener({ type, data })
  }

  @Remote('call')
  async call(request: LayerfsCall, signal: AbortSignal): Promise<unknown> {
    const fn = this.operations.get(request.op)
    if (!fn) throw new RemoteError('layerfs/unknown-op', `no dsh-layerfs operation "${request.op}"`, { op: request.op })
    try {
      const value = await fn(request.args ?? {}, signal)
      return value === undefined ? null : value
    } catch (error: any) {
      if (error?.isDSHRemoteError) throw error
      throw new RemoteError('layerfs/failed', String(error?.message ?? error), {
        op: request.op,
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(error?.detail !== undefined ? { detail: error.detail } : {}),
      }, { cause: error })
    }
  }

  @Remote({ name: 'events', mode: 'stream' })
  async *events(signal: AbortSignal): AsyncGenerator<LayerfsEvent> {
    const queue: LayerfsEvent[] = []
    let wake: (() => void) | undefined
    const listener = (event: LayerfsEvent) => { queue.push(event); wake?.() }
    // One abort listener for the stream's life, not one per wait.
    const aborted = () => wake?.()
    this.listeners.add(listener)
    signal.addEventListener('abort', aborted, { once: true })
    try {
      yield { type: 'ready' }
      while (!signal.aborted) {
        if (!queue.length) await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
        while (queue.length) yield queue.shift()!
      }
    } finally {
      this.listeners.delete(listener)
      signal.removeEventListener('abort', aborted)
    }
  }
}
