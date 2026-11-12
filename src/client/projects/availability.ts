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
  const name = project.machine ?? (project.kind === 'postgresql' ? 'native' : null)
  const catalogBlocked = !!project.catalogState && project.catalogState !== 'available'
  const storageBlocked = catalogBlocked || !['idle', 'in_use'].includes(project.storeState ?? '')
  const base = { machine: name, canStart: false, canRun: false, storageBlocked }
  if (project.catalogState === 'removed' || project.catalogState === 'identity-mismatch') return { ...base, state: 'unavailable', reason: project.catalogError }
  if (error) return { ...base, state: 'unavailable', reason: String((error as Error)?.message ?? error) }
  if (!view) return { ...base, state: 'checking' }
  if (!view.available) return { ...base, state: 'unavailable', reason: view.reason }
  const machine = view.machines.find((m) => m.name === name)
  if (!machine) return { ...base, state: 'unavailable' }
  const live = view.status[machine.name]
  const op = live?.op ?? machine.op
  if (op || ['creating', 'removing'].includes(machine.state)) {
    return { ...base, state: op?.name === 'machine.start' || op?.name === 'start' ? 'starting' : 'busy', reason: op ? [op.name, op.phase].filter(Boolean).join(' · ') : undefined }
  }
  if (live?.down || machine.error) return { ...base, state: 'unavailable', reason: live?.down ?? machine.error }
  const state = live?.state ?? machine.state
  if (state === 'stopped') return { ...base, state: 'stopped', canStart: machine.platform !== 'native' }
  if (catalogBlocked) return { ...base, state: 'unavailable', reason: project.catalogError }
  if (state === 'running' || state === 'ready') return { ...base, state: 'available', canRun: !storageBlocked }
  return { ...base, state: 'unavailable', reason: state }
}
