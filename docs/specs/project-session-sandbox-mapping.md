# Project, conversation, Sandbox and Workspace: the mapping

Status: **settled** (2026-11-25). The mapping decisions below are the owner's
calls; project-owned Sandboxes are implemented with groups 5 and 9. Broader
decisions live in `refinement-decisions.md`.

## What exists today

```text
Project  <store>/<name>                      identity branch dsh.project.<uuid>
 ├─ Conversation (a DSH session)             one owner project; a project change is a new session
 │   ├─ local log   <DSH_HOME>/layerfs/project-sessions/projects/<uuid>/sessions/<id>/
 │   ├─ archive     /.dsh/session/ on dsh.session.<id> (append-only, portable)
 │   ├─ Branch      dsh.<compact(id)>  |  dsh.<id>.rN  (restore)  |  dsh.<id>.resume.<hex>  (resumed import)
 │   ├─ Workspace   <sandbox>:main, mounted on that branch         (1 per root session)
 │   └─ Scratch     a local folder, machine-local, independent of ownership
 └─ Sandbox  dsh-<compact(id)>  (today: 1 per root session)        on one machine
```

| Link | Today | Notes |
| --- | --- | --- |
| Project → conversation | 1:N; a conversation belongs to exactly one project | ownership is the project's UUID branch; the Store moves with it |
| Conversation → Branch | 1:1 | `dsh.<id>`, a restore adds `.rN`, a resumed import `.resume.<hex>` |
| Conversation → Workspace | 1:1 | the Workspace is named `main` inside the so-far per-session Sandbox |
| Conversation → Sandbox | 1:1 for root sessions | created on first activation, removed on close (`idleMinutes`, default 30) |
| Subagent → execution | shares its root's binding | same Sandbox, Workspace and Branch; it gets no Sandbox of its own |
| Sandbox → machine | 1:1 | a PostgreSQL project picks the machine by placement (`machineFor`) |
| Sandbox → Workspace | N: the map lists them; today one per Sandbox | LayerFS allows 16 per Sandbox |
| Stored-only session | archive only, no local log | Open imports it; the Branch and checkpoints are kept |
| Scratch folder | per session, local to this machine | never part of the project; can be shared with normal sessions |

## The target once decision 1 (project-owned Sandboxes) is implemented

- Project ↔ Sandbox: **1 per project and machine**, sharded `<name>-2`, … when it
  reaches 16 Workspaces.
- Conversation ↔ Workspace: **1:1 inside the project Sandbox**, named
  `s-<compact(id)>`; one Sandbox per project and machine, sharded at 16.
- Sandbox recreation (broken/removed) re-mounts **every** session's Workspace
  in that project, not only the one that noticed.
- Closing a session checkpoints and unmounts its Workspace; it no longer
  removes the Sandbox.

## Mapping decisions (settled 2026-11-25)

1. **Workspace name.** One per session, `s-<compact(id)>` (the host's session-id
   compaction, truncated safely if it is long; uniqueness inside the Sandbox is
   checked when it mounts). No `main` special case, so a single-session project
   also uses its session name; the UI shows the conversation's title beside it
   and `DSH_LAYERFS_WS` is `<sandbox>:<name>`.
2. **Sandbox lifecycle.** Closing a session checkpoints its own Workspace and
   unmounts it. The project Sandbox closes after the last bound session's idle
   timeout (default 30 minutes) or on the project's Close; one session ending
   never removes the project Sandbox.
3. **Failure recovery.** A broken or recreated Sandbox remounts every session's
   Workspace. The project shows one **recovering** notice, each affected session
   keeps DSH's **Interrupted** word, and the next message retries; the notice
   says running commands were stopped, since they die with the Sandbox.
4. **Machine changes.** A PostgreSQL placement change or a moved Store recreates
   the project Sandbox on the new machine at the next activation; the old
   Sandbox is closed once it holds no mounted Workspaces. Branches and commits
   are untouched.
5. **Shards.** One project Sandbox per machine. At 16 Workspaces the host opens
   the next shard (`<name>-2`, …) and fills sessions in order; sharding is
   transparent and a shard is not a separate project.
6. **UI mapping.** A Workspace row shows its conversation's title with a short
   id, and the conversation's Sandbox tab marks **this session**. The interim
   **Session** tag stays until the session/project ownership design
   (`session-ownership-ui.md`) settles the rest. Sessions are never nested under
   a Sandbox in DSH's own list.
7. **Import and first mount.** A stored-only conversation opened on a new
   machine first selects (or confirms) its local scratch folder, then mounts
   into the project Sandbox as `s-<compact>`; import does not execute before the
   folder is chosen, so the first command runs in the right directory.
8. **Checkpoints on close.** When the project Sandbox closes, every bound
   session is checkpointed once (one **By DSH** row per session). A refused save
   shows **Not saved: *code*** on that session's row and keeps its Workspace.
9. **Subagents.** The host keeps the root's binding for a subagent (`kind:
   shared`): the same Sandbox, Workspace and Branch; it creates no per-subagent
   Workspace or branch. Agents may still fork a branch and mount it themselves
   (the current workflow), but that branch is outside the host's checkpoints and
   merge: the agent must commit it, and the parent branch does not see it until
   it is merged. Automating per-subagent branches is not part of this design;
   revisit with an explicit merge policy if it becomes a product need.

**Implementation order.** 1, 2 and 3 are prerequisites for project-owned
Sandboxes (groups 5 and 9); 4 and 5 land with that host work; 6 belongs to the
ownership design; 7–9 are details of the same work.

## Not mapping decisions

- The session/project ownership UI (row mark, row hiding, the hero chip) is a
  separate deferred design (`session-ownership-ui.md`).
- Split view, Trajectory parity and the brand inks are decided elsewhere
  (`refinement-decisions.md`).
