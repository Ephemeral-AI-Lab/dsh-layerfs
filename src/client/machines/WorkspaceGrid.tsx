/**
 * The Workspaces tab's grid: one card per Workspace, as many columns as the
 * page is wide (docs/specs/sandbox-terminals.md "Grid"). A card shows the
 * Workspace's name, Branch, what LayerFS says runs in it, and three figures:
 * CPU (a rate over the page's reads, with a sparkline) and memory from its own
 * cgroup when LayerFS reports usage per Workspace, and the size of its overlay
 * file with its changes. A card opens its terminal; a tick chooses it for the
 * terminals view. The last tile mounts a new Workspace.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Checkbox, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../ui/StatusDot.tsx'
import { Card } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { bytes, workspaceChanges, workspaceName, type WorkspaceInfo } from './model.ts'
import { duration, mountLabel } from './terminal.ts'
import { reasonWords } from './stats.ts'
import { cpuWords, latestRate, recordUsage, sparkPoints, type UsageTrack } from './workspace-usage.ts'
import css from './machines.module.css'
import grid from './workspace-grid.module.css'

const SPARK_W = 64
const SPARK_H = 14

export interface WorkspaceGridProps {
  /** The Sandbox's Workspaces, in creation order. */
  workspaces: readonly WorkspaceInfo[]
  /** The Workspaces chosen for the terminals view. */
  chosen: ReadonlySet<string>
  onChoose: (ws: string, on: boolean) => void
  /** Show a Workspace's terminal. */
  onOpen: (ws: string) => void
  /** Show the Files tab; absent when the pinned CLI has no files read. */
  onOpenFiles?: (() => void) | undefined
  /** The new-Workspace tile: a button, the form while adding, or nothing when the Sandbox is full or unreachable. */
  newTile: ReactNode
}

/** Re-render every second while `on`, so a running command's time moves. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return on ? now : Date.now()
}

/** Each Workspace's CPU track, stepped once per sandbox.get answer. */
function useUsageTracks(workspaces: readonly WorkspaceInfo[]): ReadonlyMap<string, UsageTrack> {
  const [tracks, setTracks] = useState<ReadonlyMap<string, UsageTrack>>(() => new Map())
  useEffect(() => { setTracks(recordUsage(workspaces)) }, [workspaces])
  return tracks
}

export function WorkspaceGrid({ workspaces, chosen, onChoose, onOpen, onOpenFiles, newTile }: WorkspaceGridProps): ReactNode {
  const { t } = useMachinesContext()
  const tracks = useUsageTracks(workspaces)
  const now = useNow(workspaces.some((w) => (w.running?.length ?? 0) > 0))
  return (
    <div className={css.sbGrid} role="list" data-ws-grid>
      {workspaces.map((ws) => (
        <div key={ws.ws} role="listitem" className={css.sbGridItem}>
          <WorkspaceCard ws={ws} track={tracks.get(ws.ws)} now={now} chosen={chosen.has(ws.ws)}
            onChoose={(on) => onChoose(ws.ws, on)} onOpen={() => onOpen(ws.ws)} onOpenFiles={onOpenFiles} />
        </div>
      ))}
      {newTile && <div role="listitem" className={css.sbGridItem}>{newTile}</div>}
      {!workspaces.length && !newTile && <p className={css.inventoryEmpty}>{t('termNoWorkspaces')}</p>}
    </div>
  )
}

function WorkspaceCard({ ws, track, now, chosen, onChoose, onOpen, onOpenFiles }: {
  ws: WorkspaceInfo, track: UsageTrack | undefined, now: number, chosen: boolean
  onChoose: (on: boolean) => void, onOpen: () => void, onOpenFiles?: (() => void) | undefined
}): ReactNode {
  const { t, tw } = useMachinesContext()
  const name = workspaceName(ws)
  const running = ws.running ?? []
  const first = running[0]
  const changes = ws.pendingMerge || ws.dirty != null ? workspaceChanges(ws) : null
  return (
    <Card className={css.sbCard} data-ws-card={ws.ws} data-chosen={chosen || undefined}>
      <div className={css.sbCardHead}>
        <Checkbox checked={chosen} onChange={onChoose} label="" title={t('wsCardChoose', { name })} className={grid.choose} />
        <button type="button" className={css.mxRowName} onClick={onOpen} title={t('wsCardOpen', { name })}>
          <StatusDot state={running.length ? 'done' : 'idle'} size={6} />
          <span className={css.mono}>{name}</span>
        </button>
        <span className={grid.ns}>{mountLabel(ws.path)}</span>
      </div>
      <div className={grid.tags}>
        {ws.branch && <span className={grid.branch} title={ws.branch}>{ws.branch}</span>}
        {ws.headMovedSinceMount && <span className={grid.tag} data-tone="warning">{t('wsCardHeadMoved')}</span>}
      </div>
      <p className={grid.run} data-ws-running={running.length}>
        {first
          ? <>
              <span className={grid.program}>{first.program ?? t('alsoProgramUnknown')}</span>
              <span className={css.muted}>{' · '}{first.started > 0 ? duration(Math.max(1000, now - first.started)) : '—'}</span>
              {running.length > 1 && <span className={css.muted}>{' · '}{t('wsCardRunningMore', { n: String(running.length - 1) })}</span>}
            </>
          : <span className={css.muted}>{t('wsCardIdle')}</span>}
      </p>
      <dl className={css.sbFigures}>
        <CpuFigure ws={ws} track={track} />
        <MemoryFigure ws={ws} />
        <div className={css.sbFigure} data-ws-cell="overlay">
          <dt>{t('wsCardOverlay')}</dt>
          <dd title={typeof ws.overlayBytes === 'number' ? t('wsOverlayTip', { size: bytes(ws.overlayBytes) }) : undefined}>
            {typeof ws.overlayBytes === 'number' ? bytes(ws.overlayBytes) : '—'}
          </dd>
          <span className={grid.sub} data-tone={changes?.tone}>{changes ? tw(changes) : '\u00a0'}</span>
        </div>
      </dl>
      <div className={css.sbCardActions}>
        <Button size="sm" variant="outline" onClick={onOpen}>{t('wsCardTerminal')}</Button>
        {onOpenFiles && <Button size="sm" variant="ghost" onClick={onOpenFiles}>{t('wsCardFiles')}</Button>}
      </div>
    </Card>
  )
}

/**
 * Why a Workspace has no usage figure (a dash's tooltip): not reported by
 * this LayerFS, LayerFS's reason (`no_command`: nothing runs; `no_controller`:
 * no memory or process count for its group; `host_process`, …), or nothing
 * running when it gave none.
 */
function useNoUsage(ws: WorkspaceInfo): string {
  const { t, tw } = useMachinesContext()
  if (ws.usage === undefined) return t('wsCardUsageAbsent')
  return ws.usageReason ? tw(reasonWords(ws.usageReason)) : t('wsCardUsageNone')
}

function CpuFigure({ ws, track }: { ws: WorkspaceInfo, track: UsageTrack | undefined }): ReactNode {
  const { t } = useMachinesContext()
  const why = useNoUsage(ws)
  const rate = cpuWords(latestRate(track))
  const points = track ? sparkPoints(track.rates, SPARK_W, SPARK_H) : null
  return (
    <div className={css.sbFigure} data-ws-cell="cpu">
      <dt>{t('wsCardCpu')}</dt>
      <dd title={rate == null && !ws.usage ? why : undefined}>{rate != null ? t('wsCardCpuValue', { n: rate }) : '—'}</dd>
      {points
        ? <svg className={grid.spark} width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden="true"><polyline points={points} /></svg>
        : <span className={grid.sub}>{'\u00a0'}</span>}
    </div>
  )
}

function MemoryFigure({ ws }: { ws: WorkspaceInfo }): ReactNode {
  const { t } = useMachinesContext()
  const why = useNoUsage(ws)
  const u = ws.usage
  return (
    <div className={css.sbFigure} data-ws-cell="memory">
      <dt>{t('wsCardMemory')}</dt>
      <dd title={u?.memoryCurrent == null ? why : undefined}>{u?.memoryCurrent != null ? bytes(u.memoryCurrent) : '—'}</dd>
      <span className={grid.sub}>{u?.memoryPeak != null ? t('wsCardPeak', { size: bytes(u.memoryPeak) }) : '\u00a0'}</span>
    </div>
  )
}

/** The grid's last tile: mount a new Workspace, with the slots left. */
export function NewWorkspaceTile({ left, empty, onClick }: { left: number, empty: boolean, onClick: () => void }): ReactNode {
  const { t } = useMachinesContext()
  return (
    <button type="button" className={grid.newTile} onClick={onClick} data-ws-new>
      <IconPlusOutlineRegular size={14} />
      <span>{empty ? t('termNoWorkspaces') : t('termNewWorkspace')}</span>
      <span className={css.muted}>{t('wsSlotsLeft', { n: String(left) })}</span>
    </button>
  )
}
