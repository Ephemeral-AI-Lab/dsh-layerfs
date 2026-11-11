/**
 * dsh-layerfs, browser half: mounts the `layerfs` Remote namespace, opens the
 * host event stream, and contributes the Machines and Storage pages and the
 * per-session LayerFS panel through DSH's slots.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'
import { remoteSpec } from '../shared/remote-spec.ts'
import { createApi } from './api.ts'
import { NS, locales } from './locale.ts'
import { registerMachines } from './machines/index.tsx'
import { registerStorage } from './storage/index.tsx'
import { registerSession } from './session/index.tsx'

export const inject = ['slots', 'locale', 'remote', 'layout']

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: locale')
  const info = createTypertRemoteInfo(remoteSpec(z) as never, z)
  ctx.effect(() => {
    let dispose: undefined | (() => unknown)
    let gone = false
    void ctx.remote.$mount(info).then((d: () => unknown) => { if (gone) void d(); else dispose = d })
    return () => { gone = true; void dispose?.() }
  }, 'dsh-layerfs: remote')
  ctx.inject(['remote.layerfs'], (ctx: any) => {
    const workspace = () => ctx.get?.('uiWorkspace')
    const api = createApi(ctx, {
      openPanel: (id) => ctx.layout.selectPanel(id),
      openWorkspace: async (id) => { await workspace()?.openWorkspace(id) },
      openSession: (id) => { workspace()?.openSession(id) },
    })
    ctx.effect(() => () => api.dispose(), 'dsh-layerfs: api')
    // Browser automation handle (tools/, test/e2e): opt-in per browser profile.
    if (typeof window !== 'undefined' && window.localStorage?.getItem('dsh-layerfs:debug') === '1') {
      ctx.effect(() => { (window as any).__dshLayerfs = api; return () => { delete (window as any).__dshLayerfs } }, 'dsh-layerfs: debug')
    }
    registerMachines(ctx, api)
    registerStorage(ctx, api)
    registerSession(ctx, api)
  })
}
