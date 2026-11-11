/**
 * The board's Backups tab: every connected bucket with the Store files it
 * holds, the Store linked to each, their state, size and when written, and
 * the move each needs (Back up now, Restore…). Before a bucket is listed its
 * rows come from the Stores' links alone.
 */
import { useEffect, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, IconRefreshOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, Empty, LinkButton, MoreMenu, Notice, Section, StateChip } from '../ui/index.tsx'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StorageT } from './locale.ts'
import { backupChip, placeWords } from './model.ts'
import { BucketGlyph } from './parts.tsx'
import type { BackupState, BucketRow, StorageView, StoreBackupLink, StoreRow } from './types.ts'
import css from './Storage.module.css'

interface FileRowData {
  file: string
  store: StoreRow | null
  storeName: string | null
  state: BackupState | null
  bytes: number | null
  modified: number | null
  reason: string | null
  link: StoreBackupLink | null
}

function rowsOf(b: BucketRow, stores: readonly StoreRow[]): FileRowData[] {
  const byName = new Map(stores.map((s) => [s.name, s]))
  const linkOf = (s: StoreRow | undefined, file: string) => s?.links.find((l) => l.bucket === b.name && l.file === file) ?? null
  const rows: FileRowData[] = b.files
    ? b.files.map((f) => ({ file: f.file, store: (f.store && byName.get(f.store)) || null, storeName: f.store, state: f.state, bytes: f.bytes, modified: f.modified, reason: f.reason, link: linkOf(f.store ? byName.get(f.store) : undefined, f.file) }))
    : stores.flatMap((s) => s.links.filter((l) => l.bucket === b.name).map((l) => ({ file: l.file, store: s, storeName: s.name, state: null, bytes: l.last?.bytes ?? null, modified: null, reason: null, link: l })))
  return rows.sort((x, y) => x.file.localeCompare(y.file) || (x.storeName ?? '').localeCompare(y.storeName ?? ''))
}

export interface BackupsProps {
  view: StorageView
  t: StorageT
  now: number
  listing: string | null
  listingAll: boolean
  onList: (bucket: string) => void
  onListAll: () => void
  onRestore: (bucket: string, file: string, store: string | null) => void
  onBackup: (store: string, bucket: string, file: string) => void
  onAdd: () => void
  onDisconnect: (bucket: string) => void
  onOpenStore: (name: string) => void
}

export function StorageBackups({ view, t, now, listing, listingAll, onList, onListAll, onRestore, onBackup, onAdd, onDisconnect, onOpenStore }: BackupsProps): ReactNode {
  // backup.list asks each bucket: once when the tab opens, then on List.
  useEffect(() => { if (view.buckets.length) onListAll() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const buckets = [...view.buckets].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <>
      <div className={css.tabBar}>
        <span />
        <span className={css.tabBarActions}>
          {buckets.length ? <Button variant="outline" size="sm" disabled={listingAll} onClick={onListAll} icon={listingAll ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={13} />}>{t('listAll')}</Button> : null}
          <Button variant="outline" size="sm" onClick={onAdd} icon={<IconPlusOutlineRegular size={13} />}>{t('addBucket')}</Button>
        </span>
      </div>
      {buckets.length === 0 ? (
        <Empty title={t('noBuckets')} icon={<BucketGlyph size={20} />}>{t('noBucketsBody')}</Empty>
      ) : buckets.map((b) => (
        <BucketSection key={b.name} bucket={b} stores={view.stores} t={t} now={now} listing={listingAll || listing === b.name}
          onList={() => onList(b.name)} onRestore={(file, store) => onRestore(b.name, file, store)} onBackup={(store, file) => onBackup(store, b.name, file)}
          onDisconnect={() => onDisconnect(b.name)} onOpenStore={onOpenStore} />
      ))}
    </>
  )
}

function BucketSection({ bucket: b, stores, t, now, listing, onList, onRestore, onBackup, onDisconnect, onOpenStore }: {
  bucket: BucketRow, stores: readonly StoreRow[], t: StorageT, now: number, listing: boolean
  onList: () => void, onRestore: (file: string, store: string | null) => void, onBackup: (store: string, file: string) => void, onDisconnect: () => void, onOpenStore: (name: string) => void
}): ReactNode {
  const rows = rowsOf(b, stores)
  const listed = b.files !== null
  const total = (b.files ?? []).reduce((n, f) => n + (f.bytes ?? 0), 0)
  const linked = new Set(rows.flatMap((r) => (r.storeName ? [r.storeName] : []))).size
  const tt = t as Translate
  return (
    <Section title={b.name} count={[
      b.provider === 'r2' ? t('r2') : b.provider === 'minio' ? t('minio') : b.provider,
      listed ? (b.files!.length === 1 ? t('bucketFile', { size: bytes(total) }) : t('bucketFiles', { n: b.files!.length, size: bytes(total) })) : t('bucketNotListed'),
      linked === 1 ? t('bucketLinkedOne') : t('bucketLinked', { n: linked }),
      listing ? t('bucketListing') : b.listed ? t('bucketListed', { ago: ago(b.listed, now, tt) }) : null,
    ].filter(Boolean).join(' · ')} actions={(
      <>
        <Button variant="outline" size="sm" disabled={listing} onClick={onList}>{listed ? t('listAgain') : t('list')}</Button>
        <MoreMenu label={b.name}>{(close) => <MenuItemButton danger onSelect={() => { close(); onDisconnect() }}>{t('disconnectBucket')}</MenuItemButton>}</MoreMenu>
      </>
    )}>
      <Card className={css.tableCard}>
        <p className={css.bucketUrl}>{b.url ?? t('bucketOutside')}</p>
        {b.error ? <Notice tone="danger" className={css.cardNotice}><strong>{t('bucketListFailed')}</strong><span>{b.error.code}: {b.error.message}</span></Notice> : null}
        {rows.length === 0 ? <p className={css.cardEmpty}>{listed ? t('bucketEmptyListed') : listing ? t('bucketListing') : t('bucketEmptyUnlisted')}</p> : (
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
        )}
      </Card>
    </Section>
  )
}
