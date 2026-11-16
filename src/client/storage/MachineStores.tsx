/**
 * The machine page's Stores tab (machine-stores.ts holds the data).
 *
 * Two tiles at the top switch between the machine's SQLite Stores (the file
 * lives on its disk: push and pull move it) and the PostgreSQL Stores
 * attached to it (the data stays on its server: attach and detach change
 * which machines dial it). The choice is remembered per viewer and machine.
 *
 * Both kinds draw the same card, line for line:
 *
 *   head      name (opens the Store) · size, or the server's version
 *   second    the share of the machine's Stores on disk, or the connection
 *   chips     its projects
 *   status    idle, in use, a transfer under way; or the last check from here
 *   detail    its backup; or the route, password and other machines
 *   actions   Pull to home, Move to…, Back up; or Check again, Edit, Detach
 *
 * A transfer this host runs on a Store replaces its status and actions with
 * its progress (and, once failed, Retry and Dismiss).
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconPlusOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, LinkButton, Meter } from '../ui/index.tsx'
import { JobPanel, OpPanel } from './JobProgress.tsx'
import type { StorageT } from './locale.ts'
import { failedStep, machineStores, routedServer, startKind, type StoreKind } from './machine-stores.ts'
import { attachmentsOf, backupChip, cardJob, linkState, loopbackAlias } from './model.ts'
import { StoreGlyph } from './parts.tsx'
import { StoreMenu, type StoreActions } from './StoreCard.tsx'
import type { PgAttachment, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './MachineStores.module.css'

const KIND_KEY = 'layerfs.machineStoreKind'

function readKind(machine: string): StoreKind | null {
  try {
    const v = (JSON.parse(localStorage.getItem(KIND_KEY) ?? '{}') as Record<string, unknown>)[machine]
    return v === 'sqlite' || v === 'postgresql' ? v : null
  } catch { return null }
}

function writeKind(machine: string, kind: StoreKind): void {
  try {
    const all = JSON.parse(localStorage.getItem(KIND_KEY) ?? '{}') as Record<string, unknown>
    localStorage.setItem(KIND_KEY, JSON.stringify({ ...all, [machine]: kind }))
  } catch { /* the tile still switches */ }
}

export interface MachineStoresProps {
  machine: string
  view: StorageView
  t: StorageT
  jobs: readonly StorageJob[]
  dismissed: ReadonlySet<string>
  now: number
  actionsFor: (s: StoreRow) => StoreActions
  /** Add Store's SQLite side: push a Store to this machine. */
  onPushHere: (machine: string) => void
  /** Connect a database: attach a connected one, or connect a new one and attach it. */
  onConnect: (machine: string) => void
  onOpenStore: (name: string) => void
}

export function MachineStores(props: MachineStoresProps): ReactNode {
  const { machine, view, t } = props
  const stores = machineStores(view, machine, t)
  const [kind, setKindState] = useState<StoreKind>(() => startKind(stores, readKind(machine)))
  const setKind = (k: StoreKind) => { setKindState(k); writeKind(machine, k) }
  const place = machine === 'native' ? t('layerfsHome') : machine
  const tiles: { kind: StoreKind, label: string, figure: string, note: string, why: string | null }[] = [
    {
      kind: 'sqlite', label: t('sqlite'),
      figure: stores.sqlite.length ? [t(stores.sqlite.length === 1 ? 'msStoreOne' : 'msStores', { n: stores.sqlite.length }), stores.sqliteBytes != null && bytes(stores.sqliteBytes)].filter(Boolean).join(' · ') : t('msNone'),
      note: t('msSqliteNote'), why: stores.sqlite.length ? null : stores.noSqlite,
    },
    {
      kind: 'postgresql', label: t('postgresql'),
      figure: stores.postgresql.length ? t(stores.postgresql.length === 1 ? 'msDatabaseOne' : 'msDatabases', { n: stores.postgresql.length }) : t('msNone'),
      note: t('msPgNote'), why: stores.postgresql.length ? null : stores.noPostgresql,
    },
  ]
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const next = kind === 'sqlite' ? 'postgresql' : 'sqlite'
    setKind(next)
    document.getElementById(`lfs-ms-${machine}-${next}`)?.focus()
  }
  const sqlite = kind === 'sqlite'
  return (
    <div className={css.stack} data-machine-stores={machine}>
      <div className={css.tiles} role="tablist" aria-label={t('msKindLabel')} onKeyDown={onKey}>
        {tiles.map((tile) => (
          <button key={tile.kind} id={`lfs-ms-${machine}-${tile.kind}`} type="button" role="tab" className={css.tile}
            aria-selected={kind === tile.kind} tabIndex={kind === tile.kind ? 0 : -1} aria-controls={`lfs-ms-${machine}-panel`}
            onClick={() => setKind(tile.kind)} data-store-kind={tile.kind}>
            <span className={css.tileHead}>
              <StoreGlyph kind={tile.kind} size={16} />
              <span className={css.tileLabel}>{tile.label}</span>
              <span className={css.tileRole}>{tile.kind === 'sqlite' ? t('msHeldHere') : t('msAttached')}</span>
            </span>
            <span className={css.tileFigure}>{tile.figure}</span>
            <span className={css.tileNote}>{tile.why ?? tile.note}</span>
          </button>
        ))}
      </div>
      <section id={`lfs-ms-${machine}-panel`} role="tabpanel" aria-labelledby={`lfs-ms-${machine}-${kind}`} className={css.panel}>
        <div className={css.panelHead}>
          <span className={css.panelNote}>{sqlite ? (machine === 'native' ? t('msSqliteBodyHome') : t('msSqliteBody', { machine: place })) : t('msPgBody', { machine: place })}</span>
          {sqlite ? (
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!!stores.noSqlite} title={stores.noSqlite ?? undefined}
              onClick={() => props.onPushHere(machine)}>{machine === 'native' ? t('msAddSqliteHome') : t('msPushHere')}</Button>
          ) : (
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!!stores.noPostgresql || view.features?.attach !== true}
              title={stores.noPostgresql ?? (view.features?.attach !== true ? t('attachUnsupported') : undefined)}
              onClick={() => props.onConnect(machine)}>{t('connectDatabase')}</Button>
          )}
        </div>
        {sqlite
          ? stores.sqlite.length
            ? <div className={css.grid}>{stores.sqlite.map((s) => <SqliteCard key={s.name} s={s} total={stores.sqliteBytes} {...props} />)}</div>
            : <p className={css.empty}>{stores.noSqlite ?? t('msSqliteEmpty', { machine: place })}</p>
          : stores.postgresql.length
            ? <div className={css.grid}>{stores.postgresql.map(({ store, attachment }) => <PgCard key={store.name} s={store} a={attachment} {...props} />)}</div>
            : <p className={css.empty}>{stores.noPostgresql ?? t('msPgEmpty', { machine: place })}</p>}
      </section>
    </div>
  )
}

function CardHead({ s, right, on, t, onOpenStore }: { s: StoreRow, right: ReactNode, on: StoreActions, t: StorageT, onOpenStore: (name: string) => void }): ReactNode {
  return (
    <div className={css.head}>
      <StoreGlyph kind={s.kind} size={16} />
      <LinkButton className={css.name} onClick={() => onOpenStore(s.name)} title={s.name}>{s.name}</LinkButton>
      <span className={css.right}>{right}</span>
      <StoreMenu store={s} on={on} t={t} />
    </div>
  )
}

function Projects({ s, t }: { s: StoreRow, t: StorageT }): ReactNode {
  return (
    <div className={css.chips} aria-label={t('colProjects')}>
      {s.projects.length ? s.projects.map((p) => <span key={p} className={css.chip}>{p}</span>) : <span className={css.muted}>{t('msNoProjects')}</span>}
    </div>
  )
}

function Line({ tone, children, title }: { tone?: 'success' | 'warning' | 'danger' | 'accent' | undefined, children: ReactNode, title?: string | undefined }): ReactNode {
  return <p className={css.line} data-tone={tone} title={title}>{children}</p>
}

function SqliteCard({ s, total, t, view, jobs, dismissed, now, actionsFor, onOpenStore }: MachineStoresProps & { s: StoreRow, total: number | null }): ReactNode {
  const on = actionsFor(s)
  const job = cardJob(jobs, s.name, dismissed, now)
  const share = s.size && total ? s.size.bytes / total : null
  const latest = [...s.links].sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0))[0]
  const chip = latest ? backupChip(linkState(s, latest.bucket, latest.file, view.buckets), t) : null
  const busy = s.state === 'busy' || s.state === 'down' || !!job && !job.ended
  return (
    <Card className={css.card} data-store={s.name} data-kind="sqlite">
      <CardHead s={s} on={on} t={t} onOpenStore={onOpenStore}
        right={<span title={s.size ? `${bytes(s.size.file)} + WAL ${bytes(s.size.wal)}` : undefined}>{s.size ? bytes(s.size.bytes) : t('sizeUnavailable')}</span>} />
      <div className={css.second}>
        <Meter share={share ?? 0} tone="neutral" label={t('msShareLabel', { name: s.name })} className={css.meter} />
        <span className={css.muted}>{share == null ? t('sizeUnavailable') : share < 0.01 ? t('msShareUnder') : t('msShare', { n: Math.round(share * 100) })}{s.size?.wal ? ` · WAL ${bytes(s.size.wal)}` : ''}</span>
      </div>
      <Projects s={s} t={t} />
      {job ? <JobPanel job={job} t={t} onRetry={() => on.retry(job)} onDismiss={() => on.dismiss(job)} /> : s.op ? <OpPanel store={s} t={t} /> : (
        <>
          {s.down ? <Line tone="danger">{s.down}</Line>
            : s.state === 'in_use' ? <Line tone="warning">{s.holders > 0 ? t('msInUseHolders', { n: s.holders }) : t('msInUse')}</Line>
              : s.state === 'unresolved' ? <Line tone="warning">{t('unresolved')}</Line>
                : <Line><StateDot state="done" size={8} /> {t('msIdle')}</Line>}
          <Line>{latest && chip
            ? <>{t('msBackedUp', { place: `${latest.bucket}/${latest.file}`, when: latest.last?.at ? ago(latest.last.at, now, t as Translate) : '—' })} · <span data-tone={chip.tone} className={css.toneText}>{chip.label}</span></>
            : t('noBackup')}</Line>
        </>
      )}
      {job && !job.ended ? null : (
        <div className={css.actions}>
          {s.machine === 'native'
            ? <Button size="sm" variant="outline" disabled={s.state !== 'idle'} onClick={on.push}>{t('pushTo')}</Button>
            : (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={on.pull}>{t('pullHome')}</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={on.move}>{t('msMoveTo')}</Button>
              </>
            )}
          <Button size="sm" variant="outline" disabled={s.state === 'down' || s.state === 'busy'} onClick={on.backup}>{t('msBackUp')}</Button>
        </div>
      )}
    </Card>
  )
}

/** A failed check in a few words: the step LayerFS names (machine-stores.ts `failedStep`), else its code. */
function failWords(e: { code: string, message: string }, t: StorageT): string {
  switch (failedStep(e.code, e.message)) {
    case 'server': return t('msFailServer')
    case 'store': return t('msFailStore')
    case 'write': return t('msFailWrite')
    default: return e.code
  }
}

/** Where `machine` dials a PostgreSQL Store: its own connection's target, else the Store's with a loopback host renamed for the machine. */
function dialed(s: StoreRow, a: PgAttachment, platform: string | undefined): string | null {
  if (a.own && a.target) return a.target
  const target = s.postgresql?.target
  if (!target) return null
  const at = target.indexOf('@')
  const user = at >= 0 ? target.slice(0, at + 1) : ''
  const rest = at >= 0 ? target.slice(at + 1) : target
  const slash = rest.indexOf('/')
  const server = slash >= 0 ? rest.slice(0, slash) : rest
  const path = slash >= 0 ? rest.slice(slash) : ''
  return `${user}${routedServer(server, platform ? loopbackAlias(platform) : null)}${path}`
}

function PgCard({ s, a, machine, t, view, now, actionsFor, onOpenStore }: MachineStoresProps & { s: StoreRow, a: PgAttachment }): ReactNode {
  const on = actionsFor(s)
  const place = (name: string) => (name === 'native' ? t('layerfsHome') : name)
  const here = place(machine)
  const platform = view.machines.find((m) => m.name === machine)?.platform
  const target = dialed(s, a, platform)
  const others = attachmentsOf(s).filter((x) => x.machine !== machine).map((x) => place(x.machine))
  const failed = !!a.lastError
  const password = a.own && a.password ? (a.saved ? t('msPasswordSaved') : a.password) : null
  return (
    <Card className={css.card} data-store={s.name} data-kind="postgresql" tone={failed ? 'danger' : undefined}>
      <CardHead s={s} on={on} t={t} onOpenStore={onOpenStore}
        right={a.checked?.version ? <span title={a.checked.version}>{t('msPgVersion', { version: a.checked.version.split(' ')[0] })}</span> : <span className={css.muted}>{t('notChecked')}</span>} />
      <div className={css.second}><span className={clsx(css.mono, css.cut)} title={target ?? undefined}>{target ?? t('postgresql')}</span></div>
      <Projects s={s} t={t} />
      {failed
        ? <Line tone="danger" title={`${a.lastError!.code}: ${a.lastError!.message}`}>{t('msUnreachable', { machine: here, reason: failWords(a.lastError!, t), when: ago(a.lastError!.at, now, t as Translate) })}</Line>
        : a.checked
          ? <Line><StateDot state="done" size={8} /> {t('msReachable', { machine: here, latency: a.checked.latencyMs ?? '—', when: a.checked.at ? ago(a.checked.at, now, t as Translate) : '—' })}</Line>
          : <Line tone="warning">{t('msNotChecked', { machine: here })}</Line>}
      <Line>{[a.own ? t('ownConnection') : t('sameAsHost'), password, others.length ? t('msAlsoOn', { machines: others.join(', ') }) : null].filter(Boolean).join(' · ')}</Line>
      <div className={css.actions}>
        {failed ? <Button size="sm" variant="outline" onClick={() => on.attach(machine, a)}>{t('msEditConnection')}</Button> : null}
        <Button size="sm" variant="outline" onClick={() => on.recheck(a)}>{t('msCheckAgain')}</Button>
        {failed ? null : <Button size="sm" variant="outline" onClick={() => on.attach(machine, a)}>{t('msEditConnection')}</Button>}
        <span className={css.grow} />
        <Button size="sm" variant="ghost" className={css.danger} onClick={() => on.detach(machine)}>{t('detach')}</Button>
      </div>
    </Card>
  )
}
