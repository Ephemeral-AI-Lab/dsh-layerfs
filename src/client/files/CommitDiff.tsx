/**
 * What one saved Commit changed: its changed paths (commit.diff, paths only)
 * and, for the selected path, its hunks (file.diff against the parent, or
 * against `from` when given) in DSH's diff block.
 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, DiffBlock, FileTypeIcon, Tag, type DiffHunk, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { codeLabels } from './labels.ts'
import { bytes, shortId } from './format.ts'
import { EmptyState, ErrorState, Loading } from './States.tsx'
import type { DiffRow, FileDiffResult, Translate } from './types.ts'
import { useQuery } from './use-query.ts'
import css from './Files.module.css'

export interface CommitDiffProps {
  api: LayerfsApi
  /** The project key, `<store>/<project>`. */
  project: string
  /** The Branch the Commit is on. */
  branch: string
  /** The Commit (or Layer) id. */
  commit: string
  /** The saved id to compare with; the Commit's parent (or base) when omitted. */
  from?: string | undefined
  t: Translate
  /** Opens a path at the Commit (e.g. in the Files tab). */
  onOpenFile?: ((path: string, pin: string) => void) | undefined
  className?: string | undefined
}

/** A change kind in the reader's words, with its tag tone. */
export function changeKind(kind: string, t: Translate): { label: string, tone: TagTone } {
  if (/add|creat|new/i.test(kind)) return { label: t('files_kindAdded'), tone: 'success' }
  if (/del|remov/i.test(kind)) return { label: t('files_kindRemoved'), tone: 'danger' }
  return { label: t('files_kindModified'), tone: 'neutral' }
}

/** `file.diff` rows as DiffBlock hunks: contiguous rows form one hunk; a jump in line numbers starts the next. */
export function hunksOf(path: string, rows: readonly DiffRow[], added: boolean): DiffHunk[] {
  const hunks: DiffRow[][] = []
  let last: DiffRow | undefined
  for (const row of rows) {
    const jump = last && ((row.left_line != null && last.left_line != null && row.left_line > last.left_line + 1)
      || (row.right_line != null && last.right_line != null && row.right_line > last.right_line + 1))
    if (!hunks.length || jump) hunks.push([])
    hunks.at(-1)!.push(row)
    last = row
  }
  return hunks.map((h) => {
    const line = (r: DiffRow) => r.text.replace(/\r?\n$/, '')
    const before = h.filter((r) => r.op !== '+').map(line)
    const after = h.filter((r) => r.op !== '-').map(line)
    return { path, oldText: added ? null : `${before.join('\n')}${before.length ? '\n' : ''}`, newText: `${after.join('\n')}${after.length ? '\n' : ''}` }
  })
}

export function CommitDiff({ api, project, branch, commit, from, t, onOpenFile, className }: CommitDiffProps): ReactNode {
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [changes, setChanges] = useState<{ path: string, kind: string }[]>([])
  const detail = useQuery(() => filesApi.commit(api, project, branch, commit, from, cursor), [api, project, branch, commit, from, cursor])
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { setCursor(undefined); setChanges([]); setSelected(null) }, [project, branch, commit, from])
  useEffect(() => {
    if (!detail.data) return
    const page = detail.data.changes ?? []
    setChanges((all) => (cursor ? [...all, ...page] : page))
    setSelected((s) => s ?? page[0]?.path ?? null)
  }, [detail.data, cursor])
  if (detail.error && !detail.data) return <ErrorState title={t('files_readFailed', { what: shortId(commit) })} error={detail.error} retryLabel={t('files_retry')} onRetry={detail.reload} />
  if (!detail.data) return <Loading label={t('files_loading')} className={css.pad} />
  const item = detail.data.item
  const left = from ?? item.parent ?? item.base ?? undefined
  const kindOf = (path: string) => changes.find((c) => c.path === path)?.kind ?? ''
  return (
    <div className={clsx(css.diffFrame, className)}>
      <div className={css.changeList}>
        <div className={css.changeHead}>
          <span>{t('files_changes')}</span>
          <span className={css.changeCount}>{t('files_changesCount', { count: changes.length })}</span>
        </div>
        {changes.length === 0 ? (left ? <p className={css.treeNote}>{t('files_noChanges')}</p> : null) : (
          <ul className={css.tree}>
            {changes.map((c) => {
              const k = changeKind(c.kind, t)
              return (
                <li key={c.path}>
                  <button type="button" className={css.treeRow} data-active={c.path === selected || undefined} onClick={() => setSelected(c.path)} title={c.path}>
                    <span className={css.treeIcon}><FileTypeIcon path={c.path} size={16} /></span>
                    <span className={css.treePath}>{c.path}</span>
                    <Tag tone={k.tone} className={css.changeTag}>{k.label}</Tag>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {detail.data.nextChanges ? <button type="button" className={css.linkButton} onClick={() => setCursor(detail.data!.nextChanges!)}>{t('files_moreChanges')}</button> : null}
      </div>
      <div className={css.diffPane}>
        {!left ? <EmptyState title={t('files_noParent')} />
          : selected
          ? <PathDiff key={`${selected}:${left}:${item.id}`} api={api} project={project} branch={branch} path={selected} left={left} right={item.id} kind={kindOf(selected)} t={t} onOpenFile={onOpenFile} />
          : <EmptyState title={t('files_selectPath')} />}
      </div>
    </div>
  )
}

export interface PathDiffProps {
  api: LayerfsApi
  project: string
  /** The Branch `right` is saved on. */
  branch: string
  path: string
  /** The saved id to compare from. */
  left: string
  /** The saved id to compare to. */
  right: string
  /** The Branch `left` is saved on (default `branch`). */
  leftBranch?: string | undefined
  /** The change kind, when the caller knows it (Added, Removed, Modified). */
  kind: string
  t: Translate
  onOpenFile?: ((path: string, pin: string) => void) | undefined
  /** Also list the unchanged lines whose owner changed. */
  attribution?: boolean | undefined
  /** Replaces the default path header. */
  header?: ReactNode
}

/** One path's change between two saved versions, possibly on different Branches. */
export function PathDiff({ api, project, branch, path, left, right, leftBranch, kind, t, onOpenFile, attribution = false, header }: PathDiffProps): ReactNode {
  const diff = useQuery<FileDiffResult>(() => filesApi.fileDiff(api, project, branch, path, left, right, leftBranch, attribution), [api, project, branch, path, left, right, leftBranch, attribution])
  const removed = /del|remov/i.test(kind)
  const head = header ?? (
    <div className={css.diffHead}>
      <span className={css.diffPath} title={path}>{path}</span>
      {onOpenFile && !removed ? <Button variant="outline" size="sm" onClick={() => onOpenFile(path, right)}>{t('files_openAtCommit')}</Button> : null}
    </div>
  )
  if (diff.error) return <>{head}<ErrorState title={t('files_readFailed', { what: path })} error={diff.error} retryLabel={t('files_retry')} onRetry={diff.reload} /></>
  if (!diff.data) return <>{head}<Loading label={t('files_loading')} className={css.pad} /></>
  const r = diff.data
  const rows = r.rows ?? []
  if (r.omission_reason) return <>{head}<EmptyState title={t('files_diffOmitted', { reason: r.omission_reason })} /></>
  if (!rows.length && (r.before?.size != null || r.after?.size != null) && r.content_coverage?.status !== 'complete') {
    return <>{head}<EmptyState title={t('files_diffBinary', { before: bytes(r.before?.size ?? 0), after: bytes(r.after?.size ?? 0) })} /></>
  }
  const owners = attribution ? <OwnerChanges rows={rows} result={r} t={t} /> : null
  if (!rows.some((row) => row.op !== ' ')) {
    return <>{head}{owners}{owners ? null : <EmptyState title={r.changes?.metadata && !r.changes.content ? t('files_metadataOnly') : t('files_diffNoContent')}>{t('files_diffNoContentBody')}</EmptyState>}</>
  }
  const added = !r.before || /add|creat|new/i.test(kind)
  const hunks = hunksOf(path, rows, added)
  return (
    <>
      {head}
      {owners}
      <DiffBlock className={css.diffBlock} diffs={hunks} labels={codeLabels(t)} maxLines={Math.max(rows.length + 1, 16)} />
      {r.has_more ? <p className={css.fileNote}>{t('files_diffMore')}</p> : null}
    </>
  )
}

/** The unchanged lines whose owner changed: text alone cannot show them. */
function OwnerChanges({ rows, result, t }: { rows: readonly DiffRow[], result: FileDiffResult, t: Translate }): ReactNode {
  const changed = rows.filter((row) => row.op === ' ' && row.owner_changed)
  const partial = result.attribution_coverage?.status && result.attribution_coverage.status !== 'complete'
  return (
    <div className={css.owners}>
      <p className={css.ownersHead}>{changed.length ? t('files_ownerChanged', { count: changed.length }) : t('files_ownerChangedNone')}</p>
      {changed.length ? (
        <ul className={css.ownerRows}>
          {changed.slice(0, 200).map((row) => (
            <li key={`${row.left_line}:${row.right_line}`} className={css.ownerRow}>
              <span className={css.ownerLine}>{row.right_line}</span>
              <code className={css.ownerIds} title={`${row.before_owner?.message ?? ''} → ${row.after_owner?.message ?? ''}`}>{shortId(row.before_owner?.ref.id)} → {shortId(row.after_owner?.ref.id)}</code>
              <code className={css.ownerText}>{row.text.replace(/\r?\n$/, '') || ' '}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {partial ? <p className={css.fileNote}>{t('files_compareOwnersUnknown')}</p> : null}
    </div>
  )
}
