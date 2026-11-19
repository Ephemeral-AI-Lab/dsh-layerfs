/**
 * A Store's third tab. A SQLite Store's Backups: one card per bucket copy it
 * is linked to, with when it was saved, its size and state, Back up now and
 * Restore. A PostgreSQL Store's Connection: its one connection, where its
 * sessions run, and the machines that dial a connection of their own.
 */
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { MachineGlyph } from '../machines/icons.tsx'
import { Card } from '../ui/index.tsx'
import { HomeGlyph } from './parts.tsx'
import type { StorageT } from './locale.ts'
import { backupStateOf, brokenWords, needsLogin, runsOnOf, storeStateWords, storeTip, type BackupState } from './model.ts'
import type { StoreActions } from './StoreCard.tsx'
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
 * A PostgreSQL Store's Connection: the one connection every machine dials
 * (URL, saved login, synchronous_commit) with Edit and Check from a
 * machine, and where its sessions run. A machine is listed only when it
 * dials a connection of its own, with Check, Edit and Remove.
 */
export function StoreConnection({ store: s, view, t, on }: { store: StoreRow, view: StorageView, t: StorageT, on: StoreActions }): ReactNode {
  const pg = s.postgresql
  const own = s.ownConnections ?? []
  const runsOn = runsOnOf(s)
  const place = (m: string) => (m === 'native' ? t('layerfsHome') : m)
  const platformOf = (m: string) => view.machines.find((x) => x.name === m)?.platform ?? (m === 'native' ? 'native' : 'unknown')
  const mark = (m: string) => <span className={css.linkMark} aria-hidden="true">{m === 'native' ? <HomeGlyph size={16} /> : <MachineGlyph platform={platformOf(m)} size={16} />}</span>
  // 2.0: a ready Store reached its server; broken with a reason did not (the state word and reason; its fix is the tip)
  const reached = s.state === 'ready' ? true : s.state === 'broken' ? false : null
  return (
    <div className={css.stack}>
      <Card className={css.linkCard} data-tone={reached === false ? 'danger' : undefined} data-connection={s.name}>
        <div className={css.linkHead}>
          <StateDot state={reached === false ? 'error' : reached ? 'done' : 'idle'} size={10} />
          <span className={css.linkName}>{t('connection')}</span>
          <span className={css.mono}>{pg?.target ?? '—'}</span>
        </div>
        <dl className={css.linkFacts}>
          <div><dt>{t('pgUrl')}</dt><dd className={css.mono}>{pg?.url ?? '—'}</dd></div>
          <div><dt>{t('pgPasswordHow')}</dt><dd className={pg?.auth ? css.mono : undefined}>{pg?.auth ? t('pgPasswordSaved', { auth: pg.auth }) : t('pgNoLogin')}</dd></div>
          <div><dt>{t('syncCommit')}</dt><dd>{pg?.synchronousCommit ?? t('syncCommitDefault')}</dd></div>
          <div>
            <dt>{t('spServer')}</dt>
            <dd title={reached === false ? storeTip(s, t) : undefined}>
              {reached === false ? <span className={css.dangerText}>{brokenWords(s, t)}</span>
                : reached ? storeStateWords(s.state, t)
                  : t('unknown')}
            </dd>
          </div>
        </dl>
        <div className={css.linkActions}>
          {/* a Store naming no saved login: Edit is the save-login form, its one action */}
          <Button variant={needsLogin(s) ? 'primary' : 'outline'} size="sm" onClick={() => on.editConnection()}>{needsLogin(s) ? t('fixRunSaveLogin') : t('edit')}</Button>
          <Button variant="ghost" size="sm" onClick={() => on.check()}>{t('pgCheckFrom')}</Button>
        </div>
      </Card>
      <Card className={css.linkCard} data-runs-on={runsOn}>
        <div className={css.linkHead}>
          {mark(runsOn)}
          <span className={css.linkName}>{t('pgRunsOn', { machine: place(runsOn) })}</span>
          <span className={css.spacer} />
          <Button variant="ghost" size="sm" onClick={on.changeRunsOn}>{t('pgRunsOnChange')}</Button>
        </div>
        <p className={css.linkCheck}>{t('pgRunsOnHint')}</p>
      </Card>
      {own.length ? <p className={css.muted}>{t('pgOwnHeading')}</p> : null}
      {own.map((c) => (
        <Card key={c.machine} className={css.linkCard} data-own-connection={c.machine}>
          <div className={css.linkHead}>
            {mark(c.machine)}
            <span className={css.linkName}>{place(c.machine)}</span>
            <span className={css.mono}>{c.url ? c.target ?? c.url : t('pgOwnPasswordOnly')}</span>
          </div>
          <dl className={css.linkFacts}>
            <div><dt>{t('pgPasswordHow')}</dt><dd>{t('pgOwnStorePassword')}</dd></div>
          </dl>
          <div className={css.linkActions}>
            <Button variant="outline" size="sm" onClick={() => on.check(c.machine)}>{t('cdCheck')}</Button>
            <Button variant="ghost" size="sm" onClick={() => on.editConnection(c.machine)}>{t('edit')}</Button>
            <span className={css.spacer} />
            <Button variant="ghost" size="sm" onClick={() => on.removeOwn(c.machine)}>{t('pgRemoveOwn')}</Button>
          </div>
        </Card>
      ))}
    </div>
  )
}
