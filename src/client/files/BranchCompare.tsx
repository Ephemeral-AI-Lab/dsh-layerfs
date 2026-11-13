/**
 * Two saved versions side by side, on the same or different Branches: the
 * files that differ from one to the other (`branch.diff`) and the selected
 * file's change. Each side is a Branch, at its saved head or at a version
 * picked in the history graph. "Only owner changes" lists the files whose
 * unchanged lines now belong to another version, and names those lines.
 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Checkbox, FileTypeIcon, IconChevronRightOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { BranchPicker } from './BranchPicker.tsx'
import { changeKind, PathDiff } from './CommitDiff.tsx'
import { shortId } from './format.ts'
import { EmptyState, ErrorState, Loading } from './States.tsx'
import type { BranchDiffItem, BranchDiffPage, Translate } from './types.ts'
import { useQuery } from './use-query.ts'
import css from './Files.module.css'

/** One side of a comparison: a Branch, at a saved version or its head. */
export interface CompareEnd { branch: string, pin?: string | undefined }

export interface BranchCompareProps {
  api: LayerfsApi
  project: string
  t: Translate
  /** The Branches a side can pick, each with its saved head. */
  branches: readonly { name: string, head: string | null }[]
  from: CompareEnd
  to: CompareEnd
  /** Opens a path at a saved version (e.g. the Files tab). */
  onOpenFile?: ((branch: string, path: string, pin: string) => void) | undefined
  className?: string | undefined
}

export function BranchCompare({ api, project, t, branches, from: initialFrom, to: initialTo, onOpenFile, className }: BranchCompareProps): ReactNode {
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [owners, setOwners] = useState(false)
  const headOf = (end: CompareEnd) => end.pin ?? branches.find((b) => b.name === end.branch)?.head ?? undefined
  const fromAt = headOf(from)
  const toAt = headOf(to)
  const first = useQuery(() => filesApi.branchDiff(api, project, from.branch, fromAt, to.branch, toAt), [api, project, from.branch, fromAt, to.branch, toAt])
  const [more, setMore] = useState<BranchDiffPage[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { setMore([]); setSelected(null) }, [first.data])

  const end = (side: CompareEnd, at: string | undefined, set: (e: CompareEnd) => void, label: string) => (
    <div className={css.compareEnd}>
      <span className={css.compareEndLabel}>{label}</span>
      <BranchPicker branches={branches} value={side.branch} onChange={(branch) => set({ branch })} t={t} />
      <code className={css.compareAt} title={at}>@ {shortId(at)}</code>
      {side.pin && side.pin !== branches.find((b) => b.name === side.branch)?.head
        ? <button type="button" className={css.inlineLink} onClick={() => set({ branch: side.branch })}>{t('files_latest')}</button> : null}
    </div>
  )
  const bar = (
    <div className={css.compareBar}>
      {end(from, fromAt, setFrom, t('files_compareFrom'))}
      <IconChevronRightOutlineRegular size={14} className={css.compareArrow} aria-hidden="true" />
      {end(to, toAt, setTo, t('files_compareTo'))}
      <Button variant="outline" size="sm" className={css.compareSwap} onClick={() => { setFrom(to); setTo(from) }}>{t('files_compareSwap')}</Button>
    </div>
  )
  if (fromAt && fromAt === toAt) return <div className={clsx(css.compare, className)}>{bar}<EmptyState title={t('files_compareSame')} /></div>
  if (first.error && !first.data) return <div className={clsx(css.compare, className)}>{bar}<ErrorState title={t('files_readFailed', { what: t('files_compareTitle') })} error={first.error} retryLabel={t('files_retry')} onRetry={first.reload} /></div>
  if (!first.data) return <div className={clsx(css.compare, className)}>{bar}<Loading label={t('files_loading')} className={css.pad} /></div>

  const pages = [first.data, ...more]
  const last = pages.at(-1)!
  const all = pages.flatMap((p) => p.items).filter((item) => item.type !== 'dir')
  const files = owners ? all.filter((item) => item.attribution === true) : all
  const current: BranchDiffItem | undefined = files.find((f) => f.path === selected) ?? files[0]
  const unknownOwners = owners && pages.some((p) => p.coverage?.complete === false)
  const loadMore = () => {
    if (!last.continuation) return
    setLoadingMore(true)
    filesApi.branchDiff(api, project, from.branch, fromAt, to.branch, toAt, last.continuation).then((p) => setMore((m) => [...m, p]), () => undefined).finally(() => setLoadingMore(false))
  }
  return (
    <div className={clsx(css.compare, className)}>
      {bar}
      <div className={css.diffFrame}>
        <div className={css.changeList}>
          <div className={css.changeHead}>
            <span>{t('files_changes')}</span>
            <span className={css.changeCount}>{all.length === 1 && !last.continuation ? t('files_compareSummaryOne') : t('files_compareSummary', { count: `${all.length}${last.continuation ? '+' : ''}` })}</span>
          </div>
          {files.length === 0
            ? <p className={css.treeNote}>{owners ? t('files_compareOwnersNone') : t('files_compareSame')}</p>
            : (
              <ul className={css.tree}>
                {files.map((f) => {
                  const k = changeKind(f.kind, t)
                  return (
                    <li key={f.path}>
                      <button type="button" className={css.treeRow} data-active={f.path === current?.path || undefined} onClick={() => setSelected(f.path)} title={f.path}>
                        <span className={css.treeIcon}><FileTypeIcon path={f.path} size={16} /></span>
                        <span className={css.treePath}>{f.path}</span>
                        <Tag tone={k.tone} className={css.changeTag}>{k.label}</Tag>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          {last.continuation ? <button type="button" className={css.linkButton} disabled={loadingMore} onClick={loadMore}>{t('files_moreChanges')}</button> : null}
          <Checkbox className={css.revisionToggle} checked={owners} label={t('files_compareOwners')} onChange={setOwners} />
          {unknownOwners ? <p className={css.treeNote}>{t('files_compareOwnersUnknown')}</p> : null}
        </div>
        <div className={css.diffPane}>
          {current && fromAt && toAt
            ? <PathDiff key={`${current.path}:${fromAt}:${toAt}:${owners}`} api={api} project={project} branch={to.branch} leftBranch={from.branch}
                path={current.path} left={fromAt} right={toAt} kind={current.kind} t={t} attribution={owners}
                onOpenFile={onOpenFile && ((path, pin) => onOpenFile(to.branch, path, pin))} />
            : files.length ? <EmptyState title={t('files_selectPath')} /> : null}
        </div>
      </div>
    </div>
  )
}
