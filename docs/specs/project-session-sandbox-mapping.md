# Project, conversation, Sandbox and Workspace: the mapping

Status: **current model recorded; the mapping decisions marked open are not made**
(2026-11-24). The decisions that are made, and the work they unblock, live in
`refinement-decisions.md`.

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
- Conversation ↔ Workspace: **1:1 inside the project Sandbox**; the Workspace
  name must then distinguish sessions (today's `main` cannot).
- Sandbox recreation (broken/removed) re-mounts **every** session's Workspace
  in that project, not only the one that noticed.
- Closing a session checkpoints and unmounts its Workspace; it no longer
  removes the Sandbox.

## Mapping decisions still open

1. **Workspace name inside a project Sandbox.** `main` is unique per Sandbox
   today. Options: `s-<compact(id)>` per session, `main` for the first session
   and named ones after it, or `session-<id>`. The choice reaches
   `DSH_LAYERFS_WS` (the agent's working handle), the Sandbox map, the tests and
   the guide. *Recommendation: one name per session (`s-<compact>`), no special
   first session.*
2. **Sandbox lifecycle.** When does a project Sandbox close: after the last
   session is idle, on the project's Close, only explicitly? What does a
   session's idle close do (checkpoint its Workspace, unmount it)? *Recommendation:
   session close = checkpoint + unmount; the Sandbox closes after the last
   session's idle timeout or on project Close.*
3. **Failure recovery.** A broken/recreated Sandbox must remount all sessions;
   their running commands die. Does a project-level state say "recovering", and
   do the session rows show it? *Recommendation: yes, a project Sandbox state;
   sessions stay `interrupted` until their next message.*
4. **Machine changes.** A PostgreSQL project's chosen machine can change, and a
   Store can move. Is the Sandbox recreated on the new machine, and who closes
   the old one? *Recommendation: recreate on the new machine on next activation;
   close the old when it has no Workspaces.*
5. **Shards.** One project Sandbox per machine, or several on one machine? How
   are the `-2` shards named and placed? *Recommendation: per machine; shard
   names derive from the project Sandbox name.*
6. **How the UI shows the mapping.** With one Sandbox hosting several sessions'
   Workspaces, "never nest sessions under Sandboxes" still holds. Where does a
   Workspace say which conversation it is: its name, a label, or the **Session**
   tag (today's interim flag)? How does the conversation's Sandbox tab mark
   "this session" among the others? *Undecided; this is part of the
   session/project ownership design (`session-ownership-ui.md`).*
7. **Import and first mount.** A stored-only conversation opened on a new
   machine: which Sandbox does it mount into, which Workspace name, and does the
   scratch picker run before the first mount? *Recommendation: the project
   Sandbox, its session Workspace name, scratch first (a local choice).*
8. **Checkpoints with a shared Sandbox.** A session's checkpoint saves its own
   Workspace. When a project Sandbox closes, which sessions are checkpointed
   first, and is that shown as "By DSH"? *Recommendation: checkpoint every bound
   session, one row per session.*
9. **Subagents.** Keep sharing the root's Workspace (no own Workspace or
   Sandbox)? *Assumed yes; confirm with the Sandboxes design.*

## Not mapping decisions

- The session/project ownership UI (row mark, row hiding, the hero chip) is a
  separate deferred design (`session-ownership-ui.md`).
- Split view, Trajectory parity and the brand inks are decided elsewhere
  (`refinement-decisions.md`).
