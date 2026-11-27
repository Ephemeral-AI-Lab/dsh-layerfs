/**
 * The Sandbox page's Workspaces tab (docs/specs/sandbox-terminals.md), in one
 * of two views:
 *
 * - Grid: a card per Workspace, as many columns as the page is wide, each
 *   with its Branch, what runs in it, CPU, memory and its overlay
 *   (WorkspaceGrid.tsx). A card opens its terminal; ticks choose which
 *   Workspaces the terminals view shows.
 * - Terminals: the Workspaces as terminals, as many on a page as the area
 *   holds (paneFit: each pane at least 380 × 220, at most 4 × 3; no layout to
 *   pick), a pager past that, and a maximized pane.
 *
 * "New workspace" mounts a Branch of the Sandbox's own project.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconPlusOutlineRegular, Input, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { enc } from '../api.ts'
import { Field, MenuSelect, Refusal, touchField } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { bytes, runningSummary, workspaceCapacity, workspaceName, type SandboxInfo } from './model.ts'
import { DEFAULT_FIT, PANE_GAP, PANE_MIN_HEIGHT, mountedWorkspace, orderWorkspaces, pageLayout, pageOf, paneFit, type Fit } from './terminal.ts'
import { TerminalPane } from './TerminalPane.tsx'
import { NewWorkspaceTile, WorkspaceGrid } from './WorkspaceGrid.tsx'
import css from './terminal.module.css'
import machinesCss from './machines.module.css'
import gridCss from './workspace-grid.module.css'
import { workspaceOffer } from './notices.ts'

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/
const NEW_BRANCH = '\u0000new'
/** The New workspace form's place in the layout, after the last Workspace. */
const ADDING = '\u0000adding'
/** Space kept under the terminals, in CSS px. */
const BOTTOM_PX = 24

type WorkspacesViewMode = 'grid' | 'terminals'
const VIEW_KEY = 'dsh-layerfs:sandbox-workspaces-view'

function readView(): WorkspacesViewMode {
  try { return localStorage.getItem(VIEW_KEY) === 'terminals' ? 'terminals' : 'grid' } catch { return 'grid' }
}
function saveView(view: WorkspacesViewMode): void {
  try { localStorage.setItem(VIEW_KEY, view) } catch { /* a blocked store keeps the default */ }
}

/**
 * How many panes fit in the terminals' area, and that area's height: its
 * width from the element, its height from the element's top to the bottom of
 * the window. Measured again when either changes.
 */
function usePaneFit(on: boolean): { ref: (el: HTMLDivElement | null) => void, fit: Fit, height: number | null } {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ width: number, height: number } | null>(null)
  useLayoutEffect(() => {
    if (!on || !el) return
    let frame = 0
    const measure = () => {
      frame = 0
      const rect = el.getBoundingClientRect()
      const height = Math.max(PANE_MIN_HEIGHT, Math.floor(window.innerHeight - rect.top - BOTTOM_PX))
      setBox((b) => (b && b.width === rect.width && b.height === height ? b : { width: rect.width, height }))
    }
    const later = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    const observer = new ResizeObserver(later)
    observer.observe(el)
    window.addEventListener('resize', later)
    return () => { observer.disconnect(); window.removeEventListener('resize', later); cancelAnimationFrame(frame) }
  }, [on, el])
  return { ref: setEl, fit: box ? paneFit(box.width, box.height) : DEFAULT_FIT, height: box?.height ?? null }
}

/** `focus`: a Workspace to show and focus (its page of terminals too); a new `n` asks again. */
export function SandboxTerminals({ info, onChanged, focus, onOpenFiles }: {
  info: SandboxInfo, onChanged: () => void, focus?: { ws: string, n: number } | null | undefined, onOpenFiles?: (() => void) | undefined
}): ReactNode {
  const { t } = useMachinesContext()
  const reachable = info.state === 'ready' && !info.refusal && !info.unread
  const workspaces = useMemo(() => orderWorkspaces(reachable || info.workspaces.length ? info.workspaces : []), [info.workspaces, reachable])
  const allIds = useMemo(() => workspaces.map((w) => w.ws), [workspaces])
  // "n of N": what sandbox.get says a Sandbox holds, else the constant it had before it said
  const capacity = workspaceCapacity(info)
  // a Sandbox whose daemon is gone never takes a Workspace: no New workspace; otherwise off with its reason
  const offer = workspaceOffer(info, workspaces.length, capacity)
  const canAdd = offer.show && offer.why === null
  const runs = useMemo(() => runningSummary(workspaces), [workspaces])
  const overlays = useMemo(() => {
    const sizes = workspaces.map((w) => w.overlayBytes).filter((n): n is number => typeof n === 'number')
    return sizes.length ? sizes.reduce((a, b) => a + b, 0) : null
  }, [workspaces])
  const [view, setViewState] = useState<WorkspacesViewMode>(readView)
  const setView = useCallback((next: WorkspacesViewMode) => { setViewState(next); saveView(next) }, [])
  // the Workspaces chosen in the grid; the terminals show only those while any is chosen and mounted
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  const picked = useMemo(() => allIds.filter((id) => chosen.has(id)), [allIds, chosen])
  const ids = picked.length ? picked : allIds
  const [page, setPage] = useState(0)
  const [max, setMax] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [announce, setAnnounce] = useState('')
  const [opened, setOpened] = useState<string | null>(null)
  const terminals = view === 'terminals'
  const measured = usePaneFit(terminals)
  const fit = measured.fit
  const laid = adding && terminals ? [...ids, ADDING] : ids
  const layout = pageLayout(laid, page, max, canAdd && !adding, fit)
  const grid = useRef<HTMLDivElement | null>(null)
  const gridRef = useCallback((el: HTMLDivElement | null) => { grid.current = el; measured.ref(el) }, [measured.ref])

  // a chosen Workspace that went away is no longer chosen
  useEffect(() => {
    if ([...chosen].some((id) => !allIds.includes(id))) setChosen(new Set([...chosen].filter((id) => allIds.includes(id))))
  }, [allIds, chosen])
  // a Workspace that went away: leave maximize, keep the page in range
  useEffect(() => {
    if (max && !ids.includes(max)) setMax(null)
    if (layout.page !== page) setPage(layout.page)
  }, [ids, max, layout.page, page])
  // a Workspace asked for from elsewhere on the page (Files' "Open terminal"): its terminal
  useEffect(() => { if (focus) { setMax(null); setAdding(false); setView('terminals'); setOpened(focus.ws) } }, [focus?.ws, focus?.n])
  // a Workspace just mounted or opened from a card: show its page and focus it
  useEffect(() => {
    if (!opened || !allIds.includes(opened)) return
    // one not among the chosen: show them all rather than hide it
    if (picked.length && !picked.includes(opened)) { setChosen(new Set()); return }
    setPage(pageOf(ids, opened, fit)); setActive(opened); setOpened(null)
  }, [allIds, ids, picked, opened, fit])

  const focusPane = (n: number) => {
    const inputs = grid.current?.querySelectorAll<HTMLInputElement>('input[data-term-input]')
    inputs?.[n]?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey) return
    const digit = /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(-1)) : /^[1-9]$/.test(e.key) ? Number(e.key) : 0
    if (digit) { e.preventDefault(); focusPane(digit - 1) }
    else if (e.key === 'PageUp' && layout.page > 0) { e.preventDefault(); setMax(null); setPage(layout.page - 1) }
    else if (e.key === 'PageDown' && layout.page < layout.pages - 1) { e.preventDefault(); setMax(null); setPage(layout.page + 1) }
    else if (e.key === 'Enter' && active) { e.preventDefault(); setMax((m) => (m ? null : active)) }
  }
  const say = useCallback((text: string) => setAnnounce(text), [])

  // the Workspaces with a running command, another client's first; the summary steps through them from the active one
  const withRuns = useMemo(() => {
    const has = workspaces.filter((w) => (w.running?.length ?? 0) > 0)
    const foreign = has.filter((w) => w.running!.some((r) => !r.own))
    return foreign.length ? foreign : has
  }, [workspaces])
  const nextRunning = withRuns.length ? withRuns[(withRuns.findIndex((w) => w.ws === active) + 1) % withRuns.length]! : null
  const openTerminal = (ws: string) => {
    setMax(null)
    setAdding(false)
    setView('terminals')
    setOpened(ws)
  }
  const showRunning = () => { if (nextRunning) openTerminal(nextRunning.ws) }

  const startAdding = () => {
    setMax(null)
    setAdding(true)
    // the form takes the tile after the last Workspace
    if (terminals) setPage(pageOf([...ids, ADDING], ADDING, fit))
  }
  const choose = (ws: string, on: boolean) => setChosen((c) => {
    const next = new Set(c)
    if (on) next.add(ws); else next.delete(ws)
    return next
  })
  const form = (
    <NewWorkspace key="adding" info={info} taken={workspaces.map((w) => w.name).filter((n): n is string => !!n)}
      onCancel={() => setAdding(false)} onMounted={(ws) => { setAdding(false); openTerminal(ws); onChanged() }} />
  )
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${layout.rows}, minmax(${PANE_MIN_HEIGHT}px, 1fr))`,
    ...(measured.height != null ? { height: Math.max(measured.height, layout.rows * PANE_MIN_HEIGHT + (layout.rows - 1) * PANE_GAP) } : {}),
  }

  return (
    <div className={css.terminals}>
      <div className={css.toolbar}>
        <span className={css.count} data-ws-count>{t('sbWorkspaceCount', { n: String(workspaces.length), cap: String(capacity) })}</span>
        <span className={gridCss.capacity} aria-hidden="true"><span style={{ width: `${Math.min(100, (workspaces.length / Math.max(1, capacity)) * 100).toFixed(1)}%` }} /></span>
        {runs.running > 0 && (
          // what runs in the Sandbox, any Workspace, any client: the way to a command on another page of terminals
          <button type="button" className={css.runSummary} data-running-summary onClick={showRunning}
            title={t('sbRunningShow', { name: nextRunning ? workspaceName(nextRunning) : '' })}>
            {[t('sbRunning', { n: String(runs.running) }), ...(runs.others > 0 ? [t('sbRunningOthers', { n: String(runs.others) })] : [])].join(' · ')}
          </button>
        )}
        {overlays != null && <span className={css.count} data-ws-overlays>{t('wsOverlayTotal', { size: bytes(overlays) })}</span>}
        <span className={css.spacer} />
        {picked.length > 0 && (
          <span className={gridCss.chosen} data-ws-chosen={picked.length}>
            {terminals
              ? <>{t('wsChosenShowing', { n: String(picked.length) })} <Button size="sm" variant="ghost" onClick={() => setChosen(new Set())}>{t('wsChosenShowAll')}</Button></>
              : <>
                  <Button size="sm" variant="outline" onClick={() => { setMax(null); setPage(0); setView('terminals') }}>{t('wsChosenOpen', { n: String(picked.length) })}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setChosen(new Set())}>{t('wsChosenClear')}</Button>
                </>}
          </span>
        )}
        {terminals && layout.pages > 1 && !max && (
          <span className={css.pager}>
            <Tooltip label={t('termPrevPage')}>
              <Button size="sm" className={css.iconButton} aria-label={t('termPrevPage')} disabled={layout.page === 0}
                icon={<IconChevronLeftOutlineRegular size={14} />} onClick={() => setPage(layout.page - 1)} />
            </Tooltip>
            <span className={css.pageNumber} aria-live="polite">{t('termPage', { page: String(layout.page + 1), pages: String(layout.pages) })}</span>
            <Tooltip label={t('termNextPage')}>
              <Button size="sm" className={css.iconButton} aria-label={t('termNextPage')} disabled={layout.page >= layout.pages - 1}
                icon={<IconChevronRightOutlineRegular size={14} />} onClick={() => setPage(layout.page + 1)} />
            </Tooltip>
          </span>
        )}
        <span className={machinesCss.sbFilters} role="group" aria-label={t('wsViewLabel')}>
          {(['grid', 'terminals'] as const).map((v) => (
            <button key={v} type="button" className={machinesCss.sbFilter} aria-pressed={view === v} data-ws-view={v}
              onClick={() => { setView(v); if (v === 'grid') setMax(null) }}>
              {v === 'grid' ? t('wsViewGrid') : t('wsViewTerminals')}
            </button>
          ))}
        </span>
        {offer.show && (
          <Tooltip label={offer.why ? t(offer.why, { cap: String(capacity) }) : t('termNewWorkspace')}>
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!canAdd} data-new-workspace={offer.why ?? 'on'}
              title={offer.why ? t(offer.why, { cap: String(capacity) }) : undefined} onClick={startAdding}>{t('termNewWorkspace')}</Button>
          </Tooltip>
        )}
      </div>

      {!terminals ? (
        <WorkspaceGrid workspaces={workspaces} chosen={chosen} onChoose={choose} onOpen={openTerminal} onOpenFiles={onOpenFiles}
          newTile={adding ? <div className={gridCss.newForm}>{form}</div> : canAdd ? <NewWorkspaceTile left={capacity - workspaces.length} empty={!workspaces.length} onClick={startAdding} /> : null} />
      ) : (
        <div ref={gridRef} className={css.grid} style={gridStyle} data-columns={layout.columns} data-rows={layout.rows} onKeyDown={onKey}>
          {layout.slots.map((slot, i) => {
            if (slot === ADDING) return form
            if (slot === 'new') {
              return (
                <button key="new" type="button" className={css.newTile} onClick={startAdding}>
                  <IconPlusOutlineRegular size={14} /> {ids.length ? t('termNewWorkspace') : t('termNoWorkspaces')}
                </button>
              )
            }
            if (slot === 'blank') return <div key={`blank-${i}`} className={css.blank} aria-hidden="true" />
            const ws = workspaces.find((w) => w.ws === slot)!
            return (
              <TerminalPane key={ws.ws} sandbox={info.name} ws={ws} canRun={reachable} maximized={max === ws.ws} active={active === ws.ws}
                onFocus={() => setActive(ws.ws)} onMaximize={() => setMax((m) => (m === ws.ws ? null : ws.ws))}
                onChanged={onChanged} onAnnounce={say} />
            )
          })}
        </div>
      )}
      <div className={css.srOnly} aria-live="polite">{announce}</div>
    </div>
  )
}

/** The Branches a Workspace can mount: the project's, without main (LayerFS refuses to mount it). */
function useBranches(project: string | null | undefined): { names: string[] | null, error: unknown } {
  const { api } = useMachinesContext()
  const [names, setNames] = useState<string[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (!project) { setNames([]); return }
    let live = true
    void (async () => {
      try {
        const all: string[] = []
        for (let pos: string | null = '0', n = 0; pos !== null && n < 20; n++) {
          const listed: { items: { name: string }[], next: string | null } = await api.call('GET', `/api/projects/${enc(project)}/branches?pos=${enc(pos)}`)
          all.push(...listed.items.map((b: { name: string }) => b.name))
          pos = listed.next ?? null
        }
        if (live) setNames(all.filter((b) => b !== 'main'))
      } catch (e) { if (live) setError(e) }
    })()
    return () => { live = false }
  }, [api, project])
  return { names, error }
}

function NewWorkspace({ info, taken, onCancel, onMounted }: { info: SandboxInfo, taken: string[], onCancel: () => void, onMounted: (ws: string) => void }): ReactNode {
  const { t, api, refusal } = useMachinesContext()
  const branches = useBranches(info.project)
  const [branch, setBranch] = useState<string>('')
  const [fresh, setFresh] = useState('')
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => { if (!branch && branches.names) setBranch(branches.names[0] ?? NEW_BRANCH) }, [branch, branches.names])
  const isNew = branch === NEW_BRANCH
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const target = isNew ? fresh.trim() : branch
    if (!target) { setProblem(t('termBranchRequired')); return }
    if (isNew && (!NAME.test(target) || target === 'main')) { setProblem(t('termNameInvalid')); return }
    if (name && !NAME.test(name)) { setProblem(t('termNameInvalid')); return }
    setProblem(null); setBusy(true); setError(null)
    try {
      const made = await api.call<{ workspace?: string, path?: string }>('POST', `/api/sandboxes/${enc(info.name)}/workspaces`, { branch: target, fork: isNew, ...(name ? { name } : {}) })
      onMounted(mountedWorkspace(info.name, made, name, target))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  const options = [...(branches.names ?? []).map((b) => ({ value: b, label: b })), { value: NEW_BRANCH, label: t('termBranchNew') }]
  return (
    <form className={css.newForm} onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel() } }}>
      <div className={css.newTitle}>{t('termNewWorkspace')}</div>
      <Field label={t('termBranch')}>
        <MenuSelect value={branch} options={options} onChange={(v) => { setBranch(v); setProblem(null) }} label={t('termBranch')} disabled={busy || !branches.names} />
      </Field>
      {isNew && (
        <Field label={t('termBranchName')}>
          <Input className={touchField} value={fresh} onChange={(e) => { setFresh(e.target.value); setProblem(null) }} aria-label={t('termBranchName')} spellCheck={false} autoFocus disabled={busy} />
        </Field>
      )}
      <Field label={t('termWsName')}>
        <Input className={touchField} value={name} onChange={(e) => { setName(e.target.value); setProblem(null) }} aria-label={t('termWsName')} spellCheck={false} disabled={busy}
          aria-invalid={!!name && taken.includes(name)} />
      </Field>
      {branches.error != null && <p className={css.formError}>{t('termBranchesFailed')}</p>}
      {problem && <p className={css.formError}>{problem}</p>}
      {error != null && <Refusal error={error} labels={refusal} compact />}
      <div className={css.formActions}>
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? t('termMounting') : t('termMount')}</Button>
      </div>
    </form>
  )
}
