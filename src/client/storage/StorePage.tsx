/**
 * One Store, laid out like a machine's tab: its head (glyph, name, state,
 * family and place, checks and the Store menu), a strip of facts, alerts and
 * a job in flight, then one card with its projects beside its backups and
 * earlier operations, and the rest folded under Details with removal.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { DoctorAction } from '../doctor/Doctor.tsx'
import type { DoctorT } from '../doctor/locale.ts'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { Card, Empty, Fact, Facts, Notice, PageHead, Section, StateChip } from '../ui/index.tsx'
import { JobList, JobPanel, OpPanel } from './JobProgress.tsx'
import type { StorageT } from './locale.ts'
import { attachmentSignal, attachmentsOf, canAddProject, latestBackup, storeStateWords, storeTone } from './model.ts'
import { StoreGlyph } from './parts.tsx'
import { Location, StoreMenu, storeNotice, type StoreActions } from './StoreCard.tsx'
import type { PgAttachment, ProjectSummary, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './Storage.module.css'

export interface StorePageProps {
  name: string
  view: StorageView
  t: StorageT
  api: LayerfsApi
  doctorT: DoctorT
  now: number
  job: StorageJob | undefined
  jobs: readonly StorageJob[]
  catalog: ReadonlyMap<string, ProjectSummary>
  on: StoreActions | undefined
  onOpenProject: (key: string) => void
}

export function StorePage({ name, view, t, api, doctorT, now, job, jobs, catalog, on, onOpenProject }: StorePageProps): ReactNode {
  const [search, setSearch] = useState('')
  const s = view.stores.find((x) => x.name === name)
  if (!s || !on) return <><PageHead title={name} /><Empty title={t('storeMissing', { name })}>{t('storeMissingBody')}</Empty></>
  const pg = s.kind === 'postgresql'
  const machineState = view.machines.find((m) => m.name === s.machine)?.state
  const notice = storeNotice(s, machineState, t)
  const query = search.trim().toLowerCase()
  const shown = s.projects.filter((p) => p.toLowerCase().includes(query)).sort()
  const tt = t as Translate
  // Jobs are matched by name: drop those of an earlier Store that had it (over
  // before this one was created). A restore that recreated it ends after, so stays.
  const mine = s.created == null ? jobs : jobs.filter((j) => (j.ended ?? Infinity) >= s.created!)
  const current = job && (s.created == null || (job.ended ?? Infinity) >= s.created) ? job : undefined
  const earlier = current ? mine.filter((j) => j.id !== current.id) : mine
  const latest = latestBackup(s)
  const blocked = s.state === 'down' || s.state === 'busy'
  return (
    <>
      <PageHead title={s.name} icon={<StoreGlyph kind={s.kind} size={22} />}
        badge={s.state !== 'idle' ? <StateChip tone={storeTone(s.state)} label={storeStateWords(s.state, t)} live={s.state === 'busy'} /> : undefined}
        intro={(
          <span className={css.cardSub}>
            <span>{pg ? t('postgresql') : t('sqlite')}</span>
            <span className={css.dotSep} aria-hidden="true">·</span>
            <Location store={s} t={t} onMachine={on.openMachine} />
          </span>
        )}
        actions={(
          <>
            <DoctorAction api={api} t={doctorT} target="store.integrity" name={s.name} label={doctorT('checkIntegrity')} />
            {pg ? <DoctorAction api={api} t={doctorT} target="store.connection" name={s.name} label={doctorT('testConnection')} /> : null}
            <StoreMenu store={s} on={on} t={t} />
          </>
        )} />

      <dl className={css.factStrip} aria-label={t('storeFacts')}>
        {pg ? (
          <>
            <div><dt>{t('factServer')}</dt><dd className={css.mono} title={s.postgresql?.target ?? undefined}>{s.postgresql?.target ?? '—'}</dd></div>
            <div><dt>{t('factReachable')}</dt><dd>{s.postgresql?.reachable == null ? t('unknown') : s.postgresql.reachable ? t('yes') : t('no')}</dd></div>
            {s.postgresql?.version ? <div><dt>{t('factVersion')}</dt><dd>{s.postgresql.version}</dd></div> : null}
          </>
        ) : (
          <>
            <div><dt>{t('factSize')}</dt><dd title={s.size ? `${bytes(s.size.file)} + WAL ${bytes(s.size.wal)}` : undefined}>{s.size ? bytes(s.size.bytes) : t('sizeUnavailable')}</dd></div>
            <div><dt>{t('factLastBackup')}</dt><dd title={latest !== null ? when(latest) : undefined}>{latest !== null ? ago(latest, now, tt) : t('noBackup')}</dd></div>
          </>
        )}
        {s.created != null ? <div><dt>{t('factCreated')}</dt><dd title={when(s.created)}>{ago(s.created, now, tt)}</dd></div> : null}
        <div><dt>{t('factHolders')}</dt><dd>{String(s.holders)}</dd></div>
      </dl>

      {notice ? (
        <Notice tone="danger" role="alert">
          <span>{notice}</span>
          {s.kind === 'sqlite' && machineState === 'stopped' ? <Button variant="outline" size="sm" onClick={on.start}>{t('startMachine', { machine: s.machine ?? '' })}</Button> : null}
        </Notice>
      ) : null}
      {current ? <JobPanel job={current} t={t} onRetry={() => on.retry(current)} onDismiss={() => on.dismiss(current)} /> : s.state === 'busy' && s.op ? <OpPanel store={s} t={t} /> : null}
      {pg ? <PgMachines store={s} view={view} t={t} now={now} on={on} /> : null}

      <Card className={css.storeBoard}>
        <section className={css.storePane} aria-label={t('tabProjects')}>
          <header className={css.paneHead}>
            <h2 className={css.paneTitle}>{t('tabProjects')}</h2>
            <span className={css.paneCount}>{s.projects.length}</span>
            <span className={css.paneSpacer} />
            {s.projects.length > 4 ? (
              <Input className={css.paneSearch} icon={<IconSearchOutlineRegular size={13} />} placeholder={t('searchProjects')} aria-label={t('searchProjects')}
                value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.preventDefault(); setSearch('') } }} />
            ) : null}
            <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!canAddProject(s)} onClick={on.addProject}>{t('addProject')}</Button>
          </header>
          {shown.length ? (
            <ul className={css.paneLines}>
              {shown.map((p) => {
                const key = `${s.name}/${p}`
                const created = catalog.get(key)?.created ?? null
                return (
                  <li key={key}>
                    <button type="button" className={css.paneLine} onClick={() => onOpenProject(key)} aria-label={t('openProject', { name: p })}>
                      <span className={css.paneLineIcon} aria-hidden="true"><LayerfsGlyph size={14} /></span>
                      <span className={css.paneLineName}>{p}</span>
                      <span className={css.paneLineMeta} title={when(created)}>{created ? t('createdAgo', { ago: ago(created, now, tt) }) : ''}</span>
                      <IconChevronRightOutlineRegular size={13} className={css.paneLineChevron} />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className={css.paneEmpty}>{query ? t('noMatchingProjects') : t('noProjects')}</p>
          )}
        </section>

        <div className={css.storeAside}>
          {pg ? null : (
            <section className={css.storePane} aria-label={t('backupsSection')}>
              <header className={css.paneHead}>
                <h2 className={css.paneTitle}>{t('backupsSection')}</h2>
                <span className={css.paneCount}>{s.links.length}</span>
                <span className={css.paneSpacer} />
                <Button variant="outline" size="sm" disabled={blocked} onClick={on.backup}>{view.buckets.length ? t('backupTo') : t('addBucketEllipsis')}</Button>
              </header>
              {s.links.length ? (
                <ul className={css.paneLines}>
                  {s.links.map((link) => {
                    const file = view.buckets.find((b) => b.name === link.bucket)?.files?.find((f) => f.file === link.file && f.store === s.name)
                    const at = file?.modified ?? link.last?.at
                    const size = file?.bytes ?? link.last?.bytes
                    return (
                      <li key={link.bucket} className={css.backupLine}>
                        <span className={css.rowMain}>
                          <span className={`${css.paneLineName} ${css.mono}`}>{link.bucket} / {link.file}</span>
                          <span className={css.rowSub}>{at ? t('lastSaved', { ago: ago(at, now, tt) }) : t('noBackupTime')}{size != null ? ` · ${bytes(size)}` : ''}</span>
                        </span>
                        <Button variant="ghost" size="sm" disabled={blocked} onClick={() => on.backupTo(link)}>{t('backupNow')}</Button>
                        {file ? <Button variant="ghost" size="sm" disabled={s.state === 'busy'} onClick={() => on.restore(link.bucket, link.file)}>{t('restore')}</Button> : null}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className={css.paneEmpty}>{t('noBackupDestinations')}</p>
              )}
            </section>
          )}
          {/* The job in the panel above is not listed again. */}
          {earlier.length || !current ? (
            <section className={css.storePane} aria-label={t('recentOperations')}>
              <header className={css.paneHead}>
                <h2 className={css.paneTitle}>{t('recentOperations')}</h2>
                <span className={css.paneCount}>{earlier.length}</span>
              </header>
              {earlier.length ? <div className={css.paneJobs}><JobList jobs={earlier} t={t} now={now} /></div> : <p className={css.paneEmpty}>{t('recentOperationsNone')}</p>}
            </section>
          ) : null}
        </div>
      </Card>

      <details className={css.storeDetails}>
        <summary className={css.storeDetailsSummary}>
          <IconChevronRightOutlineRegular size={12} className={css.storeDetailsChevron} />
          <span>{t('storeFacts')}</span>
        </summary>
        <div className={css.storeDetailsBody}>
          <Card>
            <Facts>
              {s.created != null ? <Fact label={t('factCreated')}>{when(s.created)}</Fact> : null}
              {!pg ? <Fact label={t('factFile')}>{s.size ? bytes(s.size.file) : null}</Fact> : null}
              {!pg ? <Fact label={t('factWal')}>{s.size ? bytes(s.size.wal) : null}</Fact> : null}
              {pg ? <Fact label={t('factServer')} mono>{s.postgresql?.target}</Fact> : null}
            </Facts>
          </Card>
          <div className={css.dangerRow}>
            <div className={css.dangerText}>
              <p className={css.dangerTitle}>{pg ? t('disconnectStoreTitle') : t('removeStoreTitle')}</p>
              <p className={css.sectionNote}>{pg ? t('disconnectStoreBody') : t('removeStoreBody')}</p>
            </div>
            <Button variant="outline" size="sm" className={css.dangerButton} onClick={pg ? on.disconnect : on.remove}>{pg ? t('disconnect') : t('remove')}</Button>
          </div>
        </div>
      </details>
    </>
  )
}

/** A PostgreSQL Store's machines: each one's connection and last check, with Re-check, Edit and Detach. */
function PgMachines({ store: s, view, t, now, on }: { store: StoreRow, view: StorageView, t: StorageT, now: number, on: StoreActions }): ReactNode {
  const attachable = view.features?.attach === true
  const attached = attachmentsOf(s)
  const refusals = s.attachRefusals ?? []
  const tt = t as Translate
  const place = (m: string) => (m === 'native' ? t('layerfsHome') : m)
  const check = (a: PgAttachment) => {
    if (a.lastError) return <span title={a.lastError.message}>{t('checkFailed')}: {a.lastError.message}</span>
    if (!a.checked) return <span className={css.muted}>{t('notChecked')}</span>
    return t('checked', { version: a.checked.version ?? '?', latency: a.checked.latencyMs ?? '?', ago: a.checked.at ? ago(a.checked.at, now, tt) : '—' })
  }
  return (
    <Section title={t('machinesSection')} count={String(attached.length)}
      actions={attachable ? <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={() => on.attach()}>{t('attachToMachine')}</Button> : undefined}>
      {!attachable || attached.length === 0 || (attached.length === 1 && attached[0]!.machine === 'native') ? (
        <p className={css.sectionNote}>
          {!attachable ? t('attachUnsupported') : attached.length === 0 ? t('notAttachedAnywhere', { store: s.name }) : t('connectedAttached')}
        </p>
      ) : null}
      {attached.length ? (
        <Card className={css.tableCard}>
          <table className={css.table}>
            <thead><tr><th>{t('colMachine')}</th><th>{t('colConnection')}</th><th>{t('colCheck')}</th><th><span className={css.srOnly}>{t('colActions')}</span></th></tr></thead>
            <tbody>
              {attached.map((a) => {
                const signal = attachmentSignal(a, t)
                return (
                  <tr key={a.machine}>
                    <td><span className={css.inline}>{signal ? <StateDot state={signal.state} size={12} /> : <StateDot state="done" size={12} />}{place(a.machine)}</span></td>
                    <td className={a.own ? css.mono : css.muted}>{a.own ? t('ownTarget', { target: a.target ?? '—' }) : t('sameAsHost')}</td>
                    <td className={css.muted}>{check(a)}</td>
                    <td className={css.num}>
                      {attachable ? (
                        <span className={css.inline}>
                          <Button variant="ghost" size="sm" onClick={() => on.recheck(a)}>{t('recheck')}</Button>
                          <Button variant="ghost" size="sm" onClick={() => on.attach(a.machine, a)}>{t('edit')}</Button>
                          <Button variant="ghost" size="sm" onClick={() => on.detach(a.machine)}>{t('detach')}</Button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      ) : null}
      {refusals.map((r) => (
        <Notice key={r.machine} tone="danger">
          <span>{place(r.machine)}: {r.message}</span>
          <Button variant="outline" size="sm" onClick={() => on.attach(r.machine)}>{t('attachAndCheck')}</Button>
        </Notice>
      ))}
    </Section>
  )
}
