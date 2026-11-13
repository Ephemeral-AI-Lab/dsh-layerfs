/**
 * Projects area of dsh-layerfs: the LayerFS view of the sidebar's Workspaces
 * section behind a header switch (`WorkspacesView.tsx`), and the project
 * dialog (`setup/ProjectDialog.tsx`) that creates, imports, configures and
 * picks projects (docs/specs/layerfs-workspaces.md). There is no Projects page.
 */
import type { LayerfsApi } from '../api.ts'
import { locales as listLocales, NS as LIST_NS, type ListT } from './list-locale.ts'
import { ProjectDialogMount, setProjectDialogRenderer } from './dialog.ts'
import { registerWorkspacesView } from './WorkspacesView.tsx'
import { locales as setupLocales, NS as SETUP_NS, type SetupT } from './setup/locale.ts'
import { ProjectDialog } from './setup/ProjectDialog.tsx'

/**
 * Register the Workspaces view switch and the project dialog.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the views read through.
 */
export function registerProjects(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(LIST_NS, listLocales), 'dsh-layerfs: project list locale')
  ctx.effect(() => ctx.locale.register(SETUP_NS, setupLocales), 'dsh-layerfs: project dialog locale')
  const ts: SetupT = ctx.locale.bind(SETUP_NS)
  const tl: ListT = ctx.locale.bind(LIST_NS)
  ctx.effect(() => setProjectDialogRenderer((request) => <ProjectDialog api={api} t={ts} tl={tl} request={request} />), 'dsh-layerfs: project dialog')
  // An always-mounted host at the sidebar foot; the New Session row mounts another (dialog.ts).
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'dsh-layerfs.project-dialog', locale: SETUP_NS,
  }, ProjectDialogMount)), 'dsh-layerfs: project dialog host')
  ctx.inject(['sessions'], (scope: any) => {
    registerWorkspacesView(scope, api)
  })
}
