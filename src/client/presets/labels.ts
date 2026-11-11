/** The words a LayerFS refusal needs, from the Presets dictionary. */
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
