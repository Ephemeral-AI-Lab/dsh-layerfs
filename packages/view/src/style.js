// The view's stylesheet, scoped under .lfs so it neither leaks into nor takes
// from the dsh page around it. Keyframes are named lfs-*.
import { HEROES_CSS } from "./skins/heroes/style.js";
import { MAID_CSS } from "./skins/maids/style.js";

export const CSS = `
${HEROES_CSS}
.lfs, .lfs * { box-sizing: border-box; }
.lfs button:not(.lfs-own *) { font: inherit; color: inherit; } /* .lfs-own: a page the host draws with its own controls (Sandboxes) */
/* title bar + tabs: the website's Branch tabs */
.lfs .tabs { display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-end; align-self: stretch; min-width: 0; flex: 1; padding: 8px 0 0; }
.lfs .tab { min-height: 40px; display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; color: var(--text); white-space: nowrap; border: 1px solid transparent; border-bottom: 0; background: transparent; position: relative; font: 13px var(--mono); transition: opacity .4s, background .2s; margin-bottom: -1px; }
.lfs .tab:hover { background: rgba(255,255,255,.6); }
.lfs .tab[aria-selected="true"] { background: #fff; border-color: var(--line); }
.lfs .tab.dim { opacity: .55; }
.lfs .tab .sq { width: 8px; height: 8px; background: var(--bc); flex: none; }
.lfs .tab.main .sq { background: var(--accent); }
.lfs .tab .tchip { font: 11.5px var(--mono); padding: 1px 6px; background: #F0EEE8; color: #6B6964; }
.lfs .tab .tchip.ro { background: var(--coral-pale); color: var(--coral-text); }
.lfs .tab .tchip.bad { background: var(--coral-pale); color: var(--coral-text); }
.lfs .tab.conflict { color: var(--t-red); }
.lfs .tab .avs { display: inline-flex; gap: 1px; }
.lfs .tab .pin { opacity: 0; font-size: 10px; padding: 0 2px; }
.lfs .tab:hover .pin, .lfs .tab .pin.on { opacity: .8; }
.lfs .tab.enter { animation: lfs-grow .35s ease-out; }
.lfs .tab.more { font: 600 11px var(--mono); }
.lfs .menu { position: absolute; z-index: 60; background: var(--card); border-radius: 0; box-shadow: 0 10px 30px rgba(0,0,0,.25), 0 0 0 .5px var(--sep-strong); padding: 4px; min-width: 160px; }
.lfs .menu button { display: flex; width: 100%; gap: 8px; align-items: center; border: 0; background: transparent; padding: 6px 8px; border-radius: 5px; cursor: pointer; text-align: left; }
.lfs .menu button:hover { background: var(--accent-bg); }
.lfs .ib { height: 26px; min-width: 26px; padding: 0 8px; border: 1px solid transparent; border-radius: 0; font: 11.5px var(--mono); background: transparent; cursor: pointer; color: var(--text-2); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.lfs .ib:hover { background: var(--sep); color: var(--text); }
.lfs .ib.on { color: var(--accent); border-color: var(--accent); background: var(--card); }
.lfs .ib svg { width: 15px; height: 15px; }
/* work area */
.lfs .work { flex: 1; min-height: 0; display: grid; gap: 12px; padding: 12px; background: var(--card); }
/* History like an editor (view.js drawIde), on a project page and in a conversation: Files' tree in a sidebar, then File, History and Storage as tabs */
.lfs.lfs-project { display: flex; flex-direction: column; min-height: 0; background: var(--window); }
.lfs .lfs-ide { flex: 1; min-width: 0; min-height: 0; display: flex; flex-wrap: wrap; container: ide / inline-size; background: var(--window); }
.lfs-ide .ide-side { flex: none; width: 248px; height: 100%; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); background: var(--card); }
.lfs-ide .ide-title { flex: none; display: flex; align-items: center; gap: 8px; min-width: 0; height: 38px; padding: 0 12px; border-bottom: 1px solid var(--line); background: var(--tab); font-size: 12.5px; }
.lfs-ide .ide-title .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.lfs-ide .ide-title b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs-ide .ide-title .pt { margin-left: auto; flex: none; font: 11.5px var(--mono); color: var(--text-3); }
.lfs-ide .ide-latest { flex: none; border: 0; border-radius: 4px; padding: 1px 6px; background: var(--accent-bg); color: var(--accent); font: 11px var(--mono); cursor: pointer; }
.lfs-ide .ide-side .ftree { padding-top: 6px; }
/* a wrapping row's line is as tall as its content: the full heights keep History's tree scrolling inside */
.lfs-ide .ide-main { flex: 1 1 360px; height: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.lfs-ide .ide-tabs { flex: none; height: 38px; display: flex; align-items: stretch; min-width: 0; overflow-x: auto; border-bottom: 1px solid var(--line); background: var(--tab); scrollbar-width: none; }
.lfs-ide .ide-tabs button { flex: none; display: flex; align-items: center; gap: 6px; max-width: 220px; padding: 0 14px; border: 0; border-right: 1px solid var(--line); background: transparent; color: var(--text-3); font-size: 12.5px; cursor: pointer; }
.lfs-ide .ide-tabs button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs-ide .ide-tabs button svg { flex: none; }
.lfs-ide .ide-tabs button:hover { color: var(--text); }
.lfs-ide .ide-tabs button[aria-selected="true"] { background: var(--card); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
.lfs-ide .ide-tabs .ide-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--orange); }
.lfs-ide .ide-tabs .ide-dot.down { background: var(--red); }
.lfs-ide .ide-tabs button[data-ide="file"] span { font-family: var(--mono); font-size: 12px; }
.lfs-ide .ide-tabs .ide-close { font-style: normal; margin-left: 2px; padding: 0 4px; border-radius: 4px; color: var(--text-3); line-height: 18px; }
.lfs-ide .ide-tabs .ide-close:hover { background: var(--well); color: var(--text); }
.lfs-ide .ide-tabs .ide-toggle { padding: 0 11px; color: var(--text-3); }
.lfs-ide .ide-tabs .ide-toggle[aria-pressed="true"] { color: var(--accent); }
.lfs .lfs-ide.side-hidden > .ide-side { display: none; }
.lfs .lfs-ide .ide-main > .hist { flex: 1; min-height: 0; border: 0; box-shadow: none; }
.lfs-ide .ide-store { flex: 1; min-height: 0; overflow: auto; background: var(--card); }
.lfs .lfs-ide .spage { display: grid; gap: 28px; min-width: 0; padding: 22px 24px 28px; font: 12px/1.5 var(--mono); }
.lfs .lfs-ide .spage .sp-top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px 40px; }
.lfs .lfs-ide .spage .sp-disk { display: grid; gap: 6px; }
.lfs .lfs-ide .spage .sp-disk > div { display: flex; align-items: baseline; gap: 8px; }
.lfs .lfs-ide .spage .sp-disk p { margin: 0; font-size: 11px; color: var(--text-3); }
.lfs .lfs-ide .spage .sp-disk b { font: 500 34px/1 var(--mono); color: var(--text); letter-spacing: -.02em; }
.lfs .lfs-ide .spage .sp-disk span { color: var(--text-3); }
.lfs .lfs-ide .spage .sp-facts { flex: 1 1 300px; max-width: 520px; min-width: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 0; }
.lfs .lfs-ide .spage .sp-fact { display: grid; gap: 2px; min-width: 0; padding: 0 16px; border-left: 1px solid var(--line); }
.lfs .lfs-ide .spage .sp-fact b { font: 500 16px var(--mono); color: var(--text); }
.lfs .lfs-ide .spage .sp-fact span { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs .lfs-ide .spage .sp-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 28px 48px; align-items: start; }
.lfs .lfs-ide .spage section { display: grid; gap: 10px; min-width: 0; }
.lfs .lfs-ide .spage h4 { margin: 0; padding-bottom: 6px; border-bottom: 1px solid var(--line2); font: 600 11px var(--font); letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); }
.lfs .lfs-ide .spage .srows { gap: 9px 12px; }
.lfs .lfs-ide .spage .bw { height: 10px; border-radius: 2px; background: var(--well); }
.lfs .lfs-ide .spage .bw > span { border-radius: 2px; }
.lfs .lfs-ide .spage .snote { margin: 0; font-size: 11px; }
.lfs .lfs-ide .spage .sp-cost { display: flex; flex-wrap: wrap; gap: 4px 18px; color: var(--text-3); }
.lfs .lfs-ide .spage .sp-cost b { font-weight: 500; color: var(--text); }
.lfs .lfs-ide .spage .sbars { height: 96px; gap: 2px; padding-bottom: 1px; border-bottom: 1px solid var(--line); }
.lfs .lfs-ide .spage .sbars > span { border-radius: 2px 2px 0 0; }
.lfs .lfs-ide .spage .sp-old { margin-left: auto; float: right; }
/* narrow: the main area wraps under the sidebar, which takes the whole width (.lfs-ide is the container, so its children change) */
@container ide (max-width: 620px) {
  .lfs .lfs-ide .spage { padding: 16px 14px 20px; gap: 22px; }
  .lfs .lfs-ide .spage .sp-disk b { font-size: 26px; }
  .lfs-ide .ide-side { width: 100%; height: 200px; border-right: 0; border-bottom: 1px solid var(--line); }
  .lfs-ide .ide-main { height: calc(100% - 200px); min-height: 360px; }
}
.lfs .split { cursor: col-resize; position: relative; touch-action: none; }
.lfs .split::after { content: ""; position: absolute; top: 0; bottom: 0; left: 5.5px; width: 1px; background: var(--term-border); transition: background .15s, width .15s, left .15s; }
.lfs .split:hover::after { left: 5px; width: 2px; background: var(--accent); }
/* main: storage over Branches (with their Sandboxes) on the left, the project
   log on the right the full height; under 760 one under another (the container
   queries below). Storage keeps its own height, Branches take the rest; each
   box scrolls inside itself. */
.lfs .work.mainview { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: max-content minmax(auto, 1fr); overflow-y: auto; } /* the storage row is as tall as its card */
.lfs .work.mainview > .storep { grid-column: 1; grid-row: 1; }
.lfs .work.mainview > .board { grid-column: 1; grid-row: 2; }
.lfs .work.mainview > .term:not(.storep) { grid-column: 2; grid-row: 1 / span 2; }
.lfs .work.mainview > * { min-width: 0; }
/* No box is squeezed: each keeps room for its header and one row of normal
   cards (two across), empty or not; a short view scrolls instead. */
.lfs .work.mainview { --cards-min: 92px; }
.lfs .work.mainview .floor { min-height: var(--cards-min); }
/* Branches never shrink below a few cards; the project log spans storage and
   Branches, so it grows with them; a short window scrolls the whole tab */
.lfs .work.mainview > .board { min-height: 340px; }
.lfs .work.mainview > .term { min-height: 160px; }
.lfs .work.mainview.withhist { grid-template-columns: minmax(300px, 360px) repeat(2, minmax(0, 1fr)); }
.lfs .work.mainview.withhist > .storep, .lfs .work.mainview.withhist > .board { grid-column: 2; }
.lfs .work.mainview.withhist > .term:not(.storep) { grid-column: 3; }
/* a Branch: its info, its agents, then its terminals two by two; more than four
   terminals keep their height and the whole view scrolls */
.lfs .work.branchview { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.lfs .work.branchview:not(.withhist) .wgrid { flex: 1 0 auto; overflow: visible; grid-auto-rows: minmax(240px, 1fr); }
/* the preview's layout: History is the work area's first column */
.lfs .work.withhist { grid-template-columns: minmax(360px, 440px) minmax(0, 7fr) minmax(0, 5fr); background: var(--paper); }
.lfs .work.branchview.withhist { display: grid; grid-template-columns: minmax(360px, 440px) minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); }
.lfs .work.branchview.withhist .hist { grid-row: 1 / -1; }
.lfs .work.withhist .hist { grid-row: 1 / -1; }
.lfs .ctl { display: flex; flex: none; align-self: flex-end; margin: 0 0 8px; border: 1px solid var(--line); background: #fff; }
.lfs .ctl button { min-height: 28px; border: 0; padding: 0 8px; font: 11.5px var(--mono); background: transparent; color: var(--text-2); cursor: pointer; }
.lfs .ctl button:hover { color: var(--accent); }
.lfs .ctl button.on { background: var(--text); color: #fff; }
/* terminals (Term in OrchestrationDemo.jsx) */
.lfs .wterm { border: 1px solid var(--line); box-shadow: none; }
.lfs .wterm .thead { height: auto; padding: 6px 10px; font: 12px var(--mono); border-bottom: 1px solid var(--line); gap: 8px; }
.lfs .wterm .thead .t { font-weight: 500; color: var(--text); }
.lfs .wterm .thead .ghost { color: var(--text-3); min-width: 0; overflow: hidden; text-overflow: ellipsis; border: 0; background: none; padding: 0; font: inherit; }
.lfs .wterm .thead .sp { flex: 1; margin-right: -8px; }
.lfs .wterm .thead .ghost.sbchip { flex: 0 1 auto; cursor: pointer; }
.lfs .wterm .thead .ghost.sbchip:hover { color: var(--t-orange); background: none; }
.lfs .wterm .thead .av { width: 22px; height: 18px; }
.lfs .tbox { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.lfs .tbox .wm { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); height: 76%; max-height: 240px; min-height: 48px; width: auto; pointer-events: none; font-family: var(--mono); }
.lfs .wterm .tbody { position: relative; padding: 6px 10px; font: 12.5px/1.6 var(--mono); white-space: normal; }
.lfs .wterm.cap { flex: none; height: 300px; }
/* a terminal fills from the top, like a real one; once full it scrolls to its newest line (view.js) */
.lfs .wterm.cap .tbody { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; justify-content: flex-start; }
.lfs .wterm.cap .fsmore { color: var(--text-3); }
.lfs .wterm .ln { white-space: normal; }
/* a line's row: prompt, command (shortened with "…"), agent, time, sdk; the time never leaves the view */
.lfs .wterm .lrow { display: flex; align-items: center; min-width: 0; white-space: nowrap; }
.lfs .wterm .lrow > * { flex: none; }
.lfs .wterm .lrow .prompt { white-space: pre; }
.lfs .wterm .lrow .cmd { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lfs .wterm .ln .grp { display: none; }
.lfs .wterm .ln .av { width: 20px; height: 15px; margin-left: 6px; }
.lfs .wterm .lrow .tm { margin-left: 8px; }
/* a new command types itself out, then its time, sdk and output appear */
.lfs .wterm .ln.typing .cmd { max-width: calc(var(--n) * 1ch + 0.55ch); border-right: 0.55ch solid transparent; animation: lfs-type var(--d) steps(var(--n), end) both, lfs-caret var(--d) step-end both; }
.lfs .wterm .ln.typing .lrow > :not(.cmd):not(.prompt):not(.pen) { animation: lfs-fadein .25s var(--d) both; }
.lfs .wterm .out.new[style] { animation: lfs-fadein .25s var(--d) both; }
@keyframes lfs-type { from { max-width: 0; } }
@keyframes lfs-caret { 0% { border-right-color: var(--accent); } 100% { border-right-color: transparent; } }
.lfs .wterm .pen, .lfs .wterm .stk, .lfs .wterm .seal { display: none; } /* the maids' notebook hand: skins/maids/style.js */
.lfs .wterm .out { padding-left: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lfs .wterm.hot { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.lfs .wterm.bad { border-color: var(--coral); box-shadow: 0 0 0 2px var(--coral); }
.lfs .wtag { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 6px; flex: 0 1 auto; }
.lfs .wterm .thead .t, .lfs .storep .thead .t { flex: none; }
.lfs .wtag.grey { background: #F0EEE8; color: var(--text-2); }
.lfs .wtag.blue { background: var(--accent-bg); color: var(--accent); }
.lfs .wtag.coral { background: var(--coral-pale); color: var(--coral-text); }
.lfs .fsi { flex: none; }
/* main: the Branch cards on a sand floor (AgentBoard), the Store (StorePanel), the project terminal */
.lfs .board { display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--line); background: #fff; }
.lfs .bhead { display: flex; flex-wrap: nowrap; white-space: nowrap; align-items: center; gap: 4px 12px; padding: 6px 10px; border-bottom: 1px solid var(--line); background: var(--term-head); font: 12px var(--mono); color: #6B6964; }
.lfs .bhead .t { font-weight: 500; color: var(--text); }
.lfs .bhead .sp { flex: 1; margin-right: -8px; }
.lfs .bhead .roster { flex: none; border: 0; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.lfs .bhead .roster:hover { color: var(--accent); }
.lfs .floor { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; background: #F6EEDD radial-gradient(#E9DCC0 1px, transparent 1px) 0 0 / 12px 12px; }
/* cards stack in columns at least 300px wide (one full-width list in a normal board), each right under the one above, so a short card leaves no hole beside a tall one;
   the stack keeps its natural height and the floor scrolls it (a fixed height would spill extra columns sideways) */
.lfs .floor .stack { columns: 300px; column-gap: 8px; }
.lfs .floor .stack > .bcard { break-inside: avoid; margin-bottom: 8px; }
.lfs .floor .none { padding: 24px 0; text-align: center; font: 12px var(--mono); color: #8C6A3A; }
.lfs .bcard { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--bc); background: #fff; transition: opacity .3s; }
.lfs .bcard.dim { opacity: .55; }
.lfs .bcard.flash { animation: lfs-flash 1s ease-out; }
.lfs .bcard .bhd { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font: 12.5px var(--mono); background: color-mix(in srgb, var(--bc) 10%, white); cursor: pointer; min-width: 0; }
.lfs .bcard .bhd .sq { width: 10px; height: 10px; background: var(--bc); flex: none; }
.lfs .bcard .bhd .nm { font-weight: 500; color: color-mix(in srgb, var(--bc) 75%, black); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lfs .bcard .bhd .note { margin-left: auto; flex: none; font-size: 11px; color: #6B6964; }
.lfs .crow { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-top: 1px solid var(--line2); font: 12px var(--mono); cursor: default; }
.lfs .crow[data-dws] { cursor: pointer; }
.lfs .crow.off { opacity: .6; }
.lfs .crow .av { width: 24px; height: 20px; }
.lfs .crow .nm { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lfs .crow .st { margin-left: auto; flex: none; padding: 1px 4px; font-size: 10.5px; background: color-mix(in srgb, var(--ac) 12%, white); color: color-mix(in srgb, var(--ac) 80%, black); }
.lfs .crow.off .st { background: #F0EEE8; color: var(--text-3); }
.lfs .crow.sblit { box-shadow: inset 0 0 0 2px var(--orange); }
.lfs .bcard.pulse { animation: lfs-focuspane 1.6s ease-out; }
.lfs .pool { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 6px 10px; border-top: 1px solid #E4D6B8; background: #EFE3C8; font: 11px var(--mono); color: #8C6A3A; }
.lfs .pool .av { width: 22px; height: 18px; opacity: .7; }
.lfs .board > .bhead, .lfs .board > .pool { flex: none; }
/* a Sandbox as a chip: on a Workspace's row and in the box's foot; hover lights every chip and row in it */
.lfs .sbc { display: inline-flex; align-items: center; gap: 4px; flex: 0 1 auto; min-width: 0; padding: 1px 5px; border: 1px solid #C9D3E6; background: var(--accent-bg); color: var(--accent); font: 11px var(--mono); white-space: nowrap; cursor: default; transition: box-shadow .15s; }
.lfs .sbc .boxi { flex: none; width: 12px; height: 12px; }
.lfs .sbc .pre { flex: 0 1 auto; min-width: 2ch; overflow: hidden; text-overflow: ellipsis; opacity: .65; }
.lfs .sbc b { flex: 0 1 auto; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.lfs .sbc .wsn { flex: none; margin-left: 2px; color: var(--text-2); }
.lfs .sbc.closed { opacity: .55; border-style: dashed; }
.lfs .sbc.sblit { box-shadow: 0 0 0 2px var(--orange); }
.lfs .sbc.pulse { animation: lfs-focuspane 1.6s ease-out; }
/* on a Workspace's row the Sandbox chip gives way before the agent's name */
.lfs .crow .sbc { flex-shrink: 6; }
.lfs .crow.ws .nm { flex: 0 1 auto; min-width: 3ch; }
.lfs .crow .dt { flex: none; padding: 0 4px; font-size: 10.5px; background: #F0EEE8; color: var(--text-2); }
.lfs .crow .dt.warn { background: var(--coral-pale); color: var(--coral-text); }
.lfs .crow[data-dws]:hover { background: color-mix(in srgb, var(--bc) 8%, white); }
/* the header's count of Workspaces and Sandboxes: hover or focus opens every Sandbox's record */
.lfs .sbsum { position: relative; display: inline-flex; flex: 0 1 auto; min-width: 0; cursor: default; outline: none; }
.lfs .sbsum:focus-visible .wtag { box-shadow: 0 0 0 2px var(--accent); }
.lfs .sbpop { display: none; position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: min(320px, calc(100vw - 32px)); max-height: 360px; overflow-y: auto; padding: 4px; border: 1px solid var(--line); background: var(--card); box-shadow: 0 10px 28px rgba(30,37,51,.18); font: 11px var(--mono); color: var(--text-2); white-space: normal; }
.lfs .sbsum:hover .sbpop, .lfs .sbsum:focus-within .sbpop { display: block; }
.lfs .sbsum.lefty .sbpop { right: auto; left: 0; }
.lfs .sbli { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 8px; padding: 6px; border-bottom: 1px solid var(--line2); }
.lfs .sbli:last-child { border-bottom: 0; }
.lfs .sbli.closed { opacity: .6; }
.lfs .sbli .sbst { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-3); }
.lfs .sbli .sbst::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); }
.lfs .sbli .sbst.on { color: var(--green-dark); }
.lfs .sbli .sbst.on::before { background: var(--green); }
.lfs .sbli .sbm { flex-basis: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); }
.lfs .sbli .sbm.l { color: var(--text-2); }
.lfs .sbproc { display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-top: 1px solid var(--line2); font: 11.5px var(--mono); color: var(--green-dark); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs .sbproc .d { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none; }
.lfs .hint-i { display: inline-grid; place-items: center; width: 14px; height: 14px; border-radius: 50%; border: 1px solid currentColor; font: italic 600 9.5px/1 var(--font); color: var(--text-3); cursor: help; flex: none; }
.lfs .hint-i:hover, .lfs .hint-i:focus { color: var(--accent); outline: none; }
.lfs .menu .mhead { padding: 6px 8px 2px; border-top: 1px solid var(--line2); margin-top: 4px; font: 10.5px var(--mono); color: var(--text-3); }
.lfs .menu .mt { margin-left: auto; font: 10.5px var(--mono); color: var(--text-3); }
.lfs .tab.more.retired { color: var(--text-3); font-weight: 400; }
.lfs .storep { flex: none; border: 1px solid var(--line); box-shadow: none; }
.lfs .storep .thead { height: auto; padding: 6px 10px; font: 12px var(--mono); border-bottom: 1px solid var(--line); }
.lfs .storep .thead .t { font-weight: 500; }
.lfs .storep .thead .sp { flex: 1; margin-right: -8px; }
.lfs .sbody { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; }
.lfs .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
@media (min-width: 1536px) { .lfs .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.lfs .tile { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--line2); background: #fff; padding: 4px 8px; font-family: var(--mono); }
.lfs .tile span { font-size: 10.5px; line-height: 1.25; color: #6B6964; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs .tile b { font-size: 15px; font-weight: 500; line-height: 1.4; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs .tile b.blue { color: var(--accent); }
.lfs .tile b.coral { color: var(--coral-text); }
.lfs .sbar2 { display: flex; height: 6px; background: #E6EBF5; }
.lfs .sbar2 .p { background: var(--accent); }
.lfs .sbar2 .m { background: var(--coral); }
.lfs .sbar2 .f { background: #C9D0DB; }
.lfs .sline { font: 11px var(--mono); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs .sline b { font-weight: 500; color: var(--text); }
.lfs .sline .mc { color: var(--coral-text); }
.lfs .term.storep:has(.sv2) { flex: none; overflow: visible; }
/* the storage card is as tall as its content (a fixed set of rows): it never scrolls or clips */
.lfs .work.mainview > .term.storep:has(.sv2) { flex: none; height: auto; min-height: min-content; overflow: visible; }
.lfs .sv2 { gap: 6px; padding: 8px 10px; font: 11.5px/1.45 var(--mono); color: var(--text-2); }
.lfs .sv2 .shead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.lfs .sv2 .shead b { font: 500 18px var(--mono); color: var(--text); }
.lfs .sv2 .ssub, .lfs .sv2 .snote { color: var(--text-3); font-size: 10.5px; }
.lfs .sv2 .srows, .lfs .sv2 .scost { display: grid; grid-template-columns: max-content minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; }
.lfs .sv2 .lb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs .sv2 .bw { height: 8px; }
.lfs .sv2 .bw > span { display: block; height: 100%; min-width: 2px; }
.lfs .sv2 .vl { text-align: right; color: var(--text); white-space: nowrap; }
.lfs .sv2 .hd { background: #5F5E5A; } .lfs .sv2 .fc { background: #D3D1C7; } .lfs .sv2 .dd { background: var(--accent); } .lfs .sv2 .cp { background: #1D9E75; } .lfs .sv2 .md { background: #B4B2A9; }
.lfs .sv2 .scost { grid-template-columns: max-content auto auto; justify-content: start; gap: 4px 12px; border-top: 1px solid var(--line2); padding-top: 6px; }
.lfs .sv2 .scost b { font-weight: 500; color: var(--text); }
.lfs .sv2 .sbars { display: flex; align-items: flex-end; gap: 1px; height: 24px; }
.lfs .sv2 .sbars > span { flex: 1; min-width: 1px; }
.lfs .sv2 .fs { background: #7F77DD; } .lfs .sv2 .ws { background: #D85A30; } .lfs .sv2 .ot { background: #B4B2A9; }
.lfs .sv2 .k { display: inline-block; width: 8px; height: 8px; margin: 0 4px 0 0; vertical-align: -1px; }
.lfs .sv2 .k.ws { margin-left: 8px; }
/* a Branch (BranchPanel): its line, its agents, then fs and Workspace terminals two by two */
.lfs .wchips { flex: none; display: flex; flex-wrap: nowrap; align-items: center; gap: 6px; min-height: 26px; overflow-x: auto; scrollbar-width: none; }
.lfs .wchips > .wchip, .lfs .wchips > .none { flex: none; }
/* the Branch's facts, one sign at the end of its agents' row */
.lfs .wsigns { margin-left: auto; display: flex; gap: 6px; flex: none; }
.lfs .sign { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; font: 11.5px var(--mono); color: var(--text-2); background: var(--well); border: 1px solid var(--line2); white-space: nowrap; }
.lfs .wchips .none { font: 11.5px var(--mono); color: var(--text-3); align-self: center; }
.lfs .wchip { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); padding: 2px 8px 2px 4px; font: 11.5px var(--mono); opacity: .7; }
.lfs .wchip.on { border-color: var(--ac); background: #fff; opacity: 1; }
.lfs .wchip .av { width: 20px; height: 16px; }
.lfs .wchip .nm { color: var(--text); }
.lfs .wchip .st { color: var(--text-3); }
.lfs .wchip.on .st { color: color-mix(in srgb, var(--ac) 80%, black); }
.lfs .wgrid { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: minmax(176px, 1fr); gap: 12px; overflow-y: auto; }
/* a Branch's notebook: one page, split into borderless blocks along dashed perforations.
   One block fills it; two sit across; three are fs beside two stacked; more go in rows of
   two, an odd last block across. Blocks stretch to their row (not the terminal height). */
.lfs .nb { position: relative; gap: 0; background: var(--term); box-shadow: 0 0 0 1px var(--line); }
.lfs .nb > .wterm.cap { height: auto; min-height: 0; }
.lfs .nb > .wterm { border: 0; border-radius: 0; box-shadow: none; background: transparent; }
.lfs .nb > .wterm > .thead { border-bottom: 0; background: color-mix(in srgb, var(--term-head) 70%, transparent); }
.lfs .nb > .wterm:nth-child(even) { border-left: 1.5px dashed var(--line); }
.lfs .nb > .wterm:nth-child(n+3) { border-top: 1.5px dashed var(--line); }
.lfs .nb:not(.n3) > .wterm:last-child:nth-child(odd):not(:first-child) { grid-column: 1 / -1; }
.lfs .nb.n1 { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(240px, 1fr) auto; }
.lfs .nb.n3 > .wterm:first-child { grid-row: span 2; }
.lfs .nb.n3 > .wterm:nth-child(3) { grid-column: 2; border-left: 1.5px dashed var(--line); }
/* states draw inside a block (its edges are the page's) */
.lfs .nb > .wterm.wterm.hot { box-shadow: inset 0 0 0 1.5px var(--accent); }
.lfs .nb > .wterm.wterm.bad { box-shadow: inset 0 0 0 1.5px var(--coral); border-color: var(--coral); border-style: dashed; }
.lfs .nb > .wterm.wterm.sblit { box-shadow: inset 0 0 0 2px var(--orange); }
/* a new block opens from its perforation: across from the left edge, below from the top */
.lfs .nb > .wterm.enter { animation: lfs-nbopen-x .3s ease-out; }
.lfs .nb > .wterm.enter:nth-child(odd) { animation-name: lfs-nbopen-y; }
@keyframes lfs-nbopen-x { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0); } }
@keyframes lfs-nbopen-y { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0); } }
@media (prefers-reduced-motion: reduce) { .lfs .nb > .wterm.enter { animation: none; } }
.lfs .nb > .wnone { grid-column: 1 / -1; padding: 8px 10px; font: italic 11.5px var(--mono); color: var(--text-3); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lfs .seg { display: inline-flex; border: 1px solid var(--line); background: var(--card); flex: none; }
.lfs .seg button { border: 0; background: transparent; font: 11px var(--mono); padding: 3px 8px; cursor: pointer; color: var(--text-2); display: inline-flex; align-items: center; gap: 4px; }
.lfs .seg button:hover { color: var(--text); }
.lfs .seg button.on { background: var(--text); color: #fff; }
.lfs .seg svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
.lfs .seg svg .fill { fill: currentColor; stroke: none; }
.lfs .col { display: flex; flex-direction: column; gap: 12px; min-height: 0; min-width: 0; }
.lfs .term { display: flex; flex-direction: column; background: var(--term); border-radius: 0; overflow: hidden; min-width: 0; min-height: 0; box-shadow: 0 0 0 1px var(--line); position: relative; flex: 1; transition: box-shadow .25s; }
.lfs .term.hot { box-shadow: 0 0 0 1.5px var(--accent), 0 6px 18px rgba(0,0,0,.12); }
.lfs .term.bad { box-shadow: 0 0 0 1.5px var(--red), 0 6px 18px rgba(255,59,48,.18); }
.lfs .term.enter { animation: lfs-grow .35s ease-out; }
.lfs .term.leaving { animation: lfs-leave 3.6s ease-in forwards; pointer-events: none; }
.lfs .thead { height: 34px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 10px; background: var(--term-head); color: var(--term-text); font: 12.5px var(--mono); border-bottom: 1px solid var(--line2); white-space: nowrap; overflow: hidden; }
.lfs .thead .ttl { font: 12px var(--mono); color: var(--term-dim); overflow: hidden; text-overflow: ellipsis; }
.lfs .thead .sp { flex: 1; }
.lfs .kind { font: 600 11px var(--mono); padding: 0; letter-spacing: .06em; flex: none; background: none !important; color: var(--text) !important; }
.lfs .kind.fs { background: var(--accent-bg); color: var(--t-blue); }
.lfs .kind.sandbox { background: var(--orange-bg); color: var(--t-orange); }
.lfs .kind.history { background: var(--purple-bg); color: var(--t-purple); }
.lfs .kind.files { background: var(--green-bg); color: var(--t-green); }
.lfs .kind.plain { background: var(--well); color: var(--text-2); }
.lfs .pill { font: 11px var(--mono); padding: 1px 6px; border-radius: 0; background: var(--well); color: var(--term-dim); white-space: nowrap; display: inline-flex; gap: 4px; align-items: center; }
.lfs .pill.warn { background: var(--red-bg); color: var(--t-red); }
.lfs .pill.run { background: var(--green-bg); color: var(--t-green); }
.lfs .pill.ro { background: var(--coral-pale); color: var(--coral-text); }
.lfs .agent-tag { display: inline-flex; align-items: center; gap: 4px; font: 600 11px var(--font); color: var(--ac); background: color-mix(in srgb, var(--ac) 14%, transparent); padding: 0 6px 0 3px; border-radius: 4px; height: 17px; }
.lfs .tbody { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px 8px; font: 12.5px/1.7 var(--mono); color: var(--term-text); white-space: pre-wrap; word-break: break-word; }
.lfs .ln { display: block; white-space: pre-wrap; }
.lfs .ln.new { animation: lfs-fadein .35s ease-out; }
.lfs .ln .cmd { color: var(--term-text); }
.lfs .ln .grp { font: 10px var(--mono); color: var(--term-dim); border: 1px dashed var(--term-border); border-radius: 3px; padding: 0 4px; margin-right: 6px; vertical-align: 1px; }
.lfs .ln.dim, .lfs .ln.dim .cmd { color: var(--term-dim); }
.lfs .out { display: block; color: var(--term-dim); padding-left: 2ch; }
.lfs .out.good { color: var(--t-green); }
.lfs .out.bad { color: var(--t-red); }
.lfs .out.mark { color: var(--t-orange); }
.lfs .prompt { color: var(--text-3); }
.lfs .inrow { flex: none; display: flex; align-items: center; gap: 6px; padding: 5px 10px 7px; font: 12px var(--mono); color: var(--term-dim); border-top: 1px solid var(--term-border); }
.lfs .inrow .prompt { flex: none; white-space: nowrap; }
.lfs .inrow > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs .inrow .caret { width: 7px; height: 14px; background: var(--term-dim); opacity: .5; animation: lfs-blink 1.1s steps(2) infinite; }
/* History: the website's tree (tree.js) */
.lfs .graphwrap { flex: 1; min-height: 0; overflow: auto; padding: 6px 4px; }
.lfs .panel { background: var(--card); border: 1px solid var(--line); box-shadow: 0 1px 0 var(--line), 0 12px 32px rgba(30,37,51,.06); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.lfs .hist .phead { flex: none; display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line); background: var(--tab); font: 12px var(--mono); color: var(--text-3); white-space: nowrap; overflow: hidden; }
.lfs .hist .phead .ref { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.lfs .hist .phead > * { flex: none; }
.lfs .hist .phead > .ref, .lfs .hist .phead > .m { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* a narrow History keeps its controls: the count goes first, then Play's word */
.lfs .hist { container: hist / inline-size; }
@container hist (max-width: 460px) { .lfs .hist .phead > .m { display: none; } .lfs .hist .phead { gap: 8px; } }
@container hist (max-width: 390px) { .lfs .hist .phead [data-play] .lbl { display: none; } }
.lfs .hist .phead .sp { flex: 1; }
.lfs .hist .fbody, .lfs .hist .ftree, .lfs .hist .fview { min-height: 0; }
.lfs .treebox { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.lfs .treewrap { flex: 1; min-height: 0; overflow: auto; outline: none; position: relative; cursor: grab; }
.lfs .treewrap.panning { cursor: grabbing; user-select: none; }
.lfs .treewrap [data-node], .lfs .treewrap .tag { cursor: pointer; }
.lfs.tz-key .treewrap, .lfs.tz-key .treewrap [data-node] { cursor: zoom-in; }
.lfs.tz-key.tz-out .treewrap, .lfs.tz-key.tz-out .treewrap [data-node] { cursor: zoom-out; }
.lfs .tzoom { position: absolute; z-index: 5; right: 12px; bottom: 12px; display: flex; border: 1px solid var(--line); background: rgba(255,255,255,.92); box-shadow: 0 2px 8px rgba(0,0,0,.08); backdrop-filter: blur(4px); }
.lfs .tzoom button { min-width: 28px; height: 26px; border: 0; padding: 0 6px; background: none; font: 13px var(--mono); color: var(--text-2); cursor: pointer; }
.lfs .tzoom button + button { border-left: 1px solid var(--line2); }
.lfs .tzoom button:hover { background: var(--accent-bg); color: var(--accent); }
.lfs .tzoom .tzv { min-width: 48px; font-size: 11px; }
.lfs .treewrap:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.lfs svg.tree { display: block; font-family: var(--mono); font-size: 10px; }
.lfs svg.tree .lane { fill: var(--lane); }
.lfs svg.tree .grid { stroke: #F1EEE8; }
.lfs svg.tree .now { stroke: var(--text); stroke-opacity: .35; stroke-dasharray: 2 3; }
.lfs svg.tree .nowt { font-weight: 600; fill: var(--text); }
.lfs svg.tree .fork { fill: none; stroke-width: 2.5; opacity: .6; stroke-linecap: round; }
.lfs svg.tree .publish { fill: none; stroke-width: 1.6; stroke-dasharray: 4 3; opacity: .75; }
.lfs svg.tree .graft { fill: none; stroke-width: 1.8; opacity: .6; }
.lfs svg.tree .link.far { opacity: .14; stroke-width: 1.2; }
.lfs svg.tree .link.on { opacity: .95; stroke-width: 2.2; }
.lfs svg.tree .bough { fill: none; stroke-linecap: round; opacity: .9; }
.lfs svg.tree .twig { fill: none; stroke: var(--twig); stroke-width: 2.4; stroke-linecap: round; }
.lfs svg.tree .trunk { fill: none; stroke: var(--trunk); stroke-linecap: round; }
.lfs svg.tree .trunk-on { fill: none; stroke: var(--trunk); stroke-width: 2.6; stroke-linecap: round; stroke-dasharray: 0 7; opacity: .85; } /* main past its newest Layer: dots */
.lfs svg.tree .band { stroke: #fff; stroke-width: 1; }
.lfs svg.tree .lid { font-weight: 600; pointer-events: none; }
.lfs svg.tree .hit { fill: transparent; }
.lfs svg.tree .knot circle:not(.hit) { fill: var(--card); stroke-width: 1.8; }
.lfs svg.tree .ring { fill: #fff; stroke-width: 2.4; }
.lfs svg.tree .vein { stroke: #fff; stroke-opacity: .55; stroke-width: .9; stroke-linecap: round; fill: none; }
.lfs svg.tree .node { cursor: pointer; }
.lfs svg.tree .node:hover path:not(.vein), .lfs svg.tree .node.sel path:not(.vein) { stroke: var(--text); stroke-width: 1.4; }
.lfs svg.tree .node.sel .ring, .lfs svg.tree .node.sel .band, .lfs svg.tree .knot.sel circle:not(.hit) { stroke: var(--text); }
.lfs svg.tree .leader { stroke: var(--twig); stroke-width: 1; stroke-dasharray: 2 2; }
.lfs svg.tree .tag { cursor: pointer; }
.lfs svg.tree .tag rect { fill: var(--tc); stroke: var(--tc); }
.lfs svg.tree .tag text { font-weight: 600; fill: #fff; }
.lfs svg.tree .tag.idle rect { fill: #fff; }
.lfs svg.tree .tag.idle text { fill: var(--tc); }
.lfs svg.tree .tag.on rect { stroke: var(--text); stroke-width: 1.5; }
.lfs svg.tree .tavbg { fill: var(--card); stroke-width: 1.2; }
.lfs svg.tree .ground { fill: #F6EEDD; }
.lfs svg.tree .groundline { stroke: #E4D6B8; }
.lfs svg.tree .mbadge circle { fill: var(--orange); stroke: #fff; stroke-width: 1.5; }
.lfs svg.tree .mbadge.stale circle { fill: var(--red); }
.lfs svg.tree .mbadge text { fill: #fff; font: 700 8.5px var(--font); }
.lfs svg.tree .popin { animation: lfs-popin .5s .3s both cubic-bezier(.2,.9,.3,1.35); transform-box: fill-box; transform-origin: center; }
.lfs .ov { flex: none; display: flex; height: 40px; border-top: 1px solid var(--line2); }
.lfs .ovl { width: 110px; flex: none; display: flex; flex-direction: column; justify-content: center; padding: 0 10px; border-right: 1px solid var(--line2); font: 10px/1.4 var(--mono); color: var(--text-3); }
.lfs .ovl button { align-self: flex-start; border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
.lfs .ovstrip { flex: 1; position: relative; cursor: pointer; background: #FAF9F6; }
.lfs .ovs { display: block; width: 100%; height: 100%; }
.lfs .ovs .bar { fill: #D6D1C7; }
.lfs .ovs .tick { fill: var(--trunk); }
.lfs .ovs .nowl { stroke: var(--text); stroke-opacity: .5; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
.lfs .ovbox { position: absolute; top: 1px; bottom: 1px; border: 1.5px solid var(--accent); background: rgba(47,91,181,.08); pointer-events: none; }
/* the legend: a "?" over the tree's bottom left opens it above the button */
.lfs .tkey { position: absolute; left: 12px; bottom: 12px; z-index: 3; width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--line); background: var(--card); font: 600 12px var(--mono); color: var(--text-2); cursor: pointer; box-shadow: 0 1px 3px rgba(30,37,51,.08); }
.lfs .tkey:hover { color: var(--text); border-color: var(--text-3); }
.lfs .tkey.on { background: var(--text); border-color: var(--text); color: #fff; }
.lfs .tlegend { position: absolute; left: 12px; bottom: 48px; z-index: 3; max-width: calc(100% - 24px); display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); box-shadow: 0 6px 18px rgba(30,37,51,.14); font: 11px var(--mono); color: var(--text-2); }
.lfs .tlegend span { display: inline-flex; align-items: center; gap: 6px; }
.lfs .tlegend .dash { width: 16px; border-top: 2px dashed var(--b1); }
.lfs .tlegend .hint { color: var(--text-3); }
.lfs .grow { display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 8px; border: 0; background: transparent; cursor: pointer; font: 12px var(--mono); color: var(--term-text); white-space: nowrap; text-align: left; }
.lfs .grow:hover { background: var(--sep); }
.lfs .grow.sel { background: var(--accent-bg); }
.lfs .grow > * { flex: none; }
.lfs .grow .gid { font: 600 12px var(--mono); min-width: 2.6em; }
.lfs .grow .gid.dim { font-weight: 400; color: var(--term-dim); }
.lfs .grow .gbr { font-weight: 500; }
.lfs .grow .gmsg { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); }
.lfs .grow .gby { font-weight: 500; color: var(--text-2); }
.lfs .grow .ghead { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; background: var(--accent-bg); color: var(--t-blue); }
.lfs .grow.popin { animation: lfs-fadein .4s .3s both; }
@keyframes lfs-popin { from { transform: scale(0); } to { transform: scale(1); } }
.lfs .rows { flex: 1; min-height: 0; overflow: auto; padding: 4px; }
.lfs .brow { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 0; border-bottom: 1px solid var(--line2); cursor: pointer; min-height: 32px; transition: background .25s; }
.lfs .brow .slot { width: 66px; height: 20px; flex: none; }
.lfs .brow .hd { font: 11px var(--mono); color: var(--text-2); width: 34px; text-align: right; flex: none; }
.lfs .brow:hover { background: var(--well); }
.lfs .brow.flash { animation: lfs-flash 1s ease-out; }
.lfs .brow .sq { width: 9px; height: 9px; background: var(--bc); flex: none; }
.lfs .brow .st { width: 16px; text-align: center; font-size: 12px; flex: none; }
.lfs .brow .nm { font: 600 12px var(--mono); color: var(--bc); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs .brow .meta { font: 11px var(--mono); color: var(--text-3); white-space: nowrap; }
.lfs .brow .meta.busy { color: var(--t-green); }
.lfs .brow .meta.pub { color: var(--t-blue); }
.lfs .brow .meta.bad { color: var(--t-red); }
.lfs .brow.idle .nm { opacity: .6; }
.lfs .bench { flex: none; min-height: 48px; background: var(--term); box-shadow: 0 0 0 1px var(--line); display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 11px; color: var(--text-3); position: relative; }
.lfs .bench b { font-weight: 600; letter-spacing: .04em; text-transform: uppercase; font-size: 10px; }
/* branch view */
/* SDK call details on a terminal line */
.lfs .sdkbtn { margin-left: 8px; font: 9.5px var(--mono); padding: 0 4px; border-radius: 3px; border: 1px solid var(--term-border); background: transparent; color: var(--term-dim); cursor: pointer; opacity: 0; vertical-align: 1px; }
.lfs .ln:hover .sdkbtn, .lfs .ln.open .sdkbtn, .lfs .sdkbtn:focus-visible { opacity: 1; }
.lfs .sdk { display: none; margin: 3px 0 5px; padding: 6px 9px; border-left: 2px solid var(--t-cyan); background: var(--well); border-radius: 0 6px 6px 0; color: var(--term-text); font-size: 11.5px; white-space: normal; }
.lfs .ln.open .sdk { display: block; }
.lfs .sdk .code { color: var(--term-dim); display: block; margin-bottom: 4px; padding: 0; }
.lfs .sdk .code b { color: var(--t-cyan); font-weight: 600; }
.lfs .sdk pre { margin: 0 0 6px; font: inherit; white-space: pre-wrap; }
.lfs .tm { margin-left: 8px; font: 9.5px var(--mono); color: var(--term-dim); vertical-align: 1px; }
.lfs .sdk .tm { margin-left: 6px; font-size: 10.5px; }
/* Store and overlay footers */
.lfs .store { flex: none; border-top: 1px solid var(--term-border); padding: 3px 10px 4px; font: 10.5px/1.6 var(--mono); color: var(--term-dim); background: var(--well); }
.lfs .store .srow { display: flex; align-items: center; gap: 7px; white-space: nowrap; overflow: hidden; }
.lfs .store .srow > span:not(.sbar):not(.est) { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.lfs .store .kind { flex: none; font-weight: 600; font-size: 9px; letter-spacing: .06em; padding: 0; background: none; }
.lfs .store b { color: var(--term-text); font-weight: 600; }
.lfs .store .est { margin-left: auto; flex: none; font-size: 9.5px; opacity: .8; }
.lfs .store .sbar { flex: none; display: flex; width: 44px; height: 5px; border-radius: 3px; overflow: hidden; background: var(--term-border); }
.lfs .store .sbar i { display: block; }
.lfs .store .p { background: var(--t-cyan); }
.lfs .store .m { background: var(--orange); }
.lfs .store .pc { color: var(--t-cyan); }
.lfs .store .mc { color: var(--orange); }
/* Files, stacked for the right column */
.lfs .fsel { font: 12px var(--font); height: 24px; max-width: 200px; min-width: 70px; border: 1px solid var(--term-border); border-radius: 5px; background: var(--term); color: var(--term-text); padding: 0 4px; }
.lfs .sync { font-size: 11px; line-height: 1; flex: none; }
.lfs .sync.live { color: var(--t-green); }
.lfs .sync.pinned { color: var(--term-dim); }
.lfs .fbar { flex: none; display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--term-head); border-bottom: 1px solid var(--term-border); font-size: 11.5px; color: var(--term-dim); flex-wrap: wrap; }
.lfs .fbar .segs { display: inline-flex; background: var(--well); border-radius: 6px; padding: 2px; }
.lfs .fbar .fseg { border: 0; background: transparent; padding: 2px 9px; border-radius: 4px; cursor: pointer; font-size: 11.5px; color: var(--term-dim); }
.lfs .fbar .fseg.on { background: var(--card); color: var(--term-text); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.lfs .fbar .chipb { border: 1px solid var(--term-border); background: transparent; border-radius: 10px; padding: 0 8px; height: 20px; cursor: pointer; font-size: 11px; color: var(--term-dim); }
.lfs .fbar .chipb.on { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
.lfs .fbar .chk { display: inline-flex; gap: 4px; align-items: center; }
.lfs .fbar .chk.off { opacity: .45; }
.lfs .fbar .sp { flex: 1; }
.lfs .fbar .fcount { font: 11px var(--mono); }
.lfs .fbar .sdkbtn { opacity: 1; margin-left: 0; }
.lfs .fsdk { margin: 0; padding: 6px 10px; background: var(--well); border-bottom: 1px solid var(--term-border); font: 11px/1.5 var(--mono); color: var(--term-text); white-space: pre-wrap; }
.lfs .fbody { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.lfs .ftree, .lfs .flist { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 10px; font: 12px/1.6 var(--mono); color: var(--term-text); }
.lfs .fhead { flex: none; display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: var(--term-head); border-bottom: 1px solid var(--term-border); font-size: 11.5px; color: var(--term-dim); min-width: 0; }
.lfs .fhead .fsel { min-width: 0; flex: 0 1 auto; }
.lfs .fhead .sp { flex: 1; min-width: 4px; }
.lfs .fhead .fcount { font: 11px var(--mono); white-space: nowrap; }
.lfs .fhead .sdkbtn { opacity: 1; margin-left: 0; flex: none; }
.lfs .fwide { flex: none; border: 0; background: none; color: var(--term-dim); font-size: 13px; width: 22px; height: 22px; border-radius: 5px; cursor: pointer; }
.lfs .fwide:hover, .lfs .fwide.on { background: var(--well); color: var(--term-text); }
.lfs .fsw, .lfs .fmodes { flex: none; display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-bottom: 1px solid var(--term-border); min-width: 0; }
.lfs .fsw .segs, .lfs .fmodes .segs { display: inline-flex; background: var(--well); border-radius: 6px; padding: 2px; flex: none; }
.lfs .fsw .fseg, .lfs .fmodes .fseg { border: 0; background: transparent; padding: 2px 10px; border-radius: 4px; cursor: pointer; font-size: 11.5px; color: var(--term-dim); }
.lfs .fsw .fseg.on, .lfs .fmodes .fseg.on { background: var(--card); color: var(--term-text); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.lfs .fsw .fseg b { font-weight: 600; margin-left: 2px; }
.lfs .fmodes .sp { flex: 1; }
.lfs .fstat { font-size: 11px; color: var(--term-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: help; }
.lfs .fstat b { color: var(--term-text); }
.lfs .fdir { display: flex; align-items: center; gap: 6px; padding: 8px 10px 3px; color: var(--text-2); font: 500 11.5px var(--font); }
.lfs .fdir .fr { margin-left: auto; }
.lfs .fgroup { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 4px 10px; border-top: 1px dashed var(--term-border); color: var(--term-dim); font-size: 11.5px; cursor: pointer; white-space: nowrap; }
.lfs .fgroup:hover { background: var(--well); }
.lfs .fgroup b { color: var(--term-text); font-weight: 600; }
.lfs .fgroup .car { width: 10px; }
.lfs .fgroup .nm { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.lfs .fb.lead { margin: 0 6px 0 0; }
.lfs .fpage { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--term-border); min-width: 0; }
.lfs .fback { flex: none; border: 0; background: var(--well); color: var(--accent); font-size: 11.5px; padding: 2px 8px; border-radius: 5px; cursor: pointer; }
.lfs .fback:hover { background: var(--accent-bg); }
.lfs .fpathx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--mono); }
.lfs .fpathx .dir { color: var(--term-dim); }
.lfs .fpathx .sl { color: var(--line); margin: 0 2px; }
.lfs .fpage .sp { flex: 1; }
.lfs .flang { flex: none; font: 11px var(--mono); color: var(--text-3); white-space: nowrap; }
.lfs .fpathx b { color: var(--term-text); }
.lfs .frow { display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 0 10px 0 8px; cursor: pointer; white-space: nowrap; font-family: var(--font); font-size: 12.5px; color: var(--text); border-left: 2px solid transparent; }
.lfs .frow:hover { background: #F4F2EC; }
.lfs .frow.sel { background: var(--accent-bg); border-left-color: var(--accent); }
.lfs .frow.flash { animation: lfs-flash 1.2s ease-out; }
.lfs .frow.dir .nm { font-weight: 500; }
.lfs .frow .car { width: 10px; color: var(--text-3); flex: none; display: inline-grid; place-items: center; }
.lfs .frow .nm { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.lfs .frow .ind { flex: none; align-self: stretch; margin-right: -6px; background: repeating-linear-gradient(90deg, transparent 0 6px, #E8E4DC 6px 7px, transparent 7px 14px); }
.lfs .chev { transition: transform .12s; }
.lfs .chev.open { transform: rotate(90deg); }
.lfs .fico { flex: none; display: inline-block; vertical-align: middle; }
.lfs .fico.badge { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 3px; background: color-mix(in srgb, var(--fc) 14%, white); color: var(--fc); font: 700 7.5px/1 var(--mono); letter-spacing: -.02em; }
.lfs .fico.badge.w { font-size: 6.5px; }
.lfs .frow.note { cursor: default; color: var(--term-dim); font-size: 12px; }
.lfs .frow.note[data-fmore] { cursor: pointer; color: var(--accent); }
.lfs .frow.more { color: var(--accent); }
.lfs .fline { width: 96px; font: 11.5px var(--mono); padding: 2px 6px; border: 1px solid var(--term-border); border-radius: 4px; background: var(--card); color: var(--term-text); }
.lfs .fseg:disabled { opacity: .4; cursor: default; }
.lfs .frow.gone .nm { text-decoration: line-through; color: var(--term-dim); }
.lfs .frow.flat { padding: 2px 10px; font: 12px var(--mono); }
.lfs .fb { font: 700 9.5px var(--mono); padding: 0 4px; border-radius: 3px; margin-left: auto; flex: none; }
.lfs .frow.flat .fb { margin: 0 6px 0 0; }
.lfs .fb.A { color: var(--t-green); background: var(--t-add-bg); }
.lfs .fb.M { color: var(--t-blue); background: var(--accent-bg); }
.lfs .fb.D { color: var(--t-red); background: var(--t-del-bg); }
.lfs .fr { margin-left: auto; font: 10px var(--mono); color: var(--term-dim); flex: none; }
.lfs .fview { flex: 1; min-height: 0; overflow: auto; font: 12px/1.55 var(--mono); color: var(--term-text); }
.lfs .fpath { position: sticky; top: 0; z-index: 1; background: var(--term); padding: 5px 10px; border-bottom: 1px solid var(--term-border); font-weight: 600; }
.lfs .fpath span { font-weight: 400; color: var(--term-dim); }
.lfs .fsum { padding: 6px 10px; color: var(--term-dim); font-size: 11.5px; }
.lfs .fsum b { color: var(--term-text); font-weight: 600; }
.lfs .fstats { display: flex; flex-wrap: wrap; gap: 3px 14px; padding: 6px 10px; border-bottom: 1px solid var(--term-border); background: var(--well); font-size: 11px; color: var(--term-dim); }
.lfs .fstats b { color: var(--term-text); font-weight: 600; }
.lfs .fstats .est { margin-left: auto; }
.lfs .frev { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.lfs .frev th { text-align: left; font-weight: 600; color: var(--term-dim); padding: 4px 6px; border-bottom: 1px solid var(--term-border); }
.lfs .frev td { padding: 3px 6px; border-bottom: 1px solid var(--term-border); white-space: nowrap; }
.lfs .frev td.n, .lfs .frev th.n { text-align: right; }
.lfs .frev .zero { color: var(--term-dim); }
.lfs .fempty { padding: 18px 12px; color: var(--term-dim); line-height: 1.6; }
.lfs .code { padding: 4px 0 12px; font: 12px/1.65 var(--mono); tab-size: 2; min-width: max-content; }
.lfs .cl { display: flex; white-space: pre; min-height: 19px; }
.lfs .cl:hover { background: #F6F4EF; }
.lfs .cl .no { flex: none; width: 44px; padding-right: 10px; margin-right: 10px; text-align: right; color: #B4AFA5; user-select: none; border-right: 1px solid var(--line2); }
.lfs .cl:hover .no { color: var(--text-2); }
/* syntax colours (highlight.js), the website's palette */
.lfs .hl-com { color: #9A958B; font-style: italic; }
.lfs .hl-str { color: #2E7D5B; }
.lfs .hl-num, .lfs .hl-lit { color: #B8502C; }
.lfs .hl-kw { color: #6A4DA8; font-weight: 500; }
.lfs .hl-fn { color: #2F5BB5; }
.lfs .hl-typ { color: #1F6B78; }
.lfs .hl-prop { color: #93650F; }
.lfs .hl-tag { color: #C8452F; }
.lfs .hl-attr { color: #93650F; }
.lfs .hl-var { color: #1F6B78; }
.lfs .hl-op { color: #D29A2E; font-weight: 600; }

.lfs .cl .op { flex: none; width: 14px; color: var(--term-dim); }
.lfs .cl .tx { flex: 1; padding-right: 10px; }
.lfs .cl.add { background: var(--t-add-bg); }
.lfs .cl.add .op, .lfs .cl.add .tx { color: var(--t-green); }
.lfs .cl.del { background: var(--t-del-bg); }
.lfs .cl.del .op, .lfs .cl.del .tx { color: var(--t-red); }
/* a diff keeps the syntax colours: the line is tinted, its gutter more */
.lfs .cl.add .tx, .lfs .cl.del .tx { color: var(--term-text); }
.lfs .cl.add .no { background: rgba(46,125,91,.13); color: var(--t-green); }
.lfs .cl.del .no { background: rgba(184,80,44,.13); color: var(--t-red); }
.lfs .cl.del .tx { text-decoration: none; opacity: .85; }
.lfs .bch { flex: none; width: 40px; margin: 0 4px 0 6px; font: 600 10.5px/18px var(--mono); color: var(--bc); border-left: 3px solid var(--bc); padding-left: 5px; cursor: pointer; }
.lfs .bch.cont { opacity: .55; }
.lfs .bch:hover { background: var(--well); }
.lfs .sblist { flex: 1 1 0; min-height: 120px; }
.lfs .storecard { flex: none; }
.lfs .storecard .store { border-top: 0; background: var(--term); padding: 6px 10px; }
.lfs .blist { flex: 0 1 auto; max-height: 48%; min-height: 96px; }
.lfs .blist .rows { overflow-y: auto; padding: 4px; }
.lfs .sbg { display: flex; flex-direction: column; gap: 1px; padding: 4px 2px 6px; border-radius: 6px; transition: box-shadow .15s; }
.lfs .sbg + .sbg { border-top: 1px solid var(--term-border); }
.lfs .sbg.closed { opacity: .5; }
.lfs .sbg.sblit, .lfs .term.sblit { box-shadow: 0 0 0 2px var(--orange), 0 6px 18px rgba(0,0,0,.12); }
.lfs .sbg.pulse { animation: lfs-focuspane 1.6s ease-out; }
.lfs .sbh { display: flex; align-items: center; gap: 6px; padding: 2px 4px; font: 11.5px var(--mono); }
.lfs .sbh .d { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none; }
.lfs .sbh .d.idle { background: var(--text-3); }
.lfs .sbh .d.off { background: transparent; box-shadow: 0 0 0 1px var(--text-3); }
.lfs .sbh .mk { display: inline-flex; gap: 4px; align-items: center; color: var(--term-dim); font: 11px var(--font); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lfs .sbh b, .lfs .sbh .ct { flex: none; white-space: nowrap; }
.lfs .sbh .sp { flex: 1; }
.lfs .sbh .ct { color: var(--term-dim); font-size: 10.5px; white-space: nowrap; }
.lfs .dnote { font-size: 10.5px; color: var(--t-orange); padding: 0 4px 0 17px; }
.lfs .dws { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: none; color: var(--term-text); font: 11px var(--mono); padding: 3px 4px 3px 15px; border-radius: 5px; cursor: pointer; text-align: left; white-space: nowrap; overflow: hidden; }
.lfs .dws:hover { background: var(--well); }
.lfs .dws .at { color: var(--term-dim); }
.lfs .dws .noag { width: 14px; text-align: center; color: var(--term-dim); }
.lfs .bchip { font: 10.5px var(--mono); padding: 0 5px; border-radius: 4px; color: var(--bc); box-shadow: inset 0 0 0 1px var(--bc); white-space: nowrap; }
.lfs .st { font-size: 10px; color: var(--term-dim); }
.lfs .st.warn { color: var(--t-orange); }
.lfs .st.bad { color: var(--t-red); }
.lfs .st.run { color: var(--t-green); overflow: hidden; text-overflow: ellipsis; }
.lfs .sbchip { border: 0; font: 10.5px var(--mono); padding: 1px 6px; border-radius: 4px; background: var(--well); color: var(--term-text); cursor: pointer; flex: none; }
.lfs .sbchip:hover { background: var(--orange-bg); color: var(--t-orange); }
.lfs .term.focus { animation: lfs-focuspane 1.2s ease-out; }
@keyframes lfs-focuspane { 0%, 40% { box-shadow: 0 0 0 2.5px var(--accent), 0 6px 18px rgba(0,0,0,.18); } }
/* Hover card on History nodes */
.lfs .hcard { position: absolute; z-index: 65; width: 290px; background: var(--card); border-radius: 0; border: 1px solid var(--line); box-shadow: 0 14px 44px rgba(0,0,0,.24), 0 0 0 .5px var(--sep-strong); padding: 8px; display: none; font-size: 12px; }
.lfs .hcard.open { display: block; animation: lfs-grow .12s ease-out; }
.lfs .hcard .h { display: flex; align-items: baseline; gap: 6px; margin: 0 4px 2px; }
.lfs .hcard .h b { font: 600 13px var(--mono); }
.lfs .hcard .tag { font: 600 10px var(--font); padding: 1px 6px; border-radius: 4px; background: var(--accent-bg); color: var(--accent); }
.lfs .hcard .meta { margin: 0 4px 6px; color: var(--text-2); font: 11px var(--mono); line-height: 1.5; }
.lfs .hcard .meta b { color: var(--text); }
.lfs .hcard .sec { margin: 6px 4px 3px; font-size: 10.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: .04em; }
.lfs .hcard .ws { width: 100%; display: flex; align-items: center; gap: 6px; padding: 5px 6px; border: 0; background: transparent; border-radius: 6px; cursor: pointer; text-align: left; font: 11.5px var(--mono); color: var(--text); }
.lfs .hcard .ws:hover, .lfs .hcard .ws:focus-visible { background: var(--accent-bg); outline: 0; }
.lfs .hcard .ws .d { width: 7px; height: 7px; border-radius: 50%; background: var(--orange); flex: none; }
.lfs .hcard .ws.stale .d { background: var(--red); }
.lfs .hcard .ws small { margin-left: auto; font: 10.5px var(--font); color: var(--text-2); white-space: nowrap; }
.lfs .hcard .ws.stale small { color: var(--red); }
.lfs .hcard .cbtns { display: flex; gap: 6px; margin: 8px 4px 0; }
.lfs .hcard .cbtn { flex: 1; border: 0; border-radius: 6px; padding: 5px 6px; background: var(--well); cursor: pointer; font-size: 11.5px; color: var(--text); }
.lfs .hcard .cbtn:hover { background: var(--accent); color: #fff; }
.lfs .hcard .hint { margin: 6px 4px 0; font-size: 10.5px; color: var(--text-3); }
.lfs .empty { flex: 1; display: grid; place-items: center; text-align: center; color: var(--text-2); background: var(--term); border-radius: 0; box-shadow: 0 0 0 1px var(--line); padding: 16px; }
.lfs .empty h3 { margin: 0 0 6px; font-size: 14px; color: var(--text); }
.lfs .empty .recent { white-space: pre; margin-top: 10px; font: 11.5px/1.7 var(--mono); text-align: left; color: var(--term-dim); }
/* heroes stand still and bob while they work (the website's animate-bob); bubbles and blocks fly over the view */
.lfs .lfs-fx { position: absolute; inset: 0; pointer-events: none; z-index: 40; overflow: hidden; }
.lfs .av.bob { animation: lfs-avbob .3s ease-in-out infinite; }
.lfs .av .dup { position: absolute; right: -3px; bottom: -2px; font: 700 8px/10px var(--font); font-style: normal; min-width: 10px; text-align: center; border-radius: 5px; background: var(--card); color: var(--text-2); box-shadow: 0 0 0 .5px var(--sep-strong); }
.lfs .av { position: relative; display: inline-block; width: 20px; height: 16px; flex: none; background-repeat: no-repeat; background-size: contain; background-position: 50% 100%; vertical-align: middle; }
@keyframes lfs-avbob { 50% { translate: 0 -1.5px; } }
.lfs .bubble { position: absolute; z-index: 45; pointer-events: none; transform: translate(-50%, -100%); font: 600 11px var(--mono); padding: 3px 7px; border-radius: 8px; background: var(--card); color: var(--text); box-shadow: 0 4px 14px rgba(0,0,0,.2), 0 0 0 .5px var(--sep-strong); white-space: nowrap; animation: lfs-bubble 1.9s ease-out forwards; }
.lfs .bubble.good { color: var(--t-green); }
.lfs .bubble.bad { color: var(--t-red); }
.lfs .visit { position: absolute; z-index: 43; pointer-events: none; transform: translate(-50%, -100%); transform-origin: 50% 100%; animation: lfs-visit 1.9s ease-out forwards; filter: drop-shadow(0 2px 2px rgba(0,0,0,.18)); }
.lfs .visit .av { display: block; width: 34px; height: 38px; }
.lfs .block { position: absolute; z-index: 44; width: 12px; height: 12px; border-radius: 3px; pointer-events: none; transition: transform .6s cubic-bezier(.4,0,.2,1), opacity .2s .55s; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
@keyframes lfs-bob { 50% { transform: translateY(-1.5px); } }
@keyframes lfs-claw { 50% { transform: translateY(-2px); } }
@keyframes lfs-blink { 50% { opacity: .1; } }
@keyframes lfs-grow { from { transform: scale(.96); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes lfs-leave { 0%, 45% { opacity: 1; filter: none; } 55% { opacity: .85; filter: grayscale(.6); } 100% { opacity: 0; transform: scale(.98); filter: grayscale(1); } }
@keyframes lfs-fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@keyframes lfs-pop { from { transform: scale(0); } to { transform: scale(1); } }
@keyframes lfs-flash { 0% { background: var(--accent-bg); } 100% { background: transparent; } }
@keyframes lfs-visit { 0% { opacity: 0; transform: translate(-50%, -60%) scale(.3); } 14% { opacity: 1; transform: translate(-50%, -112%) scale(1.08); } 24% { transform: translate(-50%, -100%) scale(1); } 80% { opacity: 1; transform: translate(-50%, -100%); } 100% { opacity: 0; transform: translate(-50%, -118%); } }
@keyframes lfs-bubble { 0% { opacity: 0; margin-top: 6px; } 12% { opacity: 1; margin-top: 0; } 80% { opacity: 1; } 100% { opacity: 0; margin-top: -8px; } }
@media (prefers-reduced-motion: reduce) {
  .lfs .block { transition: none; }
  .lfs .av.bob { animation: none; }
  .lfs .visit { animation: none; }
}
/* the view's own root: position for the overlay, the card and menus */
.lfs { container: lfs / inline-size; position: relative; font: 13px/1.4 var(--font); color: var(--text); -webkit-font-smoothing: antialiased; }
/* standalone layout (the dsh tab): the History | Work switch, then History or the work window (Branch tabs over the work area) */
.lfs.lfs-app { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--paper); overflow: hidden; }
.lfs .lfs-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 0; padding: 14px; background: var(--paper) radial-gradient(var(--dot) 1px, transparent 1px) 0 0 / 24px 24px; }
/* the Work | History switch, after the LayerFS mark at the left of the tab row: one window at a
   time, the whole view to itself; a small quiet pill, no outline */
.lfs .lfs-logo { flex: none; align-self: center; display: inline-flex; margin-right: 2px; }
.lfs .lfs-swap { flex: none; align-self: center; display: flex; gap: 2px; margin: 0 6px 0 0; padding: 2px; border: 0; border-radius: 999px; background: var(--well); }
.lfs .lfs-swap button { flex: none; position: relative; border: 0; border-radius: 999px; background: transparent; padding: 3px 16px; font: 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); cursor: pointer; }
.lfs .lfs-swap button:hover { color: var(--text); }
.lfs .lfs-swap button.on { background: var(--card); color: var(--text); box-shadow: 0 1px 2px rgba(30,37,51,.1); cursor: default; }
/* changed since you looked: a dot in a soft shade that breathes */
.lfs .lfs-swap .dot { position: absolute; top: 50%; right: 4px; width: 6px; height: 6px; margin: -3px 0 0; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); animation: lfs-dotshade 2.4s ease-in-out infinite; }
@keyframes lfs-dotshade { 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 10%, transparent); } }
@media (prefers-reduced-motion: reduce) { .lfs .lfs-swap .dot { animation: none; } }
/* in History the open tab only marks where Work will return to */
.lfs .lfs-strip[data-panes="history"] .tab[aria-selected="true"] { opacity: .6; filter: saturate(.4); }
.lfs .lfs-cols[data-panes="history"] > .panel.right, .lfs .lfs-cols[data-panes="work"] > .hist { display: none; }
.lfs .panel.right { overflow: hidden; }
.lfs .panel.right .work { padding: 12px; }
.lfs[data-pane="history"] > .lfs-strip { display: none; }
.lfs .lfs-strip { flex: none; display: flex; align-items: flex-end; gap: 8px; padding: 0 10px; background: var(--tab); border-bottom: 1px solid var(--line); }
/* one line: the tabs scroll sideways when they do not fit; the open one is kept in view, "+N" stays at the end */
.lfs .lfs-strip .tabs { flex: 1; position: relative; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.lfs .lfs-strip .tabs::-webkit-scrollbar { display: none; }
.lfs .lfs-strip .tab { flex: none; }
.lfs .lfs-strip .tab.more { position: sticky; right: 0; z-index: 1; background: var(--tab); box-shadow: -10px 0 8px -4px var(--tab); }
.lfs .lfs-strip .ib { margin-bottom: 7px; }
/* Narrow widths. History and the work window never share the view (the
   Work | History switch picks one). Inside the work window, by the view's width: */
/* under 1280: tighter tabs; the preview's History narrows */
@container lfs (max-width: 1279px) {
  .lfs .work.branchview.withhist { grid-template-columns: minmax(300px, 360px) minmax(0, 1fr); }
  .lfs .tab { min-height: 36px; padding: 6px 10px; font-size: 12.5px; }
}
/* the preview keeps History inside the work area: it stacks under 1000 */
@container lfs (max-width: 999px) {
  .lfs .work.withhist { overflow-y: auto; }
  .lfs .work.mainview.withhist { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: 560px max-content minmax(360px, auto); }
  .lfs .work.mainview.withhist > .storep { grid-column: 1; grid-row: 2; }
  .lfs .work.mainview.withhist > .board { grid-column: 1; grid-row: 3; }
  .lfs .work.mainview.withhist > .term:not(.storep) { grid-column: 2; grid-row: 2 / span 2; }
  .lfs .work.branchview.withhist { grid-template-columns: minmax(0, 1fr); grid-template-rows: 560px auto auto minmax(480px, auto); }
  .lfs .work.withhist .hist { grid-column: 1 / -1; grid-row: auto; }
}
/* under 760: one column everywhere; a Branch's terminals one under another */
@container lfs (max-width: 759px) {
  .lfs .lfs-cols { padding: 8px; }
  .lfs .lfs-swap button { padding: 3px 10px; }
  /* alone, the work window scrolls inside */
  .lfs .lfs-cols .panel.right .work { overflow-y: auto; }
  .lfs .work .col { min-height: auto; }
  .lfs .work.mainview .wterm { flex: none; height: 300px; }
  .lfs .work.branchview .wgrid { grid-auto-rows: 240px; }
  .lfs .work { padding: 8px; gap: 8px; }
  /* one column: the Store's line, Branches, Sandboxes, then the project log */
  /* vertical: storage, Branches with their Sandboxes (tall), the log, one under another */
  .lfs .work.mainview, .lfs .work.mainview.withhist { grid-template-columns: minmax(0, 1fr); grid-template-rows: max-content; }
  .lfs .work.mainview.withhist { grid-template-rows: 480px max-content; }
  .lfs .work.mainview > * { min-height: 300px; }
  /* undo the two-column placement (as specific as the rules that set it) */
  .lfs .work.mainview > :is(.storep, .board, .term:not(.storep)), .lfs .work.mainview.withhist > :is(.storep, .board, .term:not(.storep)) { grid-column: auto; grid-row: auto; }
  .lfs .work.mainview > .board { height: 420px; }
  .lfs .wgrid { grid-template-columns: minmax(0, 1fr); flex: none; overflow: visible; }
  /* one column: the page splits downward only */
  .lfs .nb > .wterm:nth-child(n) { grid-column: auto; grid-row: auto; border-left: 0; }
  .lfs .nb > .wterm:nth-child(n+2) { border-top: 1.5px dashed var(--line); }
  .lfs .tab { min-height: 32px; padding: 5px 8px; gap: 6px; }
  .lfs .tab .pin { display: none; }
  .lfs .tlegend .hint { display: none; }
}
${MAID_CSS}
`;

/** Adds the stylesheet once per document; returns its element. */
export function injectStyle(doc = document) {
  let el = doc.querySelector("style[data-lfs]");
  if (!el) { el = doc.createElement("style"); el.dataset.lfs = "1"; el.textContent = CSS; doc.head.appendChild(el); }
  return el;
}
