/** Project-local folder choice: changes scratch without navigating to another session. */
import clsx from 'clsx'
import { useId, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { Field } from '../ui/index.tsx'
import type { HeroKey } from './locale.ts'
import css from './hero.module.css'

type Translate = (key: HeroKey, params?: Record<string, string | number>) => string
interface Workspace { workspaceId: string, title: string, path: string }

const trimSlash = (path: string) => path.replace(/\/+$/, '') || path

export function ScratchPicker({ sessionId, scratch, api, t }: { sessionId: string, scratch?: string, api: LayerfsApi, t: Translate }): ReactNode {
  const [open, setOpen] = useState(false)
  const formId = useId()
  // null until the first listing answers: the menu shows a loading row, not stale or empty rows.
  const [rows, setRows] = useState<Workspace[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
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
  const current = scratch ? rows?.find((row) => trimSlash(row.path) === trimSlash(scratch))?.workspaceId : undefined
  const folders: MenuEntry[] = listError ? [{ type: 'label', id: '@failed', text: listError }]
    : rows === null ? [{ type: 'label', id: '@loading', text: t('scratchLoading') }]
      : rows.map((row) => ({ id: row.workspaceId, label: <span className={css.option} title={row.path}><span className={css.optionName}>{row.title || row.path.split('/').pop()}</span><span className={css.optionNote}>{row.path}</span></span> }))
  return <>
    <Menu open={open} onClose={() => setOpen(false)} portal align="start" dense selectedId={current}
      items={[
        ...folders,
        ...(folders.length ? [{ type: 'separator' as const, id: 'folders' }] : []),
        { id: '@browse', label: t('scratchBrowse') },
        { id: '@path', label: t('scratchEnterPath') },
      ]}
      onSelect={(id) => {
        if (id === '@browse') void browse()
        else if (id === '@path') { setOpen(false); setError(null); setPath(scratch ?? ''); setDialog(true) }
        else void choose({ workspaceId: id })
      }}
      anchor={<button type="button" className={clsx(css.chip, css.folderChip)} disabled={busy} aria-haspopup="menu" aria-expanded={open} aria-label={t('scratchAria', { folder: label })} title={scratch ?? t('scratchHint')}
        onClick={() => {
          setOpen((value) => !value)
          setListError(null)
          void api.op<{ workspaces: Workspace[] }>('sessions.scratchOptions').then((value) => { setRows(value.workspaces); setListError(null) }, (e: any) => { setListError(t('scratchListFailed', { message: String(e?.message ?? e) })) })
        }}>
        <IconFolderOpenOutlineRegular size={16} /><span className={css.label}>{t('scratchLabel', { folder: label })}</span><IconChevronDownOutlineRegular size={12} className={css.folderChevron} />
      </button>} />
    <Modal open={dialog} onClose={() => setDialog(false)} title={t('scratchChoose')} description={t('scratchHint')} closeLabel={t('close')} className={css.modal}
      footer={<>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(false)}>{t('cancel')}</Button>
        <Button type="submit" form={formId} variant="primary" disabled={busy || !path.trim()} aria-busy={busy || undefined}>{t('scratchSelect')}</Button>
      </>}>
      <form id={formId} className={css.scratchForm} onSubmit={(event) => { event.preventDefault(); if (path.trim()) void choose({ cwd: path.trim() }) }}>
        <Field label={t('scratchPath')}>
          <Input value={path} autoComplete="off" spellCheck={false} className={css.mono} onChange={(event) => setPath(event.target.value)} data-modal-autofocus="" />
        </Field>
        {error ? <div className={css.error} role="alert">{error}</div> : null}
      </form>
    </Modal>
    {error && !dialog ? <span className={css.error} role="alert">{error}</span> : null}
  </>
}
