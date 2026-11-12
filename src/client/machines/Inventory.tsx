/**
 * A machine's inventory as both machine pages show it: its Stores and its
 * Sandboxes side by side, one row each. The Machines tab shows the first few
 * of each (Sandboxes that need you first) and links to the machine tab; the
 * machine tab shows all of them, its Sandboxes grouped by project. A row
 * opens the Store's or the Sandbox's own tab.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { StateChip } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph, StoreGlyph } from './icons.tsx'
import {
  SANDBOX_CAPACITY, bytes, machineState, opWords, pgUsable, projectRef, sandboxesOn, shortSandbox, stateLook, storesOn,
  type AvailableView, type MachineInfo, type MachineSandbox,
} from './model.ts'
import css from './machines.module.css'

/** The name a machine goes by everywhere: the tree's "LayerFS Home" for the native machine, else its own. */
export function useMachineTitle(): (m: { name: string, platform: string }) => string {
  const { t } = useMachinesContext()
  return (m) => (m.platform === 'native' ? t('homeName') : m.name)
}

/** Whether a Sandbox needs you: its state is one LayerFS flags. */
export function sandboxNeedsYou(b: MachineSandbox): boolean {
  const look = stateLook('sandbox', b.state)
  return !!look.attention || look.tone === 'danger'
}

/** One Store row: what the machine's Sandboxes can use, sqlite on its disk or PostgreSQL attached to it. */
interface StoreLine { name: string, family: 'sqlite' | 'postgresql', projects: string[], count: number, size: number | null, state?: string | undefined, op?: MachineSandbox['op'] }

function storeLines(view: AvailableView, m: MachineInfo): StoreLine[] {
  const sqlite = storesOn(view, m).map((s): StoreLine => ({ name: s.name, family: 'sqlite', projects: s.names ?? [], count: s.projects, size: s.size, state: s.state, op: s.op ?? null }))
  const pg = pgUsable(m, view.postgresql ?? []).map((s): StoreLine => ({ name: s.name, family: 'postgresql', projects: s.names ?? [], count: s.projects, size: null, state: s.state, op: s.op ?? null }))
  return [...sqlite, ...pg]
}

/** The Sandboxes on a machine, those that need you first. */
function sandboxLines(view: AvailableView, m: MachineInfo): MachineSandbox[] {
  const all = sandboxesOn(view, m)
  return [...all.filter(sandboxNeedsYou), ...all.filter((b) => !sandboxNeedsYou(b))]
}

/**
 * The two columns. `limit` cuts each list (the Machines tab) and offers the
 * machine tab for the rest; without it every row shows and the Sandboxes
 * group by project. `actions` sit in each column's head.
 */
export function Inventory({ m, view, limit, onMore, storeAction, sandboxAction }: {
  m: MachineInfo
  view: AvailableView
  limit?: number
  onMore?: () => void
  storeAction?: ReactNode
  sandboxAction?: ReactNode
}): ReactNode {
  const { t } = useMachinesContext()
  const stores = storeLines(view, m)
  const sandboxes = sandboxLines(view, m)
  const running = machineState(m, view.status[m.name]).key === 'running'
  const storesEmpty = view.readErrors?.stores ? t('storesUnread') : t('none')
  const sandboxesEmpty = view.readErrors?.sandboxes ? t('sandboxesUnread') : running ? t('none') : t('sandboxesAfterStart', { name: m.platform === 'native' ? t('homeName') : m.name })
  return (
    <div className={css.inventory}>
      <section className={css.inventoryColumn} aria-label={t('storesOnMachine', { name: m.name })}>
        <ColumnHead label={t('stores')} count={stores.length} shown={limit} onMore={onMore} action={storeAction} />
        {stores.length === 0
          ? <p className={css.inventoryEmpty}>{storesEmpty}</p>
          : <StoreRows rows={limit ? stores.slice(0, limit) : stores} more={limit && stores.length > limit ? stores.length - limit : 0} onMore={onMore} />}
      </section>
      <section className={css.inventoryColumn} aria-label={t('sandboxesOnMachine', { name: m.name })}>
        <ColumnHead label={t('sandboxes')} count={sandboxes.length} shown={limit} onMore={onMore} action={sandboxAction} />
        {sandboxes.length === 0
          ? <p className={css.inventoryEmpty}>{sandboxesEmpty}</p>
          : limit
            ? <SandboxRows rows={sandboxes.slice(0, limit)} machine={m.name} showProject more={Math.max(0, sandboxes.length - limit)} onMore={onMore} />
            : <SandboxGroups rows={sandboxes} machine={m.name} />}
      </section>
    </div>
  )
}

function ColumnHead({ label, count, shown, onMore, action }: { label: string, count: number, shown?: number | undefined, onMore?: (() => void) | undefined, action?: ReactNode }): ReactNode {
  const { t } = useMachinesContext()
  return (
    <header className={css.columnHead}>
      <h3 className={css.columnTitle}>{label}</h3>
      <span className={css.columnCount}>{count}</span>
      <span className={css.columnSpacer} />
      {shown != null && count > shown && onMore && <button type="button" className={css.columnLink} onClick={onMore}>{t('showAll')}</button>}
      {action}
    </header>
  )
}

function StoreRows({ rows, more, onMore }: { rows: StoreLine[], more: number, onMore?: (() => void) | undefined }): ReactNode {
  const { t, stateWord, openStorageTab } = useMachinesContext()
  return (
    <ul className={css.lines}>
      {rows.map((s) => {
        const look = stateLook('store', s.state)
        const busy = !!s.op || (!!s.state && s.state !== 'idle')
        const projects = s.projects.length ? s.projects.join(', ') : s.count > 0 ? t(s.count === 1 ? 'projectCountOne' : 'projectCount', { n: String(s.count) }) : null
        return (
          <li key={`${s.family}:${s.name}`}>
            <button type="button" className={clsx(css.line, css.storeLine)} onClick={() => openStorageTab(`store:${s.name}`)} title={t('openStore', { name: s.name })}>
              <span className={css.lineIcon} aria-hidden="true"><StoreGlyph size={14} /></span>
              <span className={css.lineName}>{s.name}</span>
              <span className={css.lineMeta}>{projects && <span className={css.tag} title={projects}>{projects}</span>}</span>
              {busy
                ? <StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={opWords(s.op)} />
                : <span className={css.lineSize}>{s.family === 'postgresql' ? t('pgChip') : s.size != null ? bytes(s.size) : null}</span>}
            </button>
          </li>
        )
      })}
      {more > 0 && onMore && <li><button type="button" className={css.lineMore} onClick={onMore}>{t('moreRows', { n: String(more) })}</button></li>}
    </ul>
  )
}

function SandboxRows({ rows, machine, showProject, more, onMore }: { rows: MachineSandbox[], machine: string, showProject?: boolean, more?: number, onMore?: (() => void) | undefined }): ReactNode {
  const { t, stateWord, go } = useMachinesContext()
  return (
    <ul className={css.lines}>
      {rows.map((b) => {
        const look = stateLook('sandbox', b.state)
        const ref = b.project ? projectRef(b.project) : null
        const bad = sandboxNeedsYou(b)
        return (
          <li key={b.name}>
            <button type="button" className={clsx(css.line, css.sandboxLine)} data-tone={bad ? 'danger' : undefined}
              onClick={() => go({ kind: 'sandbox', machine, name: b.name })} title={`${b.name}${b.project ? ` · ${b.project}` : ''}`}
              aria-label={t('openSandbox', { name: b.name })}>
              <span className={css.lineIcon} aria-hidden="true"><SandboxGlyph size={14} /></span>
              <span className={clsx(css.lineName, css.mono)}>{shortSandbox(b.name)}</span>
              <span className={css.lineMeta}>
                {showProject ? (ref ? <span className={css.tag}>{ref.name}</span> : <span className={css.muted}>{t('noProject')}</span>) : <span className={css.muted}>{ref?.store ?? ''}</span>}
              </span>
              <span className={css.lineSlots}>{b.workspaces != null ? t('slotsOf', { n: String(b.workspaces), max: String(SANDBOX_CAPACITY) }) : ''}</span>
              <StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={opWords(b.op)} />
            </button>
          </li>
        )
      })}
      {more != null && more > 0 && onMore && <li><button type="button" className={css.lineMore} onClick={onMore}>{t('moreRows', { n: String(more) })}</button></li>}
    </ul>
  )
}

/** All of a machine's Sandboxes: those that need you on top, then one group per project. */
function SandboxGroups({ rows, machine }: { rows: MachineSandbox[], machine: string }): ReactNode {
  const { t } = useMachinesContext()
  const flagged = rows.filter(sandboxNeedsYou)
  const groups = new Map<string, MachineSandbox[]>()
  for (const b of rows) {
    if (sandboxNeedsYou(b)) continue
    const key = b.project ? projectRef(b.project).name : ''
    groups.set(key, [...groups.get(key) ?? [], b])
  }
  return (
    <>
      {flagged.length > 0 && <SandboxRows rows={flagged} machine={machine} showProject />}
      {[...groups].map(([project, list]) => (
        <div key={project || '-'} className={css.lineGroup}>
          <div className={css.lineGroupHead}><span className={css.lineGroupName}>{project || t('noProject')}</span><span>{list.length}</span></div>
          <SandboxRows rows={list} machine={machine} />
        </div>
      ))}
    </>
  )
}
