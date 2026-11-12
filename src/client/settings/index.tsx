/**
 * Settings area of dsh-layerfs: the sidebar's Settings row under LayerFS and
 * the page it opens. The page holds configuration: the pinned runtime (CLI,
 * daemon, Linux bundle, machine image cache, home) with Change…, and Presets
 * (the sample project library built into this home, with Build and Reset);
 * health and resources stay on their own pages. It reads the runtime through
 * the Machines controller; opening it starts nothing.
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import { IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { MachinesProvider, useMachinesContext, type MachinesPageProps, type Translate } from '../machines/context.tsx'
import type { MachinesShare } from '../machines/index.tsx'
import { RuntimeCard } from '../machines/Runtime.tsx'
import { ChildGlyph } from '../overview/child.tsx'
import type { SidebarGroup } from '../overview/group.ts'
import { NS as DOCTOR_NS } from '../doctor/locale.ts'
import { Page, PageHead, Section } from '../ui/index.tsx'
import { PresetsSection, PRESETS_NS, type PresetsT } from '../presets/index.tsx'
import { NS, locales, type SettingsT } from './locale.ts'

/** The id shared by the sidebar row and the main panel it opens. */
export const PANEL_ID = 'layerfs-settings'

interface SettingsMainProps extends Omit<MachinesPageProps, 't'> {
  t: SettingsT
  tm: Translate
  tp: PresetsT
  api: LayerfsApi
}

function SettingsMain(props: SettingsMainProps): ReactNode {
  const { t, tm, tp, api, doctorT, ...rest } = props
  const machines = useMemo<MachinesPageProps>(() => ({ ...rest, api, doctorT, t: tm }), [props])
  return (
    <MachinesProvider props={machines}>
      <SettingsBody t={t} tp={tp} api={api} />
    </MachinesProvider>
  )
}

function SettingsBody({ t, tp, api }: { t: SettingsT, tp: PresetsT, api: LayerfsApi }): ReactNode {
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

function SettingsSidebarIcon({ size }: { size?: number }): ReactNode {
  return <ChildGlyph><IconSettingsOutlineRegular size={size ?? 16} /></ChildGlyph>
}

/**
 * Register the Settings page and its sidebar row under LayerFS.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the page reads through.
 * @param group - the LayerFS sidebar group the row shows under.
 * @param machines - the Machines controller's face and `t`.
 */
export function registerSettings(ctx: any, api: LayerfsApi, group: SidebarGroup, machines: MachinesShare): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: settings locale')
  const t = ctx.locale.bind(NS)
  const doctorT = ctx.locale.bind(DOCTOR_NS)
  const tp = ctx.locale.bind(PRESETS_NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ ...machines.face, tm: machines.t, tp, api, doctorT }),
  }, SettingsMain)), 'dsh-layerfs: settings page')
  ctx.effect(() => group.whileExpanded(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 9.9,
    label: () => t('panel'),
    locale: NS,
  }, SettingsSidebarIcon))), 'dsh-layerfs: settings entry')
}
