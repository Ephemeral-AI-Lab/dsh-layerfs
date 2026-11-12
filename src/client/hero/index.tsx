/**
 * Hero area of dsh-layerfs: the LayerFS project control in the New Session
 * row (`conversation.hero.options`, rendered with a blank session).
 */
import type { LayerfsApi } from '../api.ts'
import { NS as PICKER_NS } from '../picker/locale.ts'
import { HeroProject, Imports } from './HeroProject.tsx'
import { NS, locales } from './locale.ts'

export function registerHero(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: hero locale')
  const t = ctx.locale.bind(NS)
  const tp = ctx.locale.bind(PICKER_NS)
  const imports = new Imports()
  const inject = (sessionId: string) => ({ sessionId: String(sessionId), api, t, tp, imports })
  ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => ctx.slots.register(
    { name: 'conversation.hero.options', id: 'dsh-layerfs.project', order: 10, locale: NS, inject }, HeroProject,
  )), 'dsh-layerfs: hero project')
}
