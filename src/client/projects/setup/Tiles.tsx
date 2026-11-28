/**
 * The project dialog's choices as tiles (Store and Machine): a two-column
 * grid of at most TILE_CAP tiles (a mark, the name, one note line, a check on
 * the chosen one), then one row of quiet cells: All N… (the whole list, as a
 * view of the same dialog) and + New…. The chosen item always shows: when the
 * list picks one past the cap, it takes the last tile.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MachineGlyph } from '../../machines/icons.tsx'
import { isHostName } from '../../../shared/host-machine.ts'
import { machineNote, type LocationWords } from './MachineTiles.tsx'
import { isRunning, type Machine, type TileBlock } from './model.ts'
import css from './dialog.module.css'

/** Tiles a section shows before the rest go behind All N…. */
export const TILE_CAP = 4

/**
 * The first `cap` of `items` in their order, with `chosen` in the last slot
 * when it falls past the cap (so the order stays put while the person clicks).
 */
export function capWith<T>(items: readonly T[], cap: number, isChosen: (item: T) => boolean): T[] {
  const head = items.slice(0, cap)
  if (head.some(isChosen)) return head
  const chosen = items.find(isChosen)
  return chosen ? [...head.slice(0, cap - 1), chosen] : head
}

/** Arrow keys move between a group's radios, as in any radio group. */
function arrows(e: KeyboardEvent<HTMLElement>): void {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!step) return
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')]
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  if (at < 0) return
  e.preventDefault()
  items[(at + step + items.length) % items.length]?.focus()
}

export function TileGrid({ label, children }: { label: string, children: ReactNode }): ReactNode {
  return <div className={css.tiles} role="radiogroup" aria-label={label} onKeyDown={arrows}>{children}</div>
}

/** One choice: its mark, name and one note line; the chosen one has a check. */
export function ChoiceTile({ mark, name, note, selected, disabled, tone, title, onSelect, data }: {
  mark: ReactNode, name: string, note: ReactNode, selected: boolean, onSelect: () => void
  disabled?: boolean | undefined
  /** The note in the warning tone (the item cannot be used now: the note says why). */
  tone?: 'warn' | undefined
  title?: string | undefined
  data?: Record<string, string | undefined>
}): ReactNode {
  return <button type="button" role="radio" aria-checked={selected} disabled={disabled} title={title ?? name}
    className={clsx(css.tile, selected && css.tileOn)} onClick={onSelect} {...data}>
    <span className={css.tileTop}>
      <span className={css.tileMark} aria-hidden="true">{mark}</span>
      <span className={css.tileName}>{name}</span>
      {selected ? <span className={css.tileCheck} aria-hidden="true"><IconCheckOutlineRegular size={10} /></span> : null}
    </span>
    <span className={css.tileNote} data-tone={tone}>{note}</span>
  </button>
}

/** The row under the tiles: All N… and + New…, each half the row (one alone takes all of it). */
export function TileActions({ all, add }: {
  all?: { label: string, onClick: () => void } | null | undefined
  add?: { label: string, onClick: () => void, selected?: boolean } | null | undefined
}): ReactNode {
  if (!all && !add) return null
  return <div className={css.tileActions}>
    {all ? <button type="button" className={css.ghostCell} onClick={all.onClick}>
      <span>{all.label}</span><IconChevronRightOutlineRegular size={12} />
    </button> : null}
    {add ? <button type="button" className={clsx(css.ghostCell, add.selected && css.ghostOn)} onClick={add.onClick}
      {...(add.selected !== undefined ? { role: 'radio', 'aria-checked': add.selected } : {})}>
      <IconPlusOutlineRegular size={12} /><span>{add.label}</span>
      {add.selected ? <span className={css.tileCheck} aria-hidden="true"><IconCheckOutlineRegular size={10} /></span> : null}
    </button> : null}
  </div>
}

// ---------- machines ----------

/** Machines in a stable order: the Store's (or the default), then running, stopped, and those that cannot run here last. */
export function machineOrder(machines: readonly Machine[], first: string | null | undefined, blocks: ReadonlyMap<string, TileBlock>): Machine[] {
  const rank = (m: Machine) => (m.name === first ? 0 : blocks.has(m.name) || m.state === 'broken' ? 3 : isRunning(m) ? 1 : 2)
  return [...machines].sort((a, b) => rank(a) - rank(b) || Number(isHostName(b.name)) - Number(isHostName(a.name)) || a.name.localeCompare(b.name))
}

/** A machine tile's parts: its mark, its note (state, then This Mac or the Store's badge) and whether it can be picked. */
export function machineTileParts(m: Machine, words: LocationWords, block: TileBlock | undefined, badge: string | null, chosen: boolean) {
  const os = isHostName(m.name) ? words.hostOs : undefined
  return {
    mark: <MachineGlyph platform={m.platform || m.name} os={os} size={15} />,
    note: [machineNote(m, words, block), badge].filter(Boolean).join(' · '),
    // a broken machine, or one that cannot run here and that no Start fixes, is not picked here; one already chosen stays shown
    disabled: ((!!block && !block.startable) || m.state === 'broken') && !chosen,
    tone: block ? 'warn' as const : undefined,
  }
}

/**
 * The machine tiles: at most TILE_CAP (the chosen one always among them), All N
 * machines when there are more, and New machine. `current` is the Store's
 * machine (its badge); without it `fallback` is the default.
 */
export function MachineGrid({ machines, value, onChange, words, label, current, fallback, blocks, disabled, allLabel, onAll, newLabel, onNew }: {
  machines: readonly Machine[], value: string, onChange: (machine: string) => void, words: LocationWords, label: string
  current?: string | null | undefined, fallback?: string | null | undefined, blocks: ReadonlyMap<string, TileBlock>, disabled?: boolean | undefined
  allLabel: string, onAll: () => void, newLabel: string, onNew: () => void
}): ReactNode {
  const ordered = machineOrder(machines, current ?? fallback, blocks)
  const shown = capWith(ordered, TILE_CAP, (m) => m.name === value)
  return <>
    <TileGrid label={label}>
      {shown.map((m) => {
        const badge = current ? (m.name === current ? words.here : null) : m.name === fallback ? words.default : null
        const p = machineTileParts(m, words, blocks.get(m.name), badge, value === m.name)
        return <ChoiceTile key={m.name} mark={p.mark} name={m.name} note={p.note} tone={p.tone} selected={value === m.name}
          disabled={disabled || p.disabled} onSelect={() => onChange(m.name)} data={{ 'data-machine': m.name, 'data-blocked': blocks.has(m.name) ? '' : undefined }} />
      })}
    </TileGrid>
    <TileActions all={ordered.length > shown.length ? { label: allLabel, onClick: onAll } : null} add={{ label: newLabel, onClick: onNew }} />
  </>
}

// ---------- the whole list ----------

export interface ListItem {
  key: string
  mark: ReactNode
  name: string
  note: ReactNode
  /** What the filter matches besides the name (a machine, an address). */
  search?: string | undefined
  selected: boolean
  disabled?: boolean | undefined
  tone?: 'warn' | undefined
  title?: string | undefined
  /** An action beside the row (outside its button): a broken Store's Open Store. */
  after?: ReactNode
  onPick: () => void
}

export interface ListGroup { label: string, items: ListItem[] }

/**
 * Every item, grouped, under one filter: what All N… opens in place of the
 * form. Picking a row chooses it (the caller goes back to the form).
 */
export function ChoiceList({ groups, label, placeholder, empty }: { groups: ListGroup[], label: string, placeholder: string, empty: string }): ReactNode {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matched = groups.map((g) => ({ ...g, items: g.items.filter((i) => !q || i.name.toLowerCase().includes(q) || (i.search ?? '').toLowerCase().includes(q)) })).filter((g) => g.items.length)
  return <div className={css.listView}>
    <div className={css.listFilter}>
      <IconSearchOutlineRegular size={14} className={css.listFilterIcon} />
      <input className={css.listFilterInput} value={query} placeholder={placeholder} aria-label={placeholder} autoComplete="off" spellCheck={false}
        data-modal-autofocus="" onChange={(e) => setQuery(e.target.value)} />
    </div>
    <div className={css.listBody} role="radiogroup" aria-label={label} onKeyDown={arrows}>
      {matched.map((g) => <section key={g.label} className={css.listGroup}>
        <h4 className={css.listGroupLabel}>{g.label}</h4>
        {g.items.map((i) => <div key={i.key} className={clsx(css.listRow, i.selected && css.listRowOn)}>
          <button type="button" role="radio" aria-checked={i.selected} disabled={i.disabled} title={i.title ?? i.name} className={css.listRowBtn} onClick={i.onPick}>
            <span className={css.tileMark} aria-hidden="true">{i.mark}</span>
            <span className={css.listName}>{i.name}</span>
            <span className={css.listNote} data-tone={i.tone}>{i.note}</span>
            {i.selected ? <IconCheckOutlineRegular size={13} className={css.listCheck} /> : null}
          </button>
          {i.after ?? null}
        </div>)}
      </section>)}
      {matched.length ? null : <p className={css.empty}>{empty}</p>}
    </div>
  </div>
}

/** The list view's footer: + New… on the left, Back on the right. */
export function ListFoot({ addLabel, onAdd, backLabel, onBack }: { addLabel: string, onAdd: () => void, backLabel: string, onBack: () => void }): ReactNode {
  return <footer className={css.foot}>
    <Button type="button" variant="ghost" size="sm" icon={<IconPlusOutlineRegular size={14} />} onClick={onAdd}>{addLabel}</Button>
    <div className={css.footActions}><Button type="button" variant="outline" onClick={onBack}>{backLabel}</Button></div>
  </footer>
}
