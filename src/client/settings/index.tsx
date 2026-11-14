/**
 * Settings area of dsh-layerfs: the Settings page, a Center page opened from
 * the Center bar. The page holds configuration: the pinned runtime (CLI,
 * daemon, Linux bundle, machine image cache, home) with Change…; Presets open
 * from the LayerFS home, and health and resources stay on their own pages. It reads the runtime through
 * the Machines controller; opening it starts nothing.
 */
import { useEffect, type ReactNode } from 'react'
import { IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMachinesContext } from '../machines/context.tsx'
import { RuntimeCard } from '../machines/Runtime.tsx'
import { Page, PageHead, Section } from '../ui/index.tsx'
import { NS, locales, type SettingsT } from './locale.ts'

export { NS as SETTINGS_NS } from './locale.ts'

/**
 * The Settings page's body, shown as a Center page (`settings`). It reads the
 * runtime through the Machines context the Center page provides.
 */
export function SettingsView({ t }: { t: SettingsT }): ReactNode {
  const { activate } = useMachinesContext()
  useEffect(() => activate(), [activate])
  return (
    <Page label={t('title')}>
      <PageHead title={t('title')} icon={<IconSettingsOutlineRegular size={22} />} />
      <Section title={t('runtime')}>
        <RuntimeCard />
      </Section>
    </Page>
  )
}

/**
 * Register the Settings copy (the page itself is a Center page).
 * @param ctx - the plugin's client context (locale).
 */
export function registerSettings(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: settings locale')
}
