/**
 * The PostgreSQL parts of a Store page (StorePage.tsx), which a PostgreSQL
 * Store shares with a SQLite one: the Overview's Connection card (address,
 * database, user, password, the check from this computer; Edit…) and the
 * Machines tab (the machines its Sandboxes run on; Attach machine).
 */
import type { ReactNode } from 'react'
import { IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import type { StoreActions } from './StoreCard.tsx'
import { hostStatus, pgAddress } from './store-rows.ts'
import { CopyAddress, ReachWord, RunsOnList, type Sandboxes } from './StoreRows.tsx'
import type { StorageView, StoreRow } from './types.ts'
import css from './StorePage.module.css'
import pgCss from './PgPanels.module.css'
import rowsCss from './StoreRows.module.css'

/** The saved connection, as facts, with Edit…; the last check from this computer last. */
export function PgConnectionCard({ s, t, now, checking, onEdit }: { s: StoreRow, t: StorageT, now: number, checking: boolean, onEdit: () => void }): ReactNode {
  const tt = t as Translate
  const pg = s.postgresql
  const host = hostStatus(s, checking)
  const details = [pg?.synchronousCommit ? t('pgSyncCommit', { value: pg.synchronousCommit }) : t('pgSyncCommitDefault'), pg?.binding ? t('pgStoreId', { id: pg.binding }) : null].filter(Boolean).join('\n')
  return (
    <Card className={css.panel} data-store-connection>
      <header className={css.panelHead}>
        <h2 className={css.panelTitle} title={details}>{t('connection')}</h2>
        <button type="button" className={rowsCss.link} onClick={onEdit}>{t('pgEditShort')}</button>
      </header>
      <dl className={pgCss.facts}>
        <dt>{t('pgAddress')}</dt>
        <dd className={pgCss.addr} title={pgAddress(s) ?? undefined}>
          <span className={rowsCss.mono}>{pg?.server ?? '—'}</span>{pg?.url ? <CopyAddress text={pg.url} t={t} /> : null}
        </dd>
        <dt>{t('pgDatabase')}</dt>
        <dd className={rowsCss.mono} title={pg?.database ? [pg.database, pg.binding ? t('pgStoreId', { id: pg.binding }) : null].filter(Boolean).join('\n') : undefined}>{pg?.database ?? '—'}</dd>
        <dt>{t('pgUser')}</dt>
        <dd className={rowsCss.mono}>{pg?.user ?? '—'}</dd>
        <dt>{t('pgPasswordValue')}</dt>
        <dd title={pg?.passwordChangedAt ? t('pgPasswordChanged', { when: ago(pg.passwordChangedAt, now, tt) }) : undefined}>
          {pg?.passwordSaved === true ? t('pgPasswordSaved') : pg?.passwordSaved === false ? t('pgPasswordNotSaved') : '—'}
        </dd>
        <dt>{t('pgHostCheck')}</dt>
        <dd className={pgCss.check}>
          <ReachWord status={host} t={t} onEdit={onEdit} when={pg?.host?.at ? ago(pg.host.at, now, tt) : null} />
        </dd>
      </dl>
    </Card>
  )
}

/** The Machines tab: every attached machine with its last check and Sandboxes, Detach on each; Attach machine. */
export function PgMachinesPanel({ s, view, t, on, checking, sandboxes }: { s: StoreRow, view: StorageView, t: StorageT, on: StoreActions, checking: boolean, sandboxes: Sandboxes | undefined }): ReactNode {
  const sides = new Set(checking ? (s.attached ?? []).map((a) => a.machine) : [])
  return (
    <Card className={css.panel} data-store-machines>
      <header className={css.panelHead}>
        <h2 className={css.panelTitle}>{t('rowRunsOn')}</h2>
        <button type="button" className={rowsCss.link} onClick={on.attach}><IconPlusOutlineRegular size={10} />{t('rowAttachMachine')}</button>
      </header>
      <RunsOnList s={s} view={view} t={t} on={on} checking={sides} sandboxes={sandboxes} />
    </Card>
  )
}
