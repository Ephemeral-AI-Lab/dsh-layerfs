import type { ReactNode } from 'react'

/**
 * LayerFS's brand blues (LayerFS Connect's `layerfs-mark`): the A, and the rail
 * nudged toward the text color so it holds on dark surfaces. A container may set
 * `--lfs-light` / `--lfs-dark` to tune them.
 */
const LIGHT = 'var(--lfs-light, #93B1E0)'
const DARK = 'var(--lfs-dark, color-mix(in oklab, #2F5BB5 82%, var(--dsw-alias-label-primary, #000)))'

/**
 * The LayerFS mark (an A over a three-node rail) in its two-tone brand blue,
 * or in currentColor with `mono`.
 */
export function LayerfsGlyph({ size = 16, mono = false }: { size?: number | undefined, mono?: boolean }): ReactNode {
  const a = mono ? 'currentColor' : LIGHT
  const rail = mono ? 'currentColor' : DARK
  const aOpacity = mono ? 0.45 : 1
  return (
    <svg width={size} height={size} viewBox="6 6 188 188" fill="none" aria-hidden="true" focusable="false">
      <path d="M88.5 22 L111.5 22 L170 135 L148.5 135 L100 49.5 L51.5 135 L30 135 Z" style={{ fill: a, stroke: a, fillOpacity: aOpacity, strokeOpacity: aOpacity }} strokeWidth="2" strokeLinejoin="round" />
      <path d="M27 161 L57 161 L100 117 L143 161 L173 161" style={{ stroke: rail }} strokeWidth="10.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="100" cy="117" r="15.5" style={{ fill: rail }} />
      <circle cx="27" cy="161" r="15.5" style={{ fill: rail }} />
      <circle cx="173" cy="161" r="15.5" style={{ fill: rail }} />
    </svg>
  )
}
