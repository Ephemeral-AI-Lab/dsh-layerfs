// The sharky maid look for the LayerFS page's own parts (the title bar, All
// projects, Tests), matching the board's skin (view/src/skins/maids/style.js):
// its palette and rounded font, pill tabs and buttons, round cards with a
// soft step, lace along the top and a bow, pastel tag chips and the bubble
// floor. It sets dsh's own tokens inside .lfs-maid, so dsh's buttons there
// follow; menus and dialogs open outside it and keep dsh's look. Dark follows
// dsh's colour scheme (data-theme, from followTheme), else the system's.
// Ellen shows how the tests went with one of her expressions.
import ellen from '../../../../sim/avatars/ellen_joe.png'

const bubbles = (ring: string, dot: string, heart: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="10" cy="12" r="3" fill="none" stroke="${ring}" stroke-width="1.2"/><circle cx="16" cy="6" r="1.6" fill="${dot}"/><path d="M44 40c-2-3.4-7-2-6.2 1.4.7 2.8 6.2 5.6 6.2 5.6s5.5-2.8 6.2-5.6C51 38 46 36.6 44 40z" fill="${heart}"/><circle cx="52" cy="14" r="1.2" fill="${dot}"/></svg>`)}")`

const LIGHT = `
  --lfs-paper: #F6F9FF; --lfs-floor: ${bubbles('#D6E3F7', '#DCE8FA', '#FBE1EA')};
  --lfs-line: #D3DEF1; --lfs-step: #E3ECFA; --lfs-lace: #C9D6EE; --lfs-ribbon: #F08BB0;
  --lfs-accent: #4D6BFE; --lfs-accent-bg: #EBEFFF; --lfs-accent-text: #2A47A8; --lfs-pink: #E8739A; --lfs-pink-text: #B8406A;
  --dsw-alias-label-primary: #1A2340; --dsw-alias-label-secondary: #4E5A78; --dsw-alias-label-caption: #8B95AE;
  --dsw-alias-border-l2: #D3DEF1; --dsw-alias-border-l3: #C9D6EE; --dsw-alias-bg-layer-1: #FFFFFF; --dsw-alias-bg-skeleton: #EEF3FC;
  --dsw-alias-interactive-bg-hover: #EEF3FC; --dsw-alias-interactive-bg-active: #E1E9FB;
  --dsw-alias-state-success-primary: #23856A; --dsw-alias-state-error-primary: #D2455E; --dsw-alias-state-warn-primary: #B07A12;
  --dsw-alias-button-primary-fill: #4D6BFE; --dsw-alias-button-primary-hover: #3A55D6; --dsw-alias-label-primary-foreground: #FFFFFF;`
const DARK = `
  --lfs-paper: #121729; --lfs-floor: ${bubbles('#24304F', '#222D4A', '#3A2540')};
  --lfs-line: #2C3654; --lfs-step: #0B0F1E; --lfs-lace: #3A4670; --lfs-ribbon: #F08BB0;
  --lfs-accent: #7088FF; --lfs-accent-bg: rgba(112,136,255,.16); --lfs-accent-text: #B4C3FF; --lfs-pink: #F08BB0; --lfs-pink-text: #F59BBB;
  --dsw-alias-label-primary: #E6EBFA; --dsw-alias-label-secondary: #A7B1CE; --dsw-alias-label-caption: #747E9D;
  --dsw-alias-border-l2: #2C3654; --dsw-alias-border-l3: #3A4670; --dsw-alias-bg-layer-1: #1A2138; --dsw-alias-bg-skeleton: #202842;
  --dsw-alias-interactive-bg-hover: rgba(112,136,255,.10); --dsw-alias-interactive-bg-active: rgba(112,136,255,.18);
  --dsw-alias-state-success-primary: #4CC9A0; --dsw-alias-state-error-primary: #F0708A; --dsw-alias-state-warn-primary: #E8B85A;
  --dsw-alias-button-primary-fill: #5C78FF; --dsw-alias-button-primary-hover: #7088FF; --dsw-alias-label-primary-foreground: #FFFFFF;`
const LACE = 'radial-gradient(circle at 6px 0, transparent 3.4px, var(--lfs-lace) 3.9px, var(--lfs-lace) 4.6px, transparent 5.1px) 0 0 / 12px 6px repeat-x'

export const MAID_CSS = `
.lfs-maid {${LIGHT}
  --lfs-r-sm: 8px; --lfs-r-md: 16px; --lfs-card-bw: 1.5px; --lfs-card-shadow: 0 3px 0 var(--lfs-step);
  --dsw-radius-sm: 999px; --dsw-radius-md: 999px;
  --lfs-font: ui-rounded, "Hiragino Maru Gothic ProN", "M PLUS Rounded 1c", "Nunito", "Arial Rounded MT Bold", -apple-system, sans-serif;
  --lfs-num: var(--lfs-font);
  font-family: var(--lfs-font); font-variant-numeric: tabular-nums;
  background: var(--lfs-floor) 0 0 / 64px 64px, var(--lfs-paper);
}
.lfs-maid[data-theme='dark'] {${DARK} }
@media (prefers-color-scheme: dark) { .lfs-maid:not([data-theme='light']) {${DARK} } }
.lfs-maid button { font-family: inherit; }

/* the title bar: the mark in the accent, pill tabs, lace under it */
.lfs-maid .lfs-mark { color: var(--lfs-accent); }
.lfs-maid .lfs-head { padding-bottom: 10px; background: ${LACE.replace('0 0 /', '0 100% /')}; }
.lfs-maid .lfs-tab { height: 30px; align-self: center; border-radius: 999px; border: 1.5px solid transparent !important; }
.lfs-maid .lfs-tab[aria-selected='true'] { background: var(--lfs-accent-bg); border-color: var(--lfs-accent) !important; color: var(--lfs-accent-text) !important; }
.lfs-maid .lfs-tab[aria-selected='false'] { color: var(--dsw-alias-label-secondary) !important; }
.lfs-maid .lfs-tab[aria-selected='false'] .lfs-tab-icon { opacity: .75; }

/* cards: lace along the top; the page's main card wears a bow */
.lfs-maid .lfs-lace { position: relative; }
.lfs-maid .lfs-lace::before { content: ""; position: absolute; left: 16px; right: 16px; top: 0; height: 6px; z-index: 2; pointer-events: none; background: ${LACE}; }
.lfs-maid .lfs-bow { position: relative; }
.lfs-maid .lfs-bow::after { content: "🎀"; position: absolute; top: -10px; left: 50%; transform: translateX(-50%); font-size: 17px; line-height: 1; z-index: 3; pointer-events: none; }

/* section headings start with a ribbon-pink heart */
.lfs-maid .lfs-h::before { content: "♡"; margin-right: 6px; color: var(--lfs-pink); font-weight: 700; }
`

/** A tag's pastel chip colour, the board's Branch hues, chosen by the tag's name. */
const HUES = ['#4D6BFE', '#2AA4C8', '#7B5FE0', '#E0A63A', '#36AE8C', '#E8739A']
export const hueOf = (tag: string) => HUES[[...tag].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length]

// Ellen's sheet: ten 72×96 expressions side by side (view/src/skins/maids/cast.js)
const POSES = ['happy', 'thinking', 'thumbs_up', 'surprised', 'crying', 'angry', 'smug', 'sleepy', 'shy', 'love'] as const
export type Pose = typeof POSES[number]

/** Ellen in one expression, `height` pixels tall. */
export function Ellen({ pose, height = 48, title }: { pose: Pose, height?: number, title?: string }) {
  const k = POSES.indexOf(pose)
  return <span role="img" aria-label={title ?? `Ellen, ${pose.replace('_', ' ')}`} title={title}
    style={{ display: 'block', flex: 'none', width: height * 0.75, height, backgroundImage: `url(${ellen})`, backgroundSize: `${POSES.length * 100}% 100%`, backgroundPosition: `${(k / (POSES.length - 1)) * 100}% 0`, backgroundRepeat: 'no-repeat' }} />
}
