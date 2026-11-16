/**
 * Where a machine's data disk goes, on the Machines pages (`machine.space`;
 * space.ts): a warning when the disk is getting full (from `machine.stats`,
 * which the page already polls), a bar that splits the used space into
 * LayerFS's data and what is not LayerFS's, the breakdown by part with what
 * frees each, and each Sandbox's run folder on disk.
 *
 * Shown only when the pinned CLI has machine.space (the warning only needs
 * machine.stats). A machine that is not running is not asked. A refused read
 * keeps the last answer on screen with the refusal; a part LayerFS did not
 * read shows as not read, never as zero. What is not LayerFS's is only ever
 * explained, with the command a user may run: nothing here offers to remove it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, Notice } from '../ui/index.tsx'
import { useQuery, type Query } from '../ui/use-query.ts'
import { useMachinesContext } from './context.tsx'
import { useMachineStats } from './MachineStats.tsx'
import { SandboxGlyph } from './icons.tsx'
import { gib, shortSandbox, type MachineInfo } from './model.ts'
import { diskScopeWords, statsAskable } from './stats.ts'
import {
  diskLevel, diskSpans, outsideCommand, outsideWords, sandboxSpaceReason, sandboxesBySize, spaceRows,
  type DiskLevel, type MachineSpace, type SpaceRow, type SpaceView,
} from './space.ts'
import css from './machines.module.css'

/** How often a page showing a machine's space reads it again (the host keeps an answer a minute). */
const REFRESH_MS = 60_000

const enc = encodeURIComponent
const clock = (at: number | null): string => (at ? new Date(at).toLocaleTimeString() : '—')

/** A size for a breakdown row: KiB under a MiB, else as the page's other disk sizes. */
export function size(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n > 0 && n < 2 ** 20) return `${Math.max(1, Math.round(n / 1024))} KiB`
  return gib(n)
}

/** The pinned CLI has machine.space. */
export function useSpaceOffered(): boolean {
  const { useMachines } = useMachinesContext()
  return useMachines((s) => (s.data?.available ? s.data.features?.machineSpace === true : false))
}

/**
 * One machine's `machine.space` while this component is mounted: read at
 * once, again every minute while the page is visible, and now on `refresh`.
 * @returns `offered`: the CLI has the call; `askable`: the machine runs; `read`: the host's answer so far; `refresh`: read now, past the host's minute.
 */
export function useMachineSpace(m: Pick<MachineInfo, 'name' | 'state'>): { offered: boolean, askable: boolean, read: Query<SpaceView | null>, refresh: () => void } {
  const { api } = useMachinesContext()
  const offered = useSpaceOffered()
  const askable = offered && statsAskable(m)
  const [tick, setTick] = useState(0)
  const fresh = useRef(false)
  useEffect(() => {
    if (!askable) return undefined
    const id = setInterval(() => { if (document.visibilityState === 'visible') setTick((n) => n + 1) }, REFRESH_MS)
    return () => clearInterval(id)
  }, [askable])
  const read = useQuery<SpaceView | null>(async () => {
    if (!askable) return null
    const now = fresh.current
    fresh.current = false
    return api.call('GET', `/api/machines/${enc(m.name)}/space${now ? '?fresh=1' : ''}`)
  }, [m.name, askable], { refresh: [tick], cache: `space:${m.name}` })
  return { offered, askable, read, refresh: () => { fresh.current = true; read.reload() } }
}

/** How full the machine's data disk is, from `machine.stats` (no read of its own); null when not observed. */
export function useDiskLevel(m: MachineInfo): { level: DiskLevel | null, free: number | null, total: number | null } {
  const { read } = useMachineStats(m)
  const r = read?.stats?.resources
  const free = r?.diskFree ?? null, total = r?.diskTotal ?? null
  return { level: diskLevel(free, total), free, total }
}

/** "6 GiB free" in the warning or danger tone when the disk is getting full; nothing while it is not. */
export function DiskWarning({ m }: { m: MachineInfo }): ReactNode {
  const { t } = useMachinesContext()
  const { level, free, total } = useDiskLevel(m)
  if (!level || level === 'ok') return null
  return (
    <span className={css.spaceChip} data-tone={level === 'critical' ? 'danger' : 'warning'} data-disk-level={level} role="status"
      title={t(level === 'critical' ? 'diskCriticalTitle' : 'diskLowTitle', { free: gib(free), total: gib(total) })}>
      {t('diskLowChip', { free: gib(free) })}
    </span>
  )
}

/** The disk as one bar: LayerFS's data, what is not LayerFS's (or used space the walk did not split), and free. */
export function SpaceBar({ space, className }: { space: MachineSpace, className?: string }): ReactNode {
  const { t } = useMachinesContext()
  const spans = diskSpans(space)
  if (!spans) return null
  const pct = (share: number) => `${(share * 100).toFixed(2)}%`
  const label = space.outside != null
    ? t('spaceBarLabel', { layerfs: size(space.layerfs), outside: size(space.outside), free: size(space.disk.free) })
    : t('spaceBarLabelPartial', { layerfs: size(space.layerfs), free: size(space.disk.free) })
  return (
    <span className={clsx(css.spaceBar, className)} role="img" aria-label={label} title={label} data-space-bar>
      <span className={css.spaceSeg} data-part="layerfs" style={{ width: pct(spans.layerfs) }} />
      {spans.outside > 0 && <span className={css.spaceSeg} data-part="outside" style={{ width: pct(spans.outside) }} />}
      {spans.unsplit > 0 && <span className={css.spaceSeg} data-part="unsplit" style={{ width: pct(spans.unsplit) }} />}
    </span>
  )
}

/** "LayerFS 3.3 GiB · not LayerFS 48 GiB · 180 GiB free" (or the partial form). */
function legend(space: MachineSpace, t: ReturnType<typeof useMachinesContext>['t']): string {
  return space.outside != null
    ? t('spaceLegend', { layerfs: size(space.layerfs), outside: size(space.outside), free: size(space.disk.free) })
    : t('spaceLegendPartial', { layerfs: size(space.layerfs), free: size(space.disk.free) })
}

/**
 * A machine card's space line: the bar and its legend, and the warning chip
 * when the disk is getting full. Without machine.space only the chip (from
 * machine.stats) shows; without either, nothing.
 */
export function CardSpace({ m }: { m: MachineInfo }): ReactNode {
  const { t } = useMachinesContext()
  const { offered, read } = useMachineSpace(m)
  const space = offered ? read.data?.space ?? null : null
  const { level } = useDiskLevel(m)
  const warn = level === 'low' || level === 'critical'
  if (!space && !warn) return null
  const mostlyOutside = space?.outside != null && space.layerfs != null && space.outside > space.layerfs
  return (
    <div className={css.spaceLine} data-card-space={m.name}>
      <DiskWarning m={m} />
      {space && <SpaceBar space={space} />}
      {space && <span className={css.muted} data-space-legend>{legend(space, t)}</span>}
      {warn && mostlyOutside && <span className={css.spaceHint} data-space-mostly-outside>{t('spaceMostlyOutside')}</span>}
    </div>
  )
}

/** A notice on the machine's page while its disk is getting full: how much is free and, when known, how much is not LayerFS's. */
export function DiskNotice({ m }: { m: MachineInfo }): ReactNode {
  const { t, tw } = useMachinesContext()
  const { level, free, total } = useDiskLevel(m)
  const { offered, read } = useMachineSpace(m)
  const space = offered ? read.data?.space ?? null : null
  if (!level || level === 'ok') return null
  return (
    <Notice tone={level === 'critical' ? 'danger' : 'warning'} role="status">
      <p data-disk-notice={level}>{t(level === 'critical' ? 'diskNoticeCritical' : 'diskNoticeLow', { free: gib(free), total: gib(total) })}</p>
      {space?.outside != null && space.layerfs != null && (
        <p>{t('diskNoticeSplit', { layerfs: size(space.layerfs), outside: size(space.outside) })} {tw(outsideWords(space.disk.scope))}</p>
      )}
    </Notice>
  )
}

const ROW_KEYS = {
  stores: ['spaceRowStores', 'spaceHintStores'],
  overlays: ['spaceRowOverlays', 'spaceHintOverlays'],
  sandboxFiles: ['spaceRowSandboxFiles', 'spaceHintSandboxFiles'],
  sandboxRuntime: ['spaceRowSandboxRuntime', 'spaceHintSandboxRuntime'],
  images: ['spaceRowImages', 'spaceHintImages'],
  otherRuns: ['spaceRowOtherRuns', 'spaceHintOtherRuns'],
  logs: ['spaceRowLogs', 'spaceHintLogs'],
  outside: ['spaceRowOutside', null],
  free: ['spaceRowFree', null],
} as const

/** One breakdown row: a swatch, what it is, what frees it, and its size ("at least" when the walk stopped early). */
function Row({ row, space }: { row: SpaceRow, space: MachineSpace }): ReactNode {
  const { t, tw } = useMachinesContext()
  const [copied, setCopied] = useState(false)
  const [label, hint] = ROW_KEYS[row.key]
  const command = row.key === 'outside' ? outsideCommand(space.disk.scope) : null
  const partial = !space.complete && row.layerfs
  const value = row.bytes == null
    ? <span className={css.muted}>{row.key === 'outside' && !space.complete ? t('spaceNotSplit') : t('spaceNotRead')}</span>
    : partial ? t('spaceAtLeast', { size: size(row.bytes) }) : size(row.bytes)
  return (
    <tr data-space-row={row.key}>
      <td className={css.spaceSwatchCell}><span className={css.spaceSwatch} data-part={row.layerfs ? row.key : row.key === 'free' ? 'free' : 'outside'} /></td>
      <td>
        <span className={css.spaceRowLabel}>{t(label)}</span>
        {hint && <span className={css.factSub}>{t(hint)}</span>}
        {row.key === 'outside' && <span className={css.factSub}>{tw(outsideWords(space.disk.scope))}</span>}
        {command && (
          <span className={css.factSub}>
            {t('spaceOutsideRun')} <code className={css.mono}>{command}</code>{' '}
            <button type="button" className={css.spaceCopy} onClick={() => { void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => {}) }}>
              {t(copied ? 'copied' : 'copy')}
            </button>
          </span>
        )}
      </td>
      <td className={css.spaceSize} data-space-size={row.bytes ?? ''}>{value}</td>
    </tr>
  )
}

/** The machine's Sandboxes by disk, the largest first: total, overlays, own files, runtime and log; a row not measured says why. */
function SandboxSpaceTable({ m, space }: { m: MachineInfo, space: MachineSpace }): ReactNode {
  const { t, tw, go, useMachines } = useMachinesContext()
  const states = useMachines((s) => (s.data?.available ? s.data.sandboxes : null))
  const rows = sandboxesBySize(space)
  if (!rows.length) return null
  const sum = (...v: (number | null)[]) => (v.every((x) => x == null) ? null : v.reduce<number>((a, b) => a + (b ?? 0), 0))
  const cut = (n: number | null, reason?: string) => (n == null ? '—' : reason === 'deadline' ? t('spaceAtLeast', { size: size(n) }) : size(n))
  return (
    <table className={clsx(css.rows, css.spaceTable)} aria-label={t('spaceSandboxes', { name: m.name })} data-space-sandboxes={m.name}>
      <thead>
        <tr><th className={css.mxName}>{t('mxSandbox')}</th><th>{t('spaceColTotal')}</th><th>{t('spaceColOverlays')}</th><th>{t('spaceColFiles')}</th><th>{t('spaceColRuntime')}</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const state = states?.find((b) => b.name === r.name)?.state
          const why = r.bytes == null ? sandboxSpaceReason(r.reason) : null
          return (
            <tr key={r.name} data-space-sandbox={r.name} data-space-reason={r.reason ?? undefined}>
              <td className={css.mxName}>
                <button type="button" className={css.mxRowName} onClick={() => go({ kind: 'sandbox', machine: m.name, name: r.name })} title={r.name}>
                  <SandboxGlyph size={13} />
                  <span className={css.mono}>{shortSandbox(r.name)}</span>
                  {state === 'gone' && r.bytes != null && r.bytes > 0 && <span className={css.spaceGone} data-space-gone>{t('spaceGone')}</span>}
                </button>
              </td>
              <td data-space-cell="total">{why ? <span className={css.muted} title={tw(why)}>{tw(why)}</span> : cut(r.bytes, r.reason)}</td>
              <td data-space-cell="overlays">{cut(r.overlays, r.reason)}</td>
              <td data-space-cell="files">{cut(sum(r.writes, r.home), r.reason)}</td>
              <td data-space-cell="runtime">{cut(sum(r.runtime, r.log), r.reason)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * The machine page's "Where the disk goes" card: the bar, one row per part
 * with what frees it, what is not LayerFS's (and the command that shows it),
 * free space, then the Sandboxes by disk. Refresh reads now. Nothing without
 * machine.space; "not read" while the machine is stopped.
 */
export function WhereSpaceGoes({ m }: { m: MachineInfo }): ReactNode {
  const { t, tw } = useMachinesContext()
  const { offered, askable, read, refresh } = useMachineSpace(m)
  if (!offered) return null
  const view = read.data ?? null
  const space = view?.space ?? null
  const scope = space ? diskScopeWords(space.disk.scope) : null
  return (
    <Card className={clsx(css.tableCard, css.spaceCard)} data-where-space={m.name}>
      <div className={css.spaceHead}>
        <h3 className={css.spaceTitle}>{t('spaceTitle')}</h3>
        {space && <span className={css.muted} data-space-at>{t('spaceAsOf', { time: clock(view!.at) })}</span>}
        {askable && (
          <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={12} />} onClick={refresh} disabled={read.loading}>
            {t('refresh')}
          </Button>
        )}
      </div>
      {!askable
        ? <p className={css.muted} data-space="stopped">{t('spaceStopped')}</p>
        : !space
          ? view?.stale
            ? <p className={css.muted} data-space="refused">{t('spaceRefused', { code: view.stale.code, message: view.stale.message })}</p>
            : read.error != null
              ? <p className={css.muted} data-space="error">{t('spaceRefused', { code: (read.error as any)?.code ?? 'Unknown', message: (read.error as any)?.message ?? String(read.error) })}</p>
              : <p className={css.muted} data-space="loading">{t('spaceReading')}</p>
          : (
            <>
              <SpaceBar space={space} className={css.spaceBarWide} />
              <p className={css.muted} data-space-legend>{legend(space, t)}{scope ? ` · ${tw(scope)}` : ''}</p>
              {view?.stale && <p className={css.muted} data-space="stale">{t('spaceStale', { time: clock(view.at), code: view.stale.code, message: view.stale.message })}</p>}
              {!space.complete && <p className={css.spaceHint} data-space="partial">{t('spacePartial')}</p>}
              {space.unreadable > 0 && <p className={css.spaceHint} data-space="unreadable">{t('spaceUnreadable', { n: String(space.unreadable) })}</p>}
              <table className={clsx(css.rows, css.spaceTable)} aria-label={t('spaceTitle')} data-space-breakdown>
                <tbody>{spaceRows(space).map((row) => <Row key={row.key} row={row} space={space} />)}</tbody>
              </table>
              <SandboxSpaceTable m={m} space={space} />
            </>
          )}
    </Card>
  )
}

/**
 * A Sandbox page's disk line from its machine's `machine.space` row: its run
 * folder in all, and by part. Nothing without machine.space or before the
 * machine's space was read; why, when its row was not measured.
 */
export function SandboxDisk({ name, machine }: { name: string, machine: string }): ReactNode {
  const { t, tw, useMachines } = useMachinesContext()
  const m = useMachines((s) => (s.data?.available ? s.data.machines.find((x) => x.name === machine) ?? null : null))
  const { offered, read } = useMachineSpace(m ?? { name: machine, state: 'unknown' })
  if (!offered || !m) return null
  const space = read.data?.space
  const row = space?.sandboxes.find((r) => r.name === name)
  if (!row) return null
  const why = row.bytes == null ? sandboxSpaceReason(row.reason) : null
  const add = (...v: (number | null)[]) => v.reduce<number>((a, b) => a + (b ?? 0), 0)
  const atLeast = row.reason === 'deadline'
  return (
    <p className={css.spaceSandbox} data-sandbox-disk={name}>
      <span className={css.spaceRowLabel}>{t('spaceSandboxFigure')}</span>{' '}
      {why
        ? <span className={css.muted}>{t('spaceNotReadBecause', { reason: tw(why) })}</span>
        : (
          <>
            <span data-sandbox-disk-total>{atLeast ? t('spaceAtLeast', { size: size(row.bytes) }) : size(row.bytes)}</span>
            <span className={css.muted}> · {t('spaceSandboxParts', { overlays: size(row.overlays), files: size(add(row.writes, row.home)), runtime: size(add(row.runtime, row.log)) })}</span>
          </>
        )}
    </p>
  )
}
