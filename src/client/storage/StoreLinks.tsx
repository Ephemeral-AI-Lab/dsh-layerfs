/**
 * A Store's third tab. A SQLite Store's Backups: one card per bucket copy it
 * is linked to, with when it was saved, its size and state, Back up now and
 * Restore. A PostgreSQL Store's Connection: its database, and every machine
 * that connects to it (spec v23).
 */
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { MachineGlyph } from '../machines/icons.tsx'
import { Card } from '../ui/index.tsx'
import { HomeGlyph } from './parts.tsx'
import type { StorageT } from './locale.ts'
import { backupStateOf, brokenWords, storeStateWords, storeTip, type BackupState } from './model.ts'
import { StoreAction, type StoreActions } from './StoreCard.tsx'
import type { StorageView, StoreRow } from './types.ts'
import css from './StorePage.module.css'

const STATE_TONE: Partial<Record<BackupState, 'ok' | 'warning' | 'danger'>> = {
  current: 'ok', store_changed: 'warning', bucket_changed: 'warning', both_changed: 'warning', missing: 'danger',
}

export function StoreBackups({ store: s, view, t, now, on }: { store: StoreRow, view: StorageView, t: StorageT, now: number, on: StoreActions }): ReactNode {
  const tt = t as Translate
  const blocked = s.state !== 'ready'
  return (
    <div className={css.stack}>
      <div className={css.toolbar}>
        <span className={css.muted}>{t(s.links.length === 1 ? 'spDestinationOne' : 'spDestinations', { n: String(s.links.length) })}</span>
        <span className={css.spacer} />
        <Button variant="outline" size="sm" disabled={blocked} onClick={on.backup}>{view.buckets.length ? t('backupTo') : t('addBucketEllipsis')}</Button>
      </div>
      {s.links.length ? s.links.map((link) => {
        const bucket = view.buckets.find((b) => b.name === link.bucket)
        const file = bucket?.files?.find((f) => f.file === link.file && f.store === s.name)
        const at = file?.modified ?? link.last?.at
        const size = file?.bytes ?? link.last?.bytes
        const state = backupStateOf(file)
        const tone = state ? STATE_TONE[state] : undefined
        return (
          <Card key={link.bucket} className={css.linkCard} data-backup-link={link.bucket}>
            <div className={css.linkHead}>
              <span className={css.linkName}>{link.bucket}</span>
              <span className={css.mono}>{link.file}</span>
              <span className={css.spacer} />
              {state ? <span className={css.statePill} data-tone={tone} title={file?.message ?? undefined}>{t(`spBackupState_${state}` as Parameters<StorageT>[0])}</span> : null}
            </div>
            <dl className={css.linkFacts}>
              <div><dt>{t('spLastSaved')}</dt><dd title={when(at)}>{at ? ago(at, now, tt) : t('noBackupTime')}</dd></div>
              <div><dt>{t('factSize')}</dt><dd>{size != null ? bytes(size) : '—'}</dd></div>
              {bucket?.provider ? <div><dt>{t('spProvider')}</dt><dd>{bucket.provider}</dd></div> : null}
            </dl>
            <div className={css.linkActions}>
              <Button variant="outline" size="sm" disabled={blocked} onClick={() => on.backupTo(link)}>{t('backupNow')}</Button>
              {file ? <Button variant="ghost" size="sm" disabled={s.state === 'busy'} onClick={() => on.restore(link.bucket, link.file)}>{t('restore')}</Button> : null}
            </div>
          </Card>
        )
      }) : <Card className={css.panel}><p className={css.muted}>{t('noBackupDestinations')}</p></Card>}
    </div>
  )
}

/**
 * A PostgreSQL Store's Connection (spec v23 §5.2): the Database (its login,
 * its server and database, its id as a tip, the state with one action, and
 * Check), then Machines: one row per side that connects (this computer
 * first), each with its address (its own, or the Store's: "default
 * address"), the dot of its last reach with the latency and when, its
 * Sandboxes of the Store, and Check; a machine with an address of its own
 * also Edit and Disconnect. Connect a machine ends the list.
 */
export function StoreConnection({ store: s, view, t, on, now, sandboxes }: {
  store: StoreRow, view: StorageView, t: StorageT, on: StoreActions, now: number
  sandboxes?: readonly { machine?: string | null, project?: string | null }[] | undefined
}): ReactNode {
  const tt = t as Translate
  const pg = s.postgresql
  const rows = s.connectedFrom ?? []
  const here = rows.find((c) => c.machine === null)
  const place = (m: string) => (m === 'native' ? t('pgThisComputer') : m)
  const platformOf = (m: string) => view.machines.find((x) => x.name === m)?.platform ?? (m === 'native' ? 'native' : 'unknown')
  const mark = (m: string) => <span className={css.linkMark} aria-hidden="true">{m === 'native' ? <HomeGlyph size={16} /> : <MachineGlyph platform={platformOf(m)} size={16} />}</span>
  const broken = s.state === 'broken'
  const server = pg?.server ? `${pg.server}${pg.database ? `/${pg.database}` : ''}` : pg?.target ?? '—'
  const checked = here?.reach
  return (
    <div className={css.stack}>
      <Card className={css.linkCard} data-tone={broken ? 'danger' : undefined} data-connection={s.name}>
        <div className={css.linkHead}>
          <span className={css.linkName}>{t('pgDatabase')}</span>
          <span className={css.mono} title={pg?.binding ? t('pgDatabaseIdTip', { id: pg.binding.slice(0, 8) }) : undefined}>{server}</span>
        </div>
        <dl className={css.linkFacts}>
          <div><dt>{t('pgLogin')}</dt><dd className={pg?.auth ? css.mono : undefined}>{pg?.auth ?? t('pgNoLogin')}</dd></div>
          <div><dt>{t('pgDatabaseIdLabel')}</dt><dd className={css.mono} title={t('pgDatabaseIdTip', { id: pg?.binding?.slice(0, 8) ?? '—' })}>{pg?.binding?.slice(0, 8) ?? '—'}</dd></div>
          <div><dt>{t('syncCommit')}</dt><dd>{pg?.synchronousCommit ?? t('syncCommitDefault')}</dd></div>
        </dl>
        <div className={css.linkCheck} data-state={broken ? 'failed' : undefined}>
          <StateDot state={broken ? 'error' : s.state === 'ready' ? 'done' : 'idle'} size={10} />
          <span title={broken ? storeTip(s, t) : undefined}>{broken ? brokenWords(s, t) : storeStateWords(s.state, t)}</span>
          {checked?.at ? <span className={css.muted}>{t('pgCheckedAgo', { when: ago(checked.at, now, tt) })}</span> : null}
          {checked?.ok && checked.version ? <span className={css.muted}>{checked.version.split(' ')[0]}</span> : null}
          {checked?.ok && checked.latencyMs != null ? <span className={css.muted}>{t('msReachableMs', { latency: checked.latencyMs })}</span> : null}
        </div>
        <div className={css.linkActions}>
          {broken ? <StoreAction store={s} t={t} /> : null}
          {/* accessible names name the Store they act on (UI pass 3 F5); the visible words stay short */}
          <Button variant="ghost" size="sm" aria-label={t('ariaFor', { action: t('pgChangeLogin'), name: s.name })} onClick={() => on.editConnection()}>{t('pgChangeLogin')}</Button>
          <Button variant="outline" size="sm" aria-label={t('ariaFor', { action: t('pgCheck'), name: s.name })} onClick={() => on.check()}>{t('pgCheck')}</Button>
        </div>
      </Card>
      <Card className={css.linkCard} data-machines={s.name}>
        <div className={css.linkHead}><span className={css.linkName}>{t('pgMachines')}</span></div>
        <ul className={css.connList}>
          {rows.map((c) => {
            const name = c.machine ?? 'native'
            const record = view.machines.find((m) => m.name === name)
            const reach = c.reach
            const boxes = (sandboxes ?? []).filter((b) => (b.machine ?? 'native') === name && b.project?.startsWith(`${s.name}/`)).length
            const state = record?.state === 'broken' || c.reached === 'failed' ? 'error' : c.reached === 'ok' ? 'done' : 'idle'
            return (
              <li key={c.machine ?? '(here)'} className={css.connRow} data-conn={name} data-reached={c.reached ?? 'none'}>
                {mark(name)}
                <span className={css.connName}>{place(name)}</span>
                <span className={css.muted} title={c.url ?? undefined}>{c.own ? t('pgOwnAddressShort') : t('pgDefaultAddress')}</span>
                <span className={css.connReach} title={reach?.ok === false ? t('pgCheckFailed') : undefined}>
                  <StateDot state={state} size={9} />
                  {reach ? (reach.ok ? (reach.latencyMs != null ? t('msReachableMs', { latency: reach.latencyMs }) : t('pgReached')) : t('pgCheckFailed')) : t('pgNotChecked')}
                </span>
                <span className={css.muted}>{reach?.at ? ago(reach.at, now, tt) : ''}</span>
                <span className={css.muted}>{boxes ? t(boxes === 1 ? 'pgSandboxOne' : 'pgSandboxes', { n: boxes }) : ''}</span>
                <span className={css.spacer} />
                {/* each names its machine row and the Store (F5) */}
                <Button variant="ghost" size="sm" aria-label={t('ariaForOn', { action: t('pgCheck'), name: place(name), store: s.name })} onClick={() => on.check(c.machine ?? undefined)}>{t('pgCheck')}</Button>
                {c.machine && c.own ? <Button variant="ghost" size="sm" aria-label={t('ariaForOn', { action: t('edit'), name: place(name), store: s.name })} onClick={() => on.editConnection(c.machine!)}>{t('edit')}</Button> : null}
                {c.machine && (c.own || reach) ? <Button variant="ghost" size="sm" aria-label={t('ariaForOn', { action: t('pgForget'), name: place(name), store: s.name })} onClick={() => on.removeOwn(c.machine!)}>{t('pgForget')}</Button> : null}
              </li>
            )
          })}
        </ul>
        <div className={css.linkActions}>
          <Button variant="outline" size="sm" onClick={on.connectMachine}>{t('pgConnectMachine')}</Button>
        </div>
      </Card>
    </div>
  )
}
