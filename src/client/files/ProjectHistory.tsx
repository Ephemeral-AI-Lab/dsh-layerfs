/**
 * A project's saved history: one Branch's Commits newest first (main shows its
 * Layers), paged back from the head, and the selected Commit's changes.
 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { BranchPicker } from './BranchPicker.tsx'
import { CommitDiff } from './CommitDiff.tsx'
import { ago, shortId, when } from './format.ts'
import { EmptyState, ErrorState, Loading } from './States.tsx'
import type { CommitInfo, HistoryBranch, Translate } from './types.ts'
import { useQuery } from './use-query.ts'
import css from './Files.module.css'

export interface ProjectHistoryProps {
  api: LayerfsApi
  /** The project key, `<store>/<project>`. */
  project: string
  t: Translate
  /** The Branch to open on (default main). */
  initialBranch?: string | undefined
  /** A Commit to select first. */
  initialCommit?: string | undefined
  /** Changes when the project may have changed. */
  tick?: number | undefined
  /** Opens a path at a saved id (e.g. the Files tab). */
  onOpenFile?: ((branch: string, path: string, pin: string) => void) | undefined
  className?: string | undefined
}

export function ProjectHistory({ api, project, t, initialBranch, initialCommit, tick = 0, onOpenFile, className }: ProjectHistoryProps): ReactNode {
  const listed = useQuery(() => filesApi.historyBranches(api, project), [api, project, tick])
  const branches: HistoryBranch[] = listed.data?.branches ?? []
  const [branch, setBranch] = useState(initialBranch ?? 'main')
  useEffect(() => {
    if (listed.data && !listed.data.branches.some((b) => b.name === branch)) setBranch(listed.data.branches.find((b) => b.name === 'main')?.name ?? listed.data.branches[0]?.name ?? 'main')
  }, [listed.data, branch])
  if (listed.error && !listed.data) return <ErrorState title={t('files_readFailed', { what: t('files_history') })} error={listed.error} retryLabel={t('files_retry')} onRetry={listed.reload} />
  if (!listed.data) return <Loading label={t('files_loading')} className={css.pad} />
  if (!branches.length) return <EmptyState title={t('files_noBranches')}>{t('files_noBranchesBody')}</EmptyState>
  return (
    <BranchHistory key={`${branch}:${tick}`} api={api} project={project} t={t} branch={branch} branches={branches} onBranch={setBranch}
      initialCommit={branch === initialBranch ? initialCommit : undefined} onOpenFile={onOpenFile} className={className} />
  )
}

function BranchHistory({ api, project, t, branch, branches, onBranch, initialCommit, onOpenFile, className }: { api: LayerfsApi, project: string, t: Translate, branch: string, branches: HistoryBranch[], onBranch: (b: string) => void, initialCommit: string | undefined, onOpenFile: ProjectHistoryProps['onOpenFile'], className: string | undefined }): ReactNode {
  const [at, setAt] = useState<string | undefined>(undefined)
  const [items, setItems] = useState<CommitInfo[]>([])
  const page = useQuery(() => filesApi.commits(api, project, branch, at), [api, project, branch, at])
  const [selected, setSelected] = useState<string | null>(initialCommit ?? null)
  const now = Date.now()
  useEffect(() => {
    if (!page.data) return
    setItems((all) => (at ? [...all, ...page.data!.items.filter((c) => !all.some((x) => x.id === c.id))] : page.data!.items))
    setSelected((s) => s ?? page.data!.items[0]?.id ?? null)
  }, [page.data, at])
  const chosen = items.find((c) => c.id === selected)
  return (
    <div className={clsx(css.frameWrap, className)}><div className={css.historyFrame}>
      <aside className={css.side}>
        <div className={css.sideHead}>
          <BranchPicker branches={branches} value={branch} onChange={onBranch} t={t} />
        </div>
        <div className={css.treeScroll}>
          {page.error && !items.length ? <ErrorState title={t('files_readFailed', { what: branch })} error={page.error} retryLabel={t('files_retry')} onRetry={page.reload} />
            : !page.data && !items.length ? <Loading label={t('files_loading')} className={css.pad} />
            : !items.length ? <EmptyState title={t('files_historyEmpty')}>{t('files_historyEmptyBody')}</EmptyState>
            : (
              <ol className={css.commits} aria-label={t('files_history')}>
                {items.map((c) => {
                  const merge = c.kind === 'merge' || !!c.merged
                  const layer = branch === 'main'
                  return (
                    <li key={c.id}>
                      <button type="button" className={css.commit} data-active={c.id === selected || undefined} onClick={() => setSelected(c.id)}>
                        <span className={css.commitDot} data-kind={merge ? 'merge' : layer ? 'layer' : 'commit'} aria-hidden="true" />
                        <span className={css.commitMain}>
                          <span className={css.commitMessage}>{c.message || (layer ? t('files_layer') : t('files_noMessage'))}</span>
                          <span className={css.commitMeta}>
                            <code>{shortId(c.id)}</code>
                            {c.at != null ? <span title={when(c.at)}>{ago(c.at, now, t)}</span> : null}
                            {merge ? <Tag tone="info">{t('files_merge')}</Tag> : layer && c.message ? <Tag tone="neutral">{t('files_layer')}</Tag> : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            )}
          {page.data?.next ? <button type="button" className={css.linkButton} disabled={page.loading} onClick={() => setAt(page.data!.next!)}>{t('files_earlier')}</button> : null}
        </div>
      </aside>
      <section className={css.main}>
        {chosen ? (
          <>
            <header className={css.commitHeader}>
              <h3 className={css.commitTitle}>{chosen.message || (branch === 'main' ? t('files_layer') : t('files_noMessage'))}</h3>
              <p className={css.commitSub}>
                <code title={chosen.id}>{shortId(chosen.id)}</code>
                {chosen.at != null ? <span title={when(chosen.at)}>{ago(chosen.at, now, t)}</span> : null}
                {chosen.parent ? <span>{t('files_parent', { id: shortId(chosen.parent) })}</span> : null}
              </p>
            </header>
            <CommitDiff key={chosen.id} api={api} project={project} branch={branch} commit={chosen.id} t={t}
              onOpenFile={onOpenFile && ((path, pin) => onOpenFile(branch, path, pin))} />
          </>
        ) : <EmptyState title={t('files_selectCommit')}>{t('files_selectCommitBody')}</EmptyState>}
      </section>
    </div></div>
  )
}
