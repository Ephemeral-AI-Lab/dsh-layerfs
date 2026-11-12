/** Project catalog and project overview navigation; plain folders stay in DSH. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { listProjects, messageOf, NewProjectForm, remoteMachine, waitProject, type ProjectInitJob, type ProjectRow } from '../picker/NewProjectForm.tsx'
import type { PickerKey } from '../picker/locale.ts'
import { useHostEvents } from '../storage/hooks.ts'
import { useQuery } from '../files/use-query.ts'
import { Card, Empty, Loading, Page, PageHead, Section } from '../ui/index.tsx'
import css from './projects.module.css'
import type { ProjectsT } from './locale.ts'
import { ReadDeadlineError, readWithDeadline } from './read-deadline.ts'
import type { Translate } from '../files/types.ts'
import { useProjectMachines } from './hooks.ts'
import { projectAvailability } from './availability.ts'
import { MachineStatus } from './MachineStatus.tsx'
import { openProjectHome, useProjectSelection } from './navigation.ts'
import { ProjectHome } from './ProjectHome.tsx'

type PickerTranslate<K extends string> = (key: K, params?: Record<string, string | number>) => string

const nameOf = (key: string) => key.split('/')[1] ?? key

export function ProjectsPage({ api, t, tp, tf }: { api: LayerfsApi, t: ProjectsT, tp: PickerTranslate<PickerKey>, tf: Translate }): ReactNode {
  const selected = useProjectSelection(api)
  const machines = useProjectMachines(api)
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [running, setRunning] = useState<{ key: string, error: string | null } | null>(null)

  const read = useQuery(() => readWithDeadline(listProjects(api)), [api])
  useHostEvents(api, ['layerfs-workspaces-changed', 'storage', 'machine-progress', 'connection'], () => read.reload())
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read.reload() }, 15_000)
    return () => clearInterval(timer)
  }, [read.reload])

  const follow = async (job: ProjectInitJob, key: string) => {
    setDialog(null)
    setRunning({ key, error: null })
    try {
      await waitProject(api, job)
      read.reload()
      setRunning(null)
      await api.openProjectSession(key)
    } catch (error) {
      setRunning({ key, error: messageOf(error) })
    }
  }

  const newSession = (project: ProjectRow) => {
    setActionError(null)
    setBusy(project.key)
    void api.openProjectSession(project.key, undefined, project.projectId).catch((error) => setActionError(messageOf(error))).finally(() => setBusy(null))
  }
  const projects = (read.data?.rows ?? []).filter((project) => project.key !== read.data?.scratchKey)

  if (selected) {
    const project = projects.find((p) => (p.projectId ?? p.key) === selected)
    if (project) return <ProjectHome key={selected} api={api} project={project} machines={machines} t={t} tf={tf} reload={read.reload} />
    return <Page label={t('title')}><PageHead title={t('title')} crumbs={[{ label: t('title'), onClick: () => openProjectHome(api, null) }]} />
      <div className={css.notice}>{read.loading ? t('loading') : read.error ? t('loadFailed', { message: messageOf(read.error) }) : t('projectMissing')}</div>
      <Button variant="outline" size="sm" onClick={read.reload}>{t('retry')}</Button></Page>
  }

  return (
    <Page label={t('title')}>
      <PageHead title={t('title')} intro={t('intro')} actions={(
        <>
          <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={() => setDialog('new')}>{t('newEmpty')}</Button>
          <Button variant="outline" size="sm" icon={<IconFolderOpenOutlineRegular size={13} />} onClick={() => setDialog('import')}>{t('importProject')}</Button>
        </>
      )} />
      {actionError ? <div className={css.notice} role="alert">{t('actionFailed', { message: actionError })}</div> : null}
      {running ? (
        <div className={css.emptySessions} role={running.error ? 'alert' : 'status'}>
          {running.error ? t('importFailed', { message: running.error }) : (
            <span className={css.rowMeta}><StateDot state="ongoing" size={12} /> {t('importing', { name: nameOf(running.key) })}</span>
          )}
        </div>
      ) : null}
      {read.loading && !read.data ? <Loading label={t('loading')} />
        : read.error ? (
          <Card tone="danger">
            <div className={css.emptySessions} role="alert">{t('loadFailed', { message: read.error instanceof ReadDeadlineError ? t('readTimedOut') : messageOf(read.error) })}</div>
            <div className={css.emptySessions}><Button variant="outline" size="sm" onClick={read.reload}>{t('retry')}</Button></div>
          </Card>
        )
        : !projects.length ? <Empty title={t('emptyTitle')} icon={<LayerfsGlyph size={28} />}>{t('emptyBody')}</Empty>
        : (
          <div className={css.list}>
            {projects.map((project) => {
              const remote = remoteMachine(project)
              const availability = projectAvailability(project, machines.data, machines.error)
              return (
                <Section key={project.projectId ?? project.key} headless title={project.name ?? nameOf(project.key)}>
                  <Card>
                  <div className={css.head}>
                    <span className={css.headIcon}><LayerfsGlyph size={16} /></span>
                    <button type="button" className={css.projectLink} onClick={() => openProjectHome(api, project.projectId ?? project.key)}>
                      <span className={css.headTitle}>{project.name ?? nameOf(project.key)}</span>
                      <span className={css.headSub}>
                        {remote ? t('onMachine', { machine: remote }) : project.store ?? project.key.split('/')[0]}
                      </span>
                    </button>
                    <MachineStatus value={availability} t={t} />
                    <span className={css.headActions}>
                      <Button variant="outline" size="sm" disabled={busy !== null || !availability.canRun || machines.loading} aria-busy={busy === project.key}
                        onClick={() => newSession(project)}>{t('newSession')}</Button>
                    </span>
                  </div>
                  </Card>
                </Section>
              )
            })}
          </div>
        )}
      <Modal open={dialog !== null} onClose={() => setDialog(null)} title={dialog === 'import' ? t('importTitle') : t('newEmptyTitle')} closeLabel={t('close')} className={css.modal}>
        {dialog !== null ? (
          <NewProjectForm api={api} t={tp} scratchKey={read.data?.scratchKey ?? null} withSource={dialog === 'import'} backLabel={t('cancel')}
            onBack={() => setDialog(null)} onStarted={follow} />
        ) : null}
      </Modal>
    </Page>
  )
}
