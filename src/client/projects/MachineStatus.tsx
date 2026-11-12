import { StateChip } from '../ui/index.tsx'
import type { AvailabilityState, ProjectAvailability } from './availability.ts'

export function MachineStatus({ value, t }: { value: ProjectAvailability, t: (key: AvailabilityState) => string }) {
  return <StateChip tone={value.state === 'available' ? 'success' : value.state === 'unavailable' ? 'danger' : value.state === 'stopped' ? 'neutral' : 'warning'}
    label={t(value.state)} title={value.reason} live={['checking', 'starting', 'busy'].includes(value.state)} />
}
