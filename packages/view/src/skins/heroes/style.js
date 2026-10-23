// The heroes skin's look: the LayerFS website's tokens (layerfs-website
// global.css), light only. It is the default: the view's shared rules
// (../../style.js) draw with these variables, and another skin redefines
// them under its data-skin (../maids/style.js).

export const HEROES_CSS = `
.lfs {
  /* the LayerFS website's tokens (layerfs-website global.css), light only */
  --font: "Instrument Sans", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Monaco, monospace;
  --paper: #FBF9F5; --dot: #EEE9DF; --line: #E2DED6; --line2: #ECE9E2; --tab: #F4F2EC; --lane: #F3F6FC;
  --trunk: #5C9A3C; --green-dark: #3F7524; --twig: #B9B2A6; --coral: #E07A5A; --coral-text: #B8502C; --coral-pale: #FBE9E2;
  --window: #FBF9F5; --chrome: #F4F2EC; --card: #FFFFFF; --well: #F0EEE8; --grid-bg: #FBF9F5;
  --text: #1E2533; --text-2: #5B6372; --text-3: #8A8780; --sep: #ECE9E2; --sep-strong: #E2DED6;
  --accent: #2F5BB5; --accent-bg: #E6EEFA; --green: #3E9B74; --orange: #D29A2E; --red: #C8452F; --purple: #8A6BC8;
  --orange-bg: rgba(210,154,46,.14); --purple-bg: rgba(138,107,200,.13); --red-bg: #FBE9E2; --green-bg: rgba(62,155,116,.13);
  --term: #FDFCFA; --term-head: #F6F4EF; --term-border: #E2DED6; --term-text: #1E2533; --term-dim: #8A8780;
  --t-blue: #2F5BB5; --t-green: #2E7D5B; --t-orange: #93650F; --t-red: #B8502C; --t-purple: #6A4DA8; --t-cyan: #1F6B78;
  --t-add-bg: rgba(46,125,91,.09); --t-del-bg: rgba(184,80,44,.09);
  /* Branch colours: the website demo's */
  --b0: #E07A5A; --b1: #3E9B74; --b2: #8A6BC8; --b3: #D29A2E; --b4: #2B8A9A; --b5: #C8557A;
  color-scheme: light;
}
`;
