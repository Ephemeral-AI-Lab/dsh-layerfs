/**
 * Home's "Export…" (docs/specs/project-exports.md): a small dialog with the
 * version (Branch, Commit, its message and age), the folder and Export; then
 * the progress, Stop and the outcome in place.
 *
 * - It opens on main's head (read when it opens), so exporting main is one step.
 * - "Choose version…" grows the same dialog into a picker: the project's
 *   History map, where a Commit or a Branch tag selects a version, and a Files
 *   preview of the selected version ("View files"; choosing a Branch there
 *   selects its head). "Use this version" brings the choice back; Back, Cancel
 *   or Escape leave the version as it was.
 * - Closing (or "Run in background") leaves a running export to the Home row.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconChevronLeftOutlineRegular, IconBranchOutlineRegular, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { filesApi } from '../files/api.ts'
import { ago, shortId } from '../files/format.ts'
import { ProjectFiles } from '../files/ProjectFiles.tsx'
import { ProjectHistory, type HistorySelection } from '../files/ProjectHistory.tsx'
import { Loading } from '../files/States.tsx'
import type { CommitInfo, Translate } from '../files/types.ts'
import { enc, type LayerfsApi } from '../api.ts'
import { Contained, toneScope } from '../ui/index.tsx'
import { ExportProgress, FolderCard, folderError } from './Export.tsx'
import { dismissExport, lastFolder, running, startExport, suggestedName, useExport } from './model.ts'
import css from './ExportDialog.module.css'

type Mode = 'form' | 'map' | 'files'

const errorText = (e: unknown): string => String((e as { message?: string })?.message ?? e)
const same = (a: HistorySelection | null, b: HistorySelection) => !!a && a.branch === b.branch && a.commit === b.commit && a.head === b.head

/** One version's Commit (its message and time), read once per version shown. */
function useCommit(api: LayerfsApi, project: string, sel: HistorySelection | null): CommitInfo | null {
  const [info, setInfo] = useState<{ key: string, item: CommitInfo } | null>(null)
  const key = sel ? `${sel.branch}\u0000${sel.commit}` : ''
  useEffect(() => {
    if (!sel) return
    let live = true
    void filesApi.commit(api, project, sel.branch, sel.commit).then((d) => { if (live && d?.item) setInfo({ key, item: d.item }) }, () => {})
    return () => { live = false }
  }, [api, project, key])
  return info?.key === key ? info.item : null
}

export function ExportDialog({ api, t, project, onClose }: { api: LayerfsApi, t: Translate, project: string, onClose: () => void }): ReactNode {
  const name = project.slice(project.indexOf('/') + 1)
  const [mode, setMode] = useState<Mode>('form')
  // the version exported, and the one the picker holds until "Use this version"
  const [chosen, setChosen] = useState<HistorySelection | null>(null)
  const [pick, setPick] = useState<HistorySelection | null>(null)
  // the version the Files preview opened on (it reports what it shows after)
  const [filesAt, setFilesAt] = useState<HistorySelection | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [folder, setFolder] = useState(lastFolder)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useExport(api, jobId)
  const commit = useCommit(api, project, chosen)

  useEffect(() => {
    let live = true
    void api.call<{ commit?: string }>('GET', `/api/projects/${enc(project)}/branches?branch=main`).then(
      (b) => { if (live && typeof b?.commit === 'string') setChosen((s) => s ?? { branch: 'main', commit: b.commit!, head: true }) },
      (e) => { if (live) setReadError(errorText(e)) },
    )
    return () => { live = false }
  }, [api, project])

  const target = chosen ? suggestedName(project, chosen.branch, chosen.head && chosen.branch === 'main' ? null : chosen.commit) : name
  const problem = tried ? folderError(folder, t) : null
  const submit = async () => {
    setTried(true)
    if (!chosen || folderError(folder, t) || busy) return
    setBusy(true)
    setError(null)
    try {
      const made = await startExport(api, { project, branch: chosen.branch, commit: chosen.commit, folder: folder.trim(), name: target })
      setJobId(made.id)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const openPicker = () => { setPick(chosen); setMode('map') }
  const backToForm = () => setMode('form')
  const usePick = () => { if (pick) setChosen(pick); setMode('form') }
  const choose = (s: HistorySelection) => setPick((old) => (same(old, s) ? old : s))
  const viewFiles = (s: HistorySelection) => { choose(s); setFilesAt(s); setMode('files') }
  // Escape inside the picker goes back to the form; in the form it closes
  const close = () => { if (mode === 'form') onClose(); else backToForm() }

  const form = (
    <>
      <header className={css.head}>
        <h2 className={css.title}>{t('export_title', { name })}</h2>
        <Button variant="ghost" size="sm" className={css.close} icon={<IconCloseOutlineRegular size={16} />} aria-label={t('export_close')} title={t('export_close')} onClick={onClose} />
      </header>
      <div className={css.formBody}>
        <div className={css.section}>
          <span className={css.label}>{t('export_version')}</span>
          <div className={css.card} data-export-version={chosen ? `${chosen.branch}@${chosen.commit}` : ''}>
            <span className={css.cardIcon}><IconBranchOutlineRegular size={18} /></span>
            <span className={css.cardBody}>
              <span className={css.cardTitle}>{chosen?.branch ?? 'main'}{chosen?.head ? <span className={css.muted}> · {t('export_latest')}</span> : null}</span>
              <span className={css.sub} title={commit?.message || undefined}>
                <code className={css.mono}>{chosen ? shortId(chosen.commit) : '…'}</code>
                {commit?.message ? ` · ${commit.message}` : ''}
                {commit?.at ? ` · ${ago(commit.at, Date.now(), t)}` : ''}
              </span>
            </span>
            {!job ? <Button variant="outline" size="sm" disabled={!chosen} data-export-choose="" onClick={openPicker}>{t('export_chooseVersion')}</Button> : null}
          </div>
          {readError ? <p className={css.error} role="alert">{readError}</p> : null}
        </div>
        {job ? (
          <ExportProgress api={api} job={job} t={t} onAgain={() => { setJobId(null); setTried(false) }} onChangeFolder={() => setJobId(null)}
            onClose={() => { void dismissExport(api, job.id); onClose() }} />
        ) : (
          <>
            <FolderCard api={api} t={t} folder={folder} onFolder={setFolder} name={target} error={problem} />
            {error ? <p className={css.error} role="alert">{error}</p> : null}
          </>
        )}
      </div>
      <footer className={css.footer}>
        {!job ? (
          <>
            <Button variant="outline" onClick={onClose}>{t('export_cancel')}</Button>
            <Button variant="primary" disabled={!chosen || busy} aria-busy={busy || undefined} data-export-start="" onClick={() => void submit()}>{t('export_start')}</Button>
          </>
        ) : running(job) ? <Button variant="outline" onClick={onClose}>{t('export_background')}</Button> : null}
      </footer>
    </>
  )

  const picker = (
    <>
      <header className={css.head}>
        <Button variant="ghost" size="sm" icon={<IconChevronLeftOutlineRegular size={16} />} aria-label={t('export_back')} title={t('export_back')}
          data-export-back="" onClick={mode === 'files' ? () => setMode('map') : backToForm} />
        <h2 className={css.title}>{mode === 'files' ? t('export_filesAt') : t('export_pickTitle')}</h2>
        {mode === 'map' && pick ? (
          <Button variant="outline" size="sm" className={css.headAction} data-export-view-files="" onClick={() => viewFiles(pick)}>{t('export_viewFiles')}</Button>
        ) : <span className={css.headAction} />}
      </header>
      <div className={css.pane} data-export-mode={mode}>
        {!pick ? <Loading label={t('files_loading')} className={css.center} />
          : mode === 'map' ? (
            <ProjectHistory api={api} project={project} t={t} initialBranch={pick.branch} initialCommit={pick.commit} className={css.fill} exportChip={false}
              onSelectionChange={choose}
              inspectorAction={(s) => <Button variant="outline" size="sm" onClick={() => viewFiles(s)}>{t('export_viewFiles')}</Button>} />
          ) : (
            <ProjectFiles key={`${filesAt?.branch ?? pick.branch}\u0000${filesAt?.commit ?? pick.commit}`} api={api} project={project} t={t} className={css.fill}
              initialBranch={(filesAt ?? pick).branch} initialPin={(filesAt ?? pick).head ? undefined : (filesAt ?? pick).commit}
              onVersionChange={choose} />
          )}
      </div>
      <footer className={css.pickBar}>
        <span className={css.picked} data-export-pick={pick ? `${pick.branch}@${pick.commit}` : ''}>
          {t('export_selected')} <b className={css.pickedBranch}>{pick?.branch ?? ''}</b> <code className={css.mono}>@ {pick ? shortId(pick.commit) : '…'}</code>
          {pick?.head ? <span className={css.latest}> {t('export_latest')}</span> : null}
        </span>
        <Button variant="outline" size="sm" onClick={backToForm}>{t('export_cancel')}</Button>
        <Button variant="primary" size="sm" disabled={!pick} data-export-use="" onClick={usePick}>{t('export_useVersion')}</Button>
      </footer>
    </>
  )

  return (
    <Contained>
      <Modal open headless onClose={close} title={t('export_title', { name })} className={`${toneScope} ${css.dialog}`}>
        <div className={css.body} data-export-dialog={project} data-export-size={mode === 'form' ? 'small' : 'large'}>
          {mode === 'form' ? form : picker}
        </div>
      </Modal>
    </Contained>
  )
}
