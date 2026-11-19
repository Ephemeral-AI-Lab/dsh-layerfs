/** A refusal's fix line as the host call the page's own button for it makes (Center's FixContext). */
import { enc, type LayerfsApi } from '../api.ts'
import type { RunnableFix } from '../../shared/doctor.ts'

/**
 * The host call a refusal's fix line runs: the route the page's own button for
 * it takes. `doctor`, `saveAuth` and `connectBucket` are not calls: Center
 * starts the doctor (and opens the Doctor page) or opens the save-login or
 * Connect dialog itself.
 */
export function fixCall(api: LayerfsApi, fix: RunnableFix): Promise<unknown> {
  switch (fix.kind) {
    case 'start': case 'stop': case 'restart': return api.call('POST', `/api/machines/${enc(fix.machine)}/${fix.kind}`, {})
    case 'prune': return api.call('POST', `/api/machines/${enc(fix.machine)}/prune-images`, { unused: true })
    // a created machine whose record has no vm_name: LayerFS removes its record alone
    case 'removeMachine': return api.call('DELETE', `/api/machines/${enc(fix.machine)}`)
    case 'compact': return api.call('POST', `/api/stores/${enc(fix.store)}/compact`, {})
    // a Store record LayerFS cannot place (no `kind`): its records go; the route asks the name as its confirm
    case 'removeStore': return api.call('DELETE', `/api/stores/${enc(fix.store)}?confirm=${enc(fix.store)}`)
    case 'removeSandbox': return api.call('DELETE', `/api/sandboxes/${enc(fix.sandbox)}`)
    case 'delete': return api.call('DELETE', `/api/projects/${enc(fix.project)}`)
    case 'backup': return api.call('POST', `/api/stores/${enc(fix.store)}/backup`, { bucket: fix.bucket })
    case 'homeInit': return api.op('setup.init')
    // a record with fields 2.0 no longer writes: store update names its own login again, which writes it clean (spec v23)
    case 'updateAuth': return api.call('POST', `/api/stores/${enc(fix.store)}/connection`, { auth: fix.auth })
    case 'doctor': case 'saveAuth': case 'connectBucket': return Promise.reject(new Error(`the ${fix.kind} fix is Center's own, not a host call`))
    // a multi-command fix: its steps in order, one attempt each; the first refusal ends it (nothing after it runs)
    case 'chain': return fix.steps.reduce<Promise<unknown>>((before, step) => before.then(() => fixCall(api, step)), Promise.resolve())
  }
}
