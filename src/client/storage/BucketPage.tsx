/**
 * One bucket's page: the Store files it holds, the Store linked to each, their
 * state, size and when written, and the move each needs (Back up now, Restore…).
 * Before a bucket is listed its rows come from the Stores' links alone.
 */
import { useEffect, type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular, MenuItemButton, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { DoctorAction } from '../doctor/Doctor.tsx'
import type { DoctorT } from '../doctor/locale.ts'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, Empty, LinkButton, MoreMenu, Notice, PageHead, StateChip } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { backupChip, bucketFiles, placeWords } from './model.ts'
import { BucketGlyph } from './parts.tsx'
import type { StorageView } from './types.ts'
import css from './Storage.module.css'

export interface BucketPageProps {
  name: string
  view: StorageView
  t: StorageT
  api: LayerfsApi
  doctorT: DoctorT
  now: number
  listing: boolean
  onList: () => void
  onRestore: (file: string, store: string | null) => void
  onBackup: (store: string, file: string) => void
  onDisconnect: () => void
  onOpenStore: (name: string) => void
}

export function BucketPage({ name, view, t, api, doctorT, now, listing, onList, onRestore, onBackup, onDisconnect, onOpenStore }: BucketPageProps): ReactNode {
  const b = view.buckets.find((x) => x.name === name)
  // backup.list asks the bucket: once when the page opens, then on List.
  const unlisted = b !== undefined && b.files === null && !listing
  useEffect(() => { if (unlisted) onList() }, [unlisted]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!b) return <><PageHead title={name} /><Empty title={t('bucketMissing', { name })}>{t('bucketMissingBody')}</Empty></>
  const rows = bucketFiles(b, view.stores)
  const listed = b.files !== null
  const total = (b.files ?? []).reduce((n, f) => n + (f.bytes ?? 0), 0)
  const linked = new Set(rows.flatMap((r) => (r.storeName ? [r.storeName] : []))).size
  const tt = t as Translate
  return (
    <>
      <PageHead title={b.name} icon={<BucketGlyph size={22} />}
        intro={[
          b.provider === 'r2' ? t('r2') : b.provider === 'minio' ? t('minio') : b.provider,
          b.url ?? t('bucketOutside'),
          listed ? (b.files!.length === 1 ? t('bucketFile', { size: bytes(total) }) : t('bucketFiles', { n: b.files!.length, size: bytes(total) })) : t('bucketNotListed'),
          linked === 1 ? t('bucketLinkedOne') : t('bucketLinked', { n: linked }),
          listing ? t('bucketListing') : b.listed ? t('bucketListed', { ago: ago(b.listed, now, tt) }) : null,
        ].filter(Boolean).join(' · ')}
        actions={(
          <>
            <DoctorAction api={api} t={doctorT} target="backup.connection" name={b.name} label={doctorT('testConnection')} />
            <Button variant="outline" size="sm" disabled={listing} onClick={onList}
              icon={listing ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={13} />}>{listed ? t('listAgain') : t('list')}</Button>
            <MoreMenu label={b.name}>{(close) => <MenuItemButton danger onSelect={() => { close(); onDisconnect() }}>{t('disconnectBucket')}</MenuItemButton>}</MoreMenu>
          </>
        )} />
      {b.error ? <Notice tone="danger"><strong>{t('bucketListFailed')}</strong><span>{b.error.code}: {b.error.message}</span></Notice> : null}
      {rows.length === 0 ? (
        <Empty title={listed ? t('bucketEmptyListedTitle') : t('bucketEmptyUnlistedTitle')} icon={<BucketGlyph size={20} />}>
          {listed ? t('bucketEmptyListed') : listing ? t('bucketListing') : t('bucketEmptyUnlisted')}
        </Empty>
      ) : (
        <Card className={css.tableCard}>
          <table className={css.table}>
            <thead>
              <tr><th>{t('colFile')}</th><th>{t('colLinked')}</th><th>{t('colState')}</th><th className={`${css.num} ${css.wide}`}>{t('colSize')}</th><th className={css.wide}>{t('colWritten')}</th><th><span className={css.srOnly}>{t('storeActions', { name: b.name })}</span></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const chip = backupChip(r.state, t)
                const s = r.store
                const canBackUp = !!s && s.kind === 'sqlite' && s.state !== 'busy' && s.state !== 'down'
                const backUp = (r.state === 'store_changed' || r.state === 'missing' || (r.state === null && !!r.link)) && canBackUp
                const restore = r.state !== null && r.state !== 'missing'
                return (
                  <tr key={`${r.file}:${r.storeName ?? ''}`}>
                    <td className={css.mono}>{r.file}<span className={css.muted}>/store.sqlite</span></td>
                    <td>{r.storeName ? <span className={css.linkList}><LinkButton onClick={() => onOpenStore(r.storeName!)}>{r.storeName}</LinkButton>{s ? <span className={css.muted}>{s.kind === 'postgresql' ? t('postgresql') : placeWords(s.machine, t)}</span> : null}</span> : <span className={css.muted}>{t('notLinked')}</span>}</td>
                    <td title={r.reason ?? undefined}><StateChip tone={chip.tone} label={chip.label} dashed={chip.dashed} /></td>
                    <td className={`${css.num} ${css.wide} ${css.muted}`}>{bytes(r.bytes)}</td>
                    <td className={`${css.wide} ${css.muted}`} title={when(r.modified)}>{r.modified ? ago(r.modified, now, tt) : '—'}</td>
                    <td className={css.actionsCell}>
                      {backUp ? <Button variant="outline" size="sm" onClick={() => onBackup(r.storeName!, r.file)}>{t('backupNow')}</Button> : null}
                      {restore ? <Button variant="outline" size="sm" onClick={() => onRestore(r.file, r.storeName)}>{t('restore')}</Button> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  )
}
