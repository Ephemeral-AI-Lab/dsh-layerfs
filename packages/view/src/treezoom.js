// Zoom and pan for the History tree, like a map. The tree is drawn for its
// box (tree.js); a zoom scales the drawn SVG, which keeps its viewBox, and the
// box scrolls over it. ⌘/Ctrl + wheel or a pinch zooms at the pointer, a drag
// pans, ⌘-click zooms in and ⌘⇧-click out (the cursor shows which), a
// double-click zooms in (⇧ out), + − 0 work while the tree has focus, and the
// controls in its corner zoom, show the zoom (click: 100%) and fit it all.

const MIN = 0.25, MAX = 4, STEP = 1.25, DRAG_PX = 4;
const clamp = (z) => Math.min(MAX, Math.max(MIN, z));

/**
 * @param {object} o root (the view's element), onZoom() after the viewer
 *   zoomed or panned (the view leaves "now" and moves the overview's box)
 */
export function createTreeZoom({ root, onZoom }) {
  let z = 1, pan = null, swallow = false;
  const box = () => root.querySelector("[data-tree]");
  const svgOf = (el) => el && el.querySelector("svg.tree");
  const label = () => `${Math.round(z * 100)}%`;
  /** The controls drawn in the tree's corner. */
  const controlsHtml = () => `<div class="tzoom" role="group" aria-label="Zoom History">
    <button data-tz="out" title="Zoom out (−, ⌘⇧-click, ⇧ double-click)" aria-label="Zoom out">−</button>
    <button data-tz="reset" class="tzv" title="Back to 100% (0)">${label()}</button>
    <button data-tz="in" title="Zoom in (+, ⌘-click, double-click)" aria-label="Zoom in">+</button>
    <button data-tz="fit" title="Fit the whole tree" aria-label="Fit">⤢</button></div>`;
  /** Scales the drawn tree to the zoom; the view calls it after each draw. */
  function apply(el = box()) {
    const svg = svgOf(el);
    if (!svg) return;
    svg.dataset.w ??= svg.getAttribute("width");
    svg.dataset.h ??= svg.getAttribute("height");
    svg.setAttribute("width", (+svg.dataset.w * z).toFixed(1));
    svg.setAttribute("height", (+svg.dataset.h * z).toFixed(1));
    svg.dataset.zoom = String(z);
    for (const v of root.querySelectorAll(".tzoom .tzv")) v.textContent = label();
  }
  /** Zooms to `next`, keeping the tree's point under (px, py) of its box where it is. */
  function zoomTo(next, px, py) {
    const el = box();
    if (!el) return;
    next = clamp(next);
    if (px == null) { px = el.clientWidth / 2; py = el.clientHeight / 2; }
    const cx = (el.scrollLeft + px) / z, cy = (el.scrollTop + py) / z;
    z = next;
    apply(el);
    el.scrollLeft = cx * z - px;
    el.scrollTop = cy * z - py;
    onZoom();
  }
  const at = (el, e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function fit() {
    const el = box(), svg = svgOf(el);
    if (!svg) return;
    zoomTo(Math.min(el.clientWidth / +svg.dataset.w, el.clientHeight / +svg.dataset.h, 1));
  }
  function onWheel(e) {
    const el = e.target.closest && e.target.closest("[data-tree]");
    if (!el || !(e.ctrlKey || e.metaKey)) return; // a plain wheel scrolls
    e.preventDefault();
    zoomTo(z * Math.exp(-e.deltaY * 0.01), ...at(el, e));
  }
  const onTree = (e) => e.target.closest && e.target.closest("[data-tree]");
  const onNode = (e) => e.target.closest("[data-node], .tag, a, button");
  function onDown(e) {
    const el = onTree(e);
    if (!el || e.button !== 0 || onNode(e) || e.metaKey || e.ctrlKey) return;
    pan = { el, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp, { once: true });
  }
  function onMove(e) {
    if (!pan) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!pan.moved) { pan.moved = true; pan.el.classList.add("panning"); }
    pan.el.scrollLeft = pan.left - dx;
    pan.el.scrollTop = pan.top - dy;
    onZoom();
  }
  function onUp() {
    removeEventListener("pointermove", onMove);
    if (pan && pan.moved) { swallow = true; setTimeout(() => { swallow = false; }, 0); } // the drag's click is not a click
    if (pan) pan.el.classList.remove("panning");
    pan = null;
  }
  /** Clicks the view hands over first: the controls, a drag's end, ⌘-click. True when handled. */
  function click(e) {
    if (swallow) { swallow = false; e.preventDefault(); return true; }
    const b = e.target.closest && e.target.closest("[data-tz]");
    if (b) {
      const k = b.dataset.tz;
      if (k === "in") zoomTo(z * STEP); else if (k === "out") zoomTo(z / STEP); else if (k === "reset") zoomTo(1); else fit();
      return true;
    }
    const el = onTree(e);
    if (el && (e.metaKey || e.ctrlKey)) { zoomTo(e.shiftKey ? z / STEP : z * STEP, ...at(el, e)); return true; }
    return false;
  }
  function onDbl(e) {
    const el = onTree(e);
    if (!el || onNode(e)) return;
    e.preventDefault();
    zoomTo(e.shiftKey ? z / STEP : z * STEP, ...at(el, e));
  }
  function onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    root.classList.toggle("tz-key", mod);
    root.classList.toggle("tz-out", mod && e.shiftKey);
    if (e.type !== "keydown" || mod || !onTree(e)) return;
    if (e.key === "+" || e.key === "=") zoomTo(z * STEP); else if (e.key === "-") zoomTo(z / STEP); else if (e.key === "0") zoomTo(1); else return;
    e.preventDefault();
  }
  const onBlur = () => { root.classList.remove("tz-key", "tz-out"); };
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("dblclick", onDbl);
  addEventListener("keydown", onKey);
  addEventListener("keyup", onKey);
  addEventListener("blur", onBlur);
  return {
    get zoom() { return z; },
    controlsHtml, apply, click,
    dispose() {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("dblclick", onDbl);
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKey);
      removeEventListener("blur", onBlur);
      removeEventListener("pointermove", onMove);
    },
  };
}
