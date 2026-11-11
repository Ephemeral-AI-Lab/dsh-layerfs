import type { ReactNode } from 'react'

/** The LayerFS mark (an A over a three-node rail), drawn in currentColor. */
export function LayerfsGlyph({ size = 16 }: { size?: number | undefined }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="6 6 188 188" fill="none" aria-hidden="true" focusable="false">
      <path d="M88.5 22 L111.5 22 L170 135 L148.5 135 L100 49.5 L51.5 135 L30 135 Z" fill="currentColor" fillOpacity="0.45" stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" strokeLinejoin="round" />
      <path d="M27 161 L57 161 L100 117 L143 161 L173 161" stroke="currentColor" strokeWidth="10.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="100" cy="117" r="15.5" fill="currentColor" />
      <circle cx="27" cy="161" r="15.5" fill="currentColor" />
      <circle cx="173" cy="161" r="15.5" fill="currentColor" />
    </svg>
  )
}
