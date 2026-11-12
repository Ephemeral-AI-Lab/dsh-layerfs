import type { LayerfsApi } from '../api.ts'
import { locales, NS } from './locale.ts'
import { WorkAreas } from './WorkAreas.tsx'

/** Extend the native workspace surface without replacing DSH's browser. */
export function registerWorkAreas(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: work areas locale')
  ctx.inject(['workspaces', 'sessions'], (scope: any) => {
    scope.effect(() => scope.slots.inject('sidebar.footer.action', () => scope.slots.register({
      name: 'sidebar.footer.action', id: 'dsh-layerfs.workareas', locale: NS,
      inject: () => ({ api, source: scope.get('workspaces').list, sessionSource: scope.get('sessions').list }),
    }, WorkAreas)), 'dsh-layerfs: grouped work areas')
  })
}
