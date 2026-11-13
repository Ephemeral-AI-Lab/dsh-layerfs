/**
 * The Sandbox map's two illustrations: the agent whale and the LayerFS mark.
 * The whale is tinted by `--lane` (set on an ancestor) and keeps fixed white
 * and ink from DSH's static palette so it reads the same in both themes; the
 * LayerFS mark is the brand drawing (LayerFS Connect's `layerfs-mark.tsx`)
 * with its own two blues.
 */
import type { CSSProperties, ReactNode } from 'react'
import css from './marks.module.css'

/**
 * A kawaii whale facing right, tinted by `--lane`. `spout` (0..1) grows the
 * water spout from the blowhole; `bob` (px) lifts the whale. Both come from
 * the replay clock, so they freeze with it.
 */
export function Whale({ size = 28, spout = 0, bob = 0, className }: { size?: number, spout?: number, bob?: number, className?: string }): ReactNode {
  const s = Math.max(0, Math.min(1, spout))
  const spoutStyle: CSSProperties | undefined = s > 0 ? { opacity: s, transform: `scale(${0.55 + 0.45 * s})` } : undefined
  return (
    <svg className={className ? `${css.whale} ${className}` : css.whale} width={size} height={Math.round(size * 28 / 32)} viewBox="0 0 32 28" aria-hidden
      style={bob ? { transform: `translateY(${bob.toFixed(2)}px)` } : undefined}>
      <g className={css.spout} style={spoutStyle}>
        <path d="M20 9.2V5.4" strokeWidth={1.15} strokeLinecap="round" fill="none" />
        <circle cx="17.6" cy="4.4" r="1.15" /><circle cx="20" cy="2.6" r="1.3" /><circle cx="22.4" cy="4.4" r="1.15" />
      </g>
      <path className={css.body} d="M9.4 22.4C6.6 21.6 4.9 19.3 5 16.4 3.2 16 1.9 14.6 1.6 12.6c1.9 0 3.4.8 4.3 2 .3-1.6 1.5-2.9 3.3-3.2.1 2-.9 3.6-2.3 4.5.1 1.9 1.3 3.4 3.4 4.1Z" />
      <path className={css.body} d="M7.2 19.6C7.2 13.6 12.1 9.4 18.4 9.4c6.6 0 11.4 4.2 11.4 9.8 0 5-4.3 7.9-10.4 7.9-6 0-9.6-2.1-11.6-5.2-.4-.7-.6-1.5-.6-2.3Z" />
      <path className={css.belly} d="M8.9 23.2c2.6 2.6 6.3 3.6 10.5 3.6 5 0 8.8-1.9 10.2-5.6-3.1 2.1-6.9 3-11 2.9-3.8-.1-7-.3-9.7-.9Z" />
      <path className={css.fin} d="M14.6 21.4c-.2 1.9.9 3.2 2.6 3.5-.6-1-.8-2-.6-3.1-.6-.1-1.3-.2-2-.4Z" />
      <ellipse className={css.blush} cx="25.6" cy="21.1" rx="1.75" ry="1.05" />
      <circle className={css.eye} cx="23.3" cy="17.3" r="2.5" />
      <circle className={css.shine} cx="24.15" cy="16.4" r=".95" />
      <circle className={css.shine} cx="22.6" cy="18.3" r=".45" />
      <path className={css.mouth} d="M27.1 19.6c.3.75 1.25.75 1.55 0" strokeWidth={0.8} fill="none" strokeLinecap="round" />
    </svg>
  )
}

/** The LayerFS mark (the same drawing as the LayerFS repo's layerfs-mark.svg). */
export function LayerfsMark({ size, className }: { size?: number | string, className?: string }): ReactNode {
  return (
    <svg className={className} width={size} height={size} viewBox="6 6 188 188" fill="none" aria-hidden>
      <path d="M88.5 22 L111.5 22 L170 135 L148.5 135 L100 49.5 L51.5 135 L30 135 Z" fill="#93B1E0" stroke="#93B1E0" strokeWidth="2" strokeLinejoin="round" />
      <path d="M27 161 L57 161 L100 117 L143 161 L173 161" stroke="#2F5BB5" strokeWidth="10.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="100" cy="117" r="15.5" fill="#2F5BB5" />
      <circle cx="27" cy="161" r="15.5" fill="#2F5BB5" />
      <circle cx="173" cy="161" r="15.5" fill="#2F5BB5" />
    </svg>
  )
}
