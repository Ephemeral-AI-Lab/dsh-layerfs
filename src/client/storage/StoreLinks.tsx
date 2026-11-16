/**
 * A Store's third tab. A SQLite Store's Backups: one card per bucket copy it
 * is linked to, with when it was saved, its size and state, Back up now and
 * Restore. A PostgreSQL Store's Connections: the machines it is attached to,
 * each with its connection and last check, and Re-check, Edit and Detach.
 */
import type { ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, Notice } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { attachmentsOf, attachmentSignal } from './model.ts'
import type { StoreActions } from './StoreCard.tsx'
import type { BackupState, PgAttachment, StorageView, StoreRow } from './types.ts'
import css from './StorePage.module.css'

const STATE_TONE: Partial<Record<BackupState, 'ok' | 'warning' | 'danger'>> = {
  current: 'ok', store_changed: 'warning', bucket_changed: 'warning', both_changed: 'warning', missing: 'danger',
}

export function StoreBackups({ store: s, view, t, now, on }: { store: StoreRow, view: StorageView, t: StorageT, now: number, on: StoreActions }): ReactNode {
  const tt = t as Translate
  const blocked = s.state === 'down' || s.state === 'busy'
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
        const tone = file ? STATE_TONE[file.state] : undefined
        return (
          <Card key={link.bucket} className={css.linkCard} data-backup-link={link.bucket}>
            <div className={css.linkHead}>
              <span className={css.linkName}>{link.bucket}</span>
              <span className={css.mono}>{link.file}</span>
              <span className={css.spacer} />
              {file ? <span className={css.statePill} data-tone={tone}>{t(`spBackupState_${file.state}` as Parameters<StorageT>[0])}</span> : null}
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

export function StoreConnections({ store: s, view, t, now, on }: { store: StoreRow, view: StorageView, t: StorageT, now: number, on: StoreActions }): ReactNode {
  const attachable = view.features?.attach === true
  const attached = attachmentsOf(s)
  const refusals = s.attachRefusals ?? []
  const tt = t as Translate
  const place = (m: string) => (m === 'native' ? t('layerfsHome') : m)
  const check = (a: PgAttachment) => {
    if (a.lastError) return <span className={css.dangerText} title={a.lastError.message}>{t('checkFailed')}: {a.lastError.message}</span>
    if (!a.checked) return <span className={css.muted}>{t('notChecked')}</span>
    return t('checked', { version: a.checked.version ?? '?', latency: a.checked.latencyMs ?? '?', ago: a.checked.at ? ago(a.checked.at, now, tt) : '—' })
  }
  return (
    <div className={css.stack}>
      <div className={css.toolbar}>
        <span className={css.muted}>{t('spAttachedTo', { n: String(attached.length) })}</span>
        <span className={css.spacer} />
        {attachable ? <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={() => on.attach()}>{t('attachToMachine')}</Button> : null}
      </div>
      {!attachable ? <p className={css.muted}>{t('attachUnsupported')}</p> : attached.length === 0 ? <p className={css.muted}>{t('notAttachedAnywhere', { store: s.name })}</p> : null}
      {attached.map((a) => {
        const signal = attachmentSignal(a, t)
        return (
          <Card key={a.machine} className={css.linkCard} data-tone={a.lastError ? 'danger' : undefined} data-attachment={a.machine}>
            <div className={css.linkHead}>
              <StateDot state={signal ? signal.state : 'done'} size={10} />
              <span className={css.linkName}>{place(a.machine)}</span>
              <span className={a.own ? css.mono : css.muted}>{a.own ? t('ownTarget', { target: a.target ?? '—' }) : t('sameAsHost')}</span>
            </div>
            <p className={css.linkCheck}>{check(a)}</p>
            {attachable ? (
              <div className={css.linkActions}>
                <Button variant="outline" size="sm" onClick={() => on.recheck(a)}>{t('recheck')}</Button>
                <Button variant="ghost" size="sm" onClick={() => on.attach(a.machine, a)}>{t('edit')}</Button>
                <span className={css.spacer} />
                <Button variant="ghost" size="sm" onClick={() => on.detach(a.machine)}>{t('detach')}</Button>
              </div>
            ) : null}
          </Card>
        )
      })}
      {refusals.map((r) => (
        <Notice key={r.machine} tone="danger">
          <span>{place(r.machine)}: {r.message}</span>
          <Button variant="outline" size="sm" onClick={() => on.attach(r.machine)}>{t('attachAndCheck')}</Button>
        </Notice>
      ))}
    </div>
  )
}
