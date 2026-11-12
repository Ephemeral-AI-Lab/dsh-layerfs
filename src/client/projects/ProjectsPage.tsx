/**
 * One LayerFS project's page, opened from its row in the sidebar's LayerFS
 * Projects section or on the Projects page. Its crumb leads back to the
 * Projects page; a panel restored with nothing selected (after a reload)
 * opens that page instead.
 */
import { useEffect, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { listProjects, messageOf } from '../picker/NewProjectForm.tsx'
import { useHostEvents } from '../storage/hooks.ts'
import { useQuery } from '../files/use-query.ts'
import { Page, PageHead } from '../ui/index.tsx'
import css from './projects.module.css'
import type { ProjectsT } from './locale.ts'
import { ReadDeadlineError, readWithDeadline } from './read-deadline.ts'
import type { Translate } from '../files/types.ts'
import { useProjectMachines } from './hooks.ts'
import { openProjectHome, useProjectSelection } from './navigation.ts'
import type { ListT } from './list-locale.ts'
import { ProjectHome } from './ProjectHome.tsx'

export function ProjectPanel({ api, t, tf, listT }: { api: LayerfsApi, t: ProjectsT, tf: Translate, listT: ListT }): ReactNode {
  const selected = useProjectSelection(api)
  const machines = useProjectMachines(api)
  const read = useQuery(() => readWithDeadline(listProjects(api)), [api])
  useHostEvents(api, ['layerfs-workspaces-changed', 'layerfs-availability', 'storage', 'machine-progress', 'connection'], () => read.reload())
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read.reload() }, 15_000)
    return () => clearInterval(timer)
  }, [read.reload])
  useEffect(() => { if (!selected) openProjectHome(api, null) }, [api, selected])
  if (!selected) return null

  const crumbs = [{ label: listT('panel'), onClick: () => openProjectHome(api, null), ariaLabel: listT('backToProjects') }]
  const project = (read.data?.rows ?? []).find((p) => (p.projectId ?? p.key) === selected)
  if (project) return <ProjectHome key={selected} api={api} project={project} machines={machines} t={t} tf={tf} reload={read.reload} crumbs={crumbs} />
  const failure = read.error instanceof ReadDeadlineError ? t('readTimedOut') : read.error ? messageOf(read.error) : null
  return <Page label={t('projectTitle')}><PageHead title={t('projectTitle')} crumbs={crumbs} current={t('projectTitle')} />
    <div className={css.notice} role={failure ? 'alert' : 'status'}>{read.loading ? t('loading') : failure ? t('loadFailed', { message: failure }) : t('projectMissing')}</div>
    <Button variant="outline" size="sm" onClick={read.reload}>{t('retry')}</Button></Page>
}
