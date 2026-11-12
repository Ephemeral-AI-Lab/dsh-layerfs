# Conversation views: Files, History, Sandbox

Status: implemented with DSH's public `conversation.view` slot; no DSH change.

A project session's conversation gets three LayerFS tabs beside DSH's own:

```text
Chat · Trajectory · Files · History · Sandbox
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
scrollport above the composer. DSH's Stats view uses the same slot.

| Tab | id | order |
| --- | --- | --- |
| Files | `layerfs-files` | 20 |
| History | `layerfs-history` | 30 |
| Sandbox | `layerfs-sandbox` | 50 |

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
  notify on selection. So the plugin registers the three entries only while a
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
`session.state` for that root. All three views show the root's project; the
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

A map of where the session's work runs, after Connect's `SandboxMap`:

```text
Agents            LayerFS            Sandboxes
root ─────────┐   project            sandbox (machine, state)
  subagent ───┼─> branch ──────────>   workspace (branch, status)
  subagent ───┘   branch
```

Nodes are derived, not configured:

- Agents: the root and its subagents from the DSH session list; a running
  session shows a live dot.
- Branches: the binding's branch and any branch named by a call (`file|branch|commit <project> <branch>`,
  `workspace mount <sandbox> <branch>`, `branch fork <project> <name>`).
- Sandboxes and workspaces: the binding's sandbox/workspace plus those named by
  calls (`sandbox create <project> <name> <machine>`,
  `workspace mount … --name <ws>` → `<sandbox>:<ws>`,
  `workspace exec|commit|status|unmount <sandbox>:<ws>`).

Each call from the agents' call logs becomes an event (polling reads such as
`project.get`, `workspace.status` and the `list` calls are left out). A call
travels a chain of wires: agent → branch → workspace, agent → branch, or, for a
sandbox call without a branch (`sandbox create|close`), agent → project hub →
sandbox. Agent → branch and branch → workspace wires stay drawn; the hops
through the hub exist only around their call. While a call runs its wires light
in its lane colour, a dashed flow runs along them and a request packet loops
over the chain; when it ends a result packet runs back (green, red for a
refusal) and the wires stay green or red for 1.5 s. Packets are placed from the
replay clock, so pausing freezes them and scrubbing moves them. Hovering a node
or a call dims what it does not touch; selecting a call opens its command,
timing, outcome and, when this plugin kept it, what it printed (`logs.output`).

Time: calls are written to the log when they finish, so the map replays rather
than streams. The replay clock keeps real order but paces calls so each can be
watched: idle gaps shrink to one second, every call lasts 1.4–6 s on the
replay, and one agent's back-to-back calls get their own windows 0.25 s apart
(the push delays everything after it, so order across agents is kept). The
replay ends 1.5 s after the last call so it comes to rest. Controls are
Play/Pause (Play again at the end), Replay from the start, Live, and a scrubber
in the strip under the map. Live keeps the playhead at the end and plays each
call as it is appended. The view opens at Live while any agent is running,
otherwise at the end, paused. `prefers-reduced-motion` turns packets, flows and
pulses off.

The exec command is redacted in the call log (`<N bytes>`), so the map names
the call and its workspace, not the command line.

## 6. No side panel

There is no LayerFS tab in DSH's right sidebar, no LayerFS button in the
session header and no checkpoint notes under Chat's turns (LayerFS Connect had
none either). A project session is marked by its row glyph in the Workspace
list and by these tabs. A project is chosen for a new session on the New
Session row.

## 7. Verification

- Unit: `test/views-model.test.mjs` covers argv → nodes, root resolution and
  replay timing.
- Browser: on a side server, a project session shows the three tabs; Files
  opens on the session branch; History shows the project graph on the session
  branch; Sandbox draws the map with wires and replays
  calls; a folder session shows the empty state.
