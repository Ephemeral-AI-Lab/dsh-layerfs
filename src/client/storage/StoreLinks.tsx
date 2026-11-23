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
import { Card, ExplainedButton } from '../ui/index.tsx'
import { HomeGlyph } from './parts.tsx'
import type { StorageT } from './locale.ts'
import { backupChip, backupStateOf, brokenWords, needsLogin, storeStateWords, storeTip, storeWaitsFor } from './model.ts'
import { formatHostPort } from './pg-fields.tsx'
import { providerWords } from './BucketPage.tsx'
import { StoreAction, type StoreActions } from './StoreCard.tsx'
import type { StorageView, StoreRow } from './types.ts'
import clsx from 'clsx'
import css from './StorePage.module.css'

export function StoreBackups({ store: s, view, t, now, on, runningJob }: { store: StoreRow, view: StorageView, t: StorageT, now: number, on: StoreActions, runningJob?: boolean | undefined }): ReactNode {
  const tt = t as Translate
  const reason = storeWaitsFor(s, t, !!runningJob)
  const busyReason = s.state === 'busy' || !!runningJob || !!s.job ? reason : null
  return (
    <div className={css.stack}>
      <div className={css.toolbar}>
        <span className={css.muted}>{t(s.links.length === 1 ? 'spDestinationOne' : 'spDestinations', { n: String(s.links.length) })}</span>
        <span className={css.spacer} />
        <ExplainedButton variant="outline" size="sm" disabled={reason !== null} disabledReason={reason ?? undefined} onClick={on.backup}>{view.buckets.length ? t('backupTo') : t('addBucketEllipsis')}</ExplainedButton>
      </div>
      {s.links.length ? s.links.map((link) => {
        const bucket = view.buckets.find((b) => b.name === link.bucket)
        const file = bucket?.files?.find((f) => f.file === link.file && f.store === s.name)
        const at = file?.modified ?? link.last?.at
        const size = file?.bytes ?? link.last?.bytes
        const state = backupStateOf(file)
        const chipTone = state ? backupChip(state, t).tone : undefined
        const tone = chipTone === 'success' ? 'ok' : chipTone === 'danger' ? 'danger' : undefined
        return (
          <Card key={link.bucket} className={css.linkCard} data-backup-link={link.bucket}>
            <div className={css.linkHead}>
              <span className={css.linkName}>{link.bucket}</span>
              <span className={css.mono}>{link.file}</span>
              <span className={css.spacer} />
              {state ? <span className={css.statePill} data-tone={tone} title={file?.message ?? undefined}>{backupChip(state, t).label}</span> : null}
            </div>
            <dl className={css.linkFacts}>
              <div><dt>{t('spLastSaved')}</dt><dd title={when(at)}>{at ? ago(at, now, tt) : t('noBackupTime')}</dd></div>
              <div><dt>{t('factSize')}</dt><dd>{size != null ? bytes(size) : '—'}</dd></div>
              {bucket?.provider ? <div><dt>{t('spProvider')}</dt><dd>{providerWords(bucket.provider, t)}</dd></div> : null}
            </dl>
            <div className={css.linkActions}>
              <ExplainedButton variant="outline" size="sm" disabled={reason !== null} disabledReason={reason ?? undefined} onClick={() => on.backupTo(link)}>{t('backupNow')}</ExplainedButton>
              {file ? <ExplainedButton variant="ghost" size="sm" disabled={busyReason !== null} disabledReason={busyReason ?? undefined} onClick={() => on.restore(link.bucket, link.file)}>{t('restore')}</ExplainedButton> : null}
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
  const reachFailed = !broken && checked?.ok === false
  const authRecord = pg?.auth ? view.auths?.find((a) => a.auth === pg.auth) : undefined
  const loginDisplay = pg?.auth ? (authRecord?.user ? `${pg.auth} (${authRecord.user})` : pg.auth) : t('pgNoLogin')
  const editLabel = needsLogin(s) ? t('fixRunSaveLogin') : t('pgEditConnectionMenu')
  return (
    <div className={css.stack}>
      <Card className={css.linkCard} data-tone={broken ? 'danger' : undefined} data-connection={s.name}>
        <div className={css.linkHead}>
          <span className={css.linkName}>{t('pgDatabase')}</span>
          <span className={css.mono} title={pg?.binding ? t('pgDatabaseIdTip', { id: pg.binding.slice(0, 8) }) : undefined}>{server}</span>
        </div>
        <dl className={css.linkFacts}>
          <div><dt>{t('pgLogin')}</dt><dd className={pg?.auth ? css.mono : undefined}>{loginDisplay}</dd></div>
          <div><dt>{t('pgDatabaseIdLabel')}</dt><dd className={css.mono} title={t('pgDatabaseIdTip', { id: pg?.binding?.slice(0, 8) ?? '—' })}>{pg?.binding?.slice(0, 8) ?? '—'}</dd></div>
          <div><dt>{t('syncCommit')}</dt><dd>{pg?.synchronousCommit ?? t('syncCommitDefault')}</dd></div>
        </dl>
        <div className={css.linkCheck} data-state={broken || reachFailed ? 'failed' : undefined}>
          <StateDot state={broken || reachFailed ? 'error' : s.state === 'ready' ? 'done' : 'idle'} size={10} />
          <span className={css.linkPart} title={broken ? storeTip(s, t) : reachFailed ? checked?.error ?? undefined : undefined}>
            {broken ? brokenWords(s, t) : reachFailed ? t('pgNotReachedCard') : storeStateWords(s.state, t)}
          </span>
          {checked?.at ? <span className={clsx(css.linkPart, css.muted)}>{t('pgCheckedAgo', { when: ago(checked.at, now, tt) })}</span> : null}
          {checked?.ok && checked.version ? <span className={clsx(css.linkPart, css.muted)}>{t('msPgShort', { version: checked.version.split(' ')[0]! })}</span> : null}
          {checked?.ok && checked.latencyMs != null ? <span className={clsx(css.linkPart, css.muted)}>{t('msReachableMs', { latency: checked.latencyMs })}</span> : null}
        </div>
        <div className={css.linkActions}>
          {broken ? <StoreAction store={s} t={t} /> : null}
          <Button variant="ghost" size="sm" aria-label={t('ariaFor', { action: editLabel, name: s.name })} onClick={() => on.editConnection()}>{editLabel}</Button>
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
            const failed = record?.state === 'broken' || c.reached === 'failed'
            const stopped = record?.state === 'stopped'
            const state = failed ? 'error' : stopped ? 'idle' : c.reached === 'ok' ? 'done' : 'idle'
            const ownServer = c.own && c.server?.host ? formatHostPort(c.server.host, c.server.port) : null
            return (
              <li key={c.machine ?? '(here)'} className={css.connRow} data-conn={name} data-reached={c.reached ?? 'none'}>
                <span className={css.connIdentity}>
                  {mark(name)}
                  <span className={css.connName}>{place(name)}</span>
                  {stopped ? <span className={css.connTag}>{t('pgMachineStoppedShort')}</span> : null}
                </span>
                <span className={css.connAddr} title={c.url ?? undefined}>
                  {c.own ? (
                    <>
                      <span>{t('pgOwnAddressShort')}</span>
                      {ownServer ? <span className={css.mono}>{ownServer}</span> : null}
                    </>
                  ) : t('pgDefaultAddress')}
                </span>
                <span className={css.connReach} title={reach?.ok === false ? (reach.error ?? t('pgCheckFailed')) : undefined}>
                  <StateDot state={state} size={9} />
                  {reach ? (reach.ok ? (reach.latencyMs != null ? t('msReachableMs', { latency: reach.latencyMs }) : t('pgReached')) : t('pgCheckFailed')) : t('pgNotChecked')}
                </span>
                <span className={css.muted}>{reach?.at ? ago(reach.at, now, tt) : ''}</span>
                {boxes ? <span className={css.muted}>{t(boxes === 1 ? 'pgSandboxOne' : 'pgSandboxes', { n: boxes })}</span> : null}
                <span className={css.spacer} />
                <span className={css.connActions}>
                  <Button variant="ghost" size="sm" aria-label={t('ariaForOn', { action: t('pgCheck'), name: place(name), store: s.name })} onClick={() => on.check(c.machine ?? undefined)}>{t('pgCheck')}</Button>
                  {c.machine && c.own ? <Button variant="ghost" size="sm" aria-label={t('ariaForOn', { action: t('edit'), name: place(name), store: s.name })} onClick={() => on.editConnection(c.machine!)}>{t('edit')}</Button> : null}
                  {c.machine && (c.own || reach) ? <Button variant="ghost" size="sm" aria-label={t('ariaForOn', { action: t('pgForget'), name: place(name), store: s.name })} onClick={() => on.removeOwn(c.machine!, c.own)}>{t('pgForget')}</Button> : null}
                </span>
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
