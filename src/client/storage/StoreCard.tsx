/**
 * The Store pieces the explorer and the Store page share: where a Store is,
 * the Store menu, the words under its name and why it needs you now.
 */
import type { ReactNode } from 'react'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { LinkButton, MoreMenu } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { canAddProject, inHome, latestBackup } from './model.ts'
import type { StorageJob, StoreBackupLink, StoreRow } from './types.ts'
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
