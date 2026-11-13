/**
 * Settings area of dsh-layerfs: the Settings page, a Center page opened from
 * the Center bar. The page holds configuration: the pinned runtime (CLI,
 * daemon, Linux bundle, machine image cache, home) with Change…, and Presets
 * (the sample project library built into this home, with Build and Reset);
 * health and resources stay on their own pages. It reads the runtime through
 * the Machines controller; opening it starts nothing.
 */
import { useEffect, type ReactNode } from 'react'
import { IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { useMachinesContext } from '../machines/context.tsx'
import { RuntimeCard } from '../machines/Runtime.tsx'
import { Page, PageHead, Section } from '../ui/index.tsx'
import { PresetsSection, type PresetsT } from '../presets/index.tsx'
import { NS, locales, type SettingsT } from './locale.ts'

export { NS as SETTINGS_NS } from './locale.ts'

/**
 * The Settings page's body, shown as a Center page (`settings`). It reads the
 * runtime through the Machines context the Center page provides.
 */
export function SettingsView({ t, tp, api }: { t: SettingsT, tp: PresetsT, api: LayerfsApi }): ReactNode {
  const { activate } = useMachinesContext()
  useEffect(() => activate(), [activate])
  return (
    <Page label={t('title')}>
      <PageHead title={t('title')} icon={<IconSettingsOutlineRegular size={22} />} />
      <Section title={t('runtime')}>
        <RuntimeCard />
      </Section>
      <PresetsSection api={api} t={tp} />
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
