/**
 * Setup area of dsh-layerfs (docs/specs/layerfs-setup.md §4): the Set up
 * LayerFS modal, mounted once at the sidebar foot so it can open from any
 * page. The mount reads the host's setup check once (and on setup events)
 * and opens the modal by itself at most once per page load when something
 * required is missing, unless this viewer chose Later.
 */
import { useEffect, type ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { NS, locales, type SetupModalT } from './locale.ts'
import { SetupDialog, type MachinesT } from './SetupDialog.tsx'
import { setupDialog, useSetupDialog, useSetupStatus } from './store.ts'

export { NS as SETUP_MODAL_NS } from './locale.ts'

/**
 * Register the setup modal's copy and its always-mounted host.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API.
 * @param tm - the Machines namespace's `t` (machine names, readiness reasons).
 */
export function registerSetup(ctx: any, api: LayerfsApi, tm: MachinesT): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: setup locale')
  const t: SetupModalT = ctx.locale.bind(NS)
  function SetupMount(): ReactNode {
    const status = useSetupStatus(api)
    useEffect(() => { setupDialog.autoOpen(status.data ?? null) }, [status.data])
    const section = useSetupDialog()
    return section ? <SetupDialog api={api} t={t} tm={tm} section={section} /> : null
  }
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'dsh-layerfs.setup-dialog', locale: NS,
  }, SetupMount)), 'dsh-layerfs: setup dialog host')
}
