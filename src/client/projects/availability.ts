import type { ProjectRow } from '../picker/NewProjectForm.tsx'
import type { MachinesView } from '../machines/model.ts'

export type AvailabilityState = 'available' | 'stopped' | 'unavailable' | 'checking' | 'starting' | 'busy'
export interface ProjectAvailability {
  state: AvailabilityState
  machine: string | null
  reason?: string
  canStart: boolean
  canRun: boolean
  storageBlocked: boolean
}

/** Machine readiness and Store readiness are independent observations. */
export function projectAvailability(project: ProjectRow, view?: MachinesView, error?: unknown): ProjectAvailability {
  const name = project.machine ?? (project.kind === 'postgresql' && view?.available ? view.machines.find((m) => m.platform === 'host')?.name ?? null : null)
  const catalogBlocked = !!project.catalogState && project.catalogState !== 'available'
  const storageBlocked = catalogBlocked || project.storeState !== 'ready'
  const base = { machine: name, canStart: false, canRun: false, storageBlocked }
  if (project.catalogState === 'removed' || project.catalogState === 'identity-mismatch') return { ...base, state: 'unavailable', reason: project.catalogError }
  if (error) return { ...base, state: 'unavailable', reason: String((error as Error)?.message ?? error) }
  if (!view) return { ...base, state: 'checking' }
  if (!view.available) return { ...base, state: 'unavailable', reason: view.reason }
  const machine = view.machines.find((m) => m.name === name)
  if (!machine) return { ...base, state: 'unavailable' }
  // LayerFS 2.0's six states: busy with its op, broken with its message, ready or stopped
  const op = machine.op
  if (machine.state === 'busy' || op) {
    return { ...base, state: op?.name === 'start' || op?.name === 'machine.start' ? 'starting' : 'busy', reason: op ? [op.name, op.phase].filter(Boolean).join(' · ') : undefined }
  }
  const state = machine.state
  if (state === 'broken' || state === 'unknown') return { ...base, state: 'unavailable', reason: machine.message ?? view.live[machine.name]?.error?.message ?? machine.reason ?? state }
  if (state === 'stopped') return { ...base, state: 'stopped', canStart: true }
  if (catalogBlocked) return { ...base, state: 'unavailable', reason: project.catalogError }
  if (state === 'ready') return { ...base, state: 'available', canRun: !storageBlocked }
  return { ...base, state: 'unavailable', reason: state }
}
