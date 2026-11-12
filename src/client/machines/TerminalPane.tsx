/**
 * One Workspace as a terminal: a head (name, branch, mount path, maximize,
 * ⋯ and ×), the transcript of the commands this host ran there, and a prompt
 * line. Enter sends exactly the typed line to `workspace.exec` through
 * POST /api/workspaces/<ws>/commands; output appears when the command ends.
 * Closing unmounts, and LayerFS's own refusal (Dirty, Busy) decides what the
 * close dialog offers (docs/specs/sandbox-terminals.md).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCloseOutlineRegular, IconCopyOutlineRegular, IconFullscreenOutlineRegular, Input, MenuItemButton, Modal, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { enc } from '../api.ts'
import { bytes, shortId } from '../files/format.ts'
import { MoreMenu, Refusal } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { workspaceName, type SandboxCommand, type WorkspaceInfo } from './model.ts'
import { duration, historyStep, mountLabel, paneStore, transcript, type Row } from './terminal.ts'
import css from './terminal.module.css'

const POLL_MS = 1500
/** How close to the bottom (px) still counts as following the output. */
const STICK_PX = 24

export interface TerminalPaneProps {
  sandbox: string
  ws: WorkspaceInfo
  /** Commands can run: the Sandbox runs and its daemon answered. */
  canRun: boolean
  maximized: boolean
  active: boolean
  onFocus: () => void
  onMaximize: () => void
  /** The Workspace changed (a command ended, a commit, an unmount): read the Sandbox again. */
  onChanged: () => void
  /** A finished command, for the page's screen-reader announcement. */
  onAnnounce: (text: string) => void
}

/** One Workspace's commands, newest first, polled while one runs and read again on its events. */
function useWorkspaceLog(ws: string): { items: SandboxCommand[] | null, error: unknown, reload: () => void } {
  const { api } = useMachinesContext()
  const [items, setItems] = useState<SandboxCommand[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const read = useCallback(() => {
    api.call<{ items: SandboxCommand[] }>('GET', `/api/workspaces/${enc(ws)}/commands`).then((r) => { setItems(r.items); setError(null) }, setError)
  }, [api, ws])
  useEffect(read, [read])
  useEffect(() => api.onEvent('sandbox-command', (event) => { if ((event.data as { ws?: string })?.ws === ws) read() }), [api, ws, read])
  const running = !!items?.some((c) => c.state === 'running')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read() }, POLL_MS)
    return () => clearInterval(timer)
  }, [running, read])
  return { items, error, reload: read }
}

/** Re-render every second while `on`, so a running command's time moves. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return on ? now : Date.now()
}

type Dialog = { kind: 'commit' } | { kind: 'close', why: 'dirty' | 'busy' } | null

export function TerminalPane({ sandbox, ws, canRun, maximized, active, onFocus, onMaximize, onChanged, onAnnounce }: TerminalPaneProps): ReactNode {
  const { t, api, refusal } = useMachinesContext()
  const log = useWorkspaceLog(ws.ws)
  const pane = useSyncExternalStore(paneStore.subscribe, () => paneStore.get(ws.ws))
  const [starting, setStarting] = useState(false)
  const [notice, setNotice] = useState<{ text: string, tone?: 'error' } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const input = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [behind, setBehind] = useState(false)
  const entries = log.items ?? []
  const running = entries.find((e) => e.state === 'running') ?? null
  const busy = starting || !!running
  const now = useTick(!!running)
  const rows = transcript(entries, pane.clearedAt, now)
  const name = workspaceName(ws)
  const label = mountLabel(ws.path)
  const prompt = ws.name ? `${ws.name}:${label}` : label

  // a command that ended: tell the page (the Workspace may have changed) and screen readers
  const seen = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (!log.items) return
    const before = seen.current
    seen.current = new Map(log.items.map((e) => [e.id, e.state]))
    if (!before) return
    let ended = false
    for (const e of log.items) {
      if (before.get(e.id) === 'running' && e.state !== 'running') {
        ended = true
        onAnnounce(t('termAnnounce', { name, command: e.command, code: e.exitCode == null ? '—' : String(e.exitCode) }))
      }
    }
    if (ended) onChanged()
  }, [log.items, name, onAnnounce, onChanged, t])

  // follow the output while the reader is at the bottom
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (stick.current) { el.scrollTop = el.scrollHeight; setBehind(false) } else setBehind(true)
  }, [rows.length, running?.stdoutBytes, running?.stderrBytes, entries[0]?.state])
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
    if (stick.current) setBehind(false)
  }
  const toBottom = () => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    stick.current = true
    setBehind(false)
  }

  useEffect(() => { if (active) input.current?.focus({ preventScroll: true }) }, [active])

  const run = async () => {
    const line = pane.draft
    if (!line.trim() || busy || !canRun) return
    setStarting(true); setError(null); setNotice(null)
    stick.current = true
    try {
      await api.call('POST', `/api/workspaces/${enc(ws.ws)}/commands`, { command: line })
      paneStore.patch(ws.ws, { draft: '', cursor: -1 })
      log.reload()
    } catch (e) {
      setError(e)
      if ((e as { code?: string })?.code === 'NoSuchWorkspace' || (e as { code?: string })?.code === 'NotMounted') onChanged()
    } finally { setStarting(false) }
  }
  const cancel = () => {
    if (!running) return
    api.call('POST', `/api/workspaces/${enc(ws.ws)}/cancel`, { id: running.id }).then(log.reload, setError)
  }
  const history = entries.map((e) => e.command)
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) { e.preventDefault(); void run(); return }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey) {
      e.preventDefault()
      const draft = pane.cursor < 0 ? pane.draft : (paneStore.get(ws.ws) as { saved?: string }).saved ?? ''
      const step = historyStep(history, pane.cursor, e.key === 'ArrowUp' ? -1 : 1, draft)
      paneStore.patch(ws.ws, { cursor: step.cursor, draft: step.text, ...(pane.cursor < 0 ? { saved: pane.draft } as object : {}) })
      return
    }
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      const target = e.currentTarget
      const selected = target.selectionStart !== target.selectionEnd || !!window.getSelection()?.toString()
      if (busy) { e.preventDefault(); cancel() } else if (!selected) { e.preventDefault(); paneStore.patch(ws.ws, { draft: '', cursor: -1 }) }
      return
    }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); paneStore.patch(ws.ws, { clearedAt: Date.now() }); setNotice(null); return }
    if (e.key === 'Escape' && maximized) { e.preventDefault(); onMaximize() }
  }

  /** × : unmount, and let LayerFS's refusal choose what the dialog offers. */
  const close = async (how: { discard?: boolean, force?: boolean } = {}) => {
    setError(null)
    const q = new URLSearchParams()
    if (how.discard) q.set('discard', '1')
    if (how.force) q.set('force', '1')
    try {
      await api.call('DELETE', `/api/workspaces/${enc(ws.ws)}${q.size ? `?${q}` : ''}`)
      setDialog(null)
      paneStore.forget(ws.ws)
      onChanged()
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (!how.discard && !how.force && code === 'Dirty') setDialog({ kind: 'close', why: 'dirty' })
      else if (!how.force && (code === 'Busy' || code === 'CommandRunning')) setDialog({ kind: 'close', why: 'busy' })
      else { setError(e); if (dialog) setDialog(dialog) }
    }
  }

  const focusPrompt = () => {
    onFocus()
    if (!window.getSelection()?.toString()) input.current?.focus({ preventScroll: true })
  }

  return (
    <section className={css.pane} data-active={active || undefined} data-max={maximized || undefined}
      aria-label={t('termInputLabel', { name })} onMouseUp={focusPrompt} onFocusCapture={onFocus}>
      <header className={css.head}>
        <span className={css.name} title={ws.ws}>{name}</span>
        {ws.branch && <span className={css.branch}>{ws.branch}</span>}
        <span className={css.path} title={ws.path}>{label}</span>
        {busy && <StateDot state="ongoing" size={7} />}
        <span className={css.spacer} />
        <Tooltip label={maximized ? t('termRestore') : t('termMaximize')}>
          <Button size="sm" className={css.iconButton} aria-label={maximized ? t('termRestore') : t('termMaximize')} aria-pressed={maximized}
            icon={<IconFullscreenOutlineRegular size={14} />} onClick={(e) => { e.stopPropagation(); onMaximize() }} />
        </Tooltip>
        <MoreMenu label={t('termMore', { name })} className={css.iconButton}>
          {(dismiss) => (
            <>
              <MenuItemButton disabled={!canRun} onSelect={() => { dismiss(); setError(null); setDialog({ kind: 'commit' }) }}>{t('termCommit')}</MenuItemButton>
              <MenuItemButton icon={<IconCopyOutlineRegular size={14} />} onSelect={() => { dismiss(); void navigator.clipboard?.writeText(ws.path) }}>{t('termCopyPath')}</MenuItemButton>
            </>
          )}
        </MoreMenu>
        <Tooltip label={t('termClose', { name })}>
          <Button size="sm" className={css.iconButton} aria-label={t('termClose', { name })} disabled={!canRun}
            icon={<IconCloseOutlineRegular size={14} />} onClick={(e) => { e.stopPropagation(); void close() }} />
        </Tooltip>
      </header>

      <div ref={scroller} className={css.scroll} onScroll={onScroll} role="log" aria-live="off" tabIndex={0}>
        {rows.map((row) => <TranscriptRow key={row.id} row={row} prompt={prompt} />)}
        {notice && <div className={clsx(css.line, notice.tone === 'error' ? css.err : css.meta)}>{notice.text}</div>}
        {log.error != null && !log.items && <Refusal error={log.error} labels={refusal} compact />}
      </div>
      {behind && <button type="button" className={css.jump} onClick={toBottom}>↓ {t('termJump')}</button>}

      {error != null && <div className={css.errorRow}><Refusal error={error} labels={refusal} compact /></div>}
      {canRun
        ? (
          <label className={css.promptRow}>
            <span className={css.prompt}>{prompt} <span className={css.dollar}>$</span></span>
            <input ref={input} className={css.input} value={pane.draft} spellCheck={false} autoComplete="off" autoCapitalize="off"
              aria-label={t('termInputLabel', { name })} onKeyDown={onKey}
              onChange={(e) => paneStore.patch(ws.ws, { draft: e.target.value, cursor: -1 })} />
          </label>
        )
        : <div className={clsx(css.promptRow, css.offline)}>{t('termOffline')}</div>}

      {dialog?.kind === 'commit' && (
        <CommitDialog ws={ws} name={name} onClose={() => setDialog(null)}
          onDone={(text) => { setDialog(null); setNotice({ text }); onChanged() }} />
      )}
      {dialog?.kind === 'close' && (
        <Modal open onClose={() => setDialog(null)} title={t('termCloseTitle', { name })} closeLabel={t('close')} className={css.dialog}
          description={dialog.why === 'dirty' ? t('termCloseDirty', { name }) : t('termCloseBusy', { name })}
          footer={(
            <>
              <Button variant="outline" onClick={() => setDialog(null)}>{t('cancel')}</Button>
              {dialog.why === 'dirty'
                ? (
                  <>
                    <Button variant="outline" className={css.dangerText} onClick={() => void close({ discard: true })}>{t('termDiscardUnmount')}</Button>
                    <Button variant="primary" onClick={() => setDialog({ kind: 'commit' })}>{t('termCommitUnmount')}</Button>
                  </>
                )
                : <Button variant="primary" className={css.dangerFill} onClick={() => void close({ force: true })}>{t('termForceUnmount')}</Button>}
            </>
          )}>
          {error != null && <Refusal error={error} labels={refusal} compact />}
        </Modal>
      )}
    </section>
  )

  function CommitDialog({ ws: target, name: label2, onClose, onDone }: { ws: WorkspaceInfo, name: string, onClose: () => void, onDone: (text: string) => void }): ReactNode {
    const [message, setMessage] = useState('')
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState<unknown>(null)
    const unmountAfter = dialog?.kind === 'commit' && closingAfterCommit.current
    const submit = async () => {
      setSaving(true); setFailed(null)
      try {
        const result = await api.call<any>('POST', `/api/workspaces/${enc(target.ws)}/commit`, message.trim() ? { message: message.trim() } : {})
        const text = result?.kind === 'UpToDate' ? t('termUpToDate') : t('termCommitted', { commit: shortId(typeof result?.commit === 'string' ? result.commit : result?.commit?.id ?? result?.head ?? null) })
        if (unmountAfter) { closingAfterCommit.current = false; await close(); return }
        onDone(text)
      } catch (e) { setFailed(e) } finally { setSaving(false) }
    }
    return (
      <Modal open onClose={onClose} title={t('termCommitTitle', { name: label2 })} closeLabel={t('close')} className={css.dialog}
        footer={(
          <>
            <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button variant="primary" disabled={saving} onClick={() => void submit()}>{unmountAfter ? t('termCommitUnmount') : t('termCommit').replace('…', '')}</Button>
          </>
        )}>
        <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('termCommitMessage')} aria-label={t('termCommitMessage')}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }} autoFocus />
        {failed != null && <Refusal error={failed} labels={refusal} compact />}
      </Modal>
    )
  }
}

function TranscriptRow({ row, prompt }: { row: Row, prompt: string }): ReactNode {
  const { t } = useMachinesContext()
  const failed = row.state === 'exited' && row.exitCode !== 0
  return (
    <div className={css.entry}>
      <div className={css.line}><span className={css.prompt}>{prompt} <span className={css.dollar}>$</span></span> <span className={css.command}>{row.command}</span></div>
      {row.stdoutOmitted > 0 && <div className={clsx(css.line, css.meta)}>{t('termOmitted', { total: bytes(row.stdoutBytes) })}</div>}
      {row.stdout && <pre className={css.out}>{row.stdout}</pre>}
      {row.stdoutBinary && <div className={clsx(css.line, css.meta)}>{t('termBinary', { size: bytes(row.stdoutBytes) })}</div>}
      {row.stderrOmitted > 0 && <div className={clsx(css.line, css.meta)}>{t('termOmitted', { total: bytes(row.stderrBytes) })}</div>}
      {row.stderr && <pre className={clsx(css.out, css.stderr)}>{row.stderr}</pre>}
      {row.stderrBinary && <div className={clsx(css.line, css.meta)}>{t('termBinary', { size: bytes(row.stderrBytes) })}</div>}
      {row.state === 'running' && <div className={clsx(css.line, css.running)} role="status">⠿ {t('termRunning', { time: duration(row.ms) })}</div>}
      {(row.state === 'exited' || row.state === 'cancelled') && (
        <div className={clsx(css.line, css.meta)} data-fail={failed || row.state === 'cancelled' || undefined}>
          [{row.state === 'cancelled' ? t('termCancelled') : t('termExit', { code: String(row.exitCode ?? '—') })}{row.ms != null ? ` · ${duration(row.ms)}` : ''}]
        </div>
      )}
      {row.state === 'unknown' && <div className={clsx(css.line, css.meta)}>[{t('termUnknown')}]</div>}
      {row.state === 'failed' && <div className={clsx(css.line, css.err)}>[{t('termFailed', { message: row.error ?? '' })}]</div>}
    </div>
  )
}
