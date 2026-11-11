/**
 * Machines glyphs: the sidebar entry's icon and one monochrome glyph per
 * machine kind. All draw with `currentColor` on a 16px grid so they ride the
 * surrounding text color in both themes.
 */
import type { ReactNode } from 'react'

interface GlyphProps { size?: number | undefined, className?: string | undefined }

function Svg({ size = 16, className, children }: GlyphProps & { children: ReactNode }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

/** Two stacked server units: the sidebar's Machines entry. */
export function MachinesGlyph(props: GlyphProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="2.1" y="2.6" width="11.8" height="4.6" rx="1.4" />
      <rect x="2.1" y="8.8" width="11.8" height="4.6" rx="1.4" />
      <path d="M4.6 4.9h.01M4.6 11.1h.01" strokeWidth={1.6} />
      <path d="M8.6 4.9h2.8M8.6 11.1h2.8" />
    </Svg>
  )
}

/** This computer (native): a laptop. */
function NativeGlyph(props: GlyphProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="3" y="3.2" width="10" height="7" rx="1.2" />
      <path d="M1.6 12.8h12.8" />
    </Svg>
  )
}

/** Docker: stacked containers. */
function DockerGlyph(props: GlyphProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="2" y="8" width="3.6" height="3.4" rx="0.6" />
      <rect x="6.2" y="8" width="3.6" height="3.4" rx="0.6" />
      <rect x="10.4" y="8" width="3.6" height="3.4" rx="0.6" />
      <rect x="4.1" y="4" width="3.6" height="3.4" rx="0.6" />
      <rect x="8.3" y="4" width="3.6" height="3.4" rx="0.6" />
      <path d="M2 13.4h12" />
    </Svg>
  )
}

/** A created VM: a box with a CPU-like core. */
function VmGlyph(props: GlyphProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.6" />
      <rect x="6" y="6" width="4" height="4" rx="0.6" />
      <path d="M6.4 1.6v1.6M9.6 1.6v1.6M6.4 12.8v1.6M9.6 12.8v1.6M1.6 6.4h1.6M1.6 9.6h1.6M12.8 6.4h1.6M12.8 9.6h1.6" />
    </Svg>
  )
}

/** A Sandbox: an open box. */
export function SandboxGlyph(props: GlyphProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 1.9 13.6 4.8v6.4L8 14.1 2.4 11.2V4.8L8 1.9Z" />
      <path d="M2.4 4.8 8 7.7l5.6-2.9M8 7.7v6.4" />
    </Svg>
  )
}

/** A Store: a database drum. */
export function StoreGlyph(props: GlyphProps): ReactNode {
  return (
    <Svg {...props}>
      <ellipse cx="8" cy="3.9" rx="5" ry="1.9" />
      <path d="M3 3.9v8.2c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V3.9M3 8c0 1 2.2 1.9 5 1.9s5-.9 5-1.9" />
    </Svg>
  )
}

/** The power glyph of Start/Stop. */
export function PowerGlyph(props: GlyphProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 2.2v5.2" />
      <path d="M4.6 4.2a5 5 0 1 0 6.8 0" />
    </Svg>
  )
}

/** A machine kind's glyph. */
export function MachineGlyph({ platform, ...props }: GlyphProps & { platform: string }): ReactNode {
  if (platform === 'native') return <NativeGlyph {...props} />
  if (platform === 'docker') return <DockerGlyph {...props} />
  return <VmGlyph {...props} />
}
