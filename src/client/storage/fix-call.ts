/** A refusal's fix line as the host call the page's own button for it makes (Center's FixContext). */
import { enc, type LayerfsApi } from '../api.ts'
import type { RunnableFix } from '../../shared/doctor.ts'

/** The host call a refusal's fix line runs: the route the page's own button for it takes. */
export function fixCall(api: LayerfsApi, fix: RunnableFix): Promise<unknown> {
  switch (fix.kind) {
    case 'start': case 'stop': case 'restart': return api.call('POST', `/api/machines/${enc(fix.machine)}/${fix.kind}`, {})
    case 'prune': return api.call('POST', `/api/machines/${enc(fix.machine)}/prune-images`, { unused: true })
    case 'compact': return api.call('POST', `/api/stores/${enc(fix.store)}/compact`, {})
    case 'delete': return api.call('DELETE', `/api/projects/${enc(fix.project)}`)
    case 'backup': return api.call('POST', `/api/stores/${enc(fix.store)}/backup`, { bucket: fix.bucket })
    case 'homeInit': return api.op('setup.convert')
  }
}
