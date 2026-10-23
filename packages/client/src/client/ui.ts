// Inline styles for the tab's plain messages, in dsh's colours where it sets
// them, clear of the composer that floats over the conversation's bottom.
export const MESSAGE = {
  padding: '24px 20px',
  paddingBottom: 'calc(var(--dsh-composer-height, 0px) + 24px)',
  fontSize: 13,
  lineHeight: 1.6,
  overflowWrap: 'anywhere',
  color: 'var(--dsh-color-fg-muted, inherit)',
} as const
