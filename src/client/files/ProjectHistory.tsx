/**
 * A project's saved history as one topology: main's Layers centered with every
 * Branch on its own lane, fork/merge/publish edges, dense runs collapsed into
 * groups, and the selected node's details in a floating inspector. Ported from
 * LayerFS Connect's history view over the shared host routes.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Button, IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Modal, StateDot, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { CommitDiff } from './CommitDiff.tsx'
import { shortId, when } from './format.ts'
import { branchLanes, graphNodes, layoutNodes } from './graph-model.ts'
import { HistoryGraph } from './HistoryGraph.tsx'
import { EmptyState, Loading } from './States.tsx'
import type { CommitInfo, HistoryBranch, HistoryPage, Translate } from './types.ts'
import css from './History.module.css'

const noSources = new Map<string, string>()

/** One view's scroll, selection and fold state, kept across remounts per project. */
interface View {
  query: string
  branch: string
  selected: string | null
  expanded: Set<string>
  families: Set<string>
  sides: Map<string, number>
  top: number
  left: number
}

const saved = new Map<string, View>()
const newView = (): View => ({ query: '', branch: '', selected: null, expanded: new Set(), families: new Set(), sides: new Map(), top: 0, left: -1 })

export interface ProjectHistoryProps {
  api: LayerfsApi
  /** The project key, `<store>/<project>`. */
  project: string
  t: Translate
  /** The Branch to focus on open (default none). */
  initialBranch?: string | undefined
  /** A Commit to select and pan to on open. */
  initialCommit?: string | undefined
  /** Changes when the project may have changed. */
  tick?: number | undefined
  /** Opens a path at a saved id (e.g. the Files tab). */
  onOpenFile?: ((branch: string, path: string, pin: string) => void) | undefined
  className?: string | undefined
}

export function ProjectHistory({ api, project, t, initialBranch, initialCommit, tick = 0, onOpenFile, className }: ProjectHistoryProps): ReactNode {
  const key = `graph:${project}`
  const [view, setView] = useState<View>(() => {
    const v = { ...(saved.get(key) ?? newView()) }
    if (initialCommit) v.selected = initialCommit
    if (initialBranch) v.branch = initialBranch
    return v
  })
  const viewRef = useRef(view)
  viewRef.current = view
  const viewport = useRef({ top: view.top, left: view.left })
  const [viewportRequest] = useState(() => (view.left >= 0 ? { left: view.left, top: view.top, token: 0 } : null))
  const [branches, setBranches] = useState<HistoryBranch[]>([])
  const [branchNext, setBranchNext] = useState<number | null>(null)
  const [pages, setPages] = useState<Record<string, HistoryPage | undefined>>({})
  const [busy, setBusy] = useState<string | null>('initial')
  const [error, setError] = useState<unknown>(undefined)
  const [revision, setRevision] = useState(0)
  const [finderOpen, setFinderOpen] = useState(false)
  const finderAnchor = useRef<HTMLSpanElement>(null)
  const [mapReset, setMapReset] = useState(0)
  const [diffOpen, setDiffOpen] = useState(false)
  const writeView = (patch: Partial<View>) => setView((v) => ({ ...v, ...patch }))

  useEffect(() => () => {
    if (saved.size > 40) saved.delete(saved.keys().next().value!)
    saved.set(key, { ...viewRef.current, ...viewport.current })
  }, [key])

  useEffect(() => {
    let live = true
    setBusy('initial')
    setError(undefined)
    void filesApi.historyBranches(api, project).then(async (result) => {
      if (!live) return
      while (initialBranch && !result.branches.some((b) => b.name === initialBranch) && result.next !== null) {
        const more = await filesApi.historyBranches(api, project, result.next)
        if (!live) return
        result.branches.push(...more.branches)
        result.next = more.next
      }
      setBranches(result.branches)
      setBranchNext(result.next)
      const names = [...result.branches.filter((b) => b.name === 'main'), ...result.branches.filter((b) => b.name !== 'main')].slice(0, 8)
      const loaded: Record<string, HistoryPage | undefined> = {}
      // Bound concurrent Store reads, irrespective of the number of forks.
      for (let i = 0; i < names.length; i += 4) {
        const results = await Promise.allSettled(names.slice(i, i + 4).map(async (b) => [b.name, await filesApi.commits(api, project, b.name)] as const))
        for (const r of results) {
          if (r.status === 'fulfilled') loaded[r.value[0]] = r.value[1]
          else if (live) setError(r.reason)
        }
      }
      if (live) setPages(loaded)
    }).catch((e) => live && setError(e)).finally(() => live && setBusy(null))
    return () => { live = false }
  }, [api, project, revision, tick, initialBranch])

  async function loadBranch(name: string, more = false) {
    if (busy) return
    setBusy(name)
    setError(undefined)
    try {
      const previous = pages[name]
      const next = await filesApi.commits(api, project, name, more ? previous?.next ?? undefined : undefined)
      setPages((p) => ({ ...p, [name]: { ...next, items: more ? [...new Map([...(previous?.items ?? []), ...next.items].map((c) => [c.id, c])).values()] : next.items } }))
    } catch (e) { setError(e) } finally { setBusy(null) }
  }

  const structure = useMemo(() => branchLanes(branches, pages, busy === 'initial' ? new Map(view.sides) : view.sides), [branches, pages, view.sides, busy === 'initial'])
  const parents = structure.parents
  // A collapsed family hides descendants, never its own fork/head or the selected branch's ancestry.
  const forced = new Set<string>()
  for (let b: string | null = view.branch; b && !forced.has(b); b = parents.get(b) ?? null) forced.add(b)
  const visibleBranches = branches.filter((b) => {
    const seen = new Set<string>([b.name])
    let p = parents.get(b.name)
    while (p && p !== 'main' && !seen.has(p)) {
      if (view.families.has(p) && !forced.has(b.name)) return false
      seen.add(p)
      p = parents.get(p)
    }
    return true
  })
  const nodes = graphNodes(visibleBranches, pages, noSources, view.expanded, view.selected, t)
  const layout = layoutNodes(nodes, structure.lanes)
  const selected = layout.points.get(view.selected ?? '')
  const selectedCommit = selected?.commits.find((c) => c.id === view.selected) ?? selected?.commits.at(-1)
  const detailFrom = selected?.kind === 'group' ? selected.commits[0].parent ?? undefined : undefined
  const detail = useDetail(api, project, selectedCommit, detailFrom)
  const loaded = Object.values(pages).reduce((sum, p) => sum + (p?.items.length ?? 0), 0)

  function select(id: string, branch: string) {
    writeView({ selected: id, branch })
  }
  function toggleFamily(name: string) {
    const families = new Set(view.families)
    if (families.has(name)) families.delete(name)
    else families.add(name)
    writeView({ families, branch: '', selected: null })
  }
  const openBranch = (name: string) => {
    const b = branches.find((x) => x.name === name)
    writeView({ branch: name, selected: b?.head ?? `branch:${name}` })
    setFinderOpen(false)
    if (!pages[name]) void loadBranch(name)
  }

  const eyebrow = selected?.kind === 'group' ? t('files_checkpointGroup')
    : selected?.kind === 'layer' ? t('files_layerOnMain')
    : selected?.kind === 'fork' ? t('files_branchHead')
    : selected?.second ? t('files_merge')
    : t('files_checkpoint')
  const inspector = selected ? (
    <aside className={css.detail} aria-label={t('files_commitDetails')}>
      <button type="button" className={css.inspectorClose} aria-label={t('files_closeDetails')} onClick={() => writeView({ selected: null, branch: '' })}><IconCloseOutlineRegular size={14} /></button>
      <span className={css.eyebrow}>{eyebrow}</span>
      <h3>{selected.kind === 'group' ? selected.label : detail.data?.item.message || selected.label}</h3>
      <dl>
        <dt>{t('files_branch')}</dt>
        <dd>{selected.branch}</dd>
        {selected.kind === 'fork'
          ? <><dt>{t('files_forkedFrom')}</dt><dd><code title={branches.find((b) => b.name === selected.branch)?.forkedFrom ?? ''}>{shortId(branches.find((b) => b.name === selected.branch)?.forkedFrom)}</code></dd></>
          : <><dt>{selected.kind === 'group' ? t('files_checkpoints') : t('files_id')}</dt><dd>{selected.kind === 'group' ? selected.commits.length : <code title={selected.id}>{shortId(selected.id)}</code>}</dd></>}
        {selectedCommit?.at ? <><dt>{t('files_when')}</dt><dd>{when(selectedCommit.at)}</dd></> : null}
      </dl>
      {selected.kind === 'group' ? (
        <>
          <div className={css.detailActions}><Button variant="outline" size="sm" onClick={() => writeView({ expanded: new Set([...view.expanded, selected.id]), selected: selected.commits[0].id })}>{t('files_expandCheckpoints', { count: selected.commits.length })}</Button></div>
          <p>{t('files_expandCheckpointsBody')}</p>
        </>
      ) : null}
      {selected.parent && !layout.points.has(selected.parent) ? <p>{t('files_parentMissing', { id: shortId(selected.parent) })}</p> : null}
      {selectedCommit?.sourceBranch ? <p>{t('files_sourceBranch')}: {selectedCommit.sourceBranch}</p> : null}
      {selectedCommit?.sourceCommit ? <p>{t('files_sourceCommit')}: <code>{shortId(selectedCommit.sourceCommit)}</code></p> : null}
      {selectedCommit?.base ? <p>{t('files_baseLayer')}: <code>{shortId(selectedCommit.base)}</code></p> : null}
      {selected?.second ? <p>{t('files_mergeParent', { id: shortId(selected.second) })}</p> : null}
      {selected.kind !== 'fork' ? (
        <>
          {detail.error ? <p role="alert">{t('files_readFailed', { what: t('files_changes') })}</p>
            : selectedCommit && !detail.data ? <p>{t('files_readingPaths')}</p>
            : detail.data ? (
              <>
                <h4>{selected.kind === 'group' ? t('files_netChanges') : t('files_changes')}</h4>
                {detail.data.changes == null ? <p>{t('files_noCompare')}</p>
                  : detail.data.changes.length === 0 ? <p>{selected.kind === 'layer' && !selectedCommit?.parent && !selectedCommit?.base ? t('files_initialImport') : t('files_noChanges')}</p>
                  : (
                    <ul className={css.paths}>
                      {detail.data.changes.map((c, i) => (
                        <li key={`${c.path}:${i}`}>
                          {onOpenFile && selectedCommit
                            ? <button type="button" className={css.pathButton} onClick={() => onOpenFile(selectedCommit.branch, c.path, selectedCommit.id)}><span>{c.kind}</span><code>{c.path}</code></button>
                            : <span className={css.pathButton}><span>{c.kind}</span><code>{c.path}</code></span>}
                        </li>
                      ))}
                    </ul>
                  )}
                {detail.data.nextChanges != null ? <div className={css.detailActions}><Button variant="outline" size="sm" disabled={detail.loading} onClick={detail.more}>{t('files_moreChanges')}</Button></div> : null}
              </>
            ) : null}
          {selectedCommit && selected.kind !== 'group' ? <div className={css.detailActions}><Button variant="outline" size="sm" onClick={() => setDiffOpen(true)}>{t('files_viewDiff')}</Button></div> : null}
        </>
      ) : null}
      {view.branch ? (
        <div className={css.pagination}>
          {pages[view.branch]?.next != null
            ? <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void loadBranch(view.branch, true)}>{t('files_loadEarlierCheckpoints')}</Button>
            : !pages[view.branch]
              ? <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void loadBranch(view.branch)}>{t('files_loadCheckpoints')}</Button>
              : <p>{t('files_allCheckpoints')}</p>}
        </div>
      ) : null}
    </aside>
  ) : undefined

  return (
    <div className={clsx(css.view, className)}>
      <div className={css.toolbar}>
        <div className={css.title}>
          <IconBranchOutlineRegular size={15} />
          <strong>{t('files_history')}</strong>
          <span className={css.mainSummary}>main <span>@ {shortId(branches.find((b) => b.name === 'main')?.head)}</span></span>
          <span className={css.count}>{t('files_checkpointsLoaded', { count: loaded })}</span>
        </div>
        <div className={css.actions}>
          <span ref={finderAnchor}>
            <Button variant="outline" size="sm" aria-expanded={finderOpen} onClick={() => setFinderOpen((v) => !v)}>
              {t('files_branches')} <span>{branches.length}{branchNext !== null ? '+' : ''}</span> <IconChevronDownOutlineRegular size={12} />
            </Button>
          </span>
          <Button variant="outline" size="sm" onClick={() => { writeView({ selected: null, branch: '' }); setMapReset((n) => n + 1) }}>{t('files_now')}</Button>
          <Button variant="outline" size="sm" aria-label={t('files_refresh')} disabled={!!busy} icon={busy ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={13} />} onClick={() => setRevision((n) => n + 1)} />
        </div>
      </div>
      {finderOpen ? (
        <BranchFinder anchorRef={finderAnchor} t={t} branches={branches} parents={parents} families={view.families} filtered={view.query} onQuery={(query) => writeView({ query })} onBranch={openBranch} onToggleFamily={toggleFamily} busy={busy} branchNext={branchNext} onMore={() => {
          setBusy('branches')
          void filesApi.historyBranches(api, project, branchNext!).then((r) => {
            setBranches((b) => [...new Map([...b, ...r.branches].map((x) => [x.name, x])).values()])
            setBranchNext(r.next)
          }).catch(setError).finally(() => setBusy(null))
        }} onClose={() => setFinderOpen(false)} />
      ) : null}
      {error ? <div role="alert" className={css.alert}>{error instanceof Error ? error.message : String(error)} <button type="button" onClick={() => setRevision((n) => n + 1)}>{t('files_retry')}</button></div> : null}
      <div className={css.stage}>
        {busy === 'initial' && !Object.keys(pages).length
          ? <Loading label={t('files_historyReading')} className={css.center} />
          : !branches.length
            ? <EmptyState title={t('files_historyNone')} className={css.center}>{t('files_historyNoneBody')}</EmptyState>
            : (
              <HistoryGraph
                nodes={nodes} lanes={structure.lanes} branches={visibleBranches} familyCounts={new Map(branches.map((b) => [b.name, branches.filter((c) => parents.get(c.name) === b.name).length]))}
                selected={view.selected} focus={view.selected} onSelect={select} onBranch={openBranch} collapsed={view.families} onToggleFamily={toggleFamily}
                expanded={view.expanded.size > 0} onCollapse={() => writeView({ expanded: new Set(), selected: null, branch: '' })} reset={mapReset}
                inspector={inspector} onViewport={(top, left) => { viewport.current = { top, left } }} viewportRequest={viewportRequest} t={t}
              />
            )}
      </div>
      <div className={css.legend} aria-label={t('files_historyLegend')}>
        <span><i className={css.legendTrunk} />{t('files_layerOnMain')}</span>
        <span><svg width="19" height="14" viewBox="-1 -8 20 16" aria-hidden="true"><circle cx="8" cy="0" r="3" /></svg>{t('files_checkpoint')}</span>
        <span><i className={css.legendBough} />{t('files_branch')}</span>
        <span><i className={css.legendMerge} />{t('files_merge')}</span>
        <span><i className={css.legendPublish} />{t('files_legendPublish')}</span>
        <span className={css.legendHint}>{t('files_legendHint')}</span>
      </div>
      <div className={css.foot}><span>{t('files_historyFoot')}</span></div>
      {diffOpen && selectedCommit ? (
        <Modal open onClose={() => setDiffOpen(false)} title={t('files_diffTitle', { id: shortId(selectedCommit.id) })} closeLabel={t('files_closeLabel')} className={css.diffModal} contentClassName={css.diffModalBody}>
          <CommitDiff api={api} project={project} branch={selectedCommit.branch} commit={selectedCommit.id} from={detailFrom} t={t}
            onOpenFile={onOpenFile && ((path, pin) => onOpenFile(selectedCommit.branch, path, pin))} />
        </Modal>
      ) : null}
    </div>
  )
}

/** The selected node's changed paths, paged through the Commit detail route. */
function useDetail(api: LayerfsApi, project: string, commit: CommitInfo | undefined, from: string | undefined) {
  const [page, setPage] = useState<{ item: CommitInfo, changes: { path: string, kind: string }[] | null, nextChanges: string | null } | null>(null)
  const [error, setError] = useState<unknown>(undefined)
  const [loading, setLoading] = useState(false)
  const id = commit?.id
  const branch = commit?.branch
  useEffect(() => {
    setPage(null)
    setError(undefined)
    if (!id || !branch) return
    let live = true
    setLoading(true)
    void filesApi.commit(api, project, branch, id, from).then((r) => live && setPage(r)).catch((e) => live && setError(e)).finally(() => live && setLoading(false))
    return () => { live = false }
  }, [api, project, branch, id, from])
  const more = () => {
    if (!page?.nextChanges || !id || !branch) return
    setLoading(true)
    void filesApi.commit(api, project, branch, id, from, page.nextChanges)
      .then((r) => setPage((d) => (d ? { ...r, changes: [...(d.changes ?? []), ...(r.changes ?? [])] } : r)))
      .catch(setError)
      .finally(() => setLoading(false))
  }
  return { data: page, error, loading, more }
}

/** The Branches popover: search, one row per Branch and its family fold. */
function BranchFinder({ anchorRef, t, branches, parents, families, filtered, onQuery, onBranch, onToggleFamily, busy, branchNext, onMore, onClose }: {
  anchorRef: RefObject<HTMLSpanElement | null>, t: Translate, branches: readonly HistoryBranch[], parents: ReadonlyMap<string, string | null>, families: ReadonlySet<string>
  filtered: string, onQuery: (q: string) => void, onBranch: (name: string) => void, onToggleFamily: (name: string) => void
  busy: string | null, branchNext: number | null, onMore: () => void, onClose: () => void
}): ReactNode {
  const panel = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open: true, anchorRef, panelRef: panel, side: 'bottom', align: 'end', gap: 4, margin: 8 })
  useDismissOnOutsidePointer(anchorRef, true, () => onClose(), panel)
  const rows = branches.filter((b) => b.name.toLowerCase().includes(filtered.toLowerCase()))
  return createPortal(
    <div ref={panel} className={css.finder} role="dialog" aria-label={t('files_findBranch')} style={position ?? { visibility: 'hidden' }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <label className={css.search}>
        <IconSearchOutlineRegular size={14} />
        <input autoFocus aria-label={t('files_searchBranches')} placeholder={t('files_searchBranches')} value={filtered} onChange={(e) => onQuery(e.target.value)} />
        <button type="button" onClick={onClose} aria-label={t('files_closeLabel')}><IconCloseOutlineRegular size={13} /></button>
      </label>
      <div className={css.branchList}>
        {rows.map((b) => {
          const children = branches.filter((c) => parents.get(c.name) === b.name).length
          return (
            <div className={css.branchRow} key={b.name}>
              <button type="button" onClick={() => onBranch(b.name)} title={b.name}>
                <IconBranchOutlineRegular size={13} /><span>{b.name}</span>{busy === b.name ? <StateDot state="ongoing" size={12} /> : null}
              </button>
              {children > 0 && b.name !== 'main' ? (
                <button type="button" className={css.family} aria-expanded={!families.has(b.name)}
                  aria-label={families.has(b.name) ? t('files_expandFamily', { name: b.name }) : t('files_collapseFamily', { name: b.name })}
                  onClick={() => onToggleFamily(b.name)}>
                  <IconChevronRightOutlineRegular size={12} />{children}
                </button>
              ) : null}
            </div>
          )
        })}
        {!rows.length ? <p className={css.note}>{t('files_noBranchMatch')}</p> : null}
        {branchNext !== null ? <div className={css.moreRow}><Button variant="outline" size="sm" disabled={!!busy} onClick={onMore}>{t('files_moreBranches')}</Button></div> : null}
      </div>
    </div>,
    document.body,
  )
}
