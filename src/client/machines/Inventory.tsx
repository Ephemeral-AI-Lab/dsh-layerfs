/**
 * A machine's inventory on the Machines board: its Stores and its Sandboxes
 * side by side, one row each (Sandboxes that need you first, those being
 * created on top). Each list keeps a fixed height and scrolls past it, or
 * (`flat`, the board's open row) shows every row. A row
 * opens the Store's or the Sandbox's own tab; its menu (shown on hover or
 * focus) holds what can be done to it, and each column's head its add verb.
 */
import { useContext, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { FixContext, Meter, StateChip, refusalOf } from '../ui/index.tsx'
import { runnableFix } from '../../shared/doctor.ts'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph, StoreKindGlyph } from './icons.tsx'
import { besideCreating, creatingOn, creationStore, needsSpace, phaseShare, phaseWords } from './images.ts'

export { besideCreating, creatingOn } from './images.ts'
import { FreeSpaceDialog } from './MachineImages.tsx'
import { SandboxMenu, useClose } from './Sandboxes.tsx'
import {
  SANDBOX_CAPACITY, bytes, machineState, opWords, pgUsable, projectRef, sandboxesOn, shortSandbox, stateLook, storesOn,
  type AvailableView, type Creation, type MachineInfo, type MachineSandbox, thingLook,
} from './model.ts'
import { storeSizes, useMachineStats } from './MachineStats.tsx'
import { liveNote, sandboxLook } from './stats.ts'
import css from './machines.module.css'

/** The name a machine goes by everywhere: the tree's "LayerFS Home" for the native machine, else its own. */
export function useMachineTitle(): (m: { name: string, platform: string }) => string {
  const { t } = useMachinesContext()
  return (m) => (m.platform === 'native' ? t('homeName') : m.name)
}

/** A listed Sandbox's look: its record's state, or "Daemon not running" when LayerFS saw its daemon ended (stats.ts). */
export const lookOf = (b: MachineSandbox) => sandboxLook(b, (x) => thingLook('sandbox', x))

/** Whether a Sandbox needs you: its state is one LayerFS flags, or it is recorded running and its daemon has ended. */
export function sandboxNeedsYou(b: MachineSandbox): boolean {
  const look = lookOf(b)
  return !!look.attention || look.tone === 'danger'
}

/** One Store row: what the machine's Sandboxes can use, sqlite on its disk, or PostgreSQL that runs its Sandboxes here. */
interface StoreLine { name: string, family: 'sqlite' | 'postgresql', projects: string[], count: number, size: number | null, state?: string | undefined, op?: MachineSandbox['op'], reason?: string }

export function storeLines(view: AvailableView, m: MachineInfo): StoreLine[] {
  const sqlite = storesOn(view, m).map((s): StoreLine => ({ name: s.name, family: 'sqlite', projects: s.names ?? [], count: s.projects, size: s.size, state: s.state, op: s.op ?? null, ...(s.reason ? { reason: s.reason } : {}) }))
  const pg = pgUsable(view, m).map((s): StoreLine => ({ name: s.name, family: 'postgresql', projects: s.names ?? [], count: s.projects, size: null, state: s.state, op: s.op ?? null }))
  return [...sqlite, ...pg]
}

/** The Sandboxes on a machine, those that need you first. */
function sandboxLines(view: AvailableView, m: MachineInfo): MachineSandbox[] {
  const all = sandboxesOn(view, m)
  return [...all.filter(sandboxNeedsYou), ...all.filter((b) => !sandboxNeedsYou(b))]
}

/** One Store row's menu, given by the page that holds the Store actions (Storage): null for none. */
export type StoreMenuOf = (store: { name: string, family: 'sqlite' | 'postgresql' }) => ReactNode

/**
 * The two columns, each list in a scroll box of fixed height. `storeAction`
 * and `sandboxAction` sit in each column's head; `storeMenu` gives each Store
 * row its menu, and `sandboxMenus` each Sandbox row its own (Open, Delete).
 */
export function Inventory({ m, view, storeAction, sandboxAction, storeMenu, sandboxMenus, flat }: {
  m: MachineInfo
  view: AvailableView
  storeAction?: ReactNode
  sandboxAction?: ReactNode
  storeMenu?: StoreMenuOf | undefined
  sandboxMenus?: boolean
  /** Every row at full length, no scroll box of its own (the board's open row, inside the page's one scroll). */
  flat?: boolean
}): ReactNode {
  const { t, useCreations } = useMachinesContext()
  const box = flat ? css.lineFlat : css.lineScroll
  const stores = useStoreRows(m, view)
  const sandboxes = sandboxLines(view, m)
  const creations = useCreations((all) => all)
  const creating = creatingOn(creations, m.name, sandboxes)
  const rows = besideCreating(sandboxes, creating)
  const running = machineState(m, view.live[m.name]).key === 'running'
  const storesEmpty = view.readErrors?.stores ? t('storesUnread') : t('noStoresHere')
  const sandboxesEmpty = view.readErrors?.sandboxes ? t('sandboxesUnread') : running ? t('noSandboxesHere')
    : t(m.platform === 'docker' ? 'sandboxesAfterWorker' : 'sandboxesAfterStart', { name: m.platform === 'native' ? t('homeName') : m.name })
  return (
    <div className={css.inventory}>
      <section className={css.inventoryColumn} aria-label={t('storesOnMachine', { name: m.name })}>
        <ColumnHead label={t('stores')} count={stores.length} action={storeAction} />
        {stores.length === 0
          ? <p className={css.inventoryEmpty}>{storesEmpty}</p>
          : <div className={box} data-line-scroll="stores"><StoreRows rows={stores} menu={storeMenu} projects={false} /></div>}
      </section>
      <section className={css.inventoryColumn} aria-label={t('sandboxesOnMachine', { name: m.name })}>
        <ColumnHead label={t('sandboxes')} count={sandboxes.length} action={sandboxAction} />
        {rows.length === 0 && creating.length === 0
          ? <p className={css.inventoryEmpty}>{sandboxesEmpty}</p>
          : (
            <div className={box} data-line-scroll="sandboxes">
              {creating.length > 0 && <ul className={css.lines} aria-label={t('creatingSandboxes')}>{creating.map((c) => <CreatingRow key={c.id} c={c} bare />)}</ul>}
              {rows.length > 0 && <SandboxRows rows={rows} machine={m.name} menus={sandboxMenus} />}
            </div>
          )}
      </section>
    </div>
  )
}

/** The machine's Store rows, each sqlite Store with its observed size (machine.stats) where the pinned CLI has the call and the machine answered. */
function useStoreRows(m: MachineInfo, view: AvailableView): StoreLine[] {
  const sizes = storeSizes(useMachineStats(m).read)
  return storeLines(view, m).map((s) => (s.family === 'sqlite' && sizes?.get(s.name) != null ? { ...s, size: sizes.get(s.name)! } : s))
}

/** The machine page's Stores tab: every Store the machine's Sandboxes can use, one row each, with `action` (Add Store) in its head. */
export function StoreSection({ m, view, action }: { m: MachineInfo, view: AvailableView, action?: ReactNode }): ReactNode {
  const { t } = useMachinesContext()
  const stores = useStoreRows(m, view)
  return (
    <section className={css.inventoryColumn} aria-label={t('storesOnMachine', { name: m.name })} data-machine-stores={m.name}>
      <ColumnHead label={t('stores')} count={stores.length} action={action} />
      {stores.length === 0
        ? <p className={css.inventoryEmpty}>{view.readErrors?.stores ? t('storesUnread') : t('noStoresHere')}</p>
        : <StoreRows rows={stores} />}
    </section>
  )
}

/**
 * A Sandbox being created, drawn as a real row in the same place: its name
 * and, like its neighbours, the project (`showProject`), the Store, or
 * nothing (`bare`, the Machines board). Only the phase in words (a bar while
 * the image copy reports bytes) tells it apart; a failed one keeps its place
 * with the reason, Retry (the same input again) and dismiss; a create
 * refused for lack of space offers Free space instead of Retry, and creates
 * again once images were removed. Not clickable until the Sandbox exists.
 */
export function CreatingRow({ c, showProject, bare }: { c: Creation, showProject?: boolean, bare?: boolean }): ReactNode {
  const { t, tw, retryCreation, dismissCreation } = useMachinesContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [freeing, setFreeing] = useState(false)
  const failed = c.phase === 'failed'
  const space = needsSpace(c)
  const need = space && c.error?.detail && typeof (c.error.detail as { needed_bytes?: unknown }).needed_bytes === 'number' ? (c.error.detail as { needed_bytes: number }).needed_bytes : null
  const share = phaseShare(c)
  const words = tw(phaseWords(c))
  // LayerFS's fix line: the one action where Center runs it (instead of Retry), else part of the tip
  const fixes = useContext(FixContext)
  const fixLine = c.error?.fix ?? null
  const fix = fixes && fixLine ? runnableFix(fixLine) : null
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
          {bare ? null : showProject ? <span className={css.tag}>{projectRef(c.input.project).name}</span> : <span className={css.muted}>{creationStore(c)}</span>}
        </span>
        {failed
          ? (
            <>
              <span className={css.creatingFailed} role="alert" title={[error != null ? refusalOf(error).message : c.error?.message, fixLine && !fix ? (fixes ? fixes.tip(fixLine) : fixLine) : null].filter(Boolean).join('\n')}>
                {error != null ? t('createFailedRow', { reason: refusalOf(error).message }) : words}
              </span>
              <span className={css.creatingActions}>
                {space
                  ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setFreeing(true)}>{t('freeSpace')}</Button>
                  : fix && fixes
                    ? <Button size="sm" variant="outline" disabled={busy} title={fixes.tip(fixLine!)} onClick={() => void act(() => fixes.run(fix))}>{fixes.label(fix)}</Button>
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

function ColumnHead({ label, count, action }: { label: string, count: number, action?: ReactNode }): ReactNode {
  return (
    <header className={css.columnHead}>
      <h3 className={css.columnTitle}>{label}</h3>
      <span className={css.columnCount}>{count}</span>
      <span className={css.columnSpacer} />
      {action}
    </header>
  )
}

/** Store rows; `projects` false leaves out each Store's project names (the Machines board). */
function StoreRows({ rows, menu, projects: named = true }: { rows: StoreLine[], menu?: StoreMenuOf | undefined, projects?: boolean }): ReactNode {
  const { t, stateWord, openStorageTab } = useMachinesContext()
  return (
    <ul className={css.lines}>
      {rows.map((s) => {
        const look = thingLook('store', s)
        const busy = !!s.op || s.state === 'busy'
        const projects = !named ? null : s.projects.length ? s.projects.join(', ') : s.count > 0 ? t(s.count === 1 ? 'projectCountOne' : 'projectCount', { n: String(s.count) }) : null
        const actions = menu?.(s) ?? null
        return (
          <li key={`${s.family}:${s.name}`} className={css.lineRow} data-store-row={s.name}>
            <button type="button" className={clsx(css.line, css.storeLine)} onClick={() => openStorageTab(`store:${s.name}`)} title={t('openStore', { name: s.name })}>
              <span className={css.lineIcon} aria-hidden="true"><StoreKindGlyph kind={s.family} size={14} mono /></span>
              <span className={css.lineName}>{s.name}</span>
              <span className={css.lineMeta}>{projects && <span className={css.tag} title={projects}>{projects}</span>}</span>
              {busy
                ? <StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={opWords(s.op)} />
                : <span className={css.lineSize}>{s.family === 'postgresql' ? t('pgChip') : s.size != null ? bytes(s.size) : null}</span>}
            </button>
            {menu && <span className={css.lineMenu}>{actions}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/** The board's Sandbox rows: name, slots and state (the project only in the row's tooltip). */
function SandboxRows({ rows, machine, menus }: { rows: MachineSandbox[], machine: string, menus?: boolean | undefined }): ReactNode {
  const { t, tw, stateWord, go } = useMachinesContext()
  return (
    <ul className={css.lines}>
      {rows.map((b) => {
        const look = lookOf(b)
        const note = liveNote(b, tw)
        const bad = sandboxNeedsYou(b)
        return (
          <li key={b.name} className={css.lineRow}>
            <button type="button" className={clsx(css.line, css.sandboxLine)} data-tone={bad ? 'danger' : undefined} data-sandbox-row={b.name} data-live={b.live === undefined ? undefined : String(b.live)}
              onClick={() => go({ kind: 'sandbox', machine, name: b.name })} title={`${b.name}${b.project ? ` · ${b.project}` : ''}${note ? ` · ${note}` : ''}`}
              aria-label={`${t('openSandbox', { name: b.name })}${note ? ` · ${note}` : ''}`}>
              <span className={css.lineIcon} aria-hidden="true"><SandboxGlyph size={14} /></span>
              <span className={clsx(css.lineName, css.mono)}>{shortSandbox(b.name)}</span>
              <span className={css.lineMeta} />
              <span className={css.lineSlots}>{b.workspaces != null ? t('slotsOf', { n: String(b.workspaces), max: String(SANDBOX_CAPACITY) }) : ''}</span>
              <StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={opWords(b.op)} title={note ?? undefined} />
            </button>
            {menus && <span className={css.lineMenu}><SandboxRowMenu b={b} machine={machine} /></span>}
          </li>
        )
      })}
    </ul>
  )
}

/** A Sandbox row's menu: Open, Delete (sandbox.remove, confirmed) and Force delete. */
function SandboxRowMenu({ b, machine }: { b: MachineSandbox, machine: string }): ReactNode {
  const { go } = useMachinesContext()
  const closing = useClose(b.name)
  return <SandboxMenu name={b.name} op={b.op} closing={closing} onOpen={() => go({ kind: 'sandbox', machine, name: b.name })} />
}
