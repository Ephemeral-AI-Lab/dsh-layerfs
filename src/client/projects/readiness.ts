import type { ProjectAvailability } from './availability.ts'

/** The catalog facts the sidebar's readiness rule reads from a project row. */
export interface CatalogFacts { catalogState?: string | null }

export type SidebarStatusKey = 'available' | 'removed' | 'replaced' | 'machineStopped' | 'starting' | 'busy' | 'checking' | 'notVerified' | 'storeUnavailable' | 'machineUnavailable'
export interface SidebarStatus { key: SidebarStatusKey, tone: 'success' | 'neutral' | 'warning' | 'danger', live: boolean }

/**
 * Why a project cannot run right now, as one short sidebar label. Ready means
 * its machine is up, its Store answers and its identity is verified
 * (`availability.canRun`); everything else is listed under Unavailable.
 */
export function sidebarStatus(project: CatalogFacts, a: ProjectAvailability): SidebarStatus {
  if (a.canRun) return { key: 'available', tone: 'success', live: false }
  if (project.catalogState === 'removed') return { key: 'removed', tone: 'danger', live: false }
  if (project.catalogState === 'identity-mismatch') return { key: 'replaced', tone: 'danger', live: false }
  if (a.state === 'stopped') return { key: 'machineStopped', tone: 'neutral', live: false }
  if (a.state === 'starting' || a.state === 'busy' || a.state === 'checking') return { key: a.state, tone: 'warning', live: true }
  if (project.catalogState === 'unavailable') return { key: 'notVerified', tone: 'danger', live: false }
  // The machine is up but the Store does not answer.
  if (a.state === 'available') return { key: 'storeUnavailable', tone: 'danger', live: false }
  return { key: 'machineUnavailable', tone: 'danger', live: false }
}

/**
 * Ready and Unavailable projects, in catalog order. Until the machine list has
 * been read once (`observed`), nothing is split, so rows do not start under
 * Unavailable and then jump.
 */
export function splitByReadiness<T extends { availability: ProjectAvailability }>(rows: readonly T[], observed: boolean): { ready: T[], inactive: T[] } {
  if (!observed) return { ready: [...rows], inactive: [] }
  return { ready: rows.filter((r) => r.availability.canRun), inactive: rows.filter((r) => !r.availability.canRun) }
}
