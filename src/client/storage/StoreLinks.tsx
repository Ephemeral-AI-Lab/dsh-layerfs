/**
 * A Store's third tab. A SQLite Store's Backups: one card per bucket copy it
 * is linked to, with when it was saved, its size and state, Back up now and
 * Restore. A PostgreSQL Store's Connection: its database, and every machine
 * that connects to it (spec v23).
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { MachineGlyph } from '../machines/icons.tsx'
import { Card, ExplainedButton, LinkButton } from '../ui/index.tsx'
import { HomeGlyph } from './parts.tsx'
import type { StorageT } from './locale.ts'
import { backupChip, backupStateOf, brokenWords, listStatusWords, reconnectOf, storeStateWords, storeTip, storeWaitsFor, type Reconnect } from './model.ts'
import { BucketMark, providerWords } from './BucketPage.tsx'
import { StoreAction, type StoreActions } from './StoreCard.tsx'
import type { TabId } from './tabs.ts'
import type { StorageView, StoreRow } from './types.ts'
import clsx from 'clsx'
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
                  icon={isListing ? <StateDot state="ongoing" size={12} /> : <IconRefreshOutlineRegular size={12} />}>
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
          <span className={css.linkPart} title={broken ? storeTip(s, t) : undefined}>{broken ? brokenWords(s, t) : storeStateWords(s.state, t)}</span>
          {checked?.at ? <span className={clsx(css.linkPart, css.muted)}>{t('pgCheckedAgo', { when: ago(checked.at, now, tt) })}</span> : null}
          {checked?.ok && checked.version ? <span className={clsx(css.linkPart, css.muted)}>{checked.version.split(' ')[0]}</span> : null}
          {checked?.ok && checked.latencyMs != null ? <span className={clsx(css.linkPart, css.muted)}>{t('msReachableMs', { latency: checked.latencyMs })}</span> : null}
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
