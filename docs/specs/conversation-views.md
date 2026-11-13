# Conversation views: Files, History, Sandbox, Stats

Status: implemented with DSH's public `conversation.view` slot; no DSH change.

A project session's conversation gets four LayerFS tabs beside DSH's own:

```text
Chat · Trajectory · Files · History · Sandbox · Stats
 DSH     DSH        dsh-layerfs
```

Chat (order 0) and Trajectory (order 10, shown only while Developer tools is
on) are stock DSH and unchanged. Trajectory is the trace for now; the plugin's
call log stays a sidebar page (`docs/specs/layerfs-logs.md`) and gets no tab.

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
| Files | `layerfs-files` | 20 |
| History | `layerfs-history` | 30 |
| Sandbox | `layerfs-sandbox` | 50 |
| Stats | `layerfs-stats` | 60 |

Each entry receives the owner props `openView(view, focus)`, `viewRequest` and
`completeViewRequest`. A view opens another with a JSON focus string
(`{"commit":…,"branch":…,"path":…}`); the target reads `viewRequest` once and
acknowledges it.

The LayerFS tabs have no chat composer. While one is mounted it registers a
`conversation.composer` chain entry (priority -100, selected only for its
session) that renders nothing; DSH then hides the stock composer but keeps it
mounted, so a draft survives. Approvals, questions and the subagent read-only
composer outrank it and still show. Switching back to Chat unmounts the view
and releases the entry.

Constraints of the seam (reported, not worked around):

- The tab list is global, not per session, and DSH's session list does not
  notify on selection. So the plugin registers its entries only while a
  conversation on screen is a project session: an invisible
  `conversation.session.header.actions` entry reports each mounted header, and
  `session.place` says whether it has a project (subagents included). Normal
  workspace sessions show only Chat and Trajectory; a remembered LayerFS tab
  falls back to Chat. In a split view with one project and one workspace
  session the tabs show for both, and the workspace one gets the
  "not in a LayerFS project" state.
- Only an entry of `conversation.view` receives `openView`; nothing outside the
  tabs (Chat's messages, the header, the sidebar) can select one. Linking from
  Chat to a tab needs a public "select view" call on the conversation service.

## 2. Session resolution

A subagent shares its root's project context (`binding.kind === 'shared'`).
Views resolve the root through DSH's session list (`useSessions`:
`byId[id].parentSessionId` while `origin === 'subagent'`) and read
`session.state` for that root. All four views show the root's project; the
Sandbox map also lists every subagent under the root.

Data comes from existing host operations only, so the views need no host
restart:

| Need | Operation |
| --- | --- |
| Binding, unsaved count, execution | `session.state` |
| Files, branches, commits, diffs | the shared file views (`files/`) over the `http` op |
| Calls per session | `logs.list { tag: "dsh:<sessionId>:" }` |
| Live refresh | events `layerfs-session`, `layerfs-checkpoint`, `logs` |

## 3. Files

`ProjectFiles` on the root's project, opened on the session's current branch.
A focus from History (`{branch, commit, path}`) opens that saved version. The
header line says which branch is live for the session and how many files are
unsaved in its workspace (`status.overlay.entries`); unsaved edits live in the
workspace, not in LayerFS, until the next save.

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
- Browser: on a side server, a project session shows the four tabs; Files
  opens on the session branch; History shows the project graph on the session
  branch; Sandbox draws the map with wires and replays
  calls; Stats shows the project's storage dashboard; a folder session shows
  the empty state.
