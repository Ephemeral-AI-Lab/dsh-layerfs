/**
 * A SQLite Store's backups (store-backups.ts holds the data).
 *
 * - Backups: every bucket copy of one Store, grouped by provider, the most
 *   urgent first, under a bar of how many need what. Each row offers the one
 *   thing its state calls for: Back up as new file… (missing: LayerFS will not
 *   write over a copy that is gone, so Back up opens on it with a new name),
 *   Update (the Store changed), Restore… (current, or the bucket is newer),
 *   Back up now (not listed yet). The list ends with Back up to another bucket.
 * - Back up: the buckets grouped by provider, each saying what writing there
 *   would do (update a copy, write a missing one again, a new backup). Add a
 *   bucket opens the bucket form and comes back here with the new bucket
 *   chosen. The file name is the link's (or LayerFS's default) unless changed.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Refusal } from '../ui/index.tsx'
import { BucketMark, providerWords } from './BucketPage.tsx'
import type { StorageDialog } from './dialogs.tsx'
import type { StorageT } from './locale.ts'
import { backupChip, listStatusWords } from './model.ts'
import { FormModal, refusalLabels, TextField } from './parts.tsx'
import { actionOf, backupCounts, backupGroups, backupTargets, firstTarget, freshName, storeBackups, type BackupHealth, type StoreBackup } from './store-backups.ts'
import type { StorageView, StoreRow } from './types.ts'
import css from './MachineStores.module.css'
import scss from './Storage.module.css'

const HEALTH: readonly BackupHealth[] = ['problem', 'stale', 'unknown', 'current']

interface Props {
  api: LayerfsApi
  t: StorageT
  view: StorageView | undefined
  onClose: () => void
  done: () => void
  onDialog?: ((dialog: StorageDialog) => void) | undefined
}

/** The bar of a Store's backups by health: what the card's fact summarises. */
export function HealthBar({ backups, t }: { backups: readonly StoreBackup[], t: StorageT }): ReactNode {
  const n = backupCounts(backups)
  return (
    <div className={css.health} role="img" aria-label={t('bkHealth', n)}>
      {HEALTH.filter((h) => n[h] > 0).map((h) => <span key={h} data-health={h} style={{ flex: n[h] }} />)}
    </div>
  )
}

export function BackupsDialog({ api, t, view, onClose, done, onDialog, store }: Props & { store: string }): ReactNode {
  const s = view?.stores.find((x) => x.name === store && x.kind === 'sqlite')
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(undefined)
  // A backup's state comes from its bucket's last listing: list each linked bucket again once per opening (read-only, one call each, in turn).
  const linkedBuckets = s && view ? [...new Set(s.links.map((l) => l.bucket))].filter((b) => view.buckets.some((x) => x.name === b)) : []
  const [listing, setListing] = useState(false)
  useEffect(() => {
    if (!linkedBuckets.length) return
    let live = true
    setListing(true)
    void (async () => {
      for (const b of linkedBuckets) await api.call('GET', `/api/buckets/${enc(b)}/files`).catch(() => undefined)
      if (live) { setListing(false); done() }
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!s || !view) return null
  const now = Date.now()
  const backups = storeBackups(s, view.buckets)
  const groups = backupGroups(backups)
  const blocked = s.state !== 'ready' || !!s.job
  const sub = [
    s.size ? bytes(s.size.bytes) : null,
    backups.length === 1 ? t('bkCountOne') : t('bkCount', { n: backups.length }),
    groups.length ? (groups.length === 1 ? t('bkProviderOne') : t('bkProviders', { n: groups.length })) : null,
  ].filter(Boolean).join(' · ')
  const write = async (b: StoreBackup) => {
    setRunning(b.link.bucket)
    setError(undefined)
    try {
      await api.call('POST', `/api/stores/${enc(s.name)}/backup`, { bucket: b.link.bucket, file: b.link.file })
      done()
      onClose()
    } catch (e) { setError(e) } finally { setRunning(null) }
  }
  const act = (b: StoreBackup): ReactNode => {
    const a = actionOf(b.state)
    if (a === 'again') {
      return <Button size="sm" variant="outline" disabled={blocked || !onDialog} onClick={() => onDialog?.({ kind: 'backup', store: s, pick: b.link.bucket })}>{t('bkAgain')}</Button>
    }
    if (a === 'restore') {
      return <Button size="sm" variant="outline" disabled={s.state === 'busy' || !onDialog} onClick={() => onDialog?.({ kind: 'restore', bucket: b.link.bucket, file: b.link.file, store: s.name })}>{t('restore')}</Button>
    }
    const label = a === 'update' ? t('bkUpdate') : t('backupNow')
    return (
      <Button size="sm" variant="outline" disabled={blocked || running !== null} aria-busy={running === b.link.bucket}
        icon={running === b.link.bucket ? <StateDot state="ongoing" size={12} /> : undefined} onClick={() => { void write(b) }}>{label}</Button>
    )
  }
  return (
    <Modal open onClose={() => { if (!running) onClose() }} title={t('bkTitle', { store: s.name })} description={sub} closeLabel={t('close')} className={scss.modal}>
      <div className={css.servers} data-backups={s.name}>
        {backups.length ? <HealthBar backups={backups} t={t} /> : <p className={css.serverGiven}>{t('bkNone')}</p>}
        {listing ? <p className={css.serverGiven} role="status">{t('bkListing')}</p> : null}
        {groups.map((g) => (
          <div key={g.provider ?? '?'} className={css.server} data-provider={g.provider ?? ''}>
            <div className={css.serverHead}>
              <BucketMark provider={g.provider} size={14} />
              <span className={css.serverName}>{providerWords(g.provider, t)}</span>
              <span>· {g.items.length}</span>
            </div>
            {g.items.map((b) => {
              const bucketRow = view.buckets.find((x) => x.name === b.link.bucket)
              const listErr = bucketRow?.error ? listStatusWords(bucketRow.error.code, t) : bucketRow?.state === 'broken' ? t('bucketRecordBroken') : null
              const chip = listErr ? { tone: 'danger' as const, label: listErr } : backupChip(b.state, t)
              return (
                <div key={b.link.bucket} className={css.db} data-backup={b.link.bucket}>
                  <div className={css.dbMain}>
                    <span className={css.dbName}>{b.link.bucket}</span>
                    <span className={css.dbSub}>
                      <span className={css.pill} data-tone={chip.tone} title={listErr ? (bucketRow?.error?.message ?? bucketRow?.message ?? undefined) : undefined}>{chip.label}</span>
                      <span className={css.mono} title={b.link.file}>{b.link.file}</span>
                      {[b.bytes != null ? bytes(b.bytes) : null, b.at ? ago(b.at, now, t as Translate) : null].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  {act(b)}
                </div>
              )
            })}
          </div>
        ))}
        {error !== undefined ? <Refusal error={error} labels={refusalLabels(t)} /> : null}
        {onDialog ? (
          <button type="button" className={`${css.addRow} ${css.addServer}`} disabled={blocked}
            onClick={() => onDialog(view.buckets.length ? { kind: 'backup', store: s } : { kind: 'bucket', then: { kind: 'backup', store: s, known: [] } })}>
            {t('bkAnother')}
          </button>
        ) : null}
      </div>
    </Modal>
  )
}

export function BackUpDialog({ api, t, view, onClose, done, onDialog, store: s, known, pick }: Props & { store: StoreRow, known?: string[] | undefined, pick?: string | undefined }): ReactNode {
  const groups = view ? backupTargets(s, view) : []
  const [picked, setPicked] = useState<string | null>(pick ?? null)
  const [file, setFile] = useState<string | null>(null)
  const chosen = picked ?? firstTarget(groups, known)
  const target = groups.flatMap((g) => g.items).find((x) => x.bucket.name === chosen)
  const now = Date.now()
  const tt = t as Translate
  const what = (b: StoreBackup | null): string => {
    if (!b) return t('bkNewHere')
    const when = b.at ? ago(b.at, now, tt) : '—'
    switch (actionOf(b.state)) {
      case 'again': return t('bkWritesAgain')
      case 'update': return t('bkUpdates', { when })
      case 'restore': return t('bkAlready', { when })
      default: return t('bkUpdates', { when })
    }
  }
  const linkFile = target?.backup?.link.file
  // A copy that went missing cannot be written again under its name: it starts under a new one.
  const missing = target?.backup?.state === 'missing'
  const shown = file ?? (missing && linkFile ? freshName(linkFile, (target?.bucket.files ?? []).map((f) => f.file)) : null)
  const typed = shown?.trim()
  const reused = missing && typed === linkFile
  return (
    <FormModal open onClose={onClose} t={t} title={t('backupTitle', { store: s.name })}
      description={s.size ? t('bkPick', { size: bytes(s.size.bytes) }) : t('bkPickNoSize')}
      action={chosen ? t('bkBackUpTo', { bucket: chosen }) : t('backup')} valid={!!target && !reused}
      submit={() => api.call('POST', `/api/stores/${enc(s.name)}/backup`, { bucket: chosen, ...(typed ? { file: typed } : linkFile ? { file: linkFile } : {}) }).then(done)}>
      <div className={css.servers} role="radiogroup" aria-label={t('bucket')}>
        {groups.map((g) => (
          <div key={g.provider ?? '?'} className={css.server} data-provider={g.provider ?? ''}>
            <div className={css.serverHead}>
              <BucketMark provider={g.provider} size={14} />
              <span className={css.serverName}>{providerWords(g.provider, t)}</span>
            </div>
            {g.items.map(({ bucket, backup }) => {
              const on = bucket.name === chosen
              const chip = backup?.state ? backupChip(backup.state, t) : null
              return (
                <button key={bucket.name} type="button" role="radio" aria-checked={on} className={css.pick} data-bucket={bucket.name}
                  onClick={() => { setPicked(bucket.name); setFile(null) }}>
                  <span className={css.radio} data-on={on} aria-hidden="true" />
                  <span className={css.dbMain}>
                    <span className={css.dbName}>{bucket.name}</span>
                    <span className={css.dbSub}>{what(backup)}</span>
                  </span>
                  {chip ? <span className={css.pill} data-tone={chip.tone}>{chip.label}</span> : null}
                </button>
              )
            })}
          </div>
        ))}
        {onDialog ? (
          <button type="button" className={`${css.addRow} ${css.addServer}`}
            onClick={() => onDialog({ kind: 'bucket', then: { kind: 'backup', store: s, known: (view?.buckets ?? []).map((b) => b.name) } })}>
            {t('bkAddBucket')}
          </button>
        ) : null}
      </div>
      {shown === null
        ? (
          <p className={css.fileLine}>
            <span>{t('bkFile')}</span>
            <span className={css.mono}>{linkFile ?? s.name}</span>
            <button type="button" className={css.textButton} onClick={() => setFile(linkFile ?? '')}>{t('bkChange')}</button>
          </p>
        )
        : <TextField label={t('fileName')} value={shown} onChange={setFile} mono autoFocus={file !== null} placeholder={linkFile ?? s.name} error={reused ? t('bkSameName') : null} hint={missing ? t('bkNewNameHint') : t('fileNameHint')} />}
    </FormModal>
  )
}
