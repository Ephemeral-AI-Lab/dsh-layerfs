# Conversation views: Trajectory, Files, History, Sandbox, Stats

Status: implemented with DSH's public `conversation.view` slot; no DSH change.

Decisions that shape this page — the split view's DSH-side deviation, the
custom Trajectory with its owed parity, and the brand inks — are recorded in
`docs/specs/refinement-decisions.md`.

A project session's conversation gets five LayerFS tabs beside DSH's Chat:

```text
Chat · Trajectory · Files · History · Sandbox · Stats
 DSH     dsh-layerfs
```

Chat (order 0) is stock DSH. The plugin registers the other five entries:
Trajectory under DSH's own id (`trajectory`, order 10) one priority rank lower,
so the slot renders the plugin's view; while LayerFS mode is on it also
suspends DSH's stock Trajectory entry
(`@deepseek-ai/dsh-client-ui-trajectory`) through the cordis Loader and
re-enables it on the way out (`stock-trajectory.ts`). If that suspension fails,
the plugin takes its own Trajectory entry back, so one tab remains (the stock
one) and the other four tabs stay. DSH hides any entry with id `trajectory`
while Developer tools is off, so the stock and the plugin's Trajectory are both
hidden then. The plugin's call log stays a Center page
(`docs/specs/layerfs-logs.md`) and gets no tab.

## 1. Seam

`conversation.view` is a session-scoped list slot owned by
`client-ui-conversation`. Each entry registers `{ id, order, label }`; the
header renders the entries as one tab row (with a More menu when space runs
out) and the body renders only the selected entry, inside the resident
scrollport above the composer. DSH's experimental Stats view uses the same
slot (id `stats`, order 40); the LayerFS Stats tab has its own id, so both can
show.

| Tab | id | order |
| --- | --- | --- |
| Trajectory | `trajectory` | 10 (priority -1; the stock entry of the same id is suspended) |
| Files | `layerfs-files` | 20 |
| History | `layerfs-history` | 30 |
| Sandbox | `layerfs-sandbox` | 50 |
| Stats | `layerfs-stats` | 60 |

Each entry receives the owner props `openView(view, focus)`, `viewRequest` and
`completeViewRequest`. A view opens another with a JSON focus string
(`{"commit":…,"branch":…,"path":…}`); the target reads `viewRequest` once and
acknowledges it.

A project session's LayerFS tabs have no chat composer. Once `session.state`
confirms a project binding, a mounted tab registers a `conversation.composer`
chain entry (priority 100, selected only for its session) that renders nothing;
while that read is loading or failed, none is registered, so the composer stays.
A chain elects in ascending priority, so the takeovers it must yield to are
tried first — approval (1), user questions (0), the subagent read-only composer
(-10) — and still show; DSH's stock composer stays the fallback and is kept
mounted, so a draft survives. Switching back to Chat unmounts the view and
releases the entry.

Constraints of the seam (reported, not worked around):

- The tab list is global, not per session, and DSH's session list does not
  notify on selection. So the plugin registers its entries only while a
  conversation on screen is a project session: an invisible
  `conversation.session.header.actions` entry reports each mounted header, and
  `session.place` says whether it has a project (subagents included). Normal
  workspace sessions show only Chat and the stock Trajectory; a remembered
  LayerFS tab falls back to Chat. In a split view with one project and one
  workspace session the tabs show for both: the DSH pane gets the five tabs and
  the LayerFS audit Trajectory (its LayerFS tabs say "not in a LayerFS project"),
  but it keeps its own composer, as plain DSH does: a tab hides the composer only
  once `session.state` confirms a project binding, and a DSH session has none.
  The accepted deviation is therefore the five tabs and the audit Trajectory
  only, not the composer. The faithful fix is a DSH seam (a per-session view
  registration or a tab row filter), recorded as a request in
  `docs/specs/refinement-decisions.md` §2.
- Only an entry of `conversation.view` receives `openView`; nothing outside the
  tabs (Chat's messages, the header, the sidebar) can select one. Linking from
  Chat to a tab needs a public "select view" call on the conversation service.

## 2. Session resolution

A subagent shares its root's project context (`binding.kind === 'shared'`).
Views resolve the root through DSH's session list (`useSessions`:
`byId[id].parentSessionId` while `origin === 'subagent'`) and read
`session.state` for that root. Files, History, Sandbox and Stats show the
root's project; the Sandbox map also lists every subagent under the root.
Trajectory is the mounted session's own view (`session.trajectory`), so a
subagent's Trajectory shows its own records.

The views read `session.state { observe: true }` on mount, on
`layerfs-session`, `layerfs-checkpoint` and `layerfs-operation` (coalesced to
at most one read per 500 ms) and every 10 s while visible, none of it a press,
so the read changes nothing. The content views (Files' tree, History's graph,
Stats' storage) follow `layerfs-checkpoint` only, plus reconnect. Trajectory
reads `session.trajectory` on its LayerFS events (1 s coalesced) and every 3 s
while the session runs. A refused machine, Store or Workspace check comes back
as `execution.available: false` with its reason; the binding is never
interrupted or saved by a view's read. Interrupting stays with an explicit
action (a message's activation) and the host's own Store availability poll.

Data comes from existing host operations only, so the views need no host
restart:

| Need | Operation |
| --- | --- |
| Binding, unsaved count, execution | `session.state { observe: true }` |
| Trajectory and its records | `session.trajectory`, `session.trajectory.record` |
| Files, branches, commits, diffs | the shared file views (`files/`) over the `http` op |
| Calls per session | `logs.list { tag: "dsh:<sessionId>:" }` |
| Live refresh | events `layerfs-session`, `layerfs-checkpoint`, `layerfs-operation`; a 10 s poll while visible. Content views follow `layerfs-checkpoint` only (plus reconnect); Trajectory 1 s on events, 3 s while running |

## 3. Files

`ProjectFiles` on the root's project, opened on the session's current branch.
A focus from History (`{branch, commit, path}`) opens that saved version. The
header line says which branch is live for the session and how many files are
unsaved in its workspace (`status.overlay.entries`); unsaved edits live in the
workspace, not in LayerFS, until the next save. The branch chip reads the
host's `branchKind`/`restore` (own, restore *n*, resume, or another Branch by
name), falling back to the shared `describeBranch` when the host has none.

## 4. History

`ProjectHistory` on the root's project, focused on the session's branch. Opening
a file from a commit opens Files at that saved version (`openView`).

Session checkpoints are out of scope for now. They are still made and stored
(`session.state`, the session archive), but no view lists or restores them.

## 5. Sandbox

A map of where the session's work runs. The LayerFS mark sits in a round hub
at the centre; branches are pills on an arc around it (an ellipse when there
are many); agents wire into the hub from the left; sandboxes with their
workspaces sit on the right:

```text
Agents (whales)        LayerFS                  Sandboxes
root ──────────┐          ┌── branch ─────────>  sandbox (machine, state)
  subagent ────┼──> (LayerFS) ── branch ──────>    workspace (branch, status)
  subagent ────┘          └── branch
```

Each agent is drawn as a whale in its own hue (six token-mixed hues, repeated);
its calls travel in that hue. The whale's spout shows, and it bobs, only while
the agent has a call running.

Nodes are derived, not configured:

- Agents: the root and its subagents from the DSH session list (`origin:
  'subagent'` rows and their `parentId`); a running session shows a live dot.
  The root is "Main agent"; a subagent is named by the label it was delegated
  under (the `subagent` projection, e.g. "Docs worker"), else its title.
  Subagents with no LayerFS calls (theirs or their subagents') fold into one
  "N more subagents without LayerFS calls" row. A subagent's own Sandbox tab
  shows its root's tree, with "This chat" on it.
- Branches: the binding's branch and any branch named by a call (`file|branch|commit <project> <branch>`,
  `workspace mount <sandbox> <branch>`, `branch fork <project> <name>`).
- Sandboxes and workspaces: the binding's sandbox/workspace plus those named by
  calls (`sandbox create <project> <name> <machine>`,
  `workspace mount … --name <ws>` → `<sandbox>:<ws>`,
  `workspace exec|commit|status|unmount <sandbox>:<ws>`).

Each call from the agents' call logs becomes an event (polling reads such as
`project.get`, `file.list`, `workspace.status` and the `list` calls are left
out). Only an answered call adds a node: a refused `sandbox create` or mount
made nothing, so its event names only the nodes that exist. A call
travels one continuous path: agent → into the hub → out along its branch's
spoke (→ the workspace, for a workspace call), or, for a sandbox call without a
branch (`sandbox create|close`), agent → hub → out between the pills → the
sandbox. Agent → hub, hub → branch and branch → workspace wires stay drawn
(dashed before the branch is forked or the workspace mounted); branches mounted
in a workspace take arc slots in workspace order so those wires do not cross.
Every call travels once: its request packet (the agent's hue, with a short
tail) eases out to the target, which ripples on arrival and stays lit while the
call runs; when it ends the result travels back once (green, red for a
refusal), ripples at the whale, and the path fades over 1.5 s. Nothing moves
when no call runs. Every position of a packet, ripple, spout or fade is a pure
function of the replay clock, so pausing freezes it and scrubbing moves it
(`phaseOf` in `model.ts`). Sandboxes and branches not created yet at the
playhead show as dashed ghosts, so the layout does not jump during a replay.
Hovering a node or a call dims what it does not touch; selecting a call opens
its command, timing, outcome and, when this plugin kept it, what it printed
(`logs.output`).

The map reads the log (`logs.list` per agent) and follows `logs` events. An
event names the root session and project that changed when everything appended
in its one-second window has exactly one owner of each; the map ignores another
session's calls. A rotation, a partial or untagged line, an output write, or a
window that mixed sessions or projects names none, and every open view
refreshes. Reads are coalesced: 4 s for the map, 3 s for the project page's
Sandboxes tab, which follows the same event filtered by project instead of root
session. A hidden page reads nothing until it is shown.

Time: calls are written to the log when they finish, so the map replays rather
than streams. The replay clock keeps real order but paces calls so each can be
watched: idle gaps shrink to one second, every call lasts 1.4–6 s on the
replay, and one agent's back-to-back calls get their own windows 0.25 s apart
(the push delays everything after it, so order across agents is kept). The
replay ends 2.4 s after the last call (result travel plus fade) so it comes to rest. Controls are
Play/Pause (Play again at the end), Replay from the start, Live, and a scrubber
under the map with one thin row of call bars per agent. Live keeps the playhead at the end and plays each
call as it is appended. The view opens at Live while any agent is running,
otherwise at the end, paused. `prefers-reduced-motion` turns packets, ripples, the
whales' bob and fades off: a running call shows its lit path, then its result colour.

Each sandbox card shows its machine's mark (native macOS/Linux, Docker, Lima,
Apple Container, microsandbox, from `GET /api/machines`), its name and status;
the machine and workspace count are in its tooltip. A workspace is one line
(name, and what it is doing now); clicking it unfolds its terminal under it and
widens the column. The Activity list under the map folds, and its state is
remembered per browser.

The exec command is redacted in the call log (`<N bytes>`), so the map itself
names the call and its workspace, not the command line. The workspace terminal
recovers it: a call's tag (`dsh:<sessionId>:<receiptId>`) joins it to the
agent's tool call in `session.trajectory`, whose arguments hold the command and
whose result holds the output (`session.trajectory.record`); calls one tool call
made share one entry. The command is shown as the agent meant it: the plugin's
`test -n "$DSH_LAYERFS_WS" &&` guard is dropped and each
`"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" '<cmd>' --stream` part
becomes `<cmd>`. A call with no tool call shows its logged words (or "command
not kept" when redacted) and what `logs.output` kept. Only `workspace.exec`
calls appear, up to the replay clock, newest twelve, following the newest.

## 6. Stats

The project's storage, read from `GET /api/projects/<key>/storage`: the same
`ProjectStorage` panel as the Stats tab of the project's page in Storage (one
component, the Storage page's copy), not a second page. It shows the packed
bytes, the flow from saved snapshots to packed bytes, the project's share of
its Store, main's latest tree, saves and publications, packed bytes over
history and what each recent save added. It is project-wide (every branch),
re-reads on the root's checkpoints, and "View Store usage" opens the Store's
tab in Storage.

## 7. No side panel

There is no LayerFS tab in DSH's right sidebar, no LayerFS button in the
session header and no checkpoint notes under Chat's turns (LayerFS Connect had
none either). A project session is marked by its row glyph in the Workspace
list and by these tabs. A project is chosen for a new session on the New
Session row.

## 8. Verification

- Unit: `test/views-model.test.mjs` covers argv → nodes, root resolution and
  replay timing.
- Browser: on a side server, a project session shows five tabs and exactly one
  Trajectory (the LayerFS audit view; DSH's stock entry is suspended); Files
  opens on the session branch; History shows the project graph on the session
  branch; Sandbox draws the map with wires and replays calls; Stats shows the
  project's storage dashboard. A folder session shows only Chat and the stock
  Trajectory (no LayerFS tabs; a remembered LayerFS tab falls back to Chat),
  and with Developer tools off neither Trajectory shows for either kind of
  session.
- Guard: make the stock entry's `update` fail; the plugin takes its own
  Trajectory entry back, exactly one (stock) Trajectory tab remains, and the
  other four tabs stay.
- Split view: with one project and one DSH session the DSH pane shows the same
  five tabs and the audit Trajectory while keeping its composer (its tabs show
  "not in a LayerFS project"); the tabs and the audit Trajectory are the
  accepted deviation in §1, not a bug. The composer is not hidden while
  `session.state` is loading or its read failed.
