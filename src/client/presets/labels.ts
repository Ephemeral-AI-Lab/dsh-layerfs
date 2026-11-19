/** The words a LayerFS refusal needs, from the Presets dictionary. */
import type { DemoPreset, PresetResetPlan } from '../../shared/presets.ts'
import type { RefusalLabels } from '../ui/index.tsx'
import type { PresetsT } from './locale.ts'

export function refusalLabels(t: PresetsT): RefusalLabels {
  return {
    category: (kind) => kind === 'usage' ? t('refusalUsage') : kind === 'unavailable' ? t('refusalUnavailable') : kind === 'unknown' ? t('refusalUnknown') : t('refusalRefusal'),
    inTheWay: t('inTheWay'),
    kind: (kind) => kind.charAt(0).toUpperCase() + kind.slice(1),
    phase: (phase) => t('phase', { phase }),
    operation: (op) => t('operation', { op }),
  }
}

/**
 * The machines a confirmed plan may start (RV4 NOTE 3), named in its confirm:
 * a Reset starts the machines it needs to reach their resources
 * (`startMachines`); a Build then starts each machine a preset Store is placed
 * on or runs on (`runner.js` startMachine; `native` is never started). A
 * stop-only plan starts none.
 */
export function machinesStarted(preset: Pick<DemoPreset, 'projectGroups'>, plan: PresetResetPlan, build: boolean): string[] {
  if (plan.scope !== 'environment') return []
  const built = build ? preset.projectGroups.map((g) => g.machine) : []
  return [...new Set([...plan.startMachines, ...built])].filter((name) => name && name !== 'native').sort()
}
