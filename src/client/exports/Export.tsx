/**
 * Project export views (docs/specs/project-exports.md):
 * - {@link ExportProgress}: one export's progress, stop and outcome, the same
 *   in the Home dialog and History's inspector;
 * - {@link ExportDialog}: Home's "Export main…": main's head, a folder, then
 *   the progress in place (closing it leaves the export running);
 * - {@link ExportInline}: History's inspector action for the selected Commit
 *   or Branch head, its form and progress inside the inspector;
 * - {@link ExportCell}: the Home row's Size cell while an export runs (bar,
 *   percent, stop) and its outcome after;
 * - {@link ExportChip}: History's dock chip for the project's export.
 * All of them read the one page store (model.ts); a stop from any of them
 * changes every view.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconCheckCircleFillRegular, IconCloseOutlineRegular, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular,
  IconStopFillRegular, IconWarningOutlineRegular, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bytes, shortId } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { enc, type LayerfsApi } from '../api.ts'
import { Contained, toneScope } from '../ui/index.tsx'
import {
  dismissExport, lastFolder, percentOf, revealExport, running, startExport, stopExport, stoppable, suggestedName, useExport, useExports,
  type ProjectExport,
} from './model.ts'
import css from './Export.module.css'

const errorText = (e: unknown): string => String((e as { message?: string })?.message ?? e)
const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)
const join = (folder: string, name: string) => `${folder.replace(/\/+$/, '')}/${name}`

/** The phase in words. */
function phaseText(job: ProjectExport, t: Translate): string {
  switch (job.phase) {
    case 'queued': return t('export_queued')
    case 'prepare': return t('export_prepare')
    case 'export': return t('export_copy')
    case 'finalize': return t('export_finalize')
    case 'stopping': return t('export_stopping')
    default: return ''
  }
}

/** Seconds left from the copy rate seen so far, or null while it is too early to tell. */
function useSecondsLeft(job: ProjectExport): number | null {
  const first = useRef<{ at: number, done: number } | null>(null)
  if (job.phase !== 'export' || job.done === null) { if (job.phase !== 'export') first.current = null; return null }
  const now = Date.now()
  if (!first.current) first.current = { at: now, done: job.done }
  const elapsed = (now - first.current.at) / 1000
  const copied = job.done - first.current.done
  if (elapsed < 2 || copied <= 0 || job.total === null) return null
  return Math.max(1, Math.ceil((job.total - job.done) / (copied / elapsed)))
}

function Bar({ job }: { job: ProjectExport }): ReactNode {
  const percent = percentOf(job)
  const indeterminate = percent === null && running(job) && job.phase !== 'stopping'
  return (
    <span className={css.bar} data-indeterminate={indeterminate || undefined} data-muted={job.phase === 'stopping' || undefined}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <span style={indeterminate ? undefined : { width: `${percent ?? 0}%` }} />
    </span>
  )
}

/** Stop: ends the export from here (the host stops it for every view). */
function StopButton({ api, job, t }: { api: LayerfsApi, job: ProjectExport, t: Translate }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  const tooLate = job.phase === 'finalize'
  return (
    <>
      <Button variant="outline" size="sm" icon={<IconStopFillRegular size={12} />} disabled={!stoppable(job)}
        title={tooLate ? t('export_tooLate') : undefined}
        onClick={() => { setError(null); void stopExport(api, job.id).catch((e) => setError(errorText(e))) }}>
        {job.phase === 'stopping' ? t('export_stoppingButton') : t('export_stop')}
      </Button>
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </>
  )
}

/**
 * One export's progress, stop and outcome. `onAgain` (stopped, failed) and
 * `onClose` (an ended export) add their buttons; `onChangeFolder` (failed).
 */
export function ExportProgress({ api, job, t, onAgain, onChangeFolder, onClose }: {
  api: LayerfsApi, job: ProjectExport, t: Translate
  onAgain?: (() => void) | undefined
  onChangeFolder?: (() => void) | undefined
  onClose?: (() => void) | undefined
}): ReactNode {
  const percent = percentOf(job)
  const left = useSecondsLeft(job)
  const [revealError, setRevealError] = useState<string | null>(null)
  if (running(job)) {
    const copied = job.done !== null && job.total !== null && job.phase !== 'prepare' && job.phase !== 'queued'
    return (
      <div className={css.progress} data-export-phase={job.phase}>
        <div className={css.progressHead}><span>{phaseText(job, t)}</span><span className={css.num}>{job.phase === 'export' && percent !== null ? `${percent}%` : ''}</span></div>
        <Bar job={job} />
        <div className={css.progressFoot}>
          <span className={css.sub} title={job.destination}>
            {copied ? `${t('export_bytes', { done: bytes(job.done), total: bytes(job.total) })}${left !== null ? ` · ${t('export_left', { n: left })}` : ''}` : job.destination}
          </span>
          <StopButton api={api} job={job} t={t} />
        </div>
        {job.phase === 'finalize' ? <p className={css.hint}>{t('export_tooLate')}</p> : null}
      </div>
    )
  }
  if (job.phase === 'done') {
    return (
      <div className={css.stack} data-export-phase="done">
        <div className={css.outcome}>
          <IconCheckCircleFillRegular size={16} className={css.ok} />
          <span className={css.cardBody}>
            <span>{t('export_done', { files: (job.files ?? 0).toLocaleString(), size: bytes(job.total) })}</span>
            <span className={css.mono} title={job.destination}>{job.destination}</span>
          </span>
        </div>
        {revealError ? <p className={css.error} role="alert">{revealError}</p> : null}
        <div className={css.actions}>
          <Button variant="outline" size="sm" icon={<IconFolderOpenOutlineRegular size={14} />}
            onClick={() => { setRevealError(null); void revealExport(api, job.id).catch((e) => setRevealError(errorText(e))) }}>
            {isMac() ? t('export_reveal') : t('export_revealOther')}
          </Button>
          {onClose ? <Button variant="outline" size="sm" onClick={onClose}>{t('export_ok')}</Button> : null}
        </div>
      </div>
    )
  }
  if (job.phase === 'stopped') {
    return (
      <div className={css.stack} data-export-phase="stopped">
        <div className={css.outcome}><IconCloseOutlineRegular size={16} className={css.quiet} /><span>{t('export_stopped')}</span></div>
        <div className={css.actions}>
          {onAgain ? <Button variant="outline" size="sm" onClick={onAgain}>{t('export_again')}</Button> : null}
          {onClose ? <Button variant="outline" size="sm" onClick={onClose}>{t('export_close')}</Button> : null}
        </div>
      </div>
    )
  }
  return (
    <div className={css.stack} data-export-phase="failed">
      <div className={css.outcome}>
        <IconWarningOutlineRegular size={16} className={css.bad} />
        <span className={css.cardBody}><span className={css.bad}>{t('export_failed')}</span><span className={css.hint}>{job.error?.message ?? ''}</span></span>
      </div>
      <div className={css.actions}>
        {onChangeFolder ? <Button variant="outline" size="sm" onClick={onChangeFolder}>{t('export_changeFolder')}</Button> : null}
        {onAgain ? <Button variant="outline" size="sm" onClick={onAgain}>{t('export_retry')}</Button> : null}
        {onClose ? <Button variant="outline" size="sm" onClick={onClose}>{t('export_close')}</Button> : null}
      </div>
    </div>
  )
}

/**
 * The folder field: an absolute path, typed or filled by the native dialog
 * ("Choose…", absent on a host without one), and the folder the export makes in it.
 */
function FolderCard({ api, t, folder, onFolder, name, error }: {
  api: LayerfsApi, t: Translate, folder: string, onFolder: (folder: string) => void, name: string, error: string | null
}): ReactNode {
  const [pickerMissing, setPickerMissing] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const browse = async () => {
    setPickError(null)
    try {
      const picked = await api.pickDirectory()
      if (picked) onFolder(picked)
    } catch (e) {
      // a host without the native dialog keeps the typed path only
      if ((e as { code?: string })?.code === 'no-picker') setPickerMissing(true)
      else setPickError(errorText(e))
    }
  }
  return (
    <div className={css.stack}>
      <span className={css.label}>{t('export_folder')}</span>
      <div className={css.folderRow}>
        <Input value={folder} autoComplete="off" spellCheck={false} className={`${css.input} ${css.mono}`} placeholder={t('export_folderPlaceholder')}
          aria-label={t('export_folder')} aria-invalid={error ? true : undefined} data-export-folder="" onChange={(e) => onFolder(e.target.value)} />
        {pickerMissing ? null : (
          <Button variant="outline" size="sm" type="button" data-export-pick="" onClick={() => void browse()}>{folder ? t('export_change') : t('export_choose')}</Button>
        )}
      </div>
      {error || pickError ? <p className={css.error} role="alert">{error ?? pickError}</p>
        : folder.trim().startsWith('/') ? <p className={css.hint}>{t('export_willCreate')} <span className={css.mono}>{join(folder.trim(), name)}</span></p>
          : <p className={css.hint}>{t('export_folderNone')}</p>}
    </div>
  )
}

/** The version line: Branch, latest or not, and the Commit. */
function VersionCard({ t, branch, commit, latest, note }: { t: Translate, branch: string, commit: string | null, latest: boolean, note?: string | undefined }): ReactNode {
  return (
    <div className={css.stack}>
      <span className={css.label}>{t('export_version')}</span>
      <div className={css.card}>
        <span className={css.cardIcon}><IconDownloadOutlineRegular size={18} /></span>
        <span className={css.cardBody}>
          <span className={css.cardTitle}>{branch}{latest ? <span className={css.num}> · {t('export_latest')}</span> : null}</span>
          <span className={css.sub}><span className={css.mono}>{commit ? shortId(commit) : '…'}</span>{note ? ` · ${note}` : ''}</span>
        </span>
      </div>
    </div>
  )
}

const folderError = (folder: string, t: Translate): string | null =>
  !folder.trim() ? t('export_folderRequired') : !folder.trim().startsWith('/') ? t('export_folderInvalid') : null

/**
 * Home's "Export main…": main's head (read when the dialog opens, so the
 * export is of what was shown), a folder, then the progress in place.
 * Closing leaves a running export to the row's cell.
 */
export function ExportDialog({ api, t, project, size, onClose, onOpenHistory }: {
  api: LayerfsApi, t: Translate, project: string, size?: number | null | undefined
  onClose: () => void
  onOpenHistory?: (() => void) | undefined
}): ReactNode {
  const name = project.slice(project.indexOf('/') + 1)
  const [head, setHead] = useState<string | null>(null)
  const [headError, setHeadError] = useState<string | null>(null)
  const [folder, setFolder] = useState(lastFolder)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useExport(api, jobId)
  useEffect(() => {
    let live = true
    void api.call<{ commit?: string }>('GET', `/api/projects/${enc(project)}/branches?branch=main`).then(
      (b) => { if (live) setHead(typeof b?.commit === 'string' ? b.commit : null) },
      (e) => { if (live) setHeadError(errorText(e)) },
    )
    return () => { live = false }
  }, [api, project])
  const problem = tried ? folderError(folder, t) : null
  const submit = async () => {
    setTried(true)
    if (folderError(folder, t) || !head || busy) return
    setBusy(true)
    setError(null)
    try {
      const made = await startExport(api, { project, branch: 'main', commit: head, folder: folder.trim(), name: suggestedName(project, 'main', null) })
      setJobId(made.id)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const again = () => { setJobId(null); setTried(false) }
  const form = !job
  const footer = form ? (
    <div className={css.footer}>
      <Button variant="outline" onClick={onClose}>{t('export_cancel')}</Button>
      <Button variant="primary" disabled={!head || busy} aria-busy={busy || undefined} data-export-start="" onClick={() => void submit()}>{t('export_start')}</Button>
    </div>
  ) : running(job) ? (
    <div className={css.footer}><Button variant="outline" onClick={onClose}>{t('export_background')}</Button></div>
  ) : undefined
  return (
    <Contained>
      <Modal open onClose={onClose} title={t('export_title', { name })} closeLabel={t('export_close')} className={`${toneScope} ${css.modal}`} footer={footer}>
        <div className={css.stack} data-export-dialog={project}>
          {form ? (
            <>
              <VersionCard t={t} branch="main" commit={head} latest note={size != null ? t('export_about', { size: bytes(size) }) : undefined} />
              {headError ? <p className={css.error} role="alert">{headError}</p> : null}
              <FolderCard api={api} t={t} folder={folder} onFolder={setFolder} name={suggestedName(project, 'main', null)} error={problem} />
              {onOpenHistory ? (
                <p className={css.hint}>{t('export_otherVersions')} <button type="button" className={css.link} onClick={onOpenHistory}>{t('export_openHistory')}</button></p>
              ) : null}
              {error ? <p className={css.error} role="alert">{error}</p> : null}
            </>
          ) : (
            <>
              <VersionCard t={t} branch={job.branch} commit={job.commit} latest={job.head} />
              <ExportProgress api={api} job={job} t={t} onAgain={again} onChangeFolder={again} onClose={() => { void dismissExport(api, job.id); onClose() }} />
            </>
          )}
        </div>
      </Modal>
    </Contained>
  )
}

/**
 * History's inspector action for one version: a button, then the folder
 * inline, then the progress. `head` says the Commit is its Branch's head.
 */
export function ExportInline({ api, t, project, branch, commit, head }: {
  api: LayerfsApi, t: Translate, project: string, branch: string, commit: string, head: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [folder, setFolder] = useState(lastFolder)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useExport(api, jobId)
  // another version selected: back to the button (a running export stays in the dock)
  useEffect(() => { setOpen(false); setJobId(null); setTried(false); setError(null) }, [project, branch, commit])
  const name = suggestedName(project, branch, head && branch === 'main' ? null : commit)
  if (!open && !job) {
    return (
      <Button variant="outline" size="sm" icon={<IconDownloadOutlineRegular size={14} />} data-export-open="" onClick={() => setOpen(true)}>
        {head ? t('export_inspectorHead', { branch }) : t('export_inspectorCommit')}
      </Button>
    )
  }
  if (job) {
    return (
      <div className={css.inline} data-export-inline="">
        <ExportProgress api={api} job={job} t={t} onAgain={() => setJobId(null)} onChangeFolder={() => setJobId(null)}
          onClose={() => { void dismissExport(api, job.id); setJobId(null); setOpen(false) }} />
      </div>
    )
  }
  const problem = tried ? folderError(folder, t) : null
  const submit = async () => {
    setTried(true)
    if (folderError(folder, t) || busy) return
    setBusy(true)
    setError(null)
    try { setJobId((await startExport(api, { project, branch, commit, folder: folder.trim(), name })).id) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return (
    <div className={`${css.inline} ${css.stack}`} data-export-inline="">
      <span className={css.label}>{t('export_of', { branch, commit: shortId(commit) })}</span>
      <FolderCard api={api} t={t} folder={folder} onFolder={setFolder} name={name} error={problem} />
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <div className={css.footer}>
        <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t('export_cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy} aria-busy={busy || undefined} data-export-start="" onClick={() => void submit()}>{t('export_start')}</Button>
      </div>
    </div>
  )
}

/** The newest export of a project that is running, else the newest that ended done or failed (a stop is its own answer), or null. */
function current(jobs: readonly ProjectExport[]): ProjectExport | null {
  return jobs.find(running) ?? jobs.find((j) => j.phase === 'done' || j.phase === 'failed') ?? null
}

/**
 * The Home row's Size cell: while the project's export runs, a bar, the
 * percent and stop; after it, the size with a check (shows the folder) or a
 * warning (its message; a click dismisses it). Otherwise `children` (the size).
 */
export function ExportCell({ api, t, project, children }: { api: LayerfsApi, t: Translate, project: string, children: ReactNode }): ReactNode {
  const job = current(useExports(api, project))
  if (job && running(job)) {
    const percent = percentOf(job)
    return (
      <span className={css.cell} data-export-cell={job.phase} title={`${t('export_of', { branch: job.branch, commit: shortId(job.commit) })} · ${phaseText(job, t)}`}>
        <span className={css.cellBar}><Bar job={job} /></span>
        <span className={css.num}>{job.phase === 'export' && percent !== null ? `${percent}%` : job.phase === 'finalize' ? t('export_finalizeShort') : job.phase === 'stopping' ? t('export_stoppingShort') : '…'}</span>
        <button type="button" className={css.iconButton} data-placeholder={stoppable(job) ? undefined : ''} disabled={!stoppable(job)}
          aria-label={t('export_stopTitle', { branch: job.branch })} title={t('export_stopTitle', { branch: job.branch })}
          onClick={(e) => { e.stopPropagation(); void stopExport(api, job.id).catch(() => {}) }}>
          <IconStopFillRegular size={12} />
        </button>
      </span>
    )
  }
  if (job?.phase === 'done' || job?.phase === 'failed') {
    const done = job.phase === 'done'
    const title = done ? t('export_rowDone', { path: job.destination }) : `${t('export_failed')}: ${job.error?.message ?? ''}`
    return (
      <span className={css.cell} data-export-cell={job.phase}>
        {children}
        <button type="button" className={css.iconButton} aria-label={title} title={title}
          onClick={(e) => { e.stopPropagation(); if (done) void revealExport(api, job.id).catch(() => {}); void dismissExport(api, job.id) }}>
          {done ? <IconCheckCircleFillRegular size={14} className={css.ok} /> : <IconWarningOutlineRegular size={14} className={css.bad} />}
        </button>
      </span>
    )
  }
  return <>{children}</>
}

function Ring({ job }: { job: ProjectExport }): ReactNode {
  const r = 6, c = 2 * Math.PI * r
  const percent = percentOf(job)
  const spin = percent === null && job.phase !== 'stopping'
  const filled = spin ? 0.25 : (percent ?? 0) / 100
  return (
    <svg className={css.ring} data-spin={spin || undefined} data-muted={job.phase === 'stopping' || undefined} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(filled * c).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 8 8)" />
    </svg>
  )
}

/** Ended exports stay on the dock this long (the host lists them longer; the row keeps the outcome). */
const CHIP_ENDED_MS = 5 * 60_000

/** History's dock chip: the project's export while it runs (stop), and its outcome for a while after. */
export function ExportChip({ api, t, project }: { api: LayerfsApi, t: Translate, project: string }): ReactNode {
  const job = current(useExports(api, project))
  if (!job || (!running(job) && (job.endedAt === null || Date.now() - job.endedAt > CHIP_ENDED_MS))) return null
  const name = t('export_chip', { branch: job.branch })
  const dismiss = (
    <button type="button" className={css.iconButton} aria-label={t('export_close')} title={t('export_close')} onClick={() => void dismissExport(api, job.id)}>
      <IconCloseOutlineRegular size={12} />
    </button>
  )
  if (running(job)) {
    const percent = percentOf(job)
    return (
      <span className={css.chip} data-export-chip={job.phase} title={`${t('export_of', { branch: job.branch, commit: shortId(job.commit) })} → ${job.destination}`}>
        <Ring job={job} />
        <span className={css.chipName}>{name}</span>
        <span className={css.num}>{job.phase === 'export' && percent !== null ? `${percent}%` : phaseText(job, t)}</span>
        <button type="button" className={css.iconButton} data-placeholder={stoppable(job) ? undefined : ''} disabled={!stoppable(job)}
          aria-label={t('export_stopTitle', { branch: job.branch })} title={t('export_stopTitle', { branch: job.branch })}
          onClick={() => void stopExport(api, job.id).catch(() => {})}>
          <IconStopFillRegular size={12} />
        </button>
      </span>
    )
  }
  if (job.phase === 'done') {
    return (
      <span className={css.chip} data-export-chip="done">
        <IconCheckCircleFillRegular size={14} className={css.ok} />
        <span>{t('export_chipDone')}</span>
        <button type="button" className={css.chipLink} onClick={() => void revealExport(api, job.id).catch(() => {})}>{isMac() ? t('export_reveal') : t('export_revealOther')}</button>
        {dismiss}
      </span>
    )
  }
  return (
    <span className={css.chip} data-export-chip={job.phase} data-tone="danger" title={job.error?.message}>
      <IconWarningOutlineRegular size={14} />
      <span>{t('export_chipFailed')}</span>
      {dismiss}
    </span>
  )
}
