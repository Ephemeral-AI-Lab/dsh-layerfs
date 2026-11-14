/**
 * A machine's inventory as both machine pages show it: its Stores and its
 * Sandboxes side by side, one row each. The Machines tab shows the first few
 * of each (Sandboxes that need you first) and links to the machine tab; the
 * machine tab shows all of them, its Sandboxes grouped by project (a
 * Sandbox being created sits in its project's group, like the real rows). A
 * row opens the Store's or the Sandbox's own tab.
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Meter, StateChip, refusalOf } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph, StoreKindGlyph } from './icons.tsx'
import { besideCreating, creatingOn, creationStore, needsSpace, phaseShare, phaseWords, sandboxGroups } from './images.ts'

export { besideCreating, creatingOn } from './images.ts'
import { FreeSpaceDialog } from './MachineImages.tsx'
import {
  SANDBOX_CAPACITY, bytes, machineState, opWords, pgUsable, projectRef, sandboxesOn, shortSandbox, stateLook, storesOn,
  type AvailableView, type Creation, type MachineInfo, type MachineSandbox,
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
  const { t, useCreations } = useMachinesContext()
  const stores = storeLines(view, m)
  const sandboxes = sandboxLines(view, m)
  const creations = useCreations((all) => all)
  const creating = creatingOn(creations, m.name, sandboxes)
  const rows = besideCreating(sandboxes, creating)
  const running = machineState(m, view.status[m.name]).key === 'running'
  const storesEmpty = view.readErrors?.stores ? t('storesUnread') : t('noStoresHere')
  const sandboxesEmpty = view.readErrors?.sandboxes ? t('sandboxesUnread') : running ? t('noSandboxesHere')
    : t(m.platform === 'docker' ? 'sandboxesAfterWorker' : 'sandboxesAfterStart', { name: m.platform === 'native' ? t('homeName') : m.name })
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
        {rows.length === 0 && creating.length === 0
          ? <p className={css.inventoryEmpty}>{sandboxesEmpty}</p>
          : limit
            ? (
              <>
                {creating.length > 0 && <ul className={css.lines} aria-label={t('creatingSandboxes')}>{creating.map((c) => <CreatingRow key={c.id} c={c} showProject />)}</ul>}
                {rows.length > 0 && <SandboxRows rows={rows.slice(0, limit)} machine={m.name} showProject more={Math.max(0, rows.length - limit)} onMore={onMore} />}
              </>
            )
            : <SandboxGroups rows={rows} creating={creating} machine={m.name} />}
      </section>
    </div>
  )
}

/**
 * A Sandbox being created, drawn as a real row in the same place: its name
 * and, like its neighbours, the project (`showProject`, ungrouped) or the
 * Store (inside its project's group). Only the phase in words (a bar while
 * the image copy reports bytes) tells it apart; a failed one keeps its place
 * with the reason, Retry (the same input again) and dismiss; a create
 * refused for lack of space offers Free space instead of Retry, and creates
 * again once images were removed. Not clickable until the Sandbox exists.
 */
function CreatingRow({ c, showProject }: { c: Creation, showProject?: boolean }): ReactNode {
  const { t, tw, retryCreation, dismissCreation } = useMachinesContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [freeing, setFreeing] = useState(false)
  const failed = c.phase === 'failed'
  const space = needsSpace(c)
  const need = space && c.error?.detail && typeof (c.error.detail as { need?: unknown }).need === 'number' ? (c.error.detail as { need: number }).need : null
  const share = phaseShare(c)
  const words = tw(phaseWords(c))
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await run() } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return (
    <li>
      <div className={clsx(css.line, css.sandboxLine, css.creatingLine)} data-failed={failed || undefined} aria-busy={!failed || undefined}
        title={`${c.input.name} · ${c.input.project}`}>
        <span className={css.lineIcon} aria-hidden="true"><SandboxGlyph size={14} /></span>
        <span className={clsx(css.lineName, css.mono)}>{shortSandbox(c.input.name)}</span>
        <span className={css.lineMeta}>
          {showProject ? <span className={css.tag}>{projectRef(c.input.project).name}</span> : <span className={css.muted}>{creationStore(c)}</span>}
        </span>
        {failed
          ? (
            <>
              <span className={css.creatingFailed} role="alert" title={error != null ? refusalOf(error).message : c.error?.message}>
                {error != null ? t('createFailedRow', { reason: refusalOf(error).message }) : words}
              </span>
              <span className={css.creatingActions}>
                {space
                  ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setFreeing(true)}>{t('freeSpace')}</Button>
                  : <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => retryCreation(c))}>{t('retryCreate')}</Button>}
                <Button size="sm" variant="ghost" disabled={busy} aria-label={t('dismiss')} title={t('dismiss')}
                  icon={<IconCloseOutlineRegular size={12} />} onClick={() => void act(() => dismissCreation(c.id))} />
              </span>
            </>
          )
          : (
            <>
              <span className={css.lineSlots}>{share !== null && <Meter share={share} tone="neutral" label={words} className={css.creatingBar} />}</span>
              <StateChip tone="info" live label={words} />
            </>
          )}
      </div>
      {freeing && (
        <FreeSpaceDialog machine={{ name: c.input.machine, state: 'running' }} need={need}
          onClose={(freed) => { setFreeing(false); if (freed) void act(() => retryCreation(c)) }} />
      )}
    </li>
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
              <span className={css.lineIcon} aria-hidden="true"><StoreKindGlyph kind={s.family} size={14} mono /></span>
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

function SandboxRows({ rows, machine, showProject, more, onMore, lead }: { rows: MachineSandbox[], machine: string, showProject?: boolean, more?: number, onMore?: (() => void) | undefined, lead?: ReactNode }): ReactNode {
  const { t, stateWord, go } = useMachinesContext()
  return (
    <ul className={css.lines}>
      {lead}
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

/**
 * All of a machine's Sandboxes: those that need you on top, then one group
 * per project, the Sandboxes being created for it first in their group.
 */
function SandboxGroups({ rows, creating, machine }: { rows: MachineSandbox[], creating: Creation[], machine: string }): ReactNode {
  const { t } = useMachinesContext()
  const flagged = rows.filter(sandboxNeedsYou)
  const groups = sandboxGroups(rows.filter((b) => !sandboxNeedsYou(b)), creating)
  return (
    <>
      {flagged.length > 0 && <SandboxRows rows={flagged} machine={machine} showProject />}
      {groups.map((g) => (
        <div key={g.project || '-'} className={css.lineGroup}>
          <div className={css.lineGroupHead}>
            <span className={css.lineGroupName}>{g.project || t('noProject')}</span>
            {g.rows.length > 0 && <span>{g.rows.length}</span>}
          </div>
          <SandboxRows rows={g.rows} machine={machine}
            lead={g.creating.length > 0 && g.creating.map((c) => <CreatingRow key={c.id} c={c} />)} />
        </div>
      ))}
    </>
  )
}
