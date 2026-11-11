/**
 * dsh-layerfs, browser half (spike).
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { remoteSpec } from '../shared/remote-spec.ts'

export const inject = ['slots', 'locale', 'remote', 'layout']

function Icon() {
  return <span style={{ fontSize: 14 }}>L</span>
}

function Page(props: any) {
  const [text, setText] = useState('…')
  useEffect(() => { void props.ping().then((v: unknown) => setText(JSON.stringify(v))) }, [])
  return <div style={{ padding: 24 }}>LayerFS spike: {text}</div>
}

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register('layerfs', { en: { machines: 'Machines' }, zh: { machines: 'Machines' } }), 'layerfs: locale')
  const info = createTypertRemoteInfo(remoteSpec(z) as never, z)
  ctx.effect(() => {
    let dispose: undefined | (() => unknown)
    let gone = false
    void ctx.remote.$mount(info).then((d: () => unknown) => { if (gone) void d(); else dispose = d })
    return () => { gone = true; void dispose?.() }
  }, 'layerfs: remote')
  ctx.inject(['remote.layerfs'], (ctx: any) => {
    const ping = async () => {
      const result = await ctx.remote.layerfs.call({ op: 'ping' })
      return result.ok ? result.value : { error: result.error.code, message: result.error.message }
    }
    ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'layerfs-machines', locale: 'layerfs', inject: () => ({ ping }) }, Page)), 'layerfs: main')
    ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'layerfs-machines', order: 10, label: () => 'Machines', locale: 'layerfs' }, Icon)), 'layerfs: panel')
  })
}
