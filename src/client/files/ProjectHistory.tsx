/**
 * A project's saved history as one tree: main's Layers along the middle, every
 * Branch on a lane above or below it, a leaf per checkpoint in saved order, and
 * the selected one's details in a floating inspector. Every Branch is read in
 * full in the background, so the whole run is on screen without folding.
 */
import { startTransition, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Button, IconBranchOutlineRegular, IconCompareSplitOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Modal, StateDot, Tag, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { BranchCompare, type CompareEnd } from './BranchCompare.tsx'
import { changeKind, CommitDiff } from './CommitDiff.tsx'
import { shortId, when } from './format.ts'
import { countedTotal, extendPage, movedCount } from './graph-model.ts'
import { branchParents, treeLayout } from './tree-model.ts'
import { HistoryGraph } from './HistoryGraph.tsx'
import { branchLabel } from './labels.ts'
import { EmptyState, Loading } from './States.tsx'
import type { CommitInfo, HistoryBranch, HistoryPage, Translate } from './types.ts'
import css from './History.module.css'

/** Pages read past the first to reach a deep-linked Commit. */
const DEEP_LINK_PAGES = 20
/** Branch list pages read up front. */
const BRANCH_PAGES = 40
/** The longest the tree waits for the whole history before it grows in. */
const GROW_WAIT = 8000
/** How often the tree is laid out again while the background read is running. */
const DRAW_EVERY = 1200
/** Checkpoints read in the background without asking; past this, Load all reads the rest. */
const AUTO_LIMIT = 20000
/** Wide pages read to rejoin a Branch's loaded history when its head moved (else only its first page stays). */
const REJOIN_PAGES = 5
/** `loadingAll` while every Branch is being read in full. */
const ALL = '\u0000all'

/** One view's scroll, selection and fold state, kept across remounts per project. */
interface View {
  query: string
  branch: string
  selected: string | null
  families: Set<string>
  /** The camera: `zoom` 0 is the whole run. */
  left: number
  zoom: number
}

const saved = new Map<string, View>()

/** Each project's last read (Branch list and first pages), kept across remounts. */
interface HistoryData { branches: HistoryBranch[], next: number | null, pages: Record<string, HistoryPage | undefined>, counts?: Record<string, BranchCount> }
/** A side Branch's Commit count at a head (`files.commitCount`). */
interface BranchCount { head: string | null, count: number }
const dataCache = new Map<string, HistoryData>()
const remember = (project: string, data: HistoryData) => {
  dataCache.delete(project)
  if (dataCache.size >= 8) dataCache.delete(dataCache.keys().next().value!)
  dataCache.set(project, data)
}
const newView = (): View => ({ query: '', branch: '', selected: null, families: new Set(), left: 0, zoom: 0 })

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
  const viewport = useRef({ left: view.left, zoom: view.zoom })
  const [viewportRequest] = useState(() => (view.zoom ? { left: view.left, zoom: view.zoom } : null))
  // The last read of this project draws at once on a remount (a tab switch); a fresh read follows.
  const [cached] = useState(() => dataCache.get(project))
  const [branches, setBranches] = useState<HistoryBranch[]>(() => cached?.branches ?? [])
  const [branchNext, setBranchNext] = useState<number | null>(() => cached?.next ?? null)
  const [pages, setPagesState] = useState<Record<string, HistoryPage | undefined>>(() => cached?.pages ?? {})
  const [busy, setBusy] = useState<string | null>(cached ? null : 'initial')
  // What is read so far, ahead of the render: the loaders check their own progress against it.
  const pagesRef = useRef(pages)
  const setPages = (update: (p: Record<string, HistoryPage | undefined>) => Record<string, HistoryPage | undefined>, transition = false) => {
    const next = pagesRef.current = update(pagesRef.current)
    if (transition) startTransition(() => setPagesState(next))
    else setPagesState(next)
  }
  // Each side Branch's whole Commit count, read after the pages in the background.
  const [counts, setCounts] = useState<Record<string, BranchCount>>(() => cached?.counts ?? {})
  const countsRef = useRef(counts)
  countsRef.current = counts
  // Load all: the Branch being read in full, and the read to stop when it is replaced.
  const [loadingAll, setLoadingAll] = useState<string | null>(null)
  const allGen = useRef(0)
  // Stop was pressed (or the history is past AUTO_LIMIT): the background read waits for Load all.
  const held = useRef(false)
  const filling = useRef(false)
  const branchesRef = useRef(branches)
  branchesRef.current = branches
  const [error, setError] = useState<unknown>(undefined)
  const [revision, setRevision] = useState(0)
  const [finderOpen, setFinderOpen] = useState(false)
  const finderAnchor = useRef<HTMLSpanElement>(null)
  // The tree has no bar: its zoom controls join the other controls in a corner of it.
  const [zoomSlot, setZoomSlot] = useState<HTMLElement | null>(null)
  // How long the tree waits for the whole history before it grows in with what it has.
  const [patience, setPatience] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setPatience(true), GROW_WAIT)
    return () => clearTimeout(timer)
  }, [project])
  const [diffOpen, setDiffOpen] = useState(false)
  // A comparison: open in its dialog, or waiting for its second side to be picked in the graph.
  const [compare, setCompare] = useState<{ from: CompareEnd, to: CompareEnd } | null>(null)
  const [picking, setPicking] = useState<CompareEnd | null>(null)
  const writeView = (patch: Partial<View>) => setView((v) => ({ ...v, ...patch }))

  useEffect(() => () => {
    if (saved.size > 40) saved.delete(saved.keys().next().value!)
    saved.set(key, { ...viewRef.current, ...viewport.current })
  }, [key])

  // Reads run one at a time. A refresh (`tick`) never cancels a read in flight: under a
  // steady stream of events that would discard every result. It is queued and runs once
  // the read ends. A new project, deep link or Retry (`gen`) does replace the read.
  const gen = useRef(0)
  const reading = useRef(0)
  const again = useRef(false)
  async function read(g: number): Promise<void> {
    const stale = () => gen.current !== g
    reading.current = g
    try {
      const result = await filesApi.historyBranches(api, project)
      for (let n = 1; result.next !== null && (n < BRANCH_PAGES || (initialBranch && !result.branches.some((b) => b.name === initialBranch))); n++) {
        if (stale()) return
        const more = await filesApi.historyBranches(api, project, result.next)
        result.branches.push(...more.branches)
        result.next = more.next
      }
      if (stale()) return
      // Progressive: the lanes draw from the Branch list at once, and each Branch's Commits
      // join the graph as they arrive, main and the focused Branch first.
      setBranches(result.branches)
      setBranchNext(result.next)
      const focused = initialBranch ? result.branches.find((b) => b.name === initialBranch) : undefined
      const main = result.branches.find((b) => b.name === 'main')
      const first = [main, focused].filter((b, i, all): b is HistoryBranch => !!b && all.indexOf(b) === i)
      const names = [...first, ...result.branches.filter((b) => !first.includes(b))]
      const loaded: Record<string, HistoryPage | undefined> = {}
      // A Branch whose head has not moved keeps the pages already read (more than its first, maybe).
      const had = pagesRef.current
      const toRead = names.filter((b) => {
        const old = had[b.name]
        if (old && b.head && old.head === b.head) { loaded[b.name] = old; return false }
        return true
      })
      // Bound concurrent Store reads, irrespective of the number of forks: the first Branches
      // (main, the focused one) alone, so the graph has something to draw soonest.
      const firstBatch = toRead.filter((b) => first.includes(b)).length || 4
      for (let i = 0; i < toRead.length;) {
        const size = i === 0 ? firstBatch : 4
        const results = await Promise.allSettled(toRead.slice(i, i + size).map(async (b) => [b.name, await filesApi.branchHead(api, project, b)] as const))
        i += size
        if (stale()) return
        const batch: Record<string, HistoryPage> = {}
        for (const r of results) {
          if (r.status !== 'fulfilled') { setError(r.reason); continue }
          const [name, fresh] = r.value
          // A moved head keeps what was loaded below it: the new page joins the old pages when
          // it reaches the old head (most refreshes), else a few wide pages are read to rejoin them.
          const old = pagesRef.current[name] ?? had[name]
          let page = old ? extendPage(fresh, old) : undefined
          if (old && !page && old.items.length > fresh.items.length) {
            let joined = fresh
            const branch = toRead.find((b) => b.name === name)
            for (let n = 0; !page && joined.next && n < REJOIN_PAGES; n++) {
              const next = await filesApi.commits(api, project, name, joined.next, branch?.forkedFrom, true).catch(() => null)
              if (!next || stale()) break
              joined = { ...joined, items: [...joined.items, ...next.items], next: next.next }
              page = extendPage(joined, old)
            }
            if (stale()) return
          }
          batch[name] = loaded[name] = page ?? fresh
        }
        if (Object.keys(batch).length) setPages((p) => ({ ...p, ...batch }))
      }
      // A deep-linked Commit older than the first page: read on until it is loaded (bounded).
      let page = initialCommit && focused ? loaded[focused.name] : undefined
      for (let i = 0; page && i < DEEP_LINK_PAGES && !page.items.some((c) => c.id === initialCommit) && page.next; i++) {
        const next: HistoryPage = await filesApi.commits(api, project, focused!.name, page.next ?? undefined, focused!.forkedFrom)
        if (stale()) return
        page = { ...next, items: [...new Map([...page.items, ...next.items].map((c) => [c.id, c])).values()] }
        loaded[focused!.name] = page
      }
      // Keep a deeper read of an unmoved Branch that landed meanwhile (Load all, Load earlier).
      setPages((p) => {
        for (const [name, page] of Object.entries(p)) {
          const mine = loaded[name]
          if (page && mine && page.head === mine.head && page.items.length > mine.items.length) loaded[name] = page
        }
        return { ...loaded }
      })
      remember(project, { branches: result.branches, next: result.next, pages: loaded, counts: countsRef.current })
      // The rest of every Branch follows in the background; counting only matters when that is held.
      branchesRef.current = result.branches
      if (!held.current) void fill()
      else await countAll(result.branches, loaded, stale)
    } catch (e) {
      if (!stale()) setError(e)
    } finally {
      if (reading.current === g) reading.current = 0
      if (!stale()) {
        setBusy((b) => (b === 'initial' ? null : b))
        if (again.current) { again.current = false; void read(g) }
      }
    }
  }

  /**
   * The whole count of each side Branch, after its pages, one Branch at a time and only while the
   * page is visible. A moved head whose new page reaches the old head is counted here without a
   * read; the host keeps the rest per head, so a recount reads only what is new.
   */
  async function countAll(list: HistoryBranch[], loaded: Record<string, HistoryPage | undefined>, stale: () => boolean) {
    const next: Record<string, BranchCount> = { ...countsRef.current }
    const publish = () => { const copy = { ...next }; startTransition(() => setCounts(copy)) }
    let changed = false
    for (const b of list) {
      if (b.name === 'main' || stale()) continue
      const known = next[b.name]
      if (known && known.head === (b.head ?? null)) continue
      const derived = movedCount(known, loaded[b.name], b)
      if (derived !== null) { next[b.name] = { head: b.head ?? null, count: derived }; changed = true; continue }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') continue
      const answer = await filesApi.commitCount(api, project, b).catch(() => null)
      if (stale()) return
      if (answer?.count != null) { next[b.name] = { head: answer.head, count: answer.count }; publish(); changed = false }
    }
    if (changed) publish()
    const data = dataCache.get(project)
    if (data && !stale()) data.counts = next
  }

  useEffect(() => {
    const g = ++gen.current
    again.current = false
    if (!Object.keys(pagesRef.current).length) setBusy('initial')
    setError(undefined)
    void read(g)
    return () => { gen.current++ }
  }, [api, project, revision, initialBranch, initialCommit])

  const firstTick = useRef(tick)
  useEffect(() => {
    if (tick === firstTick.current) return
    if (reading.current) again.current = true
    else void read(gen.current)
  }, [tick])

  async function loadBranch(name: string, more = false) {
    if (busy) return
    setBusy(name)
    setError(undefined)
    try {
      const previous = pages[name]
      const branch = branches.find((b) => b.name === name)
      const next = more || !branch
        ? await filesApi.commits(api, project, name, more ? previous?.next ?? undefined : undefined, branch?.forkedFrom)
        : await filesApi.branchHead(api, project, branch)
      setPages((p) => ({ ...p, [name]: { ...next, items: more ? [...new Map([...(previous?.items ?? []), ...next.items].map((c) => [c.id, c])).values()] : next.items } }))
    } catch (e) { setError(e) } finally { setBusy(null) }
  }

  /**
   * Reads the rest of a Branch in wide pages, drawing each page as it lands (as a transition, so
   * panning stays responsive), while `mine()` holds.
   */
  async function readAll(name: string, mine: () => boolean) {
    const branch = branches.find((b) => b.name === name)
    let page = pagesRef.current[name] ?? (branch ? await filesApi.branchHead(api, project, branch) : await filesApi.commits(api, project, name))
    while (mine()) {
      const current = page
      // A refresh may have moved the head meanwhile: its newer Commits join this deeper read.
      setPages((p) => ({ ...p, [name]: p[name] && p[name]!.head !== current.head ? extendPage(p[name]!, current) ?? current : current }), true)
      if (!current.next) return
      const next = await filesApi.commits(api, project, name, current.next, branch?.forkedFrom, true)
      if (!mine()) return
      page = { ...current, items: [...new Map([...current.items, ...next.items].map((c) => [c.id, c])).values()], next: next.next }
    }
  }
  /**
   * Reads every Branch that has more to read, one Branch at a time (main and the selected
   * Branch first) and only while the page is visible, so the tree fills in as pages land.
   * A refresh queues behind it; Stop holds it until Load all.
   */
  async function fill(force = false) {
    if (filling.current && !force) return
    const order = () => {
      const first = new Set(['main', viewRef.current.branch])
      const list = branchesRef.current
      return [...list.filter((b) => first.has(b.name)), ...list.filter((b) => !first.has(b.name))].filter((b) => pagesRef.current[b.name]?.next != null)
    }
    if (!order().length) return
    const loadedNow = () => Object.values(pagesRef.current).reduce((n, page) => n + (page?.items.length ?? 0), 0)
    if (!force && loadedNow() > AUTO_LIMIT) { held.current = true; return }
    held.current = false
    const g = ++allGen.current
    const mine = () => allGen.current === g
    filling.current = true
    setLoadingAll(ALL)
    setError(undefined)
    try {
      for (let next = order()[0]; next && mine(); next = order()[0]) {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') await new Promise<void>((done) => document.addEventListener('visibilitychange', () => done(), { once: true }))
        if (!mine()) return
        const before = pagesRef.current[next.name]?.items.length ?? 0
        await readAll(next.name, mine).catch((e) => { if (mine()) setError(e) })
        // A Branch that could not be read on is left for the next refresh.
        if (pagesRef.current[next.name]?.next != null && (pagesRef.current[next.name]?.items.length ?? 0) === before) break
        if (!force && loadedNow() > AUTO_LIMIT) { held.current = true; break }
      }
    } finally {
      if (allGen.current === g) {
        filling.current = false
        setLoadingAll(null)
        const data = dataCache.get(project)
        if (data) data.pages = { ...pagesRef.current }
      }
    }
  }
  const stopFill = () => { held.current = true; filling.current = false; allGen.current++; setLoadingAll(null) }
  useEffect(() => () => { allGen.current++ }, [project])

  const parents = useMemo(() => branchParents(branches, pages), [branches, pages])
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
  // The tree is laid out again only when what it draws changed, not on every render.
  const visibleKey = visibleBranches.map((b) => `${b.name}\u0000${b.head ?? ''}\u0000${b.forkedFrom ?? ''}`).join('\u0001')
  // While every Branch is being read, pages land many times a second; the tree is laid out again
  // about once a second, so its lanes hold still between updates.
  const [drawnPages, setDrawnPages] = useState(pages)
  const lastDraw = useRef(0)
  useEffect(() => {
    const draw = () => { lastDraw.current = Date.now(); setDrawnPages(pages) }
    if (loadingAll !== ALL && busy !== 'initial') { draw(); return }
    const timer = setTimeout(draw, Math.max(0, DRAW_EVERY - (Date.now() - lastDraw.current)))
    return () => clearTimeout(timer)
  }, [pages, loadingAll, busy])
  // A Branch keeps the lane it had, where that is still free, so the tree does not reshuffle as it fills in.
  const lanes = useRef(new Map<string, number>())
  // eslint-disable-next-line react-hooks/exhaustive-deps -- visibleKey stands for visibleBranches
  const layout = useMemo(() => {
    const next = treeLayout(visibleBranches, drawnPages, lanes.current)
    lanes.current = new Map(next.branches.map((b) => [b.name, b.lane]))
    return next
  }, [visibleKey, drawnPages])
  const selected = layout.byId.get(view.selected ?? '')
  const selectedCommit = selected?.commit ?? undefined
  // An empty Branch is selected through its fork point: the row is its parent's, the Branch is the one opened.
  const selectedBranch = selected ? (view.branch && view.branch !== selected.branch && !layout.byName.has(view.branch) ? view.branch : selected.branch) : ''
  const selectedEmpty = !!selected && selectedBranch !== selected.branch
  const detail = useDetail(api, project, selectedEmpty ? undefined : selectedCommit, undefined)
  // Checkpoints are side Branch Commits (main holds Layers). The total shows once every Branch is counted.
  const sideBranches = branches.filter((b) => b.name !== 'main')
  const loaded = sideBranches.reduce((sum, b) => sum + (pages[b.name]?.items.length ?? 0), 0)
  const total = countedTotal(sideBranches, counts)

  function select(id: string, branch: string) {
    writeView({ selected: id, branch })
    if (!picking) return
    const commit = layout.byId.get(id)?.commit
    const to: CompareEnd = commit ? { branch: commit.branch, pin: commit.id } : { branch }
    if (to.pin && to.pin === picking.pin) return
    setCompare({ from: picking, to })
    setPicking(null)
  }
  const compareEnds = branches.map((b) => ({ name: b.name, head: b.head ?? b.base }))
  const openCompare = () => {
    const other = branches.find((b) => b.name !== 'main')?.name ?? 'main'
    setCompare({ from: { branch: 'main' }, to: selectedCommit ? { branch: selectedCommit.branch, pin: selectedCommit.id } : { branch: other } })
  }
  function toggleFamily(name: string) {
    const families = new Set(view.families)
    if (families.has(name)) families.delete(name)
    else families.add(name)
    writeView({ families, branch: '', selected: null })
  }
  const openBranch = (name: string) => {
    const b = branches.find((x) => x.name === name)
    // A Branch with nothing saved yet is shown through the point it forked from.
    writeView({ branch: name, selected: (b?.head && layout.byId.has(b.head) ? b.head : b?.forkedFrom) ?? null })
    setFinderOpen(false)
    if (!pages[name]) void loadBranch(name)
  }

  const eyebrow = selectedEmpty ? t('files_branchHead')
    : selected?.kind === 'layer' ? t('files_layerOnMain')
    : selected?.kind === 'merge' ? t('files_merge')
    : t('files_checkpoint')
  const selectedLive = layout.byName.get(selectedBranch)?.live ?? true
  const inspector = selected ? (
    <aside className={css.detail} aria-label={t('files_commitDetails')}>
      <button type="button" className={css.inspectorClose} aria-label={t('files_closeDetails')} onClick={() => writeView({ selected: null, branch: '' })}><IconCloseOutlineRegular size={14} /></button>
      <span className={css.eyebrow}>{eyebrow}</span>
      <h3>{selectedEmpty ? branchLabel(selectedBranch, t) : detail.data?.item.message || selectedCommit?.message || eyebrow}</h3>
      <dl>
        <dt>{t('files_branch')}</dt>
        <dd title={selectedBranch}>{branchLabel(selectedBranch, t)}</dd>
        {selectedEmpty
          ? <><dt>{t('files_forkedFrom')}</dt><dd><code title={selected.id}>{shortId(selected.id)}</code></dd></>
          : <><dt>{t('files_id')}</dt><dd><code title={selected.id}>{shortId(selected.id)}</code></dd></>}
        {!selectedEmpty && selectedCommit?.at ? <><dt>{t('files_when')}</dt><dd>{when(selectedCommit.at)}</dd></> : null}
      </dl>
      {!selectedLive ? <p>{t('files_neverReachedMain')}</p> : null}
      {!selectedEmpty && selectedCommit?.parent && !layout.byId.has(selectedCommit.parent) ? <p>{t('files_parentMissing', { id: shortId(selectedCommit.parent) })}</p> : null}
      {!selectedEmpty && selectedCommit?.sourceBranch ? <p title={selectedCommit.sourceBranch}>{t('files_sourceBranch')}: {branchLabel(selectedCommit.sourceBranch, t)}</p> : null}
      {!selectedEmpty && selectedCommit?.sourceCommit ? <p>{t('files_sourceCommit')}: <code>{shortId(selectedCommit.sourceCommit)}</code></p> : null}
      {!selectedEmpty && selectedCommit?.base ? <p>{t('files_baseLayer')}: <code>{shortId(selectedCommit.base)}</code></p> : null}
      {!selectedEmpty && selectedCommit?.merged ? <p>{t('files_mergeParent', { id: shortId(selectedCommit.merged) })}</p> : null}
      {!selectedEmpty ? (
        <>
          {detail.error ? <p role="alert">{t('files_readFailed', { what: t('files_changes') })}</p>
            : selectedCommit && !detail.data ? <p>{t('files_readingPaths')}</p>
            : detail.data ? (
              <>
                <h4>{t('files_changes')}</h4>
                {detail.data.changes == null ? <p>{t('files_noCompare')}</p>
                  : detail.data.changes.length === 0 ? <p>{selected.kind === 'layer' && !selectedCommit?.parent && !selectedCommit?.base ? t('files_initialImport') : t('files_noChanges')}</p>
                  : (
                    <ul className={css.paths}>
                      {detail.data.changes.map((c, i) => {
                        const k = changeKind(c.kind, t)
                        const row = <><code>{c.path}</code><Tag tone={k.tone} className={css.pathKind}>{k.label}</Tag></>
                        return (
                          <li key={`${c.path}:${i}`}>
                            {onOpenFile && selectedCommit
                              ? <button type="button" className={css.pathButton} title={c.path} onClick={() => onOpenFile(selectedCommit.branch, c.path, selectedCommit.id)}>{row}</button>
                              : <span className={css.pathButton} title={c.path}>{row}</span>}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                {detail.data.nextChanges != null ? <div className={css.detailActions}><Button variant="outline" size="sm" disabled={detail.loading} onClick={detail.more}>{t('files_moreChanges')}</Button></div> : null}
              </>
            ) : null}
          {selectedCommit ? (
            <div className={css.detailActions}>
              <Button variant="outline" size="sm" onClick={() => setDiffOpen(true)}>{t('files_viewDiff')}</Button>
              <Button variant="outline" size="sm" onClick={() => setPicking({ branch: selectedCommit.branch, pin: selectedCommit.id })}>{t('files_comparePick')}</Button>
            </div>
          ) : null}
        </>
      ) : null}
    </aside>
  ) : undefined
  const more = total != null ? total > loaded : sideBranches.some((b) => pages[b.name]?.next != null)
  // The tree grows in once the whole history is read (or the read is stopped, or it has taken too long), so it grows whole.
  const unread = branches.some((b) => pages[b.name]?.next != null)
  const ready = busy !== 'initial' && (!unread || loadingAll !== ALL || patience) && (drawnPages === pages || patience)

  return (
    <div className={clsx(css.view, className)}>
      {finderOpen ? (
        <BranchFinder anchorRef={finderAnchor} t={t} branches={branches} parents={parents} families={view.families} filtered={view.query} onQuery={(query) => writeView({ query })} onBranch={openBranch} onToggleFamily={toggleFamily} busy={busy} branchNext={branchNext} onMore={() => {
          setBusy('branches')
          void filesApi.historyBranches(api, project, branchNext!).then((r) => {
            setBranches((b) => [...new Map([...b, ...r.branches].map((x) => [x.name, x])).values()])
            setBranchNext(r.next)
          }).catch(setError).finally(() => setBusy(null))
        }} onClose={() => setFinderOpen(false)} />
      ) : null}
      {picking ? (
        <div role="status" className={css.picking}>
          <span>{t('files_comparePicking', { id: shortId(picking.pin) })}</span>
          <Button variant="outline" size="sm" onClick={() => setPicking(null)}>{t('files_cancel')}</Button>
        </div>
      ) : null}
      {error ? <div role="alert" className={css.alert}>{error instanceof Error ? error.message : String(error)} <button type="button" onClick={() => setRevision((n) => n + 1)}>{t('files_retry')}</button></div> : null}
      <div className={css.stage}>
        {busy === 'initial' && !Object.keys(pages).length
          ? <Loading label={t('files_historyReading')} className={css.center} />
          : !branches.length
            ? <EmptyState title={t('files_historyNone')} className={css.center}>{t('files_historyNoneBody')}</EmptyState>
            : (
              <HistoryGraph
                layout={layout} selected={view.selected} branch={view.branch} focus={view.selected} onSelect={select} onBranch={openBranch} controlsHost={zoomSlot}
                inspector={inspector} onViewport={(left, zoom) => { viewport.current = { left, zoom } }} viewportRequest={viewportRequest} ready={ready} t={t}
              />
            )}
        {!ready && Object.keys(pages).length ? <Loading label={total != null ? t('files_loadingAllOf', { count: loaded.toLocaleString(), total: total.toLocaleString() }) : t('files_loadingAll', { count: loaded.toLocaleString() })} className={css.waiting} /> : null}
        <div className={css.dock}>
          <span ref={setZoomSlot} className={css.zoomSlot} />
          <div className={css.mapControls} role="group" aria-label={t('files_history')}>
            {loadingAll === ALL
              ? <button type="button" onClick={stopFill}>{t('files_stopLoading')}</button>
              : more && !busy
                ? <button type="button" disabled={!!loadingAll} title={t('files_checkpointsHint')} onClick={() => void fill(true)}>{t('files_loadAll')}</button>
                : null}
            <button type="button" disabled={!branches.length} aria-label={t('files_compare')} title={t('files_compare')} onClick={openCompare}><IconCompareSplitOutlineRegular size={14} /></button>
            <span ref={finderAnchor} className={css.dockSlot}>
              <button type="button" aria-expanded={finderOpen} aria-label={t('files_branches')} title={t('files_branches')} onClick={() => setFinderOpen((v) => !v)}>
                <IconBranchOutlineRegular size={14} />{branches.length}{branchNext !== null ? '+' : ''}
              </button>
            </span>
            <button type="button" aria-label={t('files_refresh')} title={t('files_refresh')} disabled={!!busy} onClick={() => setRevision((n) => n + 1)}>{busy ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={14} />}</button>
          </div>
        </div>
        {branches.length ? (
          <div className={css.legend} aria-label={t('files_historyLegend')}>
            <span className={css.count} role={loadingAll === ALL ? 'status' : undefined}>
              {loadingAll === ALL ? (total != null ? t('files_loadingAllOf', { count: loaded.toLocaleString(), total: total.toLocaleString() }) : t('files_loadingAll', { count: loaded.toLocaleString() }))
                : total != null && total > loaded ? t('files_checkpointsLoadedOf', { count: loaded.toLocaleString(), total: total.toLocaleString() })
                : t('files_treeCounts', { branches: sideBranches.length.toLocaleString(), checkpoints: (view.families.size ? loaded : layout.rows.length - layout.layers.length).toLocaleString(), layers: layout.layers.length.toLocaleString() })}
            </span>
            <span><i className={css.legendTrunk} />{t('files_layerOnMain')}</span>
            <span><svg width="12" height="14" viewBox="-4 -11 12 14" aria-hidden="true"><path className={css.legendLeaf} d="M0 0q4.6 -0.6 5.7 -7q-4.8 1.5 -5.7 7z" /></svg>{t('files_checkpoint')}</span>
            <span><i className={css.legendMerge} />{t('files_merge')}</span>
            <span><i className={css.legendPublish} />{t('files_legendPublish')}</span>
            <span><i className={css.legendDead} />{t('files_neverReachedMain')}</span>
          </div>
        ) : null}
      </div>
      {compare ? (
        <Modal open onClose={() => setCompare(null)} title={t('files_compareTitle')} closeLabel={t('files_closeLabel')} className={css.compareModal} contentClassName={css.compareModalBody}>
          <BranchCompare api={api} project={project} t={t} branches={compareEnds} from={compare.from} to={compare.to} onOpenFile={onOpenFile} />
        </Modal>
      ) : null}
      {diffOpen && selectedCommit ? (
        <Modal open onClose={() => setDiffOpen(false)} title={t('files_diffTitle', { id: shortId(selectedCommit.id) })} closeLabel={t('files_closeLabel')} className={css.diffModal} contentClassName={css.diffModalBody}>
          <CommitDiff api={api} project={project} branch={selectedCommit.branch} commit={selectedCommit.id} t={t}
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
  const position = useAnchoredPosition({ open: true, anchorRef, panelRef: panel, side: 'top', align: 'end', gap: 6, margin: 8 })
  useDismissOnOutsidePointer(anchorRef, true, () => onClose(), panel)
  const q = filtered.toLowerCase()
  const rows = branches.filter((b) => b.name.toLowerCase().includes(q) || branchLabel(b.name, t).toLowerCase().includes(q))
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
                <IconBranchOutlineRegular size={13} /><span>{branchLabel(b.name, t)}</span>{busy === b.name ? <StateDot state="ongoing" size={12} /> : null}
              </button>
              {children > 0 && b.name !== 'main' ? (
                <button type="button" className={css.family} aria-expanded={!families.has(b.name)}
                  aria-label={families.has(b.name) ? t('files_expandFamily', { name: branchLabel(b.name, t) }) : t('files_collapseFamily', { name: branchLabel(b.name, t) })}
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
