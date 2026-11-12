/** Project-local folder choice: changes scratch without navigating to another session. */
import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import type { HeroKey } from './locale.ts'
import css from './hero.module.css'

type Translate = (key: HeroKey, params?: Record<string, string | number>) => string
interface Workspace { workspaceId: string, title: string, path: string }

export function ScratchPicker({ sessionId, scratch, api, t }: { sessionId: string, scratch?: string, api: LayerfsApi, t: Translate }): ReactNode {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Workspace[]>([])
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const choose = async (args: { workspaceId: string } | { cwd: string }) => {
    setBusy(true); setError(null)
    try { await api.op('sessions.scratch', { sessionId, ...args }); setDialog(false); setOpen(false) }
    catch (e: any) { setError(t('scratchFailed', { message: String(e?.message ?? e) })) }
    finally { setBusy(false) }
  }
  const browse = async () => {
    setOpen(false); setError(null)
    try {
      const picked = await api.pickDirectory()
      if (picked) await choose({ cwd: picked })
    } catch {
      // Hosts without a native directory dialog can still select any local path.
      setPath(scratch ?? ''); setDialog(true)
    }
  }
  const label = scratch ? scratch.replace(/\/$/, '').split('/').pop() || scratch : t('scratchChoose')
  return <>
    <Menu open={open} onClose={() => setOpen(false)} portal align="start" dense
      items={[
        ...rows.map((row) => ({ id: row.workspaceId, label: <span className={css.option}><span>{row.title || row.path.split('/').pop()}</span><span className={css.optionNote}>{row.path}</span></span> })),
        { type: 'separator', id: 'folders' },
        { id: '@browse', label: t('scratchBrowse') },
        { id: '@path', label: t('scratchEnterPath') },
      ]}
      onSelect={(id) => {
        if (id === '@browse') void browse()
        else if (id === '@path') { setOpen(false); setPath(scratch ?? ''); setDialog(true) }
        else void choose({ workspaceId: id })
      }}
      anchor={<button type="button" className={css.chip} disabled={busy} aria-haspopup="menu" aria-expanded={open} aria-label={t('scratchAria', { folder: label })} title={scratch ?? t('scratchHint')}
        onClick={() => {
          setOpen((value) => !value)
          void api.op<{ workspaces: Workspace[] }>('sessions.scratchOptions').then((value) => { setRows(value.workspaces); setError(null) }, (e: any) => { setRows([]); setError(t('scratchFailed', { message: String(e?.message ?? e) })) })
        }}>
        <IconFolderOpenOutlineRegular size={14} /><span className={css.label}>{t('scratchLabel', { folder: label })}</span><IconChevronDownOutlineRegular size={12} />
      </button>} />
    <Modal open={dialog} onClose={() => setDialog(false)} title={t('scratchChoose')} closeLabel={t('close')} className={css.modal}>
      <form className={css.scratchForm} onSubmit={(event) => { event.preventDefault(); if (path.trim()) void choose({ cwd: path.trim() }) }}>
        <label className={css.muted} htmlFor={`scratch-${sessionId}`}>{t('scratchHint')}</label>
        <Input id={`scratch-${sessionId}`} aria-label={t('scratchPath')} value={path} onChange={(event) => setPath(event.target.value)} autoFocus />
        {error ? <div className={css.error} role="alert">{error}</div> : null}
        <Button type="submit" variant="primary" size="sm" disabled={busy || !path.trim()}>{t('scratchSelect')}</Button>
      </form>
    </Modal>
    {error && !dialog ? <span className={css.error} role="alert">{error}</span> : null}
  </>
}
