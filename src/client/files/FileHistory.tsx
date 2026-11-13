/**
 * A file's History: the saved versions that changed it, newest first, and the
 * selected version's change. A version is compared with the one it changed
 * from, or with any other listed version. Versions saved on other Branches
 * (before a fork, or merged in) are included unless the reader turns them off.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Checkbox, IconChevronDownOutlineRegular, Menu, Tag, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { PathDiff } from './CommitDiff.tsx'
import { ago, shortId, toMs, when } from './format.ts'
import { branchLabel, revisionTitle } from './labels.ts'
import { EmptyState, ErrorState, Loading } from './States.tsx'
import type { FileRevision, RevisionPage, Translate } from './types.ts'
import { useQuery } from './use-query.ts'
import css from './Files.module.css'

export interface FileHistoryProps {
  api: LayerfsApi
  project: string
  branch: string
  path: string
  pin?: string | undefined
  t: Translate
  /** A version (saved id) to select first, e.g. from Blame. */
  focus?: string | undefined
}

const PREVIOUS = 'previous'

export function FileHistory({ api, project, branch, path, pin, t, focus }: FileHistoryProps): ReactNode {
  const [others, setOthers] = useState(true)
  const traversal = others ? 'provenance' : 'branch'
  const first = useQuery(() => filesApi.revisions(api, project, branch, path, pin, traversal), [api, project, branch, path, pin, traversal])
  const [more, setMore] = useState<RevisionPage[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [selected, setSelected] = useState<string | undefined>(focus)
  const [against, setAgainst] = useState<string>(PREVIOUS)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => { setMore([]) }, [first.data])

  if (first.error && !first.data) return <ErrorState title={t('files_readFailed', { what: path })} error={first.error} retryLabel={t('files_retry')} onRetry={first.reload} />
  if (!first.data) return <Loading label={t('files_revisionsReading')} className={css.pad} />
  const pages = [first.data, ...more]
  const items = [...new Map(pages.flatMap((p) => p.items).map((v) => [v.ref.id, v])).values()]
  const last = pages.at(-1)!
  const toggle = (
    <Checkbox className={css.revisionToggle} checked={others} label={t('files_revisionsOtherBranches')} onChange={(v) => { setOthers(v); setSelected(undefined); setAgainst(PREVIOUS) }} />
  )
  if (!items.length) return <EmptyState title={t('files_revisionsNone')} action={toggle} />
  const current = items.find((v) => v.ref.id === selected) ?? items[0]!
  const chosen = against === PREVIOUS ? undefined : items.find((v) => v.ref.id === against)
  const left = chosen ? chosen.ref : current.compared_to
  const loadMore = () => {
    if (!last.continuation) return
    setLoadingMore(true)
    filesApi.revisions(api, project, branch, path, pin, traversal, last.continuation).then((p) => setMore((m) => [...m, p]), () => undefined).finally(() => setLoadingMore(false))
  }
  const now = Date.now()
  const label = (v: FileRevision) => `${revisionTitle(v, t)} · ${shortId(v.ref.id)}`
  const menu: MenuEntry[] = [
    { id: PREVIOUS, label: t('files_comparePrevious') },
    ...items.filter((v) => v.ref.id !== current.ref.id).map((v) => ({ id: v.ref.id, label: label(v) })),
  ]
  const header = (
    <div className={css.diffHead}>
      <span className={css.diffPath}>
        {left ? <><code title={left.id}>{shortId(left.id)}</code> → </> : null}<code title={current.ref.id}>{shortId(current.ref.id)}</code>
      </span>
      <Menu open={menuOpen} onClose={() => setMenuOpen(false)} items={menu} selectedId={against} selection="check" portal align="end"
        onSelect={(id) => { setMenuOpen(false); setAgainst(id) }}
        anchor={(
          <Button variant="outline" size="sm" className={css.compareWith} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            {t('files_compareWith')}: {chosen ? shortId(chosen.ref.id) : t('files_comparePrevious')} <IconChevronDownOutlineRegular size={12} />
          </Button>
        )} />
    </div>
  )
  return (
    <div className={css.historyFrame}>
      <div className={css.revisionList}>
        <ul className={css.tree} aria-label={t('files_modeHistory')}>
          {items.map((v) => {
            const at = toMs(v.recorded_at)
            const other = v.ref.branch && v.ref.branch !== branch ? v.ref.branch : null
            const tag = /add/i.test(v.kind) ? <Tag tone="success" className={css.changeTag}>{t('files_kindAdded')}</Tag>
              : /remov|del/i.test(v.kind) ? <Tag tone="danger" className={css.changeTag}>{t('files_kindRemoved')}</Tag> : null
            return (
              <li key={v.ref.id}>
                <button type="button" className={css.revisionRow} data-active={v.ref.id === current.ref.id || undefined} title={`${v.ref.id}${at != null ? `\n${when(at)}` : ''}`}
                  onClick={() => { setSelected(v.ref.id); setAgainst(PREVIOUS) }}>
                  <span className={css.revisionTop}><span className={css.revisionTitle}>{revisionTitle(v, t)}</span>{tag}</span>
                  <span className={css.blameMeta}>
                    <code>{shortId(v.ref.id)}</code>
                    {other ? <span title={other}>{branchLabel(other, t)}</span> : null}
                    {at != null ? <span>{ago(at, now, t)}</span> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {last.continuation ? <button type="button" className={css.linkButton} disabled={loadingMore} onClick={loadMore}>{t('files_revisionsMore')}</button> : null}
        {last.scan?.complete === false ? <p className={css.treeNote}>{t('files_revisionsIncomplete')}</p> : null}
        {toggle}
      </div>
      <div className={css.revisionDiff}>
        {left
          ? <PathDiff key={`${left.id}:${current.ref.id}`} api={api} project={project} branch={current.ref.branch ?? branch} leftBranch={left.branch ?? branch}
              path={path} left={left.id} right={current.ref.id} kind={chosen ? 'Modified' : current.kind} t={t} header={header} />
          : <>{header}<EmptyState title={t('files_compareFirst')} /></>}
      </div>
    </div>
  )
}
