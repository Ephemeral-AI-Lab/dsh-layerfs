/**
 * A SQLite Store's Backups tab: one card per bucket copy it is linked to,
 * with when it was saved, its size and state, Back up now and Restore.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../ui/StatusDot.tsx'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, ExplainedButton, LinkButton } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { backupChip, backupStateOf, listStatusWords, reconnectOf, storeWaitsFor, type Reconnect } from './model.ts'
import { BucketMark, providerWords } from './BucketPage.tsx'
import type { StoreActions } from './StoreCard.tsx'
import type { TabId } from './tabs.ts'
import type { StorageView, StoreRow } from './types.ts'
import css from './StorePage.module.css'

export function StoreBackups({ store: s, view, t, now, on, runningJob, onOpen, onListBucket, listingBucket, onReconnect }: {
  store: StoreRow
  view: StorageView
  t: StorageT
  now: number
  on: StoreActions
  runningJob?: boolean | undefined
  onOpen?: ((id: TabId) => void) | undefined
  onListBucket?: ((bucket: string) => void | Promise<unknown>) | undefined
  listingBucket?: string | ReadonlySet<string> | null | undefined
  onReconnect?: ((again: Reconnect) => void) | undefined
}): ReactNode {
  const tt = t as Translate
  const reason = storeWaitsFor(s, t, !!runningJob)
  const busyReason = s.state === 'busy' || !!runningJob || !!s.job ? reason : null
  const isBucketListing = (name: string) => listingBucket === '*' || (typeof listingBucket === 'string' ? listingBucket === name : !!listingBucket?.has(name))
  const autoListed = useRef(new Set<string>())
  const mounted = useRef(true)
  const storeRef = useRef(s.name)
  storeRef.current = s.name
  const listRef = useRef(onListBucket)
  listRef.current = onListBucket
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const pendingKey = onListBucket
    ? s.links
      .map((l) => l.bucket)
      .filter((name, i, arr) => arr.indexOf(name) === i)
      .filter((name) => {
        if (isBucketListing(name)) return false
        const b = view.buckets.find((x) => x.name === name)
        return !!b && b.files === null && !b.error && !autoListed.current.has(`${s.name}:${name}`)
      })
      .join('\0')
    : ''
  useEffect(() => {
    if (!pendingKey) return
    const storeName = s.name
    const names = pendingKey.split('\0')
    for (const name of names) autoListed.current.add(`${storeName}:${name}`)
    void (async () => {
      for (const name of names) {
        if (!mounted.current || storeRef.current !== storeName) break
        await listRef.current?.(name)
      }
    })()
  }, [s.name, pendingKey])
  return (
    <div className={css.stack}>
      <div className={css.toolbar}>
        <span className={css.muted}>{t(s.links.length === 1 ? 'spDestinationOne' : 'spDestinations', { n: String(s.links.length) })}</span>
        <span className={css.spacer} />
        <ExplainedButton variant="outline" size="sm" disabled={reason !== null} disabledReason={reason ?? undefined} onClick={on.backup}>{view.buckets.length ? t('backupTo') : t('addBucketEllipsis')}</ExplainedButton>
      </div>
      {s.links.length ? s.links.map((link) => {
        const bucket = view.buckets.find((b) => b.name === link.bucket)
        const listed = bucket?.files !== null && bucket?.files !== undefined
        const file = bucket?.files?.find((f) => f.file === link.file && f.store === s.name)
        const at = file?.modified ?? link.last?.at
        const size = file?.bytes ?? link.last?.bytes
        const state = backupStateOf(file)
        const err = bucket?.error ?? null
        const listErr = err ? listStatusWords(err.code, t) : bucket?.state === 'broken' ? t('bucketRecordBroken') : null
        const again = bucket && err ? reconnectOf(bucket) : null
        const isListing = isBucketListing(link.bucket)
        const chip = listErr
          ? { label: listErr, tone: 'danger' as const, dashed: false, tip: err?.message ?? bucket?.message ?? bucket?.fix ?? undefined }
          : (() => {
            const c = backupChip(state, t)
            const tone = c.tone === 'success' ? 'ok' as const : c.tone === 'danger' ? 'danger' as const : undefined
            return { label: c.label, tone, dashed: !!c.dashed, tip: file?.message ?? undefined }
          })()
        const canOpenFile = !!onOpen && listed && state !== 'missing'
        const pickNew = () => (on.backupPick ? on.backupPick(link.bucket) : on.backup())
        return (
          <Card key={link.bucket} className={css.linkCard} data-backup-link={link.bucket}>
            <div className={css.linkHead}>
              <span className={css.linkMark} aria-hidden="true"><BucketMark provider={bucket?.provider} size={15} /></span>
              {onOpen
                ? <LinkButton className={css.linkName} onClick={() => onOpen(`bucket:${link.bucket}`)}>{link.bucket}</LinkButton>
                : <span className={css.linkName}>{link.bucket}</span>}
              {canOpenFile
                ? <LinkButton className={css.mono} onClick={() => onOpen!(`backup:${link.bucket}/${link.file}`)}>{link.file}</LinkButton>
                : <span className={css.mono}>{link.file}</span>}
              <span className={css.spacer} />
              <span className={css.statePill} data-tone={chip.tone} data-dashed={chip.dashed || undefined} title={chip.tip}>{chip.label}</span>
            </div>
            <dl className={css.linkFacts}>
              <div><dt>{t('spLastSaved')}</dt><dd title={when(at)}>{at ? ago(at, now, tt) : t('noBackupTime')}</dd></div>
              <div><dt>{t('factSize')}</dt><dd>{size != null ? bytes(size) : '—'}</dd></div>
              {bucket?.provider ? <div><dt>{t('spProvider')}</dt><dd>{providerWords(bucket.provider, t)}</dd></div> : null}
            </dl>
            <div className={css.linkActions}>
              {err && again && onReconnect ? (
                <Button variant="outline" size="sm" onClick={() => onReconnect(again)}>{t('connectAgain')}</Button>
              ) : state === 'missing' ? (
                <ExplainedButton variant="outline" size="sm" disabled={reason !== null} disabledReason={reason ?? undefined} onClick={pickNew}>{t('bkAgain')}</ExplainedButton>
              ) : state === 'both_changed' ? (
                <>
                  <ExplainedButton variant="outline" size="sm" disabled={reason !== null} disabledReason={reason ?? undefined} onClick={pickNew}>{t('bkAgain')}</ExplainedButton>
                  <ExplainedButton variant="ghost" size="sm" disabled={busyReason !== null} disabledReason={busyReason ?? undefined} onClick={() => on.restore(link.bucket, link.file)}>{t('restore')}</ExplainedButton>
                </>
              ) : state === 'bucket_changed' ? (
                <>
                  <ExplainedButton variant="outline" size="sm" disabled={busyReason !== null} disabledReason={busyReason ?? undefined} onClick={() => on.restore(link.bucket, link.file)}>{t('restore')}</ExplainedButton>
                  <ExplainedButton variant="ghost" size="sm" disabled={reason !== null} disabledReason={reason ?? undefined} onClick={pickNew}>{t('bkAgain')}</ExplainedButton>
                </>
              ) : (
                <>
                  <ExplainedButton variant="outline" size="sm" disabled={reason !== null} disabledReason={reason ?? undefined} onClick={() => on.backupTo(link)}>{t('backupNow')}</ExplainedButton>
                  {listed && file ? (
                    <ExplainedButton variant="ghost" size="sm" disabled={busyReason !== null} disabledReason={busyReason ?? undefined} onClick={() => on.restore(link.bucket, link.file)}>{t('restore')}</ExplainedButton>
                  ) : !listed ? (
                    <ExplainedButton variant="ghost" size="sm" disabled disabledReason={t('spListFirstToRestore')} onClick={() => {}}>{t('restore')}</ExplainedButton>
                  ) : null}
                </>
              )}
              {onListBucket ? (
                <Button variant="ghost" size="sm" className={css.linkListBtn} disabled={isListing} onClick={() => onListBucket(link.bucket)}
                  icon={isListing ? <StatusDot state="ongoing" size={12} /> : <IconRefreshOutlineRegular size={12} />}>
                  {listed ? t('listAgain') : t('listBucket')}
                </Button>
              ) : null}
            </div>
          </Card>
        )
      }) : <Card className={css.panel}><p className={css.muted}>{t('noBackupDestinations')}</p></Card>}
    </div>
  )
}
