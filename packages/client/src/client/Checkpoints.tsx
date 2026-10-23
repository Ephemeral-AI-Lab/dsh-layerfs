// The demo strip's checkpoints (#352).
//
// Checkpoints: one segment per checkpoint of the demo's scenario, in order,
// green once the run reached it with its gates passed (a watch is a pass with
// a note), red where the run stopped at it (optimize or stop), striped and marked ↺ when the run started after
// it (restored, not replayed), the next one pulsing while the run goes.
// Clicking a checkpoint a run can start after opens the start picker with it
// chosen.
//
// With more than a dozen checkpoints (#352 has one per range, 202) the
// segments carry no labels; each names itself on hover.
//
// StartPicker: where Play or Replay starts. From the beginning, or after a
// checkpoint the latest run reached that can be restored: the ranges up to it
// are restored at once (the mock's `restore` stands in for #352's Store
// snapshot), and the run plays the next range onwards. It is one row of
// numbers that scrolls sideways: 0 is the beginning, k is after the k-th
// checkpoint.
import { useEffect, useRef } from 'react'
import type { DemoCheckpoint } from './demo.ts'

/** A checkpoint whose gates passed (a watch passes, with a note); optimize and stop halt the run there. */
export const passed = (c: DemoCheckpoint) => c.verdict === 'pass' || c.verdict === 'watch'
const color = (c: DemoCheckpoint) => (passed(c) ? '#2e9e5b' : '#d14343')
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const stripes = (color: string) => `repeating-linear-gradient(135deg, ${color} 0 4px, color-mix(in srgb, ${color} 35%, transparent) 4px 7px)`

/** The line the strip shows for the checkpoints: how many were reached, and the last one. */
export function checkpointText(checkpoints: DemoCheckpoint[]): string {
  const reached = checkpoints.filter((c) => c.reachedAt !== null)
  const restored = reached.filter((c) => c.restored).length
  const last = reached.at(-1)
  return last ? `Checkpoint ${reached.length} of ${checkpoints.length}${restored ? ` (${restored} restored)` : ''} · ${last.label}${passed(last) ? '' : ` · ${last.verdict}`}` : `0 of ${checkpoints.length} checkpoints`
}

/** The checkpoints a new run can start after: reached by the latest run with its gates passed, and restorable. */
export const startable = (checkpoints: DemoCheckpoint[]) => checkpoints.flatMap((c, i) => (c.reachedAt !== null && c.resumable && passed(c) ? [i] : []))

// past this many checkpoints the timeline is segments only; each names itself on hover
const LABELED = 12

export function Checkpoints({ checkpoints, running, onPick }: { checkpoints: DemoCheckpoint[], running: boolean, onPick: (i: number) => void }) {
  const labeled = checkpoints.length <= LABELED
  const next = checkpoints.findIndex((c) => c.reachedAt === null)
  const can = new Set(startable(checkpoints))
  return (
    <div role="list" aria-label="Checkpoints" style={{ display: 'flex', gap: labeled ? 3 : 1, minWidth: 0, fontSize: 11 }}>
      {checkpoints.map((c, i) => {
        const reached = c.reachedAt !== null, current = running && i === next
        const title = [
          reached ? `${c.label} · ${c.restored ? 'restored' : 'reached'} ${time(c.reachedAt as number)}${passed(c) ? '' : ` · ${c.verdict}`}` : `${c.label} · ${current ? 'in progress' : 'not reached yet'}`,
          reached && c.note && !c.restored ? c.note : null,
          can.has(i) && !running ? 'Click to start a new run after it.' : null,
        ].filter(Boolean).join('\n')
        return (
          <div role="listitem" key={i} title={title} onClick={can.has(i) && !running ? () => onPick(i) : undefined}
            style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2, cursor: can.has(i) && !running ? 'pointer' : 'default' }}>
            <div style={{
              height: labeled ? 6 : 8, borderRadius: labeled ? 3 : 1,
              background: !reached ? 'color-mix(in srgb, currentColor 12%, transparent)' : c.restored ? stripes(color(c)) : color(c),
              outline: current ? '1px dashed color-mix(in srgb, currentColor 55%, transparent)' : 'none', outlineOffset: 1,
              animation: current ? 'lfs-checkpoint-pulse 1.2s ease-in-out infinite' : 'none',
            }} />
            {labeled ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: reached ? 'inherit' : 'var(--dsh-color-fg-muted, inherit)', opacity: reached ? 1 : 0.7 }}>
              {reached ? (c.restored ? '↺ ' : '✓ ') : ''}{c.label}
            </span> : null}
          </div>
        )
      })}
      <style>{'@keyframes lfs-checkpoint-pulse { 0%, 100% { opacity: 0.35 } 50% { opacity: 0.9 } }'}</style>
    </div>
  )
}

export interface StartPickerProps { checkpoints: DemoCheckpoint[], chosen: number | null, onChoose: (i: number | null) => void, onStart: () => void, onCancel: () => void }

const line = '1px solid color-mix(in srgb, currentColor 18%, transparent)'
const button = { border: line, borderRadius: 8, padding: '3px 10px', font: 'inherit', color: 'inherit', background: 'transparent', cursor: 'pointer' } as const

/** Where the next run starts: one sideways-scrolling row of numbers, 0 (the beginning) and each checkpoint it can start after. */
export function StartPicker({ checkpoints, chosen, onChoose, onStart, onCancel }: StartPickerProps) {
  const list = useRef<HTMLDivElement | null>(null), chosenRow = useRef<HTMLButtonElement | null>(null)
  // only the list scrolls to the chosen number: scrollIntoView would move the composer too
  useEffect(() => {
    const box = list.current, at = chosenRow.current
    if (box && at) box.scrollLeft = at.offsetLeft - (box.clientWidth - at.offsetWidth) / 2
  }, [])
  const row = (i: number | null) => (
    <button type="button" key={i ?? -1} ref={chosen === i ? chosenRow : undefined} aria-pressed={chosen === i} onClick={() => onChoose(i)}
      style={{ flex: 'none', minWidth: 28, border: 0, borderRadius: 6, padding: '2px 6px', font: 'inherit', color: 'inherit', cursor: 'pointer',
        background: chosen === i ? 'color-mix(in srgb, currentColor 14%, transparent)' : 'transparent' }}>{i === null ? 0 : i + 1}</button>
  )
  return (
    <div role="dialog" aria-label="Start after checkpoint" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 12 }}>
      <div ref={list} style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', gap: 2, overflowX: 'auto', border: line, borderRadius: 8, padding: '2px 2px 8px', scrollbarWidth: 'thin' }}>
        {row(null)}
        {startable(checkpoints).map(row)}
      </div>
      <button type="button" onClick={onCancel} style={{ ...button, flex: 'none' }}>Cancel</button>
      <button type="button" onClick={onStart} style={{ ...button, flex: 'none', whiteSpace: 'nowrap', border: 0, fontWeight: 600, color: 'var(--dsh-color-fg-on-accent, #fff)', background: 'var(--dsh-color-bg-accent, #2563eb)' }}>
        Start after {chosen === null ? 0 : chosen + 1}
      </button>
    </div>
  )
}
