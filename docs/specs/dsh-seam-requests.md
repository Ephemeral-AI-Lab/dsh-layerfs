# DSH seam requests

Status: **open requests to DSH** (2026-11-25). Two public seams the
dsh-layerfs refinement needs and DSH 0.2.2-rc.1 does not expose. Until they
ship, the plugin keeps the documented workarounds below; it does not fork,
vendor or patch DSH (`AGENTS.md`).

## 1. Per-session `conversation.view` (or a per-session tab-row filter)

**Problem.** `conversation.view` is a global list slot: every visible
conversation gets the same entries, and DSH's session list does not notify on
selection. The plugin registers its five tabs only while at least one visible
conversation is a project session, and is global for all panes
(`src/client/views/index.tsx`). In a split view with one project session and
one plain DSH session, the DSH pane therefore gets the five LayerFS tabs and the
plugin's audit Trajectory; that is the accepted deviation recorded in
`refinement-decisions.md` §2 and the guide.

**What is needed.** Either

- a registration scoped to a session (the slot resolves entries per
  `sessionId`), or
- a tab-row filter callback evaluated per session.

**Why.** The DSH pane keeps its stock tab row and stock Trajectory; the plugin's
tabs appear only in the project pane. Third-party plugins that register into
`conversation.view` keep their meaning, and the plugin stops needing a global
mode switch plus the Loader suspension of the stock Trajectory.

**Acceptance.** In a split view (project + DSH) the DSH pane's tab row and
Trajectory are stock; the project pane has the five LayerFS tabs; no tab
flicker when switching conversations; a failed `session.place` read does not
change either pane's tabs.

## 2. A tool-call-level slot inside the stock Trajectory

**Problem.** `@deepseek-ai/dsh-client-ui-trajectory` registers only
`conversation.view`; its `TrajectoryView` and stores are not exported and it
offers no inner seat. A plugin cannot add a row under (or inside) one tool
call. To show the LayerFS calls a tool call made, the versions it saved and
the host checkpoints, dsh-layerfs currently replaces the whole view with its
own copy, which duplicates a DSH surface and loses stock features (token
usage, prompt diffs, tool schemas, system/request records, live text) until
parity work catches up.

**What is needed.** A public slot rendered once per tool-call record in the
stock Trajectory, with the call's identity and owner props, e.g.
`conversation.trajectory.toolCall.tail` receiving
`{ sessionId, seq, callId, name, status }`, and ideally a seat for an extra
timeline lane. A plain children/slot on the tool-call row is enough.

**Why.** LayerFS rows can sit under the stock view; the stock Trajectory stays
mounted, so third-party plugins keep its services, Conversation target and
events, and dsh-layerfs can retire its copy. The "Inspect" target also stays
stock.

**Acceptance.** With the stock Trajectory on screen, a plugin can render a
node under every tool call, receive the call id/status, and re-render when the
call changes; the stock view's own layout, inspector and stores are untouched.

## Until these ship

- Request 1: global mode + the documented split-view deviation; the DSH pane
  keeps its composer (amendment) but gets the LayerFS tabs/Trajectory.
- Request 2: the plugin's own Trajectory view (`layerfs-trajectory.md`), with
  the parity list in that spec; a tool-call-level seam would let it retire.

Both requests are also referenced from `conversation-views.md` §1 and
`layerfs-trajectory.md` §2.
