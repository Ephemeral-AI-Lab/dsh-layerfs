/**
 * Projects area of dsh-layerfs: the LayerFS view of the sidebar's Workspaces
 * section behind a header switch (`WorkspacesView.tsx`), the Projects page its
 * folder button opens (`layerfs-projects`), and one project's page
 * (`layerfs-project`, opened from a project row or `openProjectHome`).
 */
import type { ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { locales, NS, type ProjectsT } from './locale.ts'
import { locales as listLocales, NS as LIST_NS, type ListT } from './list-locale.ts'
import { NS as STORAGE_NS, type StorageT } from '../storage/locale.ts'
import { ProjectList, type SessionSource } from './ProjectList.tsx'
import { ProjectPanel } from './ProjectsPage.tsx'
import { LIST_PANEL_ID, PROJECT_PANEL_ID } from './navigation.ts'
import { registerWorkspacesView } from './WorkspacesView.tsx'

/** The Projects page's panel id. */
export const PANEL_ID = LIST_PANEL_ID

function ProjectListMain(props: { api: LayerfsApi, t: ListT, sessionSource?: SessionSource }): ReactNode {
  return <ProjectList api={props.api} t={props.t} sessionSource={props.sessionSource} />
}

function ProjectMain(props: { api: LayerfsApi, t: ProjectsT, tf: StorageT, listT: ListT }): ReactNode {
  return <ProjectPanel api={props.api} t={props.t} tf={props.tf as import('../files/types.ts').Translate} listT={props.listT} />
}

/**
 * Register the Workspaces view switch, the Projects page and the project page.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the pages read through.
 */
export function registerProjects(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: projects locale')
  ctx.effect(() => ctx.locale.register(LIST_NS, listLocales), 'dsh-layerfs: project list locale')
  const t = ctx.locale.bind(NS)
  const tf = ctx.locale.bind(STORAGE_NS)
  const listT = ctx.locale.bind(LIST_NS)
  ctx.inject(['sessions'], (scope: any) => {
    scope.effect(() => scope.slots.inject('main', () => scope.slots.register({
      name: 'main',
      key: LIST_PANEL_ID,
      locale: LIST_NS,
      inject: () => ({ api, t: listT, sessionSource: scope.get('sessions').list }),
    }, ProjectListMain)), 'dsh-layerfs: project list page')
    registerWorkspacesView(scope, api)
  })
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PROJECT_PANEL_ID,
    locale: NS,
    inject: () => ({ api, t, tf, listT }),
  }, ProjectMain)), 'dsh-layerfs: project page')
}
