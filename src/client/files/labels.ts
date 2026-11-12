/** Localized chrome and saved-version words shared by the file views. */
import type { ReadBlockLabels, DiffBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileRevision, LineOwner, SavedRef, Translate } from './types.ts'

/** ReadBlock's and DiffBlock's localized chrome. */
export function codeLabels(t: Translate): ReadBlockLabels & DiffBlockLabels {
  return {
    codeLabel: t('files_code'),
    wrapLabel: t('files_wrap'),
    unwrapLabel: t('files_unwrap'),
    copy: t('files_copy'),
    copied: t('files_copied'),
    collapse: t('files_collapse'),
    collapseAria: t('files_collapseAria'),
    expand: (hidden: number) => t('files_expand', { count: hidden }),
    expandAria: (hidden: number) => t('files_expandAria', { count: hidden }),
    window: (shown: number, total: number) => t('files_window', { shown, total }),
  }
}

/** A saved version's title: its message, else what kind of version it is. */
export function versionTitle(ref: SavedRef | undefined | null, message: string | null | undefined, t: Translate): string {
  if (message) return message
  if (!ref) return t('files_blameUnknown')
  return ref.kind === 'Layer' ? t('files_layerOnMain') : t('files_noMessage')
}

export const ownerTitle = (owner: LineOwner | null | undefined, t: Translate): string => versionTitle(owner?.ref, owner?.message, t)

/** A revision's title: its message, else what it did to the file. */
export function revisionTitle(rev: FileRevision, t: Translate): string {
  if (rev.message) return rev.message
  if (/add/i.test(rev.kind) && !rev.compared_to) return rev.ref.kind === 'Layer' ? t('files_initialImport').replace(/\.$/, '') : t('files_revisionAdded')
  if (/remov|del/i.test(rev.kind)) return t('files_revisionRemoved')
  return versionTitle(rev.ref, null, t)
}

/** A coverage note, or null when the answer is exact. */
export function approximateNote(coverage: { status?: string, reasons?: string[] } | undefined, coarse: boolean | undefined, t: Translate): string | null {
  const partial = (coverage?.status && coverage.status !== 'complete') || coarse
  if (!partial) return null
  const reasons = coverage?.reasons?.filter(Boolean) ?? []
  return reasons.length ? t('files_approximate', { reasons: reasons.join(', ') }) : t('files_approximateNoReason')
}
