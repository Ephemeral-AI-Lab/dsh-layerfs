// Where each agent stands, from its own calls only: nothing is assigned.
// An agent stands where its last call ran while that call is recent, then
// on its mounted Workspace, else on the bench.

/** Seconds an idle agent stays on a Branch tab's "recently here" bench. */
export const RECENT_S = 90;
/** Seconds a call keeps its agent where it ran. */
export const CALL_S = 12;
/** How many agents each kind of host draws before "+N". */
export const CAP = { row: 3, term: 3, bench: 6, chip: 1 };
/** Idle Branch tabs fade after this many seconds unless pinned; at most MAX_TABS show. */
export const FADE_S = 30,
  MAX_TABS = 6;
/** Seconds after which a Branch nobody is on, with no Workspace or conflict, retires
 * from the tabs and the board (still in History, and in the tabs' "+N" menu), and a
 * closed Sandbox leaves the Sandboxes list. */
export const RETIRE_S = 120;

export function where(W, n) {
  const A = W.agents[n];
  if (!A) return null;
  if (W.clock - A.lastT <= CALL_S) return A.lastLoc;
  const w = Object.values(W.ws).find((x) => x.agent === n);
  return w ? { kind: "ws", branch: w.branch, ws: w.id } : { kind: "bench" };
}
export const idle = (W, n) => where(W, n).kind === "bench";
export const recentlyOn = (W, b) =>
  Object.keys(W.agents).filter(
    (n) => idle(W, n) && W.agents[n].lastBranch === b && W.clock - W.agents[n].lastT <= RECENT_S,
  );
export const agentsOn = (W, b) => Object.keys(W.agents).filter((n) => where(W, n).branch === b);
export const conflicted = (W, b) => Object.values(W.ws).some((w) => w.branch === b && w.bad);
export const mounted = (W, b) => Object.values(W.ws).some((w) => w.branch === b);
export const retired = (W, b) =>
  !agentsOn(W, b).length && !mounted(W, b) && !conflicted(W, b) && W.clock - W.branches[b].last > RETIRE_S;

/** The Branch tabs to show: pinned, active, mounted, conflicted or recently
 * touched, newest first, at most MAX_TABS (the active one always kept); the
 * rest are hidden, or retired after RETIRE_S (newest first). */
export function visibleTabs(W, { pinned = {}, active = "main" } = {}) {
  const show = W.order.filter(
    (b) => pinned[b] || b === active || mounted(W, b) || conflicted(W, b) || W.clock - W.branches[b].last <= FADE_S,
  );
  show.sort((x, y) => W.branches[y].last - W.branches[x].last);
  const keep = show.slice(0, MAX_TABS);
  if (show.includes(active) && !keep.includes(active)) keep[keep.length - 1] = active;
  const rest = W.order.filter((b) => !keep.includes(b));
  const old = rest.filter((b) => !pinned[b] && retired(W, b)).sort((x, y) => W.branches[y].last - W.branches[x].last);
  return { tabs: W.order.filter((b) => keep.includes(b)), hidden: rest.filter((b) => !old.includes(b)), retired: old };
}

/** The terminal an agent's location names, for the "last hit" highlight. */
export function locKey(l) {
  return !l
    ? null
    : l.kind === "ws"
      ? "ws:" + l.ws
      : l.kind === "fs"
        ? "fs:" + l.branch
        : l.kind === "hist"
          ? "hist"
          : null;
}
