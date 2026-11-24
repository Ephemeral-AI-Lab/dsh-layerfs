/**
 * Home's "Export…" (docs/specs/project-exports.md): the project's History and
 * Files in one modal, sharing one selected version, over a bottom bar that
 * names the selection, takes the folder and exports; then the same bar shows
 * the progress, Stop, and the outcome.
 *
 * - It opens on main's head (read when it opens).
 * - History: a Commit or a Branch tag selects that version; the inspector's
 *   "View in Files" opens Files on it.
 * - Files: opens on the selected version; choosing a Branch there selects its
 *   head. Switching back to History selects it there too.
 * - The selection pill (top right) is what Export sends: a Branch and a fixed Commit.
 * - Closing (or "Run in background") leaves a running export to the Home row.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconBranchOutlineRegular, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { shortId } from '../files/format.ts'
import { ProjectFiles } from '../files/ProjectFiles.tsx'
import { ProjectHistory, type HistorySelection } from '../files/ProjectHistory.tsx'
import { Loading } from '../files/States.tsx'
import type { Translate } from '../files/types.ts'
import { enc, type LayerfsApi } from '../api.ts'
import { TabBar } from '../ui/TabBar.tsx'
import { Contained, toneScope } from '../ui/index.tsx'
import { ExportProgress, FolderInput, folderError } from './Export.tsx'
import { lastFolder, running, startExport, suggestedName, useExport } from './model.ts'
import css from './ExportBrowser.module.css'

type Tab = 'history' | 'files'

const errorText = (e: unknown): string => String((e as { message?: string })?.message ?? e)
const join = (folder: string, name: string) => `${folder.replace(/\/+$/, '')}/${name}`
const same = (a: HistorySelection | null, b: HistorySelection) => !!a && a.branch === b.branch && a.commit === b.commit && a.head === b.head

export function ExportBrowser({ api, t, project, onClose }: { api: LayerfsApi, t: Translate, project: string, onClose: () => void }): ReactNode {
  const name = project.slice(project.indexOf('/') + 1)
  const [sel, setSel] = useState<HistorySelection | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('history')
  // the version Files opened on: Files then reports what it shows, and is remounted only when opened anew
  const [filesAt, setFilesAt] = useState<HistorySelection | null>(null)
  const [folder, setFolder] = useState(lastFolder)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useExport(api, jobId)

  useEffect(() => {
    let live = true
    void api.call<{ commit?: string }>('GET', `/api/projects/${enc(project)}/branches?branch=main`).then(
      (b) => { if (live && typeof b?.commit === 'string') setSel((s) => s ?? { branch: 'main', commit: b.commit!, head: true }) },
      (e) => { if (live) setReadError(errorText(e)) },
    )
    return () => { live = false }
  }, [api, project])

  // A new selection after an export ended starts the form over (a running export keeps the bar).
  const choose = (s: HistorySelection) => {
    setSel((old) => (same(old, s) ? old : s))
    if (job && !running(job)) setJobId(null)
  }
  const openFiles = (at: HistorySelection | null) => {
    if (at) setFilesAt(at)
    setTab('files')
  }

  const target = sel ? suggestedName(project, sel.branch, sel.head && sel.branch === 'main' ? null : sel.commit) : name
  const problem = tried ? folderError(folder, t) : null
  const submit = async () => {
    setTried(true)
    if (!sel || folderError(folder, t) || busy) return
    setBusy(true)
    setError(null)
    try {
      const made = await startExport(api, { project, branch: sel.branch, commit: sel.commit, folder: folder.trim(), name: target })
      setJobId(made.id)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const pill = sel ? (
    <span className={css.pill} data-export-selection={`${sel.branch}@${sel.commit}`} title={`${sel.branch} @ ${sel.commit}`}>
      <IconBranchOutlineRegular size={13} />
      <span className={css.pillBranch}>{sel.branch}</span>
      <code className={css.mono}>@ {shortId(sel.commit)}</code>
      {sel.head ? <span className={css.latest}>{t('export_latest')}</span> : null}
    </span>
  ) : null

  const pane = !sel
    ? (readError ? <p className={css.error} role="alert">{readError}</p> : <Loading label={t('files_loading')} className={css.center} />)
    : tab === 'history'
      ? (
        <ProjectHistory api={api} project={project} t={t} initialBranch={sel.branch} initialCommit={sel.commit} className={css.fill} exportChip={false}
          onSelectionChange={choose}
          inspectorAction={(s) => <Button variant="outline" size="sm" data-export-view-files="" onClick={() => { choose(s); openFiles(s) }}>{t('export_viewFiles')}</Button>} />
      )
      : (
        <ProjectFiles key={`${filesAt?.branch ?? sel.branch}\u0000${filesAt?.commit ?? sel.commit}`} api={api} project={project} t={t} className={css.fill}
          initialBranch={filesAt?.branch ?? sel.branch} initialPin={(filesAt ?? sel).head ? undefined : (filesAt ?? sel).commit}
          onVersionChange={choose} />
      )

  const bar = job ? (
    <ExportProgress api={api} job={job} t={t} row onAgain={() => setJobId(null)} onBackground={onClose} />
  ) : (
    <div className={css.form}>
      <div className={css.formRow}>
        <span className={css.what}>
          {t('export_start')} <b className={css.whatBranch}>{sel?.branch ?? 'main'}</b> <code className={css.mono}>@ {sel ? shortId(sel.commit) : '…'}</code>
        </span>
        <span className={css.arrow} aria-hidden="true">→</span>
        <span className={css.folder}><FolderInput api={api} t={t} folder={folder} onFolder={setFolder} invalid={!!problem} onPickError={setPickError} /></span>
        <Button variant="primary" size="sm" disabled={!sel || busy} aria-busy={busy || undefined} data-export-start="" onClick={() => void submit()}>{t('export_start')}</Button>
      </div>
      {problem || error || pickError ? <p className={css.error} role="alert">{problem ?? error ?? pickError}</p>
        : folder.trim().startsWith('/') ? <p className={css.hint}>{t('export_willCreate')} <code className={css.mono}>{join(folder.trim(), target)}</code></p>
          : null}
    </div>
  )

  return (
    <Contained>
      <Modal open headless onClose={onClose} title={t('export_title', { name })} className={`${toneScope} ${css.dialog}`}>
        <div className={css.body} data-export-browser={project}>
          <header className={css.head}>
            <h2 className={css.title}>{t('export_title', { name })}</h2>
            <span className={css.store}>{project.slice(0, project.indexOf('/'))}</span>
            <Button variant="ghost" size="sm" className={css.close} icon={<IconCloseOutlineRegular size={16} />} aria-label={t('export_close')} title={t('export_close')} onClick={onClose} />
          </header>
          <TabBar className={css.tabs} label={t('export_title', { name })} active={tab}
            onSelect={(key) => { if (key === 'files') openFiles(sel); else setTab('history') }}
            tabs={[{ key: 'history', label: t('export_tabHistory') }, { key: 'files', label: t('export_tabFiles') }]}
            actions={pill} />
          <div className={css.pane} data-export-tab={tab}>{pane}</div>
          <footer className={css.bar}>{bar}</footer>
        </div>
      </Modal>
    </Contained>
  )
}
