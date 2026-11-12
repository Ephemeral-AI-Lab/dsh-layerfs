/**
 * The Sandbox page's body: its Workspaces as terminals, up to four a page
 * tiled 2×2, a pager past four, a maximized pane, and "New workspace", which
 * mounts a Branch of the Sandbox's own project (docs/specs/sandbox-terminals.md).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconPlusOutlineRegular, Input, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { enc } from '../api.ts'
import { Field, MenuSelect, Refusal } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SANDBOX_CAPACITY, type SandboxInfo } from './model.ts'
import { orderWorkspaces, pageLayout, pageOf } from './terminal.ts'
import { TerminalPane } from './TerminalPane.tsx'
import css from './terminal.module.css'

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/
const NEW_BRANCH = '\u0000new'
/** The New workspace form's place in the layout, after the last Workspace. */
const ADDING = '\u0000adding'

export function SandboxTerminals({ info, onChanged }: { info: SandboxInfo, onChanged: () => void }): ReactNode {
  const { t } = useMachinesContext()
  const reachable = info.state === 'running' && !info.downReason && !info.refusal && !info.unread
  const workspaces = useMemo(() => orderWorkspaces(reachable || info.workspaces.length ? info.workspaces : []), [info.workspaces, reachable])
  const ids = useMemo(() => workspaces.map((w) => w.ws), [workspaces])
  const canAdd = reachable && workspaces.length < SANDBOX_CAPACITY
  const [page, setPage] = useState(0)
  const [max, setMax] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [announce, setAnnounce] = useState('')
  const [opened, setOpened] = useState<string | null>(null)
  const laid = adding ? [...ids, ADDING] : ids
  const layout = pageLayout(laid, page, max, canAdd && !adding)
  const grid = useRef<HTMLDivElement>(null)

  // a Workspace that went away: leave maximize, keep the page in range
  useEffect(() => {
    if (max && !ids.includes(max)) setMax(null)
    if (layout.page !== page) setPage(layout.page)
  }, [ids, max, layout.page, page])
  // a Workspace just mounted here: show its page and focus it
  useEffect(() => {
    if (opened && ids.includes(opened)) { setPage(pageOf(ids, opened)); setActive(opened); setOpened(null) }
  }, [ids, opened])

  const focusPane = (n: number) => {
    const inputs = grid.current?.querySelectorAll<HTMLInputElement>('input[data-term-input]')
    inputs?.[n]?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey) return
    if (/^[1-4]$/.test(e.key) || /^Digit[1-4]$/.test(e.code)) { e.preventDefault(); focusPane(Number(e.code.slice(-1) || e.key) - 1) }
    else if (e.key === 'PageUp' && layout.page > 0) { e.preventDefault(); setMax(null); setPage(layout.page - 1) }
    else if (e.key === 'PageDown' && layout.page < layout.pages - 1) { e.preventDefault(); setMax(null); setPage(layout.page + 1) }
    else if (e.key === 'Enter' && active) { e.preventDefault(); setMax((m) => (m ? null : active)) }
  }
  const say = useCallback((text: string) => setAnnounce(text), [])

  const startAdding = () => {
    setMax(null)
    setAdding(true)
    // the form takes the tile after the last Workspace
    setPage(pageOf([...ids, ADDING], ADDING))
  }

  return (
    <div className={css.terminals}>
      <div className={css.toolbar}>
        <span className={css.count}>{t('sbWorkspaceCount', { n: String(workspaces.length), cap: String(SANDBOX_CAPACITY) })}</span>
        <span className={css.spacer} />
        {layout.pages > 1 && !max && (
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
        <Tooltip label={canAdd ? t('termNewWorkspace') : reachable ? t('termFull') : t('termOffline')}>
          <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!canAdd} onClick={startAdding}>{t('termNewWorkspace')}</Button>
        </Tooltip>
      </div>

      <div ref={grid} className={css.grid} data-grid={layout.grid} onKeyDown={onKey}>
        {layout.slots.map((slot, i) => {
          if (slot === ADDING) {
            return <NewWorkspace key="adding" info={info} taken={workspaces.map((w) => w.name).filter((n): n is string => !!n)}
              onCancel={() => setAdding(false)} onMounted={(ws) => { setAdding(false); setOpened(ws); onChanged() }} />
          }
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
        for (let pos: number | null = 0, n = 0; pos !== null && n < 20; n++) {
          const listed: { items: { name: string }[], next: number | null } = await api.call('GET', `/api/projects/${enc(project)}/branches?pos=${pos}`)
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
      const made = await api.call<{ ws?: string, path?: string }>('POST', `/api/sandboxes/${enc(info.name)}/workspaces`, { branch: target, fork: isNew, ...(name ? { name } : {}) })
      onMounted(made.ws ?? `${info.name}:${name || made.path}`)
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
          <Input value={fresh} onChange={(e) => { setFresh(e.target.value); setProblem(null) }} aria-label={t('termBranchName')} spellCheck={false} autoFocus disabled={busy} />
        </Field>
      )}
      <Field label={t('termWsName')}>
        <Input value={name} onChange={(e) => { setName(e.target.value); setProblem(null) }} aria-label={t('termWsName')} spellCheck={false} disabled={busy}
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
