// The sharky maid skin's look (the Cast button; its cast is ./cast.js, its
// voice ./voice.js). Colours: dsh's white and blue for the paper and accent,
// the dress's navy for text, a blue main bough, aqua, lavender, gold, mint and
// one ribbon pink for the Branches. Shapes: a rounded face, pill tabs and
// chips, round cards with lace and a bow, notebook terminals, a pastel bubble
// pattern. Everything is under data-skin="maids" and overrides the heroes'
// look (../heroes/style.js); LayerFS words and numbers never change.

const M = '.lfs[data-skin="maids"]';
const svg = (body) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`)}")`;
// the notebook's tools: a pencil (tip at the bottom left), an eraser and a paperclip
const PENCIL = svg(
  '<g transform="rotate(45 12 12)" stroke="#5B4636" stroke-width=".9" stroke-linejoin="round"><rect x="9.6" y="1" width="4.8" height="15" fill="#F6C453"/><rect x="9.6" y="1" width="4.8" height="3" fill="#F49AB5"/><path d="M9.6 16 12 22.2 14.4 16Z" fill="#F7E1BC"/><path d="M11.3 20.4 12 22.2 12.7 20.4Z" fill="#3A3A48"/></g>',
);
const ERASER = svg(
  '<g transform="rotate(-25 12 12)" stroke="#B8406A" stroke-width="1"><rect x="2.5" y="8" width="19" height="9" rx="2.2" fill="#F7B3C8"/><rect x="12" y="8" width="9.5" height="9" rx="1.6" fill="#E3ECFA"/></g>',
);
const CLIP = svg(
  '<path d="M8.5 7v9.5a3.5 3.5 0 0 0 7 0V5.2a2.4 2.4 0 0 0-4.8 0v10.3a1.1 1.1 0 0 0 2.2 0V7.5" fill="none" stroke="#D4537E" stroke-width="1.7" stroke-linecap="round"/>',
);
// the floor: bubbles and small hearts, pale, on cool white
const PATTERN = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="10" cy="12" r="3" fill="none" stroke="#D6E3F7" stroke-width="1.2"/><circle cx="16" cy="6" r="1.6" fill="#DCE8FA"/><path d="M44 40c-2-3.4-7-2-6.2 1.4.7 2.8 6.2 5.6 6.2 5.6s5.5-2.8 6.2-5.6C51 38 46 36.6 44 40z" fill="#FBE1EA"/><circle cx="52" cy="14" r="1.2" fill="#DCE8FA"/></svg>')}")`;

export const MAID_CSS = `
${M} {
  --paper: #F6F9FF; --dot: #DCE6F7; --line: #D3DEF1; --line2: #E3EAF7; --tab: #EDF2FC; --lane: #EAF0FC;
  --trunk: #3456C9; --green-dark: #2A47A8; --twig: #A9B6CF; --coral: #E8739A; --coral-text: #B8406A; --coral-pale: #FDEEF3;
  --window: #F6F9FF; --chrome: #EDF2FC; --card: #FFFFFF; --well: #EEF3FC; --grid-bg: #F6F9FF;
  --text: #1A2340; --text-2: #4E5A78; --text-3: #8B95AE; --sep: #E3EAF7; --sep-strong: #D3DEF1;
  --accent: #4D6BFE; --accent-bg: #EBEFFF; --green: #36AE8C; --orange: #E0A63A; --red: #D2455E; --purple: #7B5FE0;
  --orange-bg: rgba(224,166,58,.14); --purple-bg: rgba(123,95,224,.12); --red-bg: #FDEEF3; --green-bg: rgba(54,174,140,.13);
  --term: #FFFFFF; --term-head: #F3F7FE; --term-border: #D3DEF1; --term-text: #1A2340; --term-dim: #8B95AE;
  --t-blue: #3A55D6; --t-green: #23856A; --t-orange: #93650F; --t-red: #B8406A; --t-purple: #5D45B8; --t-cyan: #1D7896;
  --b0: #4D6BFE; --b1: #2AA4C8; --b2: #7B5FE0; --b3: #E0A63A; --b4: #36AE8C; --b5: #E8739A;
  --lace: #C9D6EE; --ribbon: #F08BB0;
  --font: ui-rounded, "Hiragino Maru Gothic ProN", "M PLUS Rounded 1c", "Nunito", "Arial Rounded MT Bold", -apple-system, sans-serif;
  font-family: var(--font);
}
/* the website's beige, where it is not a variable */
${M} .tab .tchip, ${M} .wtag.grey, ${M} .crow.off .st, ${M} .sbws .dt { background: var(--well); color: var(--text-2); }
${M} .bhead, ${M} .bcard .bhd .note, ${M} .tile span { color: var(--text-2); }
${M} .floor .none { color: var(--text-3); }
${M} .pool { border-top-color: var(--line); background: var(--well); color: var(--text-2); }
${M} .sbcards { background: transparent; }
${M} .floor { background: transparent; }
${M} .frow:hover, ${M} .cl:hover { background: var(--well); }
${M} .frow .ind { background: repeating-linear-gradient(90deg, transparent 0 6px, var(--dot) 6px 7px, transparent 7px 14px); }
${M} svg.tree .grid { stroke: var(--line2); }
${M} svg.tree .ground { fill: var(--lane); }
${M} svg.tree .groundline { stroke: var(--line); }
${M} .ovstrip { background: var(--well); border-radius: 8px; }
${M} .sv2 .hd { background: var(--text-2); } ${M} .sv2 .fc { background: #C9D5EC; } ${M} .sv2 .cp { background: var(--b1); } ${M} .sv2 .md { background: var(--twig); }
${M} .sv2 .fs { background: var(--b2); } ${M} .sv2 .ws { background: var(--b5); } ${M} .sv2 .ot { background: var(--twig); }

/* the floor */
${M} .lfs-cols { background: var(--paper) ${PATTERN} 0 0 / 64px 64px; }

/* pills: tabs, chips, tags, the switches */
${M} .tab { border: 1.5px solid var(--line); border-radius: 999px; margin: 0 0 6px; min-height: 32px; padding: 4px 12px; background: var(--card); font-family: var(--font); }
${M} .tab[aria-selected="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
${M} .tab[aria-selected="true"] .tchip { background: rgba(255,255,255,.22); color: #fff; }
${M} .tab .sq { border-radius: 50%; }
${M} .tab .tchip, ${M} .wtag, ${M} .sign, ${M} .sbws .dt, ${M} .crow .st { border-radius: 999px; }
${M} .ctl { border-radius: 999px; overflow: hidden; border-width: 1.5px; }
${M} .ctl button { font-family: var(--font); }
${M} .ctl button.on { background: var(--accent); }

/* cards: round, a soft step under them, lace along the top, a bow on the bigger ones */
${M} .panel, ${M} .board, ${M} .term { border-radius: 16px; box-shadow: 0 0 0 1.5px var(--line), 0 4px 0 #E3ECFA; border: 0; }
${M} .board { position: relative; overflow: visible; }
${M} .board > .bhead { border-radius: 16px 16px 0 0; }
${M} .bcard, ${M} .sbrow, ${M} .tile, ${M} .wchip { border-radius: 12px; overflow: hidden; }
${M} .bcard .bhd .sq, ${M} .tab .sq { border-radius: 50%; }
${M} .panel.hist { position: relative; }
${M} .board::before, ${M} .term::before, ${M} .panel.hist::before {
  content: ""; position: absolute; left: 14px; right: 14px; top: 0; height: 6px; z-index: 2; pointer-events: none;
  background: radial-gradient(circle at 6px 0, transparent 3.4px, var(--lace) 3.9px, var(--lace) 4.6px, transparent 5.1px) 0 0 / 12px 6px repeat-x;
}
${M} .board::after, ${M} .panel.hist::after { content: "🎀"; position: absolute; top: -11px; left: 50%; transform: translateX(-50%); font-size: 17px; line-height: 1; z-index: 3; pointer-events: none; }
${M} .bhead .t, ${M} .thead .t { font-family: var(--font); font-weight: 600; }
/* History as an editor: its History tab sits under the tab row, flat, without lace or a bow */
${M} .lfs-ide .ide-main > .panel.hist { border-radius: 0; box-shadow: none; }
${M} .lfs-ide .panel.hist::before, ${M} .lfs-ide .panel.hist::after { content: none; }
${M} .panel.hist:has(> .lfs-ide)::after { content: none; } /* the bow would sit on the tab row */
${M} .lfs-ide .ide-tabs button[aria-selected="true"] { box-shadow: inset 0 -2px 0 #F2B8CC; }

/* notebook terminals: ruled lines and a pink margin; the LayerFS stamp gives way */
${M} .tbody {
  background: linear-gradient(90deg, transparent 22px, #F7C5D6 22px, #F7C5D6 23.5px, transparent 23.5px),
    repeating-linear-gradient(transparent 0 calc(1.7em - 1px), #E6EEFA calc(1.7em - 1px) 1.7em);
  background-attachment: local; padding-left: 32px;
}
${M} .wm { display: none; }
/* a Branch's notebook is one round card; its blocks are plain paper inside it */
${M} .nb { border-radius: 16px; box-shadow: 0 0 0 1.5px var(--line), 0 4px 0 #E3ECFA; }
${M} .work.branchview:not(.withhist) .nb { overflow: hidden; }
${M} .nb > .term { border-radius: 0; box-shadow: none; }
${M} .nb > .term::before { display: none; }
${M} .nb::before {
  content: ""; position: absolute; left: 14px; right: 14px; top: 0; height: 6px; z-index: 2; pointer-events: none;
  background: radial-gradient(circle at 6px 0, transparent 3.4px, var(--lace) 3.9px, var(--lace) 4.6px, transparent 5.1px) 0 0 / 12px 6px repeat-x;
}
${M} .nb > .wterm:nth-child(even), ${M} .nb > .wterm:nth-child(n+3), ${M} .nb.n3 > .wterm:nth-child(3) { border-color: #F2B8CC; }

/* the notebook's hand, on a step's first draw. A pencil writes each new command (no caret);
   a highlighter runs over what a read looked at; a failed line keeps a red wavy underline.
   A Workspace's page is held by a paperclip from mount until unmount, when an eraser rubs
   it out and the clip falls off; each Commit closes a margin bracket around the calls it
   captured, with its id as a sticker. The project opens with a ruler line under Init; a
   fork and a merge draw a vine in the margin in the Branch's colour; a publish is stamped
   with its Layer and ruled off. An fs script's calls share a margin line: solid when it
   wrote, dotted when it only read. */
${M} .wterm .ln.typing .cmd { border-right: 0; animation: lfs-type var(--d) linear both, lfs-unclipped var(--d) linear; }
@keyframes lfs-unclipped { from, to { text-overflow: clip; } }
${M} .wterm .ln.typing .pen { display: inline-block; position: relative; width: 0; height: 1em; }
${M} .wterm .ln.typing .pen::before { content: ""; position: absolute; left: -3px; bottom: 2px; width: 19px; height: 19px; background: ${PENCIL} center / contain no-repeat; transform-origin: 0 100%; pointer-events: none;
  animation: lfs-pen-wiggle .16s ease-in-out infinite alternate, lfs-pen-lift .3s var(--d) ease-in forwards; }
@keyframes lfs-pen-wiggle { from { transform: rotate(-7deg); } to { transform: rotate(4deg) translateY(-1px); } }
@keyframes lfs-pen-lift { to { opacity: 0; transform: translate(9px, -10px) rotate(14deg); } }
${M} .wterm .ln.new.op-read .cmd { background: linear-gradient(rgba(246,196,83,.55), rgba(246,196,83,.55)) left 60% / 0% 72% no-repeat; border-radius: 2px; animation: lfs-hl var(--d, .4s) ease-out forwards; }
@keyframes lfs-hl { to { background-size: 100% 72%; } }
${M} .wterm .out.bad { text-decoration: underline wavy #E8739A; text-decoration-thickness: 1px; text-underline-offset: 3px; }
${M} .wterm[data-sb] > .thead { position: relative; }
${M} .wterm[data-sb] > .thead::after { content: ""; position: absolute; left: 50%; top: -5px; width: 16px; height: 28px; background: ${CLIP} center / contain no-repeat; transform: rotate(10deg); pointer-events: none; z-index: 3; }
${M} .wterm.enter[data-sb] > .thead::after { animation: lfs-clip-on .5s .2s cubic-bezier(.2,1.6,.4,1) both; }
${M} .wterm.leaving[data-sb] > .thead::after { animation: lfs-clip-off .6s calc(var(--ld, 0ms) + 1300ms) ease-in forwards; }
@keyframes lfs-clip-on { from { opacity: 0; transform: translateY(-16px) rotate(-30deg); } }
@keyframes lfs-clip-off { to { opacity: 0; transform: translate(22px, 40px) rotate(70deg); } }
${M} .wterm.leaving[data-sb] .tbody::after { content: ""; position: absolute; left: 34px; top: 12px; width: 24px; height: 24px; background: ${ERASER} center / contain no-repeat; pointer-events: none; opacity: 0; animation: lfs-erase 1.2s var(--ld, 0ms) ease-in-out both; }
@keyframes lfs-erase { 0% { opacity: 0; transform: none; } 10% { opacity: 1; } 25% { transform: translate(150px, 4px); } 40% { transform: translate(10px, 34px); } 55% { transform: translate(170px, 52px); } 70% { transform: translate(20px, 84px); } 90% { opacity: 1; transform: translate(190px, 104px); } 100% { opacity: 0; transform: translate(210px, 110px); } }
${M} .wterm.leaving[data-sb] .tbody > * { animation: lfs-rubbed .9s calc(var(--ld, 0ms) + 200ms) ease-in forwards; }
@keyframes lfs-rubbed { to { opacity: .14; filter: blur(1px); } }
${M} .wterm .ru, ${M} .wterm .ln.op-commit, ${M} .wterm .ln.op-fork, ${M} .wterm .ln.op-merge { position: relative; }
/* a margin span is painted inside each of its lines (an output line clips what lies outside
   it): the line reaches into the margin, a stroke runs down its left edge, and the span's
   first and last lines hook in at the top and bottom */
${M} .wterm .cm, ${M} .wterm .gw, ${M} .wterm .gr { --c: #8C7BE0; --t: 0px; --b: 0px; --ht: 0px; --hb: 0px; --v: linear-gradient(var(--c), var(--c));
  margin-left: -27px; padding-left: 27px; background: var(--v) 0 var(--t) / 1.6px calc(100% - var(--t) - var(--b)) no-repeat,
    linear-gradient(var(--c), var(--c)) 0 var(--t) / var(--ht) 1.6px no-repeat, linear-gradient(var(--c), var(--c)) 0 calc(100% - var(--b)) / var(--hb) 1.6px no-repeat; }
${M} .wterm .gw { --c: #8B95AE; }
${M} .wterm .gr { --c: #E0A63A; --v: repeating-linear-gradient(var(--c) 0 2px, transparent 2px 4px); }
${M} .wterm .cm0, ${M} .wterm .gw0, ${M} .wterm .gr0 { --t: 6px; --ht: 7px; }
${M} .wterm .cm1, ${M} .wterm .gw1, ${M} .wterm .gr1 { --b: 6px; --hb: 7px; }
${M} .wterm .cmnew { animation: lfs-bracket .45s ease-out both; }
@keyframes lfs-bracket { from { background-size: 1.6px 0, 0 1.6px, 0 1.6px; } }
${M} .wterm .stk { display: inline-block; position: absolute; left: -4px; top: 3px; padding: 0 2px; border: 1px solid #AFA9EC; border-radius: 4px; background: #EEEDFE; color: #3C3489; font: 700 9px/13px var(--mono); transform: rotate(-9deg); z-index: 1; }
${M} .wterm .ln.new .stk { animation: lfs-pop .35s .35s cubic-bezier(.2,1.8,.4,1) both; }
@keyframes lfs-pop { from { transform: scale(0) rotate(-40deg); } }
${M} .wterm .seal { display: inline-block; margin-left: 8px; padding: 0 5px; border: 1.5px solid #D2455E; border-radius: 4px; color: #D2455E; font: 700 10.5px/15px var(--mono); transform: rotate(-7deg); }
${M} .wterm .ln.new .seal { animation: lfs-seal .45s var(--d, 0ms) cubic-bezier(.2,1.8,.4,1) both; }
@keyframes lfs-seal { from { opacity: 0; transform: scale(2.4) rotate(-22deg); } }
${M} .wterm .ru1::after { content: ""; position: absolute; left: -10px; right: 12px; bottom: 0; height: 1.5px; border-radius: 1px; background: #8B95AE; transform-origin: left; pointer-events: none; }
${M} .wterm .runew.ru1::after { animation: lfs-ruler .5s calc(var(--d, 0ms) + 250ms) ease-out both; }
@keyframes lfs-ruler { from { transform: scaleX(0); } }
${M} .wterm .ln.op-init .cmd { font-weight: 700; }
${M} .wterm .ln.op-fork::before, ${M} .wterm .ln.op-merge::before { content: ""; position: absolute; left: -26px; top: -9px; width: 10px; height: 19px; border: 0 solid var(--bc, #7B5FE0); border-bottom-width: 1.8px; pointer-events: none; }
${M} .wterm .ln.op-fork::before { border-left-width: 1.8px; border-bottom-left-radius: 9px; }
${M} .wterm .ln.op-merge::before { border-right-width: 1.8px; border-bottom-right-radius: 9px; }
${M} .wterm .ln.new.op-fork::before, ${M} .wterm .ln.new.op-merge::before { animation: lfs-vine .45s ease-out both; }
@keyframes lfs-vine { from { clip-path: inset(0 0 100% 0); } }
@media (prefers-reduced-motion: reduce) { ${M} .wterm *, ${M} .wterm *::before, ${M} .wterm *::after, ${M} .wterm > .thead::after { animation: none !important; } ${M} .wterm .pen, ${M} .wterm.leaving .tbody::after { display: none !important; } }

/* bubbles: round, ribbon-edged; sparkles and hearts float up once */
${M} .bubble { border-radius: 14px; font: 600 12px var(--font); border: 1.5px solid var(--ribbon); box-shadow: 0 4px 12px rgba(77,107,254,.18); }
${M} .bubble.good { color: var(--t-blue); border-color: #A9BCF8; }
${M} .bubble.bad { color: var(--coral-text); }
${M} .block { border-radius: 50%; }
.lfs .maidfx { position: absolute; z-index: 46; pointer-events: none; font-size: 14px; line-height: 1; transform: translate(-50%, -50%); animation: lfs-maidfx 1.1s ease-out forwards; }
@keyframes lfs-maidfx { 0% { opacity: 0; transform: translate(-50%, -50%) scale(.4); } 25% { opacity: 1; transform: translate(calc(-50% + var(--dx)), calc(-50% - 10px)) scale(1.1); } 100% { opacity: 0; transform: translate(calc(-50% + var(--dx) * 1.6), calc(-50% - 34px)) scale(.9); } }
@media (prefers-reduced-motion: reduce) { .lfs .maidfx { animation: none; opacity: 0; } }
`;
