/**
 * Running the Setup card's steps over the host API (docs/specs/layerfs-workspaces.md §3):
 * folder check, machine start, Store create / connect, Init, place (push, pull or move)
 * and a PostgreSQL Store's "runs on" choice. Each waits for its job; a refusal throws.
 */
import { enc, type LayerfsApi } from '../../api.ts'
import { waitProject, type ProjectInitJob } from '../../picker/NewProjectForm.tsx'
import type { PgAttachResult, StorageJob } from '../../storage/types.ts'
import { pgLoginBody, type CreatePlan, type Step } from './model.ts'

/** Start a machine and wait until it runs (the host machine too: it can be stopped). Only ever behind a press on that machine's own Start. */
export async function startMachine(api: LayerfsApi, machine: string): Promise<void> {
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

/** Put a SQLite Store on a machine (a push from the host machine, a pull to it, or a move) and wait. */
/** @param made - the Store was just made here (New Store, a Create's new Store): the job reads "Created on", not "Pushed to". */
export async function placeStore(api: LayerfsApi, store: string, machine: string, made = false): Promise<void> {
  const job = await api.call<StorageJob>('POST', `/api/machines/${enc(machine)}/stores`, made ? { store, made } : { store })
  if (job && typeof job === 'object' && 'id' in job && 'ended' in job) await waitJob(api, job)
}

/** The Store a plan creates in or uses. */
export const storeOfPlan = (plan: CreatePlan): string => plan.store?.name ?? plan.newStore?.name ?? ''

/**
 * Run one Create step. `open` is left to the caller (it opens the session).
 * @param onJob - Init progress, for the step's line.
 */
export async function runStep(api: LayerfsApi, plan: CreatePlan, step: Step, onJob?: (job: ProjectInitJob) => void): Promise<void> {
  const store = storeOfPlan(plan)
  switch (true) {
    case step.id === 'check':
      await api.call('POST', '/api/project-sources/check', { source: plan.source ?? '' })
      return
    case step.id === 'store':
      await api.call('POST', '/api/stores', { name: store })
      return
    case step.id === 'connect':
      // the address, the user and the password (on stdin, through the host): LayerFS checks from the host before it saves
      await api.call('POST', '/api/stores/postgresql', { name: store, url: plan.newStore?.url ?? '', ...(plan.newStore?.login ? pgLoginBody(plan.newStore.login) : {}) })
      return
    case step.id.startsWith('attach:'): {
      // the machine the first session runs on, checked from there; its refusal is the step's
      const answer = await api.call<PgAttachResult>('POST', `/api/stores/${enc(store)}/attach`, { machines: [step.machine!] })
      const failed = answer?.results?.find((r) => !r.ok)
      if (failed && !failed.ok) throw Object.assign(new Error(failed.error.message), failed.error)
      return
    }
    case step.id === 'init': {
      const job = await api.call<ProjectInitJob>('POST', '/api/projects', { store, name: plan.name, ...(plan.source ? { source: plan.source } : {}) })
      await waitProject(api, job, onJob)
      return
    }
    case step.id.startsWith('place:'):
      await placeStore(api, store, step.machine!, !plan.store)
      return
    default:
  }
}
