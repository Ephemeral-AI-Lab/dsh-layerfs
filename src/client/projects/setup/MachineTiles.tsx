/**
 * Machines as tiles, shared by the project dialog and Storage's New Store:
 * one tile per machine (its mark, name, state, a badge), and the Location
 * picker: where a SQLite Store is placed, or where a PostgreSQL Store's
 * sessions run. The host machine (`macos-host` / `linux-host`) is named like any machine.
 * A machine whose platform is not ready here (`blocks`, model.ts tileBlocks)
 * shows so and cannot be picked, except a docker machine whose Docker Engine
 * its Start launches (picked by the person, who presses its named Start).
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCheckOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { MachineGlyph } from '../../machines/icons.tsx'
import { usePressGuard } from '../../ui/index.tsx'
import { isRunning, type Machine, type TileBlock } from './model.ts'
import css from './dialog.module.css'
import { isHostName } from '../../../shared/host-machine.ts'

/** The words a tile uses, from the caller's locale. */
export interface LocationWords {
  /** The running host machine's note: This Mac, unisolated. */
  thisMac: string
  running: string
  stopped: string
  /** The badge on the default machine. */
  default: string
  /** The badge on the Store's current machine. */
  here: string
  /** The host machine's mark: this computer's OS (absent: a Mac's). */
  hostOs?: 'mac' | 'linux' | 'pc' | undefined
  /** The note of a machine that cannot run here now (its platform is not ready). */
  blocked?: string | undefined
  /** The note of a docker machine whose Docker Engine is not running (its own Start launches it). */
  engineDown?: string | undefined
  /** Another LayerFS machine state (busy, broken, blocked, unknown…) in the caller's locale (RV4 NOTE 9: never the raw word in zh). */
  state: (state: string) => string
}

const NO_BLOCKS: ReadonlyMap<string, TileBlock> = new Map()

/** A machine's state in words: This Mac, Running, Stopped; Can't run here now when `block` says so. */
export function machineNote(m: Machine, words: LocationWords, block?: TileBlock | undefined): string {
  if (block) return (block.startable ? words.engineDown : words.blocked) ?? words.stopped
  if (isRunning(m)) return isHostName(m.name) ? words.thisMac : words.running
  if (m.state === 'stopped') return words.stopped
  return words.state(m.state ?? 'unknown')
}

/**
 * The machines an action needs that are not running: one line each (a dot,
 * "Stopped · <m>") with that machine's own Start. A dialog never starts a
 * machine on its own (UI pass 2: a machine starts only on the person's press
 * on that machine); its action waits until none is left here. A refused
 * Start reads as a word on that line ("Not started · <m>") with LayerFS's
 * message as its tip; the line's Start is its one action (RV4 NOTE 10).
 */
export function StartFirst({ names, words, start, onStarted, className }: {
  names: readonly string[]
  words: { stopped: (machine: string) => string, start: (machine: string) => string, refused: (machine: string) => string }
  /** Starts one machine (it resolves once the machine runs). */
  start: (machine: string) => Promise<unknown>
  /** A machine started: read the machines again. */
  onStarted: () => void
  className?: string | undefined
}): ReactNode {
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ machine: string, message: string } | null>(null)
  // each Start <machine> behind the press guard, like every power control
  const guard = usePressGuard(`start-first:${names.join(',')}`)
  if (!names.length) return null
  const press = (m: string) => {
    setBusy(m); setFailed(null)
    start(m).then(onStarted, (e: unknown) => setFailed({ machine: m, message: e instanceof Error ? e.message : String(e) })).finally(() => setBusy(null))
  }
  return (
    <div className={clsx(css.startFirst, className)}>
      {names.map((m) => (
        <p key={m} className={css.startFirstRow} data-start-first={m}>
          {failed?.machine === m
            ? <span className={clsx(css.startFirstWord, css.startFirstFailed)} role="alert" title={failed.message} data-start-refused={m}><StatusDot state="error" size={6} />{words.refused(m)}</span>
            : <span className={css.startFirstWord}><StatusDot state="idle" size={6} />{words.stopped(m)}</span>}
          <Button type="button" size="sm" variant="outline" disabled={busy !== null || guard.settling} aria-disabled={guard.settling || undefined} aria-label={words.start(m)}
            icon={busy === m ? <StatusDot state="ongoing" size={12} /> : undefined} onClick={guard(() => press(m))}>{words.start(m)}</Button>
        </p>
      ))}
    </div>
  )
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
  /** The host machine's mark (LocationWords.hostOs). */
  os?: 'mac' | 'linux' | 'pc' | undefined
}): ReactNode {
  const glyphOs = isHostName(m.name) ? os : undefined
  if (compact) {
    return <button type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={selected} disabled={disabled}
      className={clsx(css.machine, css.compact, selected && css.selected)} onClick={onSelect} data-machine={m.name} data-blocked={blocked || undefined}
      aria-label={[label, note, badge].filter(Boolean).join(', ')}>
      <span className={css.compactMark}><MachineGlyph platform={m.platform || m.name} os={glyphOs} size={16} /></span>
      <span className={css.compactText}>
        <span className={css.machineName}>{label}</span>
        <span className={css.machineNote}>
          {!blocked ? <span className={css.dot} data-on={isRunning(m) || undefined} aria-hidden="true" /> : null}
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
      {!blocked ? <span className={css.dot} data-on={isRunning(m) || undefined} aria-hidden="true" /> : null}
      <span>{note}</span>
    </span>
  </button>
}

/**
 * One machine, the host machine among them: where a SQLite Store lives, or
 * where a PostgreSQL Store's sessions run. `current` marks the Store's
 * machine (Here now); without it `fallback` is marked Default. `children` follow the tiles (a New machine tile).
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
      return <MachineTile key={m.name} m={m} os={words.hostOs} label={m.name} multi={false} selected={value === m.name}
        // a broken machine is not picked here (its page holds the fix); one already chosen stays shown
        disabled={disabled || (((!!block && !block.startable) || m.state === 'broken') && value !== m.name)} blocked={!!block}
        note={machineNote(m, words, block)} badge={badge} compact={compact} onSelect={() => onChange(m.name)} />
    })}
    {children}
  </div>
}
