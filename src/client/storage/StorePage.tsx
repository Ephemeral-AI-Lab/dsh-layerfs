/**
 * One Store: its head (identity, location, size, actions, alerts, a job in
 * flight), then on one page its projects, its backups (or the machines using
 * it), recent operations, facts and removal.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { DoctorAction } from '../doctor/Doctor.tsx'
import type { DoctorT } from '../doctor/locale.ts'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, Empty, Fact, Facts, Notice, PageHead, Section, StateChip } from '../ui/index.tsx'
import { JobList, JobPanel, OpPanel } from './JobProgress.tsx'
import type { StorageT } from './locale.ts'
import { canAddProject, storeStateWords, storeTone } from './model.ts'
import { StoreGlyph } from './parts.tsx'
import { StoreMenu, storeNotice, StoreSub, type StoreActions } from './StoreCard.tsx'
import type { ProjectSummary, StorageJob, StorageView } from './types.ts'
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
  return (
    <>
      <PageHead title={s.name} icon={<StoreGlyph kind={s.kind} size={22} />}
        badge={s.state !== 'idle' ? <StateChip tone={storeTone(s.state)} label={storeStateWords(s.state, t)} live={s.state === 'busy'} /> : undefined}
        intro={<StoreSub store={s} t={t} now={now} onMachine={on.openMachine} />}
        actions={(
          <>
            <DoctorAction api={api} t={doctorT} target="store.integrity" name={s.name} label={doctorT('checkIntegrity')} />
            {pg ? <DoctorAction api={api} t={doctorT} target="store.connection" name={s.name} label={doctorT('testConnection')} /> : null}
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={13} />} disabled={!canAddProject(s)} onClick={on.addProject}>{t('addProject')}</Button>
            <StoreMenu store={s} on={on} t={t} />
          </>
        )} />
      {notice ? (
        <Notice tone="danger" role="alert">
          <span>{notice}</span>
          {s.kind === 'sqlite' && machineState === 'stopped' ? <Button variant="outline" size="sm" onClick={on.start}>{t('startMachine', { machine: s.machine ?? '' })}</Button> : null}
        </Notice>
      ) : null}
      {job ? <JobPanel job={job} t={t} onRetry={() => on.retry(job)} onDismiss={() => on.dismiss(job)} /> : s.state === 'busy' && s.op ? <OpPanel store={s} t={t} /> : null}
      <Section title={t('tabProjects')} count={String(s.projects.length)}
        actions={s.projects.length > 0 ? (
          <Input className={css.search} icon={<IconSearchOutlineRegular size={14} />} placeholder={t('searchProjects')} aria-label={t('searchProjects')}
            value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.preventDefault(); setSearch('') } }} />
        ) : undefined}>
        {shown.length ? (
          <Card className={css.tableCard}>
            <table className={css.table}>
              <thead><tr><th>{t('colProject')}</th><th className={css.num}>{t('colCreated')}</th><th><span className={css.srOnly}>{t('openProject', { name: '' })}</span></th></tr></thead>
              <tbody>
                {shown.map((p) => {
                  const key = `${s.name}/${p}`
                  const created = catalog.get(key)?.created ?? null
                  return (
                    <tr key={key} className={css.rowLink} onClick={() => onOpenProject(key)}>
                      <td><button type="button" className={css.rowButton} onClick={(e) => { e.stopPropagation(); onOpenProject(key) }}>{p}</button></td>
                      <td className={`${css.num} ${css.muted}`} title={when(created)}>{created ? ago(created, now, tt) : '—'}</td>
                      <td className={css.chevronCell}><IconChevronRightOutlineRegular size={14} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        ) : (
          <p className={css.sectionNote}>{query ? t('noMatchingProjects') : t('noProjects')}</p>
        )}
      </Section>
      {pg ? null : (
        <Section title={t('backupsSection')} count={String(s.links.length)} actions={<Button variant="outline" size="sm" disabled={s.state === 'down' || s.state === 'busy'} onClick={on.backup}>{t('backupTo')}</Button>}>
          <p className={css.sectionNote}>{t('backupsNote')}</p>
          {s.links.length ? (
            <Card className={css.tableCard}>
              <ul className={css.rows}>
                {s.links.map((link) => {
                  const file = view.buckets.find((b) => b.name === link.bucket)?.files?.find((f) => f.file === link.file && f.store === s.name)
                  const at = file?.modified ?? link.last?.at
                  const size = file?.bytes ?? link.last?.bytes
                  return (
                    <li key={link.bucket} className={css.row}>
                      <span className={css.rowMain}>
                        <span className={`${css.rowTitle} ${css.mono}`}>{link.bucket} / {link.file}</span>
                        <span className={css.rowSub}>{at ? t('lastSaved', { ago: ago(at, now, tt) }) : t('noBackupTime')}{size != null ? ` · ${bytes(size)}` : ''}</span>
                      </span>
                      <Button variant="ghost" size="sm" disabled={s.state === 'down' || s.state === 'busy'} onClick={() => on.backupTo(link)}>{t('backupNow')}</Button>
                      {file ? <Button variant="ghost" size="sm" disabled={s.state === 'busy'} onClick={() => on.restore(link.bucket, link.file)}>{t('restore')}</Button> : null}
                    </li>
                  )
                })}
              </ul>
            </Card>
          ) : <p className={css.sectionNote}>{t('noBackupDestinations')}</p>}
        </Section>
      )}
      <Section title={t('recentOperations')} count={String(jobs.length)}>
        {jobs.length ? <Card className={css.tableCard}><JobList jobs={jobs} t={t} now={now} /></Card> : <p className={css.sectionNote}>{t('recentOperationsNone')}</p>}
      </Section>
      <Section title={t('storeFacts')}>
        <Card>
          <Facts>
            <Fact label={t('factType')}>{pg ? t('postgresql') : t('sqlite')}</Fact>
            <Fact label={t('factLocation')} mono={pg}>{pg ? s.postgresql?.target : s.machine === 'native' ? t('layerfsHome') : s.machine}</Fact>
            {s.created != null ? <Fact label={t('factCreated')}>{when(s.created)}</Fact> : null}
            {!pg ? <Fact label={t('factFile')}>{s.size ? bytes(s.size.file) : null}</Fact> : null}
            {!pg ? <Fact label={t('factWal')}>{s.size ? bytes(s.size.wal) : null}</Fact> : null}
            {pg ? <Fact label={t('factReachable')}>{s.postgresql?.reachable == null ? t('unknown') : s.postgresql.reachable ? t('yes') : t('no')}</Fact> : null}
            {pg && s.postgresql?.version ? <Fact label={t('factVersion')}>{s.postgresql.version}</Fact> : null}
            <Fact label={t('factHolders')}>{String(s.holders)}</Fact>
          </Facts>
        </Card>
      </Section>
      <Card tone="danger" className={css.danger}>
        <div className={css.dangerText}>
          <p className={css.dangerTitle}>{pg ? t('disconnectStoreTitle') : t('removeStoreTitle')}</p>
          <p className={css.sectionNote}>{pg ? t('disconnectStoreBody') : t('removeStoreBody')}</p>
        </div>
        <Button variant="outline" size="sm" className={css.dangerButton} onClick={pg ? on.disconnect : on.remove}>{pg ? t('disconnect') : t('remove')}</Button>
      </Card>
    </>
  )
}
