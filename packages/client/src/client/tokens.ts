// dsh's own tokens (--dsw-*) for the LayerFS page, and the 4/8/12/16/24 spacing scale.
// Inside the page the sharky maid theme (maid.tsx) sets them, and the --lfs-*
// radii, card border and step; elsewhere (dialogs, the Work tab) dsh's apply.
export const T = {
  text: 'var(--dsw-alias-label-primary)', text2: 'var(--dsw-alias-label-secondary)', caption: 'var(--dsw-alias-label-caption)',
  border: 'var(--dsw-alias-border-l2)', card: 'var(--dsw-alias-bg-layer-1)', well: 'var(--dsw-alias-bg-skeleton)',
  hover: 'var(--dsw-alias-interactive-bg-hover)', active: 'var(--dsw-alias-interactive-bg-active)',
  danger: 'var(--dsw-alias-state-error-primary)', warn: 'var(--dsw-alias-state-warn-primary)', ok: 'var(--dsw-alias-state-success-primary)',
  sm: 'var(--lfs-r-sm, var(--dsw-radius-sm))', md: 'var(--lfs-r-md, var(--dsw-radius-md))',
} as const
// a card: dsh's layer fill (white in light mode) inside a hairline, as dsh's settings cards
export const card = { background: T.card, border: `var(--lfs-card-bw, 1px) solid ${T.border}`, borderRadius: T.md, boxShadow: 'var(--lfs-card-shadow, none)' } as const
