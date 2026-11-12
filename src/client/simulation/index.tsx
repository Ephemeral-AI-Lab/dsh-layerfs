/** Script inspection uses ordinary session actions; execution stays in DSH. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import css from './simulation.module.css'

const NS = 'layerfsSimulation'
const locales = {
  en: { inspect: 'View script', close: 'Close', unavailable: 'The script source is unavailable. The conversation can still be read.', description: 'The instructions used by this session’s model.', hash: 'Content hash' },
  zh: { inspect: '查看脚本', close: '关闭', unavailable: '脚本源文件不可用。仍可阅读此会话。', description: '此会话模型使用的指令。', hash: '内容哈希' },
}
type T = (key: keyof typeof locales.en) => string
interface Script {
  runId: string
  agentKey: string
  scriptId: string
  name: string
  hash: string
  source?: string | null
}
interface ScriptState { script: Script | null, state: string, locked: boolean }
interface Inspection { sessionId: string, script: Script }

export function registerSimulation(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: script inspection locale')
  const t: T = ctx.locale.bind(NS)
  // Keep inspection state outside the header's lifetime. The existing ambient
  // overlay slot portals the modal clear of the composer's clipping boundary.
  let inspection: Inspection | null = null
  const listeners = new Set<() => void>()
  const show = (value: Inspection | null) => { inspection = value; for (const notify of listeners) notify() }
  const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } }
  const snapshot = () => inspection

  // A running script shows nothing extra: a real agent run has no script control.
  // Inspection appears once the session's script reached a terminal state.
  const STATUS_POLL_MS = 4000
  function Action({ sessionId }: { sessionId: string }): ReactNode {
    const [script, setScript] = useState<Script | null>(null)
    const [locked, setLocked] = useState(true)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
      let current = true
      let timer: ReturnType<typeof setTimeout> | undefined
      setScript(null); setLocked(true)
      const poll = () => {
        clearTimeout(timer)
        void api.op<{ state: string, locked: boolean }>('simulation.status', { sessionId }).then((value) => {
          if (!current) return
          setLocked(value.locked)
          if (value.locked) timer = setTimeout(poll, STATUS_POLL_MS)
        }, () => { if (current) timer = setTimeout(poll, STATUS_POLL_MS) })
      }
      void api.op<ScriptState>('simulation.script', { sessionId }).then((value) => {
        if (!current) return
        setScript(value.script); setLocked(value.locked)
        if (value.script && value.locked) timer = setTimeout(poll, STATUS_POLL_MS)
      }, () => {})
      const off = api.onEvent('layerfs-session', ({ data }) => { if (current && data?.sessionId === sessionId) poll() })
      return () => { current = false; clearTimeout(timer); off() }
    }, [sessionId])
    if (!script || locked) return null
    return <><Button variant="toolbar" size="sm" onClick={() => {
      // Re-read on inspection so source integrity failures stay visible.
      void api.op<ScriptState>('simulation.script', { sessionId }).then((value) => {
        if (!value.script) { setError(t('unavailable')); return }
        setError(null); show({ sessionId, script: value.script })
      }, (error: unknown) => setError(error instanceof Error ? error.message : String(error)))
    }}>{t('inspect')}</Button>{error && <span role="alert" className={css.failure}>{error}</span>}</>
  }

  function Inspector({ sessionId }: { sessionId: string }): ReactNode {
    const value = useSyncExternalStore(subscribe, snapshot)
    const selected = value?.sessionId === sessionId ? value.script : null
    if (!selected) return null
    return createPortal(<Modal open onClose={() => show(null)} title={selected.name} description={t('description')} closeLabel={t('close')}>
      <p className={css.identity}>{t('hash')}: <code>{selected.hash}</code></p>
      {selected.source == null ? <p>{t('unavailable')}</p> : <pre className={css.source}><code>{selected.source}</code></pre>}
    </Modal>, document.body)
  }

  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'dsh-layerfs.script', order: 45,
    inject: (sessionId: string) => ({ sessionId: String(sessionId) }),
  }, Action)), 'dsh-layerfs: model script inspection')
  ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'dsh-layerfs.script-inspector', order: 40,
    inject: (sessionId: string) => ({ sessionId: String(sessionId) }),
  }, Inspector)), 'dsh-layerfs: script inspection modal')
  ctx.effect(() => api.onEvent('simulation-open', ({ data }) => {
    if (data?.sessionId && data.sourceSessionId === api.selectedSessionId()) api.openSession(String(data.sessionId))
  }), 'dsh-layerfs: open command project session')
}
