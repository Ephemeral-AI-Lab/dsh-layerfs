/**
 * The machine page's Sandboxes tab as cards, one per Sandbox
 * (machine-tabs.ts `sandboxCards` filters and orders them):
 *
 * - head: the name (opens the Sandbox), its state and the Sandbox menu;
 * - a line of what it is: project, its own image, up time, mounted Workspaces;
 * - three figures, each with a bar: processor (machine.stats), memory
 *   (machine.stats) and space on disk split into Workspace changes, own files
 *   and runtime and log (machine stats --with space);
 * - Terminals and Files, which open the Sandbox page on that tab.
 *
 * Each Sandbox may run a different image: its card names it, linking to the
 * machine's Images tab.
 *
 * Those that need you come first with a warning edge; a gone one says why and
 * offers Close. Sandboxes closed within the sampler's hour are their own
 * filter, as small cards with when they closed and their peak memory. A
 * figure whose call the pinned CLI lacks is not drawn; a value LayerFS did not
 * read is a dash with why, never 0.
 */
import { useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconPlusOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, LinkButton, MenuSelect, Meter, StateChip, refusalOf } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph } from './icons.tsx'
import { creatingOn } from './images.ts'
import { CreatingRow, lookOf, sandboxNeedsYou } from './Inventory.tsx'
import { useImageName, useSandboxImages } from './ImageMenu.tsx'
import { useMetrics } from './MachineStats.tsx'
import { SANDBOX_FILTERS, SANDBOX_SORTS, sandboxCards, type SandboxCard, type SandboxFilter, type SandboxSort } from './machine-tabs.ts'
import { processors, sandboxTable, upTime } from './metrics.ts'
import { Dash, useWords } from './MetricsViews.tsx'
import { gib, machineState, projectRef, sandboxGone, sandboxesOn, shortSandbox, type AvailableView, type MachineInfo, type MachineSandbox, type SandboxImagesView } from './model.ts'
import type { Query } from '../ui/use-query.ts'
import { SandboxMenu, useClose } from './Sandboxes.tsx'
import { sandboxSpaceReason, spaceSize, type SandboxSpace } from './space.ts'
import { useMachineSpace } from './SpaceViews.tsx'
import { liveNote } from './stats.ts'
import css from './machines.module.css'
import { chipOpWords, sandboxesEmptyKey } from './notices.ts'

type Row = ReturnType<typeof sandboxTable>[number] & { memory: number | null }

/** A gone Sandbox's Close: sandbox.remove, which removes its record and run folder (a gone Sandbox has no daemon to stop). */
function CloseGone({ name }: { name: string }): ReactNode {
  const { t } = useMachinesContext()
  const { busy, error, close } = useClose(name)
  return (
    <span className={css.sbAction}>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void close(false)} data-close-gone={name}>{t('closeGone')}</Button>
      {error != null && <span className={css.creatingFailed} role="alert" title={refusalOf(error).message}>{refusalOf(error).code}</span>}
    </span>
  )
}

const add = (...xs: (number | null)[]): number | null => (xs.every((x) => x == null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0))

/** A Sandbox's space on disk as one bar: Workspace changes, own files, runtime and log, each its share of the Sandbox's total. */
function SplitBar({ s }: { s: SandboxSpace }): ReactNode {
  const { t } = useMachinesContext()
  const parts = [['overlays', s.overlays], ['sandboxFiles', add(s.writes, s.home)], ['sandboxRuntime', add(s.runtime, s.log)]] as const
  const total = parts.reduce((a, [, v]) => a + (v ?? 0), 0)
  if (!total) return <span className={css.sbBar} />
  const label = t('spaceSandboxParts', { overlays: spaceSize(parts[0][1]), files: spaceSize(parts[1][1]), runtime: spaceSize(parts[2][1]) })
  return (
    <span className={css.sbBar} role="img" aria-label={label} title={label} data-sb-split>
      {parts.map(([part, v]) => (v ? <span key={part} className={css.sbBarSeg} data-part={part} style={{ width: `${((v / total) * 100).toFixed(2)}%` }} /> : null))}
    </span>
  )
}

/** One of a card's figures: its label, its value (or a dash with why), and a bar under it. */
function Figure({ label, cell, children, bar }: { label: string, cell: string, children: ReactNode, bar?: ReactNode }): ReactNode {
  return (
    <div className={css.sbFigure} data-sb-cell={cell}>
      <dt>{label}</dt>
      <dd>{children}</dd>
      {bar ?? <span className={css.sbBar} />}
    </div>
  )
}

/** One Sandbox's card. */
function SandboxCardView({ m, card, image, onImages, cpus, memoryTotal, metricsOffered, spaceOffered, now }: {
  m: MachineInfo, card: SandboxCard<Row>, image: string | null, onImages?: (() => void) | undefined, cpus: number | null, memoryTotal: number | null, metricsOffered: boolean, spaceOffered: boolean, now: number
}): ReactNode {
  const { t, tw, go, stateWord } = useMachinesContext()
  const w = useWords()
  const b = card.record
  const mx = card.metrics
  const closing = useClose(card.name)
  const usage = mx && !mx.gap ? mx.row?.usage ?? null : null
  const why = mx?.gap ?? mx?.row?.usageReason ?? mx?.row?.liveReason
  const open = (tab?: 'terminals' | 'files') => go({ kind: 'sandbox', machine: m.name, name: card.name, ...(tab ? { tab } : {}) })
  const head = (dot: 'idle' | 'error' | 'done', state: ReactNode, menu?: ReactNode) => (
    <div className={css.sbCardHead}>
      <button type="button" className={css.mxRowName} onClick={() => open()} title={card.name}>
        <StateDot state={dot} size={6} />
        <SandboxGlyph size={13} />
        <span className={css.mono}>{shortSandbox(card.name)}</span>
      </button>
      <span className={css.columnSpacer} />
      {state}
      {menu}
    </div>
  )

  if (!b) {
    // closed within the sampler's hour: only its values remain
    const ran = mx?.row?.startedAt != null && mx.closedAt != null ? upTime(mx.row.startedAt, mx.closedAt) : null
    const peak = mx?.row?.usage?.memoryPeak ?? null
    return (
      <Card className={clsx(css.sbCard, css.sbCardClosed)} data-sb-card={card.name} data-sb-closed>
        {head('idle', <span className={css.muted}>{mx?.closedAt != null ? t('sbClosedAt', { time: new Date(mx.closedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }) : t('mxClosed')}</span>)}
        <p className={css.sbCardSub}>{[ran && ran !== '—' ? t('sbRan', { time: ran }) : null, peak != null ? t('sbPeak', { size: gib(peak) }) : null].filter(Boolean).join(' · ') || t('mxClosed')}</p>
      </Card>
    )
  }

  const look = lookOf(b)
  const gone = sandboxGone(b)
  const closeFix = b.state === 'broken' && b.fix === `layerfs sandbox remove ${card.name}`
  const needs = sandboxNeedsYou(b)
  const dot = needs ? 'error' : b.state === 'ready' ? 'done' : 'idle'
  const up = b.state === 'ready' && mx && !mx.gap && mx.row?.startedAt != null ? upTime(mx.row.startedAt, now) : null
  const sub = [
    b.project ? projectRef(b.project).name : null,
    up && up !== '—' ? t('sbUp', { time: up }) : null,
    b.workspaces != null ? (b.workspaces > 0 ? t(b.workspaces === 1 ? 'sbWorkspaceOne' : 'sbWorkspaces', { n: String(b.workspaces) }) : t('sbNoWorkspaces')) : null,
  ].filter(Boolean).join(' · ')
  const s = card.space
  const spaceWhy = s && s.bytes == null ? sandboxSpaceReason(s.reason) : null
  // neither processor nor memory read (a native Sandbox has no cgroup, say): one line with why, not two cut-off dashes
  const unread = metricsOffered && mx && mx.cpu?.v == null && usage?.memoryCurrent == null && why ? w.reason(why) : null
  const showMetrics = metricsOffered && !unread
  const showFigures = !gone && (showMetrics || spaceOffered)
  return (
    <Card className={css.sbCard} data-sb-card={card.name} tone={needs ? 'warning' : undefined}>
      {head(dot, <StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={chipOpWords({ ...look, op: b.op ?? null, state: b.state ?? '' })} title={liveNote(b, tw) ?? b.message ?? undefined} />,
        <SandboxMenu name={card.name} op={b.op} closing={closing} />)}
      {sub && <p className={css.sbCardSub}>{sub}</p>}
      {image && <p className={css.sbCardImage} data-sb-image title={card.record?.image ?? undefined}><span className={css.sbCardImageLabel}>{t('sbImageLabel')}</span>{onImages ? <LinkButton className={css.mono} onClick={onImages} title={t('sbImageOpen')}>{image}</LinkButton> : <span className={css.mono}>{image}</span>}</p>}
      {gone && (
        <div className={css.sbCardGone} role="status">
          <p>{s?.bytes != null ? t('sbGoneBodySize', { size: spaceSize(s.bytes) }) : t('sbGoneBody')}</p>
          <CloseGone name={card.name} />
        </div>
      )}
      {/* broken otherwise (a retired backend's, an unknown outcome, a daemon that does not answer): LayerFS's sentence is the tip, its remove fix the one action */}
      {!gone && closeFix && (
        <div className={css.sbCardGone} role="status">
          <p title={b.message ?? undefined}>{t('sbBrokenBody')}</p>
          <CloseGone name={card.name} />
        </div>
      )}
      {showFigures && (
        <dl className={css.sbFigures}>
          {showMetrics && (
            <Figure label={t('mxProcessor')} cell="cpu"
              bar={mx?.cpu?.v != null && cpus ? <Meter className={css.sbMeter} share={Math.min(1, mx.cpu.v / cpus)} label={t('mxProcessor')} /> : undefined}>
              {mx?.cpu?.v != null ? (cpus != null ? t('mxProcessorsOf', { n: processors(mx.cpu.v), of: String(cpus) }) : processors(mx.cpu.v))
                : mx ? <Dash why={w.gap(mx.cpu?.reason ?? why ?? undefined)} /> : '—'}
            </Figure>
          )}
          {showMetrics && (
            <Figure label={t('memory')} cell="memory"
              bar={usage?.memoryCurrent != null && memoryTotal ? <Meter className={css.sbMeter} share={Math.min(1, usage.memoryCurrent / memoryTotal)} label={t('memoryUse')} /> : undefined}>
              {usage?.memoryCurrent != null ? gib(usage.memoryCurrent) : mx ? <Dash why={w.reason(why)} /> : '—'}
            </Figure>
          )}
          {spaceOffered && (
            <Figure label={t('spaceColTotal')} cell="disk" bar={s?.bytes != null ? <SplitBar s={s} /> : undefined}>
              {s?.bytes != null ? (s.reason === 'deadline' ? t('spaceAtLeast', { size: spaceSize(s.bytes) }) : spaceSize(s.bytes))
                : spaceWhy ? <Dash why={tw(spaceWhy)} /> : '—'}
            </Figure>
          )}
        </dl>
      )}
      {!gone && unread && <p className={css.sbCardNote} data-sb-unread title={unread}>{t('sbNotRead', { why: unread })}</p>}
      {!gone && (
        <div className={css.sbCardActions}>
          <Button size="sm" variant="outline" onClick={() => open('terminals')}>{t('tabTerminals')}</Button>
          <Button size="sm" variant="ghost" onClick={() => open('files')}>{t('tabFiles')}</Button>
        </div>
      )}
    </Card>
  )
}

/**
 * The Sandboxes tab: filter chips with counts, the order, New Sandbox,
 * Sandboxes being created, and the cards.
 */
type TabProps = { m: MachineInfo, view: AvailableView, canCreate: boolean, onCreate: () => void, onImages?: (() => void) | undefined }

export function SandboxesTab(props: TabProps): ReactNode {
  // Stage 1 machines that run images (not macOS native) read their image copies, for the cards' image names
  return props.view.features?.imageStage === 1 && props.m.backend !== 'native' ? <WithImages {...props} /> : <SandboxesBody {...props} images={null} />
}

function WithImages(props: TabProps): ReactNode {
  return <SandboxesBody {...props} images={useSandboxImages(props.m)} />
}

/** A Sandbox's image in words: its name among the machine's copies, else its short id; none for a Sandbox without one. */
function imageWord(id: string | null | undefined, names: Map<string, string>): string | null {
  if (!id || id === 'local') return null
  return names.get(id) ?? id.replace(/^sha256:/, '').slice(0, 12)
}

function SandboxesBody({ m, view, canCreate, onCreate, onImages, images }: TabProps & { images: Query<SandboxImagesView> | null }): ReactNode {
  const { t, useCreations } = useMachinesContext()
  const nameOf = useImageName()
  const imageNames = new Map((images?.data?.ready ?? []).map((r) => [r.id, nameOf(r)]))
  const [filter, setFilter] = useState<SandboxFilter>('all')
  const [sort, setSort] = useState<SandboxSort>('listed')
  const records: MachineSandbox[] = sandboxesOn(view, m)
  const metrics = useMetrics(m.name)
  const space = useMachineSpace(m)
  const table = useMemo<Row[]>(() => (metrics.offered ? sandboxTable(metrics.snapshot, m.name) : [])
    .map((r) => ({ ...r, memory: r.gap ? null : r.row?.usage?.memoryCurrent ?? null })), [metrics.offered, metrics.snapshot, m.name])
  const spaceRows = space.offered ? space.read.data?.space?.sandboxes ?? null : null
  const { cards, counts } = sandboxCards(records, table, spaceRows, sandboxNeedsYou, filter, sort)
  const creations = useCreations((all) => all)
  const creating = creatingOn(creations, m.name, records)
  const resources = metrics.snapshot.machines[m.name]?.latest?.stats.resources
  const now = metrics.snapshot.now ?? Date.now()
  const filterWords: Record<SandboxFilter, string> = { all: t('sbFilterAll'), running: t('sbFilterRunning'), attention: t('sbFilterAttention'), closed: t('sbFilterClosed') }
  const sortWords: Record<SandboxSort, string> = { listed: t('sbSortListed'), name: t('sbSortName'), disk: t('sbSortDisk'), memory: t('sbSortMemory') }
  const sorts = SANDBOX_SORTS.filter((x) => (x === 'disk' ? space.offered : x === 'memory' ? metrics.offered : true))
  const filters = SANDBOX_FILTERS.filter((f) => f === 'all' || counts[f] > 0 || f === filter)
  const running = machineState(m, view.live[m.name]).key === 'running'
  const emptyKey = sandboxesEmptyKey(m, view, running)
  const empty = filter !== 'all' ? t('sbFilterEmpty') : t(emptyKey.key, { name: emptyKey.home ? t('homeName') : m.name })
  return (
    <div className={css.tabStack}>
      <div className={css.tabToolbar}>
        <div className={css.sbFilters} role="group" aria-label={t('sbFilterLabel')}>
          {filters.map((f) => (
            <button key={f} type="button" className={css.sbFilter} aria-pressed={filter === f} data-tone={f === 'attention' ? 'warning' : undefined}
              data-sb-filter={f} onClick={() => setFilter(f)}>
              {filterWords[f]} <span className={css.sbFilterCount}>{counts[f]}</span>
            </button>
          ))}
        </div>
        <span className={css.columnSpacer} />
        {filter !== 'closed' && cards.length > 1 && (
          <MenuSelect value={sort} options={sorts.map((x) => ({ value: x, label: sortWords[x] }))} onChange={setSort} label={t('sbSortLabel')} className={css.sbSort} />
        )}
        <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!canCreate}
          title={canCreate ? undefined : t('sandboxAfterPower')} onClick={onCreate}>
          {t('newSandbox')}
        </Button>
      </div>
      {creating.length > 0 && <ul className={css.lines} aria-label={t('creatingSandboxes')}>{creating.map((c) => <CreatingRow key={c.id} c={c} showProject />)}</ul>}
      {cards.length === 0 && creating.length === 0 && <p className={css.inventoryEmpty}>{empty}</p>}
      {cards.length > 0 && (
        <div className={css.sbGrid} aria-label={t('sandboxesOnMachine', { name: m.name })} role="list">
          {cards.map((card) => (
            <div key={card.name} role="listitem" className={css.sbGridItem}>
              <SandboxCardView m={m} card={card} onImages={onImages} image={m.backend === 'native' ? null : imageWord(card.record?.image, imageNames)} cpus={resources?.cpus ?? null} memoryTotal={resources?.memoryTotal ?? null}
                metricsOffered={metrics.offered} spaceOffered={space.offered} now={now} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
