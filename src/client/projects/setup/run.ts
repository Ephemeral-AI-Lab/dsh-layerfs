/**
 * Running the Setup card's steps over the host API (docs/specs/layerfs-workspaces.md §3):
 * machine start, Store create / connect, Init, place (push, pull or move),
 * attach and detach. Each waits for its job; a refusal throws.
 */
import { enc, type LayerfsApi } from '../../api.ts'
import { waitProject, type ProjectInitJob } from '../../picker/NewProjectForm.tsx'
import type { StorageJob } from '../../storage/types.ts'
import { passwordBody, type CreatePlan, type Step } from './model.ts'

/** Start a machine and wait until it runs (the host waits; native answers at once). */
export async function startMachine(api: LayerfsApi, machine: string): Promise<void> {
  if (machine === 'native') return
  await api.call('POST', `/api/machines/${enc(machine)}/start`)
}

/** Wait for a storage job (push, pull, move) to end; throws its refusal. */
export async function waitJob(api: LayerfsApi, job: StorageJob): Promise<StorageJob> {
  let current = job
  while (!current.ended) {
    await new Promise((r) => setTimeout(r, 700))
    current = await api.call<StorageJob>('GET', `/api/storage-jobs/${enc(current.id)}`)
  }
  if (current.error) throw new Error(current.error.message ?? String(current.error.code))
  return current
}

/** Put a SQLite Store on a machine (a push from native, a pull to native, or a move) and wait. */
export async function placeStore(api: LayerfsApi, store: string, machine: string): Promise<void> {
  const job = await api.call<StorageJob>('POST', `/api/machines/${enc(machine)}/stores`, { store })
  if (job && typeof job === 'object' && 'id' in job && 'ended' in job) await waitJob(api, job)
}

export const attachStore = (api: LayerfsApi, store: string, machine: string) => api.call('POST', `/api/stores/${enc(store)}/attach`, { machine })
export const detachStore = (api: LayerfsApi, store: string, machine: string) => api.call('POST', `/api/stores/${enc(store)}/detach`, { machine })

/** The Store a plan creates in or uses. */
export const storeOfPlan = (plan: CreatePlan): string => plan.store?.name ?? plan.newStore?.name ?? ''

/**
 * Run one Create step. `open` is left to the caller (it opens the session).
 * @param onJob - Init progress, for the step's line.
 */
export async function runStep(api: LayerfsApi, plan: CreatePlan, step: Step, onJob?: (job: ProjectInitJob) => void): Promise<void> {
  const store = storeOfPlan(plan)
  switch (true) {
    case step.id === 'store':
      await api.call('POST', '/api/stores', { name: store })
      return
    case step.id === 'connect':
      await api.call('POST', '/api/stores/postgresql', { name: store, url: plan.newStore?.url ?? '', ...passwordBody(plan.newStore?.password ?? '') })
      return
    case step.id === 'start-store':
    case step.id.startsWith('start:'):
      await startMachine(api, step.machine!)
      return
    case step.id === 'init': {
      const job = await api.call<ProjectInitJob>('POST', '/api/projects', { store, name: plan.name, ...(plan.source ? { source: plan.source } : {}) })
      await waitProject(api, job, onJob)
      return
    }
    case step.id.startsWith('place:'):
      await placeStore(api, store, step.machine!)
      return
    case step.id.startsWith('attach:'):
      await attachStore(api, store, step.machine!)
      return
    case step.id === 'detach:native':
      await detachStore(api, store, 'native')
      return
    default:
  }
}
