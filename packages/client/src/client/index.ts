// @dsh-layerfs/client: the LayerFS Work and History tabs beside Chat and Trajectory, the
// session's project beside its title, the project picker in the New Session row,
// and the LayerFS sidebar panel.
// While the LayerFS scripted model (@dsh-layerfs/mock) is on, also the
// panel's Tests tab and the Run bar above a scenario run's composer.
import { LayerFsIcon, LayerFsPanel, type PanelServices } from './LayerFsPanel.tsx'
import { LayerFsView } from './LayerFsView.tsx'
import { ProjectChip } from './ProjectChip.tsx'
import { ProjectPicker, type UsePreset } from './ProjectPicker.tsx'
import { RunBar, type RunServicesWithStatus } from './RunBar.tsx'
import { markLayerFsTabs } from './tablogo.ts'

export const inject = ['slots']

const PANEL = 'layerfs'

// any: this bundle builds outside the dsh workspace, without its Context types
export function apply(ctx: any): void {
  const directories = () => ctx.get('uiWorkspace')
  // LayerFS is two of the conversation's tabs: Work (the Branches, Sandboxes
  // and terminals) and History (the tree and Files); the logo marks Work
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'layerfs',
        order: 20,
        label: () => 'Work',
        inject: (sessionId: string) => ({ sessionId, directories, pane: 'work' }),
      },
      LayerFsView,
    ),
  )
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'layerfs-history',
        order: 21,
        label: () => 'History',
        inject: (sessionId: string) => ({ sessionId, directories, pane: 'history' }),
      },
      LayerFsView,
    ),
  )
  // the session's LayerFS project, named beside its title on every tab
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'layerfs-project',
        // static session context, right after the agent preset (-10)
        order: -5,
        inject: (sessionId: string) => ({ sessionId }),
      },
      ProjectChip,
    ),
  )
  if (typeof document !== 'undefined')
    ctx.effect?.(
      () => markLayerFsTabs(document, { work: 'Work', history: 'History' }),
      'layerfs-client: the Work and History tab group',
    )
  // the Remote session services a scenario run uses, while the scope that injects them is up
  let remote: RunServicesWithStatus['remote']
  const runServices = (): RunServicesWithStatus => ({
    remote,
    uiWorkspace: ctx.get('uiWorkspace'),
    uiSession: ctx.get('uiSession'),
  })
  // workspace services are optional: without them the panel lists no
  // workspaces and Init offers only the workspace folder as its source
  const services = (): PanelServices => ({
    workspaces: ctx.get('workspaces'),
    uiWorkspace: ctx.get('uiWorkspace'),
    runs: runServices(),
  })
  ctx.inject(['remote', 'remote.session', 'remote.workspace'], (scope: any) => {
    remote = scope.remote
    scope.effect(
      () => () => {
        remote = undefined
      },
      'layerfs-client: the Remote session services',
    )
  })
  // the Run bar, in a scenario run's Session only (it renders nothing elsewhere)
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'layerfs-mock',
        order: 5,
        inject: (sessionId: string) => ({ sessionId, services: runServices }),
      },
      RunBar,
    ),
  )
  // a new conversation that picks a LayerFS project runs the LayerFS preset:
  // dsh's own preset service switches the blank session (its chip follows)
  let usePreset: UsePreset | undefined
  ctx.inject(['remote', 'remote.agentPresets'], (scope: any) => {
    usePreset = (sessionId, preset) => scope.remote.agentPresets.select(sessionId, preset)
    scope.effect(
      () => () => {
        usePreset = undefined
      },
      'layerfs-client: the agent preset service',
    )
  })
  ctx.slots.inject('conversation.hero.options', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.options',
        id: 'layerfs-project',
        order: 50,
        label: () => 'LayerFS project',
        inject: (sessionId: string) => ({ sessionId, directories, usePreset: () => usePreset }),
      },
      ProjectPicker,
    ),
  )
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL,
        inject: () => ({ services }),
      },
      LayerFsPanel,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL,
        order: 40,
        label: () => 'LayerFS',
      },
      LayerFsIcon,
    ),
  )
}
