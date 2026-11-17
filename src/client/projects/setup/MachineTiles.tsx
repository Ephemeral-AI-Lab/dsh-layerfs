/**
 * Machines as tiles, shared by the project dialog and Storage's New Store:
 * one tile per machine (its mark, name, state, a badge), and the Location
 * picker a SQLite Store is placed with. `native` is shown as the LayerFS Home.
 * A machine whose platform is not ready here (`blocks`, model.ts tileBlocks)
 * shows so and cannot be picked, except a docker machine whose Docker Engine
 * its Start launches (Create starts it).
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconCheckOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MachineGlyph } from '../../machines/icons.tsx'
import { isRunning, type Machine, type TileBlock } from './model.ts'
import css from './dialog.module.css'

/** The words a tile uses, from the caller's locale. */
export interface LocationWords {
  /** `native`'s name: LayerFS Home. */
  home: string
  /** `native`'s note: This Mac, unisolated. */
  thisMac: string
  running: string
  stopped: string
  /** The badge on the default machine. */
  default: string
  /** The badge on the Store's current machine. */
  here: string
  /** The native machine's mark: this computer's OS (absent: a Mac's). */
  nativeOs?: 'mac' | 'linux' | 'pc' | undefined
  /** The note of a machine that cannot run here now (its platform is not ready). */
  blocked?: string | undefined
  /** The note of a docker machine whose Docker Engine is not running (Create starts it). */
  engineDown?: string | undefined
}

const NO_BLOCKS: ReadonlyMap<string, TileBlock> = new Map()

/** A machine's name as shown: `native` is the LayerFS Home. */
export const placeName = (name: string, words: Pick<LocationWords, 'home'>): string => (name === 'native' ? words.home : name)

/** A machine's state in words: This Mac, Running, Stopped; Can't run here now when `block` says so. */
export function machineNote(m: Machine, words: LocationWords, block?: TileBlock | undefined): string {
  if (block) return (block.startable ? words.engineDown : words.blocked) ?? words.stopped
  if (m.name === 'native') return words.thisMac
  if (isRunning(m)) return words.running
  if (m.state === 'stopped') return words.stopped
  return m.state ?? ''
}

/** The chosen machines that are stopped (native never is). */
export function stoppedPicked(names: readonly string[], machines: readonly Machine[]): string[] {
  return names.filter((n) => { const m = machines.find((x) => x.name === n); return !!m && !isRunning(m) })
}

export function Tick({ on, square }: { on: boolean, square?: boolean }): ReactNode {
  return <span className={clsx(css.tick, square && css.tickSquare, on && css.tickOn)} aria-hidden="true">{on ? <IconCheckOutlineRegular size={11} /> : null}</span>
}

/**
 * One machine as a tile: its mark, name, state and a badge (Default, Here now).
 * `compact`: one row (mark, name over state, tick), for small forms; the badge joins the state.
 */
export function MachineTile({ m, label, selected, multi, note, badge, onSelect, disabled, working, workingMark, compact, os, blocked }: {
  m: Machine, label: string, selected: boolean, multi: boolean, note: string, badge?: string | null, onSelect: () => void
  disabled?: boolean | undefined, working?: boolean | undefined, workingMark?: ReactNode, compact?: boolean | undefined
  /** Its platform is not ready here (the note says why): no running dot. */
  blocked?: boolean | undefined
  /** The native machine's mark (LocationWords.nativeOs). */
  os?: 'mac' | 'linux' | 'pc' | undefined
}): ReactNode {
  const glyphOs = m.name === 'native' ? os : undefined
  if (compact) {
    return <button type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={selected} disabled={disabled}
      className={clsx(css.machine, css.compact, selected && css.selected)} onClick={onSelect} data-machine={m.name} data-blocked={blocked || undefined}
      aria-label={[label, note, badge].filter(Boolean).join(', ')}>
      <span className={css.compactMark}><MachineGlyph platform={m.platform || m.name} os={glyphOs} size={16} /></span>
      <span className={css.compactText}>
        <span className={css.machineName}>{label}</span>
        <span className={css.machineNote}>
          {m.name !== 'native' && !blocked ? <span className={css.dot} data-on={isRunning(m) || undefined} aria-hidden="true" /> : null}
          <span>{[note, badge].filter(Boolean).join(' · ')}</span>
        </span>
      </span>
      {working ? workingMark : <Tick on={selected} square={multi} />}
    </button>
  }
  return <button type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={selected} disabled={disabled}
    className={clsx(css.machine, selected && css.selected)} onClick={onSelect} data-machine={m.name} data-blocked={blocked || undefined}
    aria-label={[label, note, badge].filter(Boolean).join(', ')}>
    <span className={css.machineTop}>
      <span className={css.machineMark}><MachineGlyph platform={m.platform || m.name} os={glyphOs} size={18} /></span>
      {badge ? <span className={css.badge}>{badge}</span> : null}
      {working ? workingMark : <Tick on={selected} square={multi} />}
    </span>
    <span className={css.machineName}>{label}</span>
    <span className={css.machineNote}>
      {m.name !== 'native' && !blocked ? <span className={css.dot} data-on={isRunning(m) || undefined} aria-hidden="true" /> : null}
      <span>{note}</span>
    </span>
  </button>
}

/**
 * Where a SQLite Store lives: one machine, the LayerFS Home among them.
 * `current` marks the Store's machine (Here now); without it `fallback` is
 * marked Default. `children` follow the tiles (a New machine tile).
 */
export function LocationPicker({ machines, value, onChange, words, label, current, fallback, disabled, compact, blocks = NO_BLOCKS, children }: {
  machines: readonly Machine[], value: string, onChange: (machine: string) => void, words: LocationWords, label: string
  current?: string | null | undefined, fallback?: string | undefined, disabled?: boolean | undefined, compact?: boolean | undefined
  /** Machines that cannot run here now (model.ts tileBlocks). */
  blocks?: ReadonlyMap<string, TileBlock> | undefined
  children?: ReactNode
}): ReactNode {
  return <div className={clsx(css.machines, compact && css.machinesCompact)} role="radiogroup" aria-label={label}>
    {machines.map((m) => {
      const badge = current ? (m.name === current ? words.here : null) : m.name === fallback ? words.default : null
      const block = blocks.get(m.name)
      return <MachineTile key={m.name} m={m} os={words.nativeOs} label={placeName(m.name, words)} multi={false} selected={value === m.name}
        disabled={disabled || (!!block && !block.startable && value !== m.name)} blocked={!!block}
        note={machineNote(m, words, block)} badge={badge} compact={compact} onSelect={() => onChange(m.name)} />
    })}
    {children}
  </div>
}

/**
 * The machines a PostgreSQL Store is attached to: any number, none included.
 * `fallback` is marked Default; `notes` overrides a tile's note (Attached…).
 */
export function AttachPicker({ machines, value, onChange, words, label, fallback, disabled, notes, compact, blocks = NO_BLOCKS, children }: {
  machines: readonly Machine[], value: readonly string[], onChange: (machines: string[]) => void, words: LocationWords, label: string
  fallback?: string | undefined, disabled?: boolean | undefined, notes?: Record<string, string> | undefined, compact?: boolean | undefined
  /** Machines that cannot run here now (model.ts tileBlocks). */
  blocks?: ReadonlyMap<string, TileBlock> | undefined
  children?: ReactNode
}): ReactNode {
  return <div className={clsx(css.machines, compact && css.machinesCompact)} role="group" aria-label={label}>
    {machines.map((m) => <MachineTile key={m.name} m={m} os={words.nativeOs} label={placeName(m.name, words)} multi selected={value.includes(m.name)}
      disabled={disabled || (!!blocks.get(m.name) && !blocks.get(m.name)!.startable && !value.includes(m.name))} blocked={blocks.has(m.name)}
      note={notes?.[m.name] ?? machineNote(m, words, blocks.get(m.name))} badge={m.name === fallback ? words.default : null} compact={compact}
      onSelect={() => onChange(value.includes(m.name) ? value.filter((x) => x !== m.name) : [...value, m.name])} />)}
    {children}
  </div>
}
