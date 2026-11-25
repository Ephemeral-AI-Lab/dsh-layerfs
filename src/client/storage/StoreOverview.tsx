/**
 * A Store's Overview tab: four tiles (database size, projects and Commits,
 * Sandboxes running, last backup or the machines it runs on), a PostgreSQL
 * Store's connection, then what fills the database, how the Store grew, which
 * projects wrote it, its health, and its details with removal folded at the
 * bottom. No activity feed: a job in flight is the page's own panel.
 */
import { useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { useQuery } from '../ui/use-query.ts'
import { Card, DangerButton, Fact, Facts, FixAction, FixContext, resolveFix } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { backupChip, formatWords, namesUpgrade, overviewMachineHealth, pgStoreBytes } from './model.ts'
import { refusalLabels } from './parts.tsx'
import { Signal } from './Signal.tsx'
import { StatusDot } from '../ui/StatusDot.tsx'
import { PgConnectionCard } from './PgPanels.tsx'
import { latestBackupCopy, overviewBackupHealth, storeBackups } from './store-backups.ts'
import { commitTotal, commitTotalWords, compressionOf, fileParts, growthRuns, projectShares, storeUnread, type ObservationJournal, type StoreProject, type StoreStats, type StoreUnread } from './store-page.ts'
import { hostStatus, listWords, pgSummary, REACH_LABEL, type ReachStatus } from './store-rows.ts'
import type { StorageView, StoreRow } from './types.ts'
import css from './StorePage.module.css'
import storageCss from './Storage.module.css'

export interface StoreOverviewProps {
  store: StoreRow
  view: StorageView
  t: StorageT
  api: LayerfsApi
  now: number
  /** `store.stats` (the page reads it, as the Projects tab's shares need it too). */
  stats: StoreStats | undefined
  /** Why the last stats read was refused. */
  statsError: unknown
  projects: readonly StoreProject[] | undefined
  running: ReadonlyMap<string, number>
  machineState: string | null | undefined
  onTab: (tab: 'projects' | 'backups' | 'machines') => void
  onRemove: () => void
  /** The Upgrade dialog, when the runtime has store.upgrade and the Store's format names it (#804). */
  onUpgrade?: (() => void) | undefined
  /** A PostgreSQL Store's Check is running (this computer, then its machines). */
  checking?: boolean
  onEditConnection?: () => void
}

export function StoreOverview({ store: s, view, t, api, now, stats, statsError, projects, running, machineState, onTab, onRemove, onUpgrade, checking = false, onEditConnection }: StoreOverviewProps): ReactNode {
  const pg = s.kind === 'postgresql'
  const tt = t as Translate
  // Each stats read is journaled by the host, so the journal is read again after one.
  const journal = useQuery(() => api.call<ObservationJournal>('GET', `/api/stores/${enc(s.name)}/observations`), [api, s.name], { refresh: [stats], cache: `store-observations:${s.name}` })
  const sandboxes = [...running.values()].reduce((a, n) => a + n, 0)
  const commits = projects ? commitTotal(projects) : null
  // a Store whose read was refused (an older format, say) claims no counts
  const unread = stats ? null : storeUnread(statsError)
  const commitsSub = unread && (unread.outdated || !commits?.commits) ? t('spCommitsUnread')
    : commits ? t(commitTotalWords(commits).key, { n: commitTotalWords(commits).n }) : undefined
  const backups = pg ? [] : storeBackups(s, view.buckets)
  const latestCopy = latestBackupCopy(backups)
  const bh = overviewBackupHealth(backups)
  const backupTileValue = latestCopy?.at != null
    ? ago(latestCopy.at, now, tt)
    : bh.kind === 'none' ? t('noBackup')
      : bh.kind === 'ok' ? t('backupCurrent')
        : bh.kind === 'problem' ? backupChip(bh.state, t).label
          : backupChip(backups[0]?.state, t).label
  const backupTileTone = latestCopy?.at != null ? undefined
    : bh.kind === 'problem' ? 'danger'
      : bh.kind === 'ok' ? undefined : 'muted'
  const backupTileSub = latestCopy?.link.bucket ?? backups[0]?.link.bucket

  return (
    <div className={css.stack}>
      <div className={css.tiles} role="group" aria-label={t('storeFacts')}>
        {pg ? (
          <Tile label={t('spDatabasePg')} value={stats?.file_bytes != null ? bytes(stats.file_bytes) : pgStoreBytes(stats) !== null ? bytes(pgStoreBytes(stats)!) : stats || statsError ? t('sizeUnavailable') : t('spReading')} />
        ) : (
          <Tile label={t('spDatabaseFile')} value={s.size ? bytes(s.size.bytes) : t('sizeUnavailable')} sub={s.size?.stale && s.size.seen ? t('msSizeSeen', { when: ago(s.size.seen, now, tt) }) : undefined} />
        )}
        <Tile label={t('tabProjects')} value={String(s.projectsCount ?? s.projects.length)} onOpen={() => onTab('projects')}
          sub={commitsSub} />
        <Tile label={t('spRunning')} value={t(sandboxes === 1 ? 'spSandboxOne' : 'spSandboxes', { n: String(sandboxes) })} />
        {pg ? (
          <Tile label={t('rowRunsOn')} value={t((s.attached ?? []).length === 1 ? 'spMachineOne' : 'spMachines', { n: String((s.attached ?? []).length) })} onOpen={() => onTab('machines')}
            sub={listWords((s.attached ?? []).map((a) => a.machine)) || undefined} />
        ) : (
          <Tile label={t('factLastBackup')} value={backupTileValue} title={latestCopy?.at != null ? when(latestCopy.at) : undefined}
            onOpen={() => onTab('backups')} tone={backupTileTone} sub={backupTileSub} />
        )}
      </div>

      {pg && onEditConnection ? <PgConnectionCard s={s} t={t} now={now} checking={checking} onEdit={onEditConnection} /> : null}
      <FileCard stats={stats} unread={unread} pg={pg} t={t} onRemove={onRemove} onUpgrade={view.upgrade && namesUpgrade(unread?.fix ?? s.format?.fix, s.name) ? onUpgrade : undefined} />
      {/* The host journals a read only when store.stats names the Store's identity
          (store_id, store_generation); a build without it records nothing, so no card. */}
      {growthRuns(journal.data).length ? <GrowthCard journal={journal.data} t={t} now={now} /> : null}
      <WhoWroteCard projects={projects} stats={stats} unread={unread} pg={pg} t={t} />
      <HealthCard store={s} view={view} t={t} now={now} stats={stats} unread={unread} machineState={machineState} checking={checking} />

      <details className={storageCss.storeDetails}>
        <summary className={storageCss.storeDetailsSummary}>
          <IconChevronRightOutlineRegular size={12} className={storageCss.storeDetailsChevron} />
          <span>{t('storeFacts')}</span>
        </summary>
        <div className={storageCss.storeDetailsBody}>
          <Card>
            <Facts>
              {s.created != null ? <Fact label={t('factCreated')}>{when(s.created)}</Fact> : null}
              {!pg ? <Fact label={t('factFile')}>{s.size ? bytes(s.size.bytes) : null}</Fact> : null}
              {formatWords(s.format, t) ? <Fact label={t('factFormat')}>{formatWords(s.format, t)}</Fact> : null}
              {pg ? <Fact label={t('factServer')} mono>{s.postgresql?.target}</Fact> : null}
            </Facts>
          </Card>
          <div className={storageCss.dangerRow}>
            <div className={storageCss.dangerText}>
              <p className={storageCss.dangerTitle}>{pg ? t('disconnectStoreTitle') : t('removeStoreTitle')}</p>
              <p className={storageCss.sectionNote}>{pg ? t('disconnectStoreBody') : t('removeStoreBody')}</p>
            </div>
            <DangerButton appearance="outline" size="sm" onClick={onRemove}>{pg ? t('disconnect') : t('remove')}</DangerButton>
          </div>
        </div>
      </details>
    </div>
  )
}

function Tile({ label, value, sub, onOpen, tone, title }: { label: string, value: string, sub?: string | undefined, onOpen?: () => void, tone?: 'muted' | 'warning' | 'danger' | undefined, title?: string | undefined }): ReactNode {
  const body = (
    <span className={css.tileInner}>
      <span className={css.tileLabel}>{label}</span>
      <span className={css.tileValue} data-tone={tone} title={title}>{value}</span>
      {sub ? <span className={css.tileSub}>{sub}</span> : null}
    </span>
  )
  return onOpen
    ? <div className={css.tile}><button type="button" className={css.tileButton} onClick={onOpen}>{body}</button></div>
    : <div className={css.tile}>{body}</div>
}

/**
 * A Store that could not be read: its word (Outdated for an older format,
 * else Not read) with LayerFS's sentence as the tip, and one action: an
 * outdated Store's fix (`store remove`, or `store disconnect` for a
 * PostgreSQL one) as the page's own Remove… or Disconnect…, else its fix
 * line where the page can run it. No nested error text on the card.
 */
export function StoreUnreadSignal({ unread, pg, t, onRemove, onUpgrade }: { unread: StoreUnread, pg: boolean, t: StorageT, onRemove?: (() => void) | undefined, onUpgrade?: (() => void) | undefined }): ReactNode {
  const fixes = useContext(FixContext)
  const resolved = unread.outdated ? null : resolveFix(fixes, unread.fix)
  const line = resolved?.line || null
  const fix = fixes ? resolved?.fix ?? null : null
  const word = unread.outdated ? t('spOutdated') : t('spUnread')
  // an outdated Store's fix: Upgrade… when it names store upgrade (#804), else the page's own Remove… or Disconnect…
  const action = unread.outdated && onUpgrade ? <Button variant="outline" size="sm" onClick={onUpgrade}>{t('upgradeStore')}</Button>
    : unread.outdated
    ? (onRemove ? <DangerButton appearance="outline" size="sm" onClick={onRemove}>{pg ? t('disconnect') : t('remove')}</DangerButton> : undefined)
    : fix && fixes && line ? <FixAction line={line} fix={fix} runner={fixes} labels={refusalLabels(t)} /> : undefined
  return (
    <span data-store-unread={unread.outdated ? 'outdated' : 'refused'}>
      <Signal state={unread.outdated ? 'error' : 'warning'} title={word} label={`${word}: ${unread.message}`}
        anchorText={<span className={css.unreadWord}><StatusDot state={unread.outdated ? 'error' : 'warning'} size={8} />{word}</span>}
        detail={<>{unread.message}{line && !fix ? <><br /><code>{fixes ? fixes.tip(line) : line}</code></> : null}</>}
        action={action} />
    </span>
  )
}

/** The database file's pages by part, and unique content over its packed bytes. */
function FileCard({ stats, unread, pg, t, onRemove, onUpgrade }: { stats: StoreStats | undefined, unread: StoreUnread | null, pg: boolean, t: StorageT, onRemove: () => void, onUpgrade?: (() => void) | undefined }): ReactNode {
  const [hovered, setHovered] = useState<string | null>(null)
  const barId = useId()
  const barRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLStyleElement>(null)
  const parts = fileParts(stats)
  const ratio = compressionOf(stats)
  const words: Record<string, string> = { stored: t('spPartStored'), metadata: t('spPartMetadata'), free: t('spPartFree') }
  const barParts = parts?.filter((p) => p.bytes > 0) ?? []
  const labelKey = barParts.map((p) => `${p.key}:${words[p.key]} ${Math.round(p.share * 100)}%`).join('|')
  useLayoutEffect(() => {
    const bar = barRef.current, styleEl = styleRef.current
    if (!bar || !styleEl) return
    const fontKey = () => {
      const cs = getComputedStyle(bar)
      return `${cs.fontFamily}|${cs.fontSize}`
    }
    const measure = () => {
      styleEl.textContent = ''
      const scope = `[data-bar="${CSS.escape(barId)}"]`
      const rules: string[] = []
      for (const seg of bar.children) {
        const part = (seg as HTMLElement).dataset.part
        const label = seg.firstElementChild as HTMLElement | null
        if (!part || !label) continue
        label.style.maxWidth = 'none'
        label.style.flexShrink = '0'
        const need = Math.max(label.scrollWidth, label.getBoundingClientRect().width)
        label.style.maxWidth = ''
        label.style.flexShrink = ''
        if (need > 0) rules.push(`@container (max-width: ${Math.max(0, need - 0.01).toFixed(2)}px){${scope} [data-part="${CSS.escape(part)}"]>span{display:none}}`)
      }
      styleEl.textContent = rules.join('\n')
    }
    let lastFont = fontKey()
    let lastWidth = bar.clientWidth
    measure()
    const onResize = () => {
      const nextFont = fontKey()
      const nextWidth = bar.clientWidth
      const revealed = lastWidth === 0 && nextWidth > 0
      lastWidth = nextWidth
      if (nextFont !== lastFont || revealed) { lastFont = nextFont; measure() }
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    observer?.observe(bar)
    document.fonts?.addEventListener('loadingdone', measure)
    return () => {
      observer?.disconnect()
      document.fonts?.removeEventListener('loadingdone', measure)
    }
  }, [barId, labelKey])
  return (
    <Card className={css.panel} data-store-file>
      <header className={css.panelHead}>
        <h2 className={css.panelTitle}>{pg ? t('spFileTitlePg') : t('spFileTitle')}</h2>
        {stats?.file_bytes != null ? <span className={css.panelFigure}>{bytes(stats.file_bytes)}</span> : null}
      </header>
      {parts ? (
        <>
          <style ref={styleRef} />
          <div ref={barRef} data-bar={barId} className={css.partsBar} role="img" aria-label={parts.map((p) => `${words[p.key]} ${bytes(p.bytes)} (${Math.round(p.share * 100)}%)`).join(', ')}>
            {barParts.map((p) => {
              const pct = Math.round(p.share * 100)
              return (
                <span
                  key={p.key}
                  className={css.partSeg}
                  data-part={p.key}
                  data-dim={hovered && hovered !== p.key ? '' : undefined}
                  style={{ width: `${(p.share * 100).toFixed(2)}%` }}
                  title={`${words[p.key]} · ${bytes(p.bytes)} (${pct}%)`}
                  onMouseEnter={() => setHovered(p.key)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <span className={css.partLabel}>{words[p.key]} {pct}%</span>
                </span>
              )
            })}
          </div>
          <ul className={css.partsLegend}>
            {parts.map((p) => (
              <li
                key={p.key}
                data-dim={hovered && hovered !== p.key ? '' : undefined}
                onMouseEnter={() => setHovered(p.key)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className={css.legendName}><i data-part={p.key} />{words[p.key]}</span>
                <span className={css.legendValue}>{bytes(p.bytes)} <span className={css.muted}>{Math.round(p.share * 100)}%</span></span>
              </li>
            ))}
          </ul>
          {ratio !== null && stats?.canonical_bytes != null && stats.stored_bytes != null ? (
            <p className={css.ratioLine}>
              <span>{t('spCompression', { canonical: bytes(stats.canonical_bytes), stored: bytes(stats.stored_bytes) })}</span>
              <strong>{t('spRatio', { n: ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1) })}</strong>
            </p>
          ) : null}
        </>
      ) : unread ? <StoreUnreadSignal unread={unread} pg={pg} t={t} onRemove={onRemove} onUpgrade={onUpgrade} />
        : <p className={css.muted}>{stats ? t('spFileUnknown') : t('spReading')}</p>}
    </Card>
  )
}

const W = 600, H = 120

/** File, content and metadata over the host's reads; gaps longer than the journal's are breaks. Drawn once one read is recorded. */
function GrowthCard({ journal, t, now }: { journal: ObservationJournal | undefined, t: StorageT, now: number }): ReactNode {
  const runs = growthRuns(journal)
  const points = runs.flat()
  const from = points[0]?.at ?? now, to = Math.max(points[points.length - 1]?.at ?? now, from + 1)
  const max = Math.max(1, ...points.map((p) => Math.max(p.file ?? 0, (p.stored ?? 0) + (p.metadata ?? 0))))
  const x = (at: number) => ((at - from) / (to - from)) * W
  const y = (v: number) => H - 4 - (v / max) * (H - 10)
  const path = (run: typeof points, value: (p: (typeof points)[number]) => number) => run.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)} ${y(value(p)).toFixed(1)}`).join(' ')
  return (
    <Card className={css.panel} data-store-growth>
      <header className={css.panelHead}>
        <h2 className={css.panelTitle}>{t('spGrowthTitle')}</h2>
        <span className={css.legendInline}>
          <span><i data-series="file" />{t('spDatabaseFile')}</span>
          <span><i data-part="stored" />{t('spPartStored')}</span>
          <span><i data-part="metadata" />{t('spPartMetadata')}</span>
        </span>
      </header>
      {points.length >= 2 ? (
        <>
          <svg className={css.growth} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t('spGrowthLabel', { n: String(points.length) })}>
            {runs.map((run, i) => run.length > 1 ? (
              <g key={i}>
                <path data-part="stored" d={`${path(run, (p) => p.stored ?? 0)} L${x(run[run.length - 1]!.at)} ${H} L${x(run[0]!.at)} ${H} Z`} />
                <path data-part="metadata" d={`${path(run, (p) => (p.stored ?? 0) + (p.metadata ?? 0))} L${[...run].reverse().map((p) => `${x(p.at).toFixed(1)} ${y(p.stored ?? 0).toFixed(1)}`).join(' L')} Z`} />
                <path data-series="file" d={path(run, (p) => p.file ?? 0)} vectorEffect="non-scaling-stroke" />
              </g>
            ) : (
              <circle key={i} data-series="file" cx={x(run[0]!.at)} cy={y(run[0]!.file ?? 0)} r={2} />
            ))}
          </svg>
          <div className={css.axis}><span>{when(from)}</span><span>{when(to)}</span></div>
        </>
      ) : <p className={css.muted}>{t('spGrowthFew')}</p>}
    </Card>
  )
}

/** Include bytes from before commit accounting so the shares add up to the stored content. */
function WhoWroteCard({ projects, stats, unread, pg, t }: { projects: readonly StoreProject[] | undefined, stats: StoreStats | undefined, unread: StoreUnread | null, pg: boolean, t: StorageT }): ReactNode {
  const shares = projects ? projectShares(projects) : []
  const counted = shares.reduce((a, p) => a + p.bytes, 0)
  const stored = typeof stats?.stored_bytes === 'number' ? stats.stored_bytes : null
  const rest = stored !== null && stored > counted ? stored - counted : 0
  const whole = counted + rest
  const refused = projects ? commitTotal(projects).refused : null
  return (
    <Card className={css.panel} data-store-shares>
      <header className={css.panelHead}><h2 className={css.panelTitle}>{t('spSharesTitle')}</h2></header>
      {whole > 0 ? (
        <ul className={css.shares}>
          {shares.map((p) => (
            <li key={p.name} className={css.shareBlock} title={`${p.name} ${bytes(p.bytes)}`}>
              <span className={css.shareName}>{p.name}</span>
              <span className={css.shareValue}>{bytes(p.bytes)} · {Math.round(p.bytes / whole * 100)}%</span>
            </li>
          ))}
          {rest > 0 ? (
            <li className={css.shareBlock} title={`${t('spSharesRest')} ${bytes(rest)}`}>
              <span className={css.shareName}>{t('spSharesRest')}</span>
              <span className={css.shareValue}>{bytes(rest)} · {Math.round(rest / whole * 100)}%</span>
            </li>
          ) : null}
        </ul>
      ) : unread ? <StoreUnreadSignal unread={unread} pg={pg} t={t} />
        : refused ? <StoreUnreadSignal unread={storeUnread({ message: refused })!} pg={pg} t={t} />
          : <p className={css.muted}>{!projects ? t('spReading') : t('spSharesNone')}</p>}
    </Card>
  )
}

type HealthTone = 'ok' | 'warning' | 'danger' | 'info'

const healthTone = (tone: ReachStatus['tone']): HealthTone => (tone === 'ok' ? 'ok' : tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info')

function HealthCard({ store: s, view, t, now, stats, unread, machineState, checking }: { store: StoreRow, view: StorageView, t: StorageT, now: number, stats: StoreStats | undefined, unread: StoreUnread | null, machineState: string | null | undefined, checking: boolean }): ReactNode {
  const tt = t as Translate
  const rows: { key: string, tone: HealthTone, label: string, text: string }[] = []
  // a Store that could not be read says so first: its file (or database) and the word
  if (unread) rows.push({ key: 'store', tone: unread.outdated ? 'danger' : 'warning', label: s.kind === 'postgresql' ? t('spDatabasePg') : t('spDatabaseFile'), text: unread.outdated ? t('spOutdated') : t('spUnread') })
  if (s.kind === 'postgresql') {
    // the connection as this computer last saw it, then the attached machines' last checks
    const host = hostStatus(s, checking)
    rows.push({ key: 'host', tone: healthTone(host.tone), label: t('spConnection'), text: t(REACH_LABEL[host.key]) })
    const sum = pgSummary(s, view)
    const label = t('spTabMachines')
    rows.push(!sum.machines.length ? { key: 'machines', tone: 'warning', label, text: t('rowNoMachinesBody') }
      : sum.failed ? { key: 'machines', tone: 'danger', label, text: t('pgRowFailed', { n: sum.failed }) }
        : sum.stopped ? { key: 'machines', tone: 'warning', label, text: t('pgRowStopped', { n: sum.stopped }) }
          : { key: 'machines', tone: 'ok', label, text: t('spMachinesOk', { n: String(sum.machines.length) }) })
    rows.push({ key: 'backups', tone: 'info', label: t('backupsSection'), text: t('spPgBackups') })
  } else {
    const place = s.machine ?? '?'
    const mh = overviewMachineHealth(s, machineState)
    rows.push({ key: 'machine', tone: mh.tone, label: t('spMachine'), text: t(mh.key, { machine: place }) })
    const backups = storeBackups(s, view.buckets)
    const bh = overviewBackupHealth(backups)
    const behindText = bh.kind === 'store_changed'
      ? (bh.at !== null ? t('spBackupBehind', { ago: ago(bh.at, now, tt) }) : t('spBackupBehindUndated'))
      : ''
    const backupText = bh.kind === 'problem' ? backupChip(bh.state, t).label
      : bh.kind === 'none' ? t('noBackup')
      : bh.kind === 'store_changed' ? (bh.bucket ? `${bh.bucket} · ${behindText}` : behindText)
      : bh.kind === 'bucket_changed' ? backupChip('bucket_changed', t).label
      : bh.kind === 'not_checked' ? backupChip('unknown', t).label
      : bh.kind === 'not_listed' ? backupChip(null, t).label
      : bh.at !== null ? t('spBackupOk', { ago: ago(bh.at, now, tt) }) : t('spBackupOkUndated')
    rows.push({ key: 'backup', tone: bh.tone, label: t('backupsSection'), text: backupText })
    if (stats?.reusable_bytes != null && stats.file_bytes) rows.push({ key: 'free', tone: 'ok', label: t('spPartFree'), text: t('spFreeText', { free: bytes(stats.reusable_bytes), n: String(Math.round(stats.reusable_bytes / stats.file_bytes * 100)) }) })
  }
  return (
    <Card className={css.panel} data-store-health>
      <header className={css.panelHead}><h2 className={css.panelTitle}>{t('spHealthTitle')}</h2></header>
      <ul className={css.health}>
        {rows.map((r) => (
          <li key={r.key} data-tone={r.tone}>
            <i aria-hidden="true" />
            <span className={css.healthLabel}>{r.label}</span>
            <span className={css.healthText}>{r.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
