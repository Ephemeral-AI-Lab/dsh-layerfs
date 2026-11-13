# LayerFS project sessions and conversation handling

Status: implementation specification, based on the session-design discussion.
The implementation retains stock DSH formats and public plugin seams; practical
integration details are recorded below.

## 1. Session ownership

There are two explicit session types:

```text
LayerFS Project                 DSH Workspace
 └─ Project Session              └─ Normal Session
```

- A project session belongs to one LayerFS project. The project is the center of
  navigation, execution, saved file history, and conversation ownership.
- A normal session belongs to a DSH workspace and retains stock DSH behavior.
- A project session does not acquire a second owner merely because its selected
  local folder is also registered as a DSH workspace.
- Both types reuse DSH's conversation runtime and log format. They differ in
  ownership, persistence routing, execution context, and LayerFS annotations.
- Choose the owner before the first turn. Changing the project, or switching
  between project and normal mode after work begins, creates a new session.
  Moving existing history would require a separate explicit migration operation.

## 2. A selected workspace becomes scratch in project mode

Ownership and the selected local folder are independent:

| Session type | Owner | Role of selected local folder |
| --- | --- | --- |
| Normal | DSH workspace | Ordinary working files |
| Project | LayerFS project | Scratch: temporary files, downloads, local outputs |

Users can select any available local workspace/folder, including an existing DSH
workspace, for a project session. Do not require a generated per-session scratch
folder. An optional default may be offered when no folder has been selected.

The scratch designation applies to the session, not globally to the folder.
The same folder can remain the working folder of normal sessions. Scratch does
not imply disposable: never clear a user-selected folder when closing, forgetting,
or deleting a session. Multiple sessions can select the same folder; do not claim
that their scratch files are isolated.

Project file operations target the session's LayerFS execution context. The
selected folder remains available for local scratch work. Prompts and controls
must distinguish the project files from scratch, including on native machines
where the LayerFS mount has a host path. A local shell command must not silently
change meaning based on whether the project's machine is native or remote.

Record the local folder selection as machine-local state. Opening a portable
session elsewhere may require selecting another folder; this does not change
project ownership. Never automatically create or execute in an imported absolute
path from another machine.

## 3. Storage locations

The project-session home defaults to `<DSH_HOME>/layerfs/project-sessions`
(it was `~/.layerfs/dsh`, which is now inside the LayerFS home; see
`homes.md`). Normal sessions remain in `<DSH_HOME>/sessions`.

```text
<DSH_HOME>/layerfs/project-sessions/
 └─ projects/<project-id>/
     └─ sessions/<session-id>/
         ├─ <standard DSH session files>
         └─ layerfs.json

<DSH_HOME>/sessions/
 └─ <standard normal-session files>
```

`<project-id>` is the project's UUID (§11, "Project identity"), so a directory
name never comes from a display name and a recreated project with the same name
never shares a directory with the old one.

The standard DSH files are the local durable conversation log. `layerfs.json` is
an additive sidecar for project identity, operation receipts, checkpoint links,
and archive progress. Machine-local mount handles and folder preferences remain
local and are excluded from portable session identity.

The stock backend retains its native cwd partition beneath each project's
`sessions/` root. The on-disk directory is therefore that backend's native
layout, rather than a new session-file naming scheme. `owners.json` in the
project-session home routes session IDs to project identities independently of
DSH's workspace metadata. Owners recorded before project UUIDs keep their
64-hex directory key; they stay readable and are never adopted (§11).

Do not store session internals in the selected scratch folder. Do not maintain a
second authoritative project-session log in `<DSH_HOME>/sessions`; indexes there,
if required by a public DSH seam, are routing information rather than log copies.

The local log and sidecar are also archived into the LayerFS project for
portability. Internal history storage stays separate from project code history,
so saving a conversation does not create a visible project-file checkpoint and
restoring code does not roll back the conversation.

Archive writes are asynchronous. Track the exact log position saved into LayerFS
and expose pending/error state; a local write is not a claim of portable durability.

The archive (version 3, under `/.dsh/session/` of the session's internal
`dsh.session.<id>` branch) is append-only, so a save costs what was added rather
than the whole conversation:

- `session.jsonl` is a native unpacked DSH log (header and rows); each
  `session.<line>.jsonl` part holds the native rows added by one later save. The
  files concatenated in `manifest.log` order are the exact log.
- `layerfs.json` is the sidecar without its receipts; `invocations.jsonl` and its
  `invocations.<line>.jsonl` parts hold the receipts, one per line, in
  `manifest.invocations` order.
- Manifest file lists give each file's line range (`from`, `to`; the log's line 0
  is its header) and byte size. Import checks names, contiguity, line counts and
  the checksum over the log, the sidecar (without archive progress) and the
  receipts.
- A save appends only when the stream's archived prefix is unchanged (local
  marks: line count and checksum). Otherwise (a header or receipt changed in
  place, or no marks), or once a stream has 32 parts or its parts outgrow
  `max(base, 64 KiB)`, the stream is rewritten as one base file and its parts are
  removed in the same commit. Version-2 (one native file) and version-1 archives
  stay readable and are rewritten as version 3 on their next save.

Saves to one Store run one at a time, on a lane per Store: LayerFS serializes
writers on a Store anyway, so concurrent saves would only wait on its Store lock
and hold up the user's own calls. A session waiting in that queue is not queued
again; its save reads the latest log when it starts.
Import reconstructs the same DSH files and annotations without rewriting event
identities. Resume local durable work first; reconcile archive progress without
discarding locally pending events or blindly overwriting divergent histories.

The storage root must be configurable. Development and tests use private `.dev*/`
roots and must not touch the user's real `~/.layerfs`. This document authorizes no
runtime migration or writes to that directory.

## 4. Preserve DSH's conversation format

Use the complete stock DSH session representation, including messages, tool
calls, results, event ordering, and fork/inheritance semantics. Keep logs unpacked
and directly inspectable using the normal DSH JSONL representation.

Do not split the session into new `conversation/`, `execution/`, `operations/`, or
`checkpoints/` log formats. Do not rewrite original messages or tool results to
insert LayerFS labels. Use the sidecar to reference existing event and tool-call
identities. A missing sidecar must not prevent reading the original conversation.

The sidecar records only the additional information needed to connect DSH tool
calls to observed LayerFS invocations and confirmed saved versions. It is not a
replacement transcript or a copy of full tool output.

## 5. Operation and checkpoint associations

The association model supports:

```text
DSH session / turn / tool call
 └─ zero or more observed LayerFS invocations
     └─ zero or more confirmed saved-version links
```

Each invocation (a receipt in the session sidecar's `invocations[]`) is
`{id, origin, sessionId, project, turn?, toolCallId?, operation, outcome,
versions, captureGap?, at, ms, argv, tag?, code?, kind?, execId?, exit?, step?,
imported?}`: a unique receipt ID, origin (`tool` or `host`), session
and turn identity where available, optional DSH tool-call identity, canonical
operation (`family.call`), target project and outcome (`success`, `refusal`,
`unknown`). Saved-version links carry the actual version identity and an effect
such as `created`, `unchanged`, or `referenced`. Preserve typed Commit versus
Layer identities. The receipt also carries the call itself (start, duration,
redacted portable argv, log tag, outcome code, result kind, exec id and exit,
the simulation step) so it renders without this machine's call log; the exact
fields, caps and the import merge are in docs/specs/layerfs-logs.md §4–§5a.
Older sidecars may also hold `arguments`, `source`, `startedAt`, `finishedAt`
and `error`, or lack the call fields; they are read as they are and those old
fields are no longer written.

**Tag.** Every CLI call made inside a project session's trace context carries
`LAYERFS_LOGS_TAG=dsh:<sessionId>:<receiptId>`, with one new receipt ID per call
and the caller's own session ID (a subagent's, not its parent's). Calls outside
a trace context run with any inherited `LAYERFS_LOGS_TAG` removed. Store archive
writes stay untagged and record no receipt.

**Checkpoint receipt.** A checkpoint carries `receipt`, the receipt ID of the
call that saved or referenced it: the host `workspace.commit` of a `turn`,
`manual` or `idle` checkpoint (also for an `UpToDate` save, shown as unchanged,
and for a failed save, whose line keeps the refusal code), and the successful
`branch.fork` of a `restore` checkpoint, of a branched child's `base` and of a
session's first binding. A commit ID alone cannot bind: the same commit is named
by the source turn, a later restore, a branch's base and every `UpToDate` save.

One tool call may invoke multiple LayerFS operations. Repeated invocations of
the same command are separate invocations. A tool call may have no checkpoint.
Host-generated saves have a host origin; never invent a DSH tool call for them.

Use confirmed operation results or verified reconciliation to obtain saved-version
identities. Never associate a call with a commit by timestamp proximity, the
current project head, command-string parsing, or a generic success flag.

### Eligible CLI operations

| CLI command | Eligible saved-version association |
| --- | --- |
| `layerfs file write` | Resulting commit, or existing version if unchanged |
| `layerfs file edit` | Resulting commit, or existing version if unchanged |
| `layerfs file apply` | Resulting commit, or existing version if unchanged |
| `layerfs file rm` | Resulting commit, or existing version if unchanged |
| `layerfs file mkdir` | Resulting commit, or existing version if unchanged |
| `layerfs file mv` | Resulting commit, or existing version if unchanged |
| `layerfs file cp` | Resulting commit, or existing version if unchanged |
| `layerfs workspace commit` | Saved commit, existing head, or initial base Layer |
| `layerfs branch fork` | Reference to the existing starting version |
| `layerfs branch merge` | Confirmed resulting saved version |
| `layerfs branch publish` | Resulting published Layer |

Use an explicit supported-command table, not a `file.*` prefix rule. Extend it
only after verifying another command's saved-version receipt semantics.

**`workspace.exec` does not count.** It may be shown as an observed invocation,
but receives no checkpoint links merely because it ran or changed files. A later
`workspace.commit` owns the save association. Do not backfill that association
onto preceding `workspace.exec` calls as inferred contributors.

Reads, list/search/diff/status, mount/unmount, sandbox and machine lifecycle,
`project.init`, and scratch-folder writes also have no checkpoint links.
Internal conversation-archive writes are excluded from user-facing code
checkpoints even when implemented with an otherwise eligible write operation.

An unchanged result references an existing saved version and must not appear as
a newly created checkpoint. Fork references a starting version without claiming
authorship of it. Restore references an existing version without implying a new
file commit. Failed or uncertain operations do not receive invented links.

### Save boundaries

Retain explicit saves and automatic turn-end saves when project files changed.
Do not add an automatic save after every `workspace.exec`. A turn-end save is a
separate host-origin `workspace.commit` activity, associated with the turn.
Closing or restoring may save pending changes before proceeding, with the same
receipt rules. A failed save is visible as a failure, not as a saved checkpoint.

## 6. Capture in SDK and CLI modes

SDK calls carry the DSH correlation context to the common invocation boundary
(`execute()` in `src/host/layerfs/cli.ts`, under `traceInvocation`): the receipt
ID is made before the call, the child gets the tag, and the receipt is recorded
from the returned result, preserving the SDK-facing operation identity.

CLI calls receive the correlation context from the DSH tool execution through
the managed CLI entry point (`agent-bin/layerfs`): `DSH_LAYERFS_TRACE_CONTEXT`
stays per shell and names the tool call's receipt-ID prefix (`scope`); the
wrapper makes a receipt ID per invocation and sets the tag for its child. The
recording channel is the call log: LayerFS's own (#659) when the pinned CLI has
the `logs` family, else the plugin's stand-in, whose line the wrapper appends
itself. After each tool call (and again when the turn stops, for calls still
running when their tool call returned) the host builds that call's receipts from
lines tagged `dsh:<sessionId>:<scope>.…` since the call started, deduped by
receipt ID. A line yields versions from its `kind` and `commit`/`layer`
(`Committed`/`Added` created; `UpToDate`/`NoChanges` unchanged; `Forked` and
`Merged` referenced, since a line has no `fast_forward`); a `workspace commit`
whose Workspace is not the bound one gets no versions and
`captureGap: target-workspace-unconfirmed`. There is no receipt spool. Preserve
normal stdout, stderr, exit status, streaming behavior, and cancellation.

Both paths emit the same annotation model. If a wrapper and the SDK observe the
same invocation, correlate them by receipt ID and store one operation.
Context must be scoped per execution, including concurrent calls and subagents;
do not use a process-global 'current tool call'. Background work retains its
originating context or is marked unassociated when provenance is unavailable.

Shell-text parsing can help display a request, but is not evidence of execution.
CLI calls that bypass the managed entry point cannot be claimed as captured
without a supported LayerFS tracing source. Mark gaps honestly. Do not claim
that wrapper tracing observes every internal SDK/daemon operation or individual
filesystem write made inside `workspace.exec`.

Capture through public DSH plugin seams. Availability of a public hook carrying
the exact tool-call context into shell execution must be verified before
implementation claims complete CLI correlation. Do not fork DSH packages or
modify the read-only reference repositories to obtain such a hook.

## 7. Conversation and navigation UI

Navigate project sessions under their project and normal sessions under their
DSH workspace. Keep project identity visible in a project conversation, with the
selected local folder separately labeled as scratch. Selecting a scratch folder
must not move the session into that workspace's normal-session list.

The sidebar's Workspaces section has two views, switched by a LayerFS button in
its header and remembered per browser. The DSH view is DSH's own workspace
browser, unchanged apart from that button (hidden while DSH's search is open).
The LayerFS view keeps the same header (DSH's "Workspaces" label, the switch,
and a `+` menu) and lists the projects that have sessions on this DSH by name
(never named after the selected scratch workspace), each with Start or New
session, ⚙ for the project dialog, and its conversations folding out under it.
Creating, importing, configuring and picking projects happen in one modal; there
is no Projects page (docs/specs/layerfs-workspaces.md).

This is plugin-only. The LayerFS view is a `sidebar.workspaces` registration at
a lower priority than the stock browser, which the slot runtime renders instead
while it is registered. DSH has no header seam, so in the DSH view the switch
button is placed beside the stock header's actions row, which is found by its
CSS-module class (`WorkspacesView.tsx`).

Legacy LayerFS workspace registrations can be retired through an explicit
operation. Retirement removes only the generated registrations, preserving
directories, conversation logs, and project bindings. Ordinary conversations
from the old root group remain accessible as ungrouped DSH sessions. Until a
legacy registration is retired it shows in DSH's Workspaces section.

Reuse the DSH conversation renderer and add labels/details to existing tool calls:

- An eligible write: `Created checkpoint <commit>`.
- A confirmed no-op: `Unchanged · <version>`.
- A fork: `Starting checkpoint <version>`.
- A host turn-end save: a separate saved-checkpoint activity for that turn.

Show operation names and outcomes in expandable details when a tool invokes
multiple LayerFS commands. Checkpoint links open the saved file state or diff.
Aggregate only the actual eligible operation links belonging to that tool call.

Do not show branches, branch names, or branch-management controls in project
session navigation, headers, checkpoint details, or generated explanatory copy.
Internal branch identity remains an implementation detail. Preserve literal raw
tool output in the original DSH log rather than redacting or rewriting it; the
curated UI must not promote branch fields into user-facing controls.

## 8. Resume, subagents, and migration

Resume resolves the explicit session owner and uses that owner's persistence
backend. A project session with an unavailable project must not fall back to
executing in scratch as though it were a normal session.

Subagents inherit project ownership and the parent's execution context. Preserve
their native DSH session/tool identities in annotations so concurrent operations
remain distinguishable. If a save covers shared work, do not invent per-subagent
file attribution. Conversation forks retain DSH's native history semantics and
reference the selected saved file version.

Migration from the existing model must preserve session IDs, DSH events, code
history, and confirmed checkpoint links. Validate copied logs and annotations
before changing routing. Keep old data until migration succeeds; do not delete
user-selected folders or treat generated scratch contents as automatically
disposable. Legacy bindings may establish ownership during migration, but future
ownership must not be inferred from a folder path.

## 9. Acceptance criteria

1. Normal sessions retain stock DSH storage and execution behavior.
2. Project sessions are owned and listed by project, with local logs under the
   configured project-session home, defaulting to `<DSH_HOME>/layerfs/project-sessions`.
3. An existing DSH workspace can serve as scratch for a project session without
   changing ownership or affecting normal sessions using the same folder.
4. Project logs open using the standard DSH format without LayerFS annotations;
   annotations enrich the same conversation when available.
5. An eligible operation's confirmed version links to its exact originating tool
   call in both SDK and managed CLI execution, including repeated/concurrent calls.
6. `workspace.exec` never gains an inferred checkpoint link. A subsequent explicit
   or host save is shown independently.
7. Reads, lifecycle operations, scratch writes, and internal archive writes never
   appear as code checkpoints. No-op references do not masquerade as new commits.
8. Project session UI presents projects, conversations, operation activity, and
   checkpoints without exposing branch controls or generated branch labels.
9. A second installation can reconstruct the conversation and annotations from
   the project archive, selecting its own local scratch folder.
10. Interrupted saves, uncertain receipts, archive lag, and tracing gaps remain
    distinguishable from confirmed successful saves; reconciliation does not
    blindly replay a potentially completed mutation.
11. Migration preserves original histories and IDs, and development verification
    remains entirely within private `.dev*/` state.

## 10. DSH integration details

- The conversation extension uses the public turn-tail slot to group exact
  operation associations by tool-call ID. It leaves native tool cards intact.
  Version labels open an immutable file view pinned to the returned saved version.
- DSH has no public workspace-session list filter. The host detaches materialized
  project sessions using the public workspace registry. A trailing-row slot
  adapter hides their fallback Ungrouped rows only when the exact session row
  identity matches; unknown markup remains visible. Blank membership is retained
  until materialization to satisfy DSH's native reusable-session rule.
- The project-specific Scratch picker changes the selected folder on the same
  session. It does not call the native workspace navigation action, which would
  otherwise switch conversations and lose the pending project choice.
- SDK invocation capture uses execution-scoped context. Managed CLI capture uses
  the same provenance through shell environment resolution and a durable receipt
  spool. Direct CLI bypass remains outside coverage; unresolved targets and
  missing saved-version receipts produce no speculative checkpoint links.
- Portable archives contain a native unpacked DSH log and sidecar with a checksum.
  Archive saves append to them (version 3, below) instead of rewriting them. Migration keeps
  original histories as recovery copies, outside the normal active log root when
  moving them is possible.
- Shared subagent archives retain parent identity. Resuming a shared context
  requires its parent execution context; it must fail clearly if that context
  is unavailable rather than starting unrelated project work.

## 11. Durable ownership and lazy execution

Conversation ownership is independent of availability and execution resources:

```text
conversation -> project UUID (branch dsh.project.<uuid> inside the project)
             -> current address <store>/<project> and machine (locators only)
```

### Project identity

LayerFS has no project ID, and the pinned CLI's `store stats` reports no Store
identity. So the plugin mints one: a random UUID kept inside the project as an
empty branch `dsh.project.<uuid>`, forked from `main`.

- Claiming. The first time a conversation attaches to a project that has no
  identity branch, the plugin forks one. Branch creation is atomic; if two
  installations claim at once, both branches exist and everyone takes the
  smallest UUID, so they agree. Listing projects never claims: an unclaimed
  project is listed as `unclaimed:<store>/<project>` and claimed when chosen.
- Checking. Every execution, restore and archive write reads the project's
  branches at the owner's address and requires the owner's UUID; a missing or
  different one fails with `ProjectIdentityChanged`. History stays readable.
- What it survives. The branch is part of the project's history, so it moves
  with the project: a Store moved to another machine, push/pull, backup and
  restore. A project deleted and recreated under the same name has no identity
  branch (or a new one) and is a different project; the old conversations
  stay with the old UUID, shown as `identity-mismatch`.
- Copies. A restored copy next to its original carries the same UUID. The
  catalog lists the first address as the owner and the copy as
  `identity-mismatch`; conversations stay with the original. On another
  installation, where only the copy exists, it is the same project and imports
  its conversations.
- Hidden. File and history views hide `dsh.project.*` (and `dsh.session.*`)
  branches. Machine and app-home paths are not part of identity.

A durable catalog under the project-session home combines live discovery with
previously observed projects and locally owned conversations. A failed read is
unavailable, not proof of deletion. Confirmed missing records and identity
mismatches retain their catalog entries, native conversation logs, checkpoint
references, pending selections and archive progress. Removal never deletes
conversation history implicitly.

Presets Reset and Build are the one deletion path. After their machines are
stopped (Reset) or their Stores removed (Build), they delete every project
conversation of that LayerFS home: native logs and sidecars, owner routes,
bindings, checkpoint references, pending choices and archive progress. A
conversation belongs to the home when its Store is one of the home's Stores (by
Store ID when an older owner recorded one and the CLI reports it, else by name); conversations of other homes
sharing the project-session home stay. A loaded conversation is archived with
its activity stopped through DSH's workspace registry first. Copies archived
inside a kept Store are not deleted (the CLI cannot delete branches); a deletion
record keeps store sync and open-by-id from importing them back, and only an
explicit open lifts it. The confirmation states how many conversations go.

Availability refreshes automatically through read-only event/polling paths.
Opening history only prepares local metadata. A new message activates the
execution workspace at pre-step; each tool execution revalidates ownership.
Machine startup remains an explicit user action. Returning availability never
replays a command or starts a sandbox automatically.

Execution has separate `inactive`, `activating`, `active` and `interrupted`
states. Explicit/idle close checkpoints project changes before releasing its
sandbox and marks execution inactive. Failed checkpoints keep execution
resources intact. Lost access marks an active context interrupted. Recovery of
access changes availability, while execution waits for a new message. Missing
saved file contexts block activation rather than silently starting from main.

Portable manifests and sidecars carry the permanent project identity. A backup
restored with another identity does not automatically adopt its original
conversation IDs. Local reads remain possible even when identity validation
fails; execution, restore, archive writes and scoped project reads are blocked.
Owners recorded before project UUIDs (a 64-hex key, no UUID) are retained and
blocked with `ProjectIdentityChanged`; they are never adopted automatically. Archives without permanent ownership metadata
require explicit ownership recovery before import; they are not automatically
bound by display name.

Archive writes compare the remote manifest checksum and event position with the
last confirmed save. A changed, rolled-back or unverifiable archive pauses writes
with `ArchiveConflict`, preserving both the remote archive and locally pending
history. This is a conflict guard, not an automatic history-merge or cross-Store
rebinding workflow.
