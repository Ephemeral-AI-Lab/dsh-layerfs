import { useMemo, useState, type ReactNode } from 'react'
import { Button, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { ProjectFiles } from '../files/ProjectFiles.tsx'
import { ProjectHistory } from '../files/ProjectHistory.tsx'
import type { Translate } from '../files/types.ts'
import { messageOf, type ProjectRow } from '../picker/NewProjectForm.tsx'
import { Card, Fact, Facts, Page, PageHead, Section, type CrumbStep } from '../ui/index.tsx'
import type { Query } from '../files/use-query.ts'
import type { MachinesView } from '../machines/model.ts'
import { projectAvailability } from './availability.ts'
import { MachineStatus } from './MachineStatus.tsx'
import { openMachineHome } from './navigation.ts'
import type { ProjectsT } from './locale.ts'
import { ProjectSessions } from './ProjectSessions.tsx'
import css from './projects.module.css'

export function ProjectHome({ api, project, machines, t, tf, reload, crumbs }: {
  api: LayerfsApi, project: ProjectRow, machines: Query<MachinesView>, t: ProjectsT, tf: Translate, reload: () => void, crumbs?: readonly CrumbStep[],
}): ReactNode {
  const filesApi = useMemo<LayerfsApi>(() => ({ ...api, call: (method, path, body) => {
    const scope = `/api/projects/${enc(project.key)}`
    const scoped = project.projectId && (path === scope || path.startsWith(`${scope}/`) || path.startsWith(`${scope}?`))
      ? `${path}${path.includes('?') ? '&' : '?'}projectId=${enc(project.projectId)}` : path
    return api.call(method, scoped, body)
  } }), [api, project.key, project.projectId])
  const [tab, setTab] = useState<'overview' | 'files' | 'history'>('overview')
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [file, setFile] = useState<{ branch: string, pin: string, path: string } | undefined>()
  const observed = projectAvailability(project, machines.data, machines.error)
  const availability = starting ? { ...observed, state: 'starting' as const, canStart: false, canRun: false } : observed
  const name = project.name ?? project.key.split('/').slice(1).join('/')
  const refresh = () => { machines.reload(); reload(); setTick((n) => n + 1) }
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await work() } catch (error) { setError(messageOf(error)) }
    finally { setBusy(false); refresh() }
  }
  const start = () => act(async () => {
    setStarting(true)
    try { await api.call('POST', `/api/machines/${enc(availability.machine!)}/start`) }
    finally { setStarting(false) }
  })
  const hint = availability.state === 'stopped' ? t('stoppedHint') : availability.state === 'unavailable' ? t('unavailableHint')
    : availability.state === 'checking' ? t('checkingHint') : availability.state !== 'available' ? t('busyHint')
      : availability.storageBlocked ? t('storageBlocked', { state: project.storeState ?? t('unknown') }) : null
  const tabs = ['overview', 'files', 'history'] as const
  return <Page label={name} wide={tab !== 'overview'}>
    <PageHead title={name} crumbs={crumbs} current={name} intro={project.store ?? project.key.split('/')[0]}
      badge={<MachineStatus value={availability} t={t} />}
      actions={<>
        <Button variant="outline" size="sm" onClick={refresh}>{t('refresh')}</Button>
        {availability.canStart ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void start()}>{t('startMachine')}</Button> : null}
        <Button variant="primary" size="sm" disabled={busy || !availability.canRun || machines.loading} onClick={() => void act(() => api.openProjectSession(project.key, undefined, project.projectId))}>{t('newSession')}</Button>
      </>} />
    {hint ? <Card tone={availability.state === 'unavailable' ? 'danger' : undefined}>
      <div className={css.notice} role="status">
        <div>{hint}</div>
        {project.catalogState && project.catalogState !== 'available' ? <div className={css.reason}>{t('retentionHint')}</div> : null}
        {availability.reason ? <div className={css.reason}>{availability.reason}</div> : null}
        <div className={css.actions}>
          <Button variant="outline" size="sm" onClick={() => openMachineHome(api, availability.machine)}>{t('openMachine')}</Button>
          {availability.storageBlocked && availability.state === 'available' ? <Button variant="outline" size="sm" onClick={() => api.openPanel('layerfs-storage')}>{t('openStorage')}</Button> : null}
        </div>
      </div>
    </Card> : null}
    {error ? <div className={css.notice} role="alert">{t('actionFailed', { message: error })}</div> : null}
    <SegmentedTabs size="sm" label={t('overview')} value={tab} onChange={setTab}
      items={tabs.map((value) => ({ value, label: t(value), id: `project-home-${value}`, panelId: `project-home-${value}-panel` })) as [never, ...never[]]} />
    <div role="tabpanel" id={`project-home-${tab}-panel`} aria-labelledby={`project-home-${tab}`} className={tab !== 'overview' ? css.filePanel : undefined}>
      {tab === 'overview' ? <div className={css.list}>
        <Section title={t('basicInfo')}><Card><Facts>
          <Fact label={t('projectKey')} mono>{project.key}</Fact>
          {project.projectId && !project.projectId.startsWith('unclaimed:') ? <Fact label={t('identity')} mono title={project.projectId}>{project.projectId}</Fact> : null}
          <Fact label={t('store')}>{project.store ?? project.key.split('/')[0]}</Fact>
          <Fact label={t('machine')}>{availability.machine ? <Button variant="ghost" size="sm" onClick={() => openMachineHome(api, availability.machine)}>{availability.machine}</Button> : null}</Fact>
          <Fact label={t('storageType')}>{project.kind}</Fact>
          <Fact label={t('created')}>{project.created ? new Date(project.created).toLocaleString() : null}</Fact>
        </Facts></Card></Section>
        <Section title={t('sessions')}><Card><ProjectSessions api={api} project={project.key} projectId={project.projectId} t={t} /></Card></Section>
      </div> : !availability.canRun ? <Card><div className={css.notice}>{t('contentUnavailable')}</div></Card>
        : tab === 'files' ? <ProjectFiles key={file ? `${file.pin}:${file.path}` : project.key} api={filesApi} project={project.key} t={tf} tick={tick} initialBranch={file?.branch} initialPin={file?.pin} initialPath={file?.path} />
          : <ProjectHistory api={filesApi} project={project.key} t={tf} tick={tick} onOpenFile={(branch, path, pin) => { setFile({ branch, path, pin }); setTab('files') }} />}
    </div>
  </Page>
}
