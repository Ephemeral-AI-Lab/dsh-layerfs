/**
 * One Store on the board: its row (name opens the Store's page; kind,
 * location, size, backups, Add project and the Store menu), a job or notice
 * under it, then its projects as rows.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconChevronRightOutlineRegular, IconPlusOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, LinkButton, MoreMenu, Notice, StateChip } from '../ui/index.tsx'
import { JobPanel, OpPanel } from './JobProgress.tsx'
import type { StorageT } from './locale.ts'
import { canAddProject, inHome, latestBackup, storeStateWords, storeTone } from './model.ts'
import { StoreGlyph } from './parts.tsx'
import type { DoctorFinding, ProjectSummary, StorageJob, StoreBackupLink, StoreRow } from './types.ts'
import css from './Storage.module.css'

export interface StoreActions {
  push: () => void
  pull: () => void
  move: () => void
  backup: () => void
  backupTo: (link: StoreBackupLink) => void
  restore: (bucket: string, file: string) => void
  remove: () => void
  disconnect: () => void
  start: () => void
  addProject: () => void
  retry: (job: StorageJob) => void
  dismiss: (job: StorageJob) => void
  openMachine: (name: string) => void
}

/** Where a Store is: the home, a machine (opens it on Machines), or its PostgreSQL server. */
export function Location({ store: s, t, onMachine }: { store: StoreRow, t: StorageT, onMachine: (name: string) => void }): ReactNode {
  if (s.kind === 'postgresql') return <span className={css.mono} title={s.postgresql?.target ?? undefined}>{s.postgresql?.target ?? t('postgresql')}</span>
  if (inHome(s)) return <span>{t('layerfsHome')}</span>
  return <LinkButton onClick={() => s.machine && onMachine(s.machine)}>{s.machine ?? '?'}</LinkButton>
}

/** The Store menu: every Store-wide action. */
export function StoreMenu({ store: s, on, t }: { store: StoreRow, on: StoreActions, t: StorageT }): ReactNode {
  const pg = s.kind === 'postgresql'
  return (
    <MoreMenu label={t('storeActions', { name: s.name })}>
      {(close) => {
        const run = (fn: () => void) => () => { close(); fn() }
        return pg ? (
          <>
            <MenuItemButton disabled={!canAddProject(s)} onSelect={run(on.addProject)}>{t('addProject')}</MenuItemButton>
            <MenuItemButton danger separatorBefore onSelect={run(on.disconnect)}>{t('disconnect')}</MenuItemButton>
          </>
        ) : (
          <>
            {inHome(s)
              ? <MenuItemButton disabled={s.state !== 'idle'} onSelect={run(on.push)}>{t('pushTo')}</MenuItemButton>
              : (
                <>
                  <MenuItemButton disabled={s.state === 'busy'} onSelect={run(on.pull)}>{t('pullHome')}</MenuItemButton>
                  <MenuItemButton disabled={s.state === 'busy'} onSelect={run(on.move)}>{t('moveTo')}</MenuItemButton>
                </>
              )}
            <MenuItemButton disabled={s.state === 'down' || s.state === 'busy'} onSelect={run(on.backup)}>{t('backupTo')}</MenuItemButton>
            {s.links.map((l) => (
              <MenuItemButton key={l.bucket} disabled={s.state === 'down' || s.state === 'busy'} onSelect={run(() => on.backupTo(l))}>
                {`${t('backupNow')} · ${l.bucket}/${l.file}`}
              </MenuItemButton>
            ))}
            <MenuItemButton disabled={!canAddProject(s)} onSelect={run(on.addProject)}>{t('addProject')}</MenuItemButton>
            <MenuItemButton danger separatorBefore onSelect={run(on.remove)}>{t('remove')}</MenuItemButton>
          </>
        )
      }}
    </MoreMenu>
  )
}

/** The words under a Store's name: family · place · size · backups. */
export function StoreSub({ store: s, t, now, onMachine }: { store: StoreRow, t: StorageT, now: number, onMachine: (name: string) => void }): ReactNode {
  const pg = s.kind === 'postgresql'
  const latest = latestBackup(s)
  return (
    <span className={css.cardSub}>
      <span>{pg ? t('postgresql') : t('sqlite')}</span>
      <span className={css.dotSep} aria-hidden="true">·</span>
      <Location store={s} t={t} onMachine={onMachine} />
      {!pg ? (
        <>
          <span className={css.dotSep} aria-hidden="true">·</span>
          <span title={s.size ? `${bytes(s.size.file)} + WAL ${bytes(s.size.wal)}` : undefined}>{s.size ? bytes(s.size.bytes) : t('sizeUnavailable')}</span>
          <span className={css.dotSep} aria-hidden="true">·</span>
          <span>{!s.links.length ? t('noBackup') : [s.links.length === 1 ? t('backupOne') : t('backups', { n: s.links.length }), latest !== null && ago(latest, now, t as Translate)].filter(Boolean).join(' · ')}</span>
        </>
      ) : null}
    </span>
  )
}

/** Why a Store needs you now, if it does. */
export function storeNotice(s: StoreRow, machineState: string | null | undefined, t: StorageT): string | null {
  if (s.down) return s.down
  if (s.state === 'unresolved') return t('unresolved')
  if (s.kind === 'sqlite' && machineState === 'stopped') return t('machineStopped', { machine: s.machine ?? '?' })
  if (s.kind === 'postgresql' && s.postgresql?.reachable === false) return s.postgresql.error ?? t('unreachable')
  return null
}

export interface StoreCardProps {
  store: StoreRow
  t: StorageT
  now: number
  machineState: string | null | undefined
  attention: 'warning' | 'danger' | null
  job: StorageJob | undefined
  findings: readonly DoctorFinding[]
  projects: readonly string[]
  catalog: ReadonlyMap<string, ProjectSummary>
  searching: boolean
  on: StoreActions
  onOpen: () => void
  onOpenProject: (key: string) => void
}

export function StoreCard({ store: s, t, now, machineState, attention, job, findings, projects, catalog, searching, on, onOpen, onOpenProject }: StoreCardProps): ReactNode {
  const notice = storeNotice(s, machineState, t)
  return (
    <Card className={css.storeCard} tone={attention ?? undefined} aria-label={s.name} data-store={s.name}>
      <div className={css.cardHead}>
        <span className={css.cardIcon} aria-hidden="true"><StoreGlyph kind={s.kind} size={20} /></span>
        <div className={css.cardMain}>
          <div className={css.titleRow}>
            <button type="button" className={css.cardTitle} onClick={onOpen} aria-label={t('openStore', { name: s.name })}>{s.name}</button>
            {s.state !== 'idle' ? <StateChip tone={storeTone(s.state)} label={storeStateWords(s.state, t)} live={s.state === 'busy'} /> : null}
          </div>
          <StoreSub store={s} t={t} now={now} onMachine={on.openMachine} />
        </div>
        <div className={css.cardEnd}>
          <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={13} />} disabled={!canAddProject(s)} onClick={on.addProject}>{t('addProject')}</Button>
          <StoreMenu store={s} on={on} t={t} />
        </div>
      </div>
      {job ? <JobPanel job={job} t={t} onRetry={() => on.retry(job)} onDismiss={() => on.dismiss(job)} />
        : s.state === 'busy' && s.op ? <OpPanel store={s} t={t} /> : null}
      {notice ? (
        <Notice tone="danger" className={css.cardNotice}>
          <span>{notice}</span>
          {s.kind === 'sqlite' && machineState === 'stopped' ? <Button variant="outline" size="sm" onClick={on.start}>{t('startMachine', { machine: s.machine ?? '' })}</Button> : null}
        </Notice>
      ) : null}
      {findings.length ? (
        <Notice tone={findings.some((f) => f.severity === 'error') ? 'danger' : 'warning'} className={css.cardNotice}>
          <span>{findings.map((f) => f.message).join(' · ')}</span>
        </Notice>
      ) : null}
      {projects.length ? (
        <ul className={css.projectRows}>
          {projects.map((name) => {
            const key = `${s.name}/${name}`
            const created = catalog.get(key)?.created ?? null
            return (
              <li key={key}>
                <button type="button" className={css.projectRow} onClick={() => onOpenProject(key)} aria-label={t('openProject', { name })}>
                  <span className={css.projectName}>{name}</span>
                  <span className={css.projectMeta} title={when(created)}>{created ? ago(created, now, t as Translate) : ''}</span>
                  <IconChevronRightOutlineRegular size={14} className={css.projectChevron} />
                </button>
              </li>
            )
          })}
        </ul>
      ) : <p className={clsx(css.cardEmpty)}>{searching ? t('noMatchingProjects') : t('noProjects')}</p>}
    </Card>
  )
}
