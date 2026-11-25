# Project, conversation, Sandbox and Workspace: the mapping

Status: **settled** (2026-11-25, revised). The model is today's **per-session
Sandbox** (option A); a project-owned Sandbox (option B) was considered and is
not planned. The checkpoint model stays hybrid (host turn and close saves plus
per-operation `file.*` commits). Broader
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

## The model (option A, today's)

- Project ↔ Sandbox: **N through sessions**. Every root session gets its own
  `dsh-<id>` Sandbox; a project with N active sessions has N Sandboxes.
- Conversation ↔ Sandbox: **1:1**. The Sandbox is created on first activation
  and removed when the session closes (idle 30 minutes, user Close, project
  Close).
- Conversation ↔ Workspace: **1:1**, named `main` inside that Sandbox, on the
  session's branch.
- Subagents share the root's Sandbox, Workspace and Branch; they never get one
  of their own.
- The 16-Workspace limit is not reached: one Workspace per Sandbox.
- A project-owned Sandbox (one per project and machine, `s-<compact>`
  Workspaces, sharding at 16, remount-all recovery) was considered and is
  **not planned**; the option is kept as a future note in
  `refinement-decisions.md` §1.

## Mapping decisions (settled 2026-11-25, revised the same day)

1. **Workspace name.** `main`. One Sandbox holds one Workspace, so no
   per-session name is needed; `DSH_LAYERFS_WS` stays `<sandbox>:main`. (If a
   project-owned Sandbox is ever revisited, its per-session name would be
   `s-<compact(id)>`.)
2. **Sandbox lifecycle.** Create it on the session's first activation; on close,
   checkpoint and then `sandbox remove`; the idle timer (30 minutes), a user
   Close and a project Close all take that path. A session close never affects
   another session, because each has its own Sandbox.
3. **Failure recovery.** A broken Sandbox is recreated for that session on its
   next message; no other session is touched and there is no project-wide
   "recovering" state.
4. **Machine.** Each session's Sandbox lives on the machine its project/Store
   placement selects at that time; a PostgreSQL placement change is followed on
   that session's next activation.
5. **Shards.** None. A Sandbox holds one Workspace, so the 16-Workspace limit is
   irrelevant and there is no `<name>-2`.
6. **UI mapping.** The Sandbox is session-owned and the **Session** tag says so
   on the project's Sandboxes tab; the conversation's Sandbox tab marks **this
   session**. There is no workspace↔session ambiguity inside a Sandbox, because
   there is only one Workspace.
7. **Import and first mount.** A stored-only conversation gets its own Sandbox
   like any other session; the local scratch folder is chosen before the first
   mount, so the first command runs in the right directory.
8. **Checkpoints (revised).** Saving stays **hybrid, as today**:
   - the host checkpoints at each turn end (default `checkpoints: 'turn'`; the
     existing config can disable it), which saves shell changes made through
     `workspace.exec`;
   - the agent's `file.*` calls commit per operation, and an agent may run
     `workspace commit` itself;
   - closing a session first saves that session's Workspace, and only then
     removes the Sandbox (see below).
   The agent is not the only writer, and the host's turn/close checkpoints are
   the guarantee that shell work is not lost.
9. **Subagents.** The host keeps the root's binding for a subagent (`kind:
   shared`): the same Sandbox, Workspace and Branch; it creates no per-subagent
   Workspace or branch. Agents may still fork a branch and mount it themselves
   (the current workflow), but that branch is outside the host's checkpoints and
   merge: the agent must commit it, and the parent branch does not see it until
   it is merged. Automating per-subagent branches is not part of this design;
   revisit with an explicit merge policy if it becomes a product need.

### Dirty close: aligned with today

Today `close()` checkpoints the session's Workspace (`checkpoint('idle')`) and
throws if that save fails, so the close is refused and the Workspace/Sandbox are
kept; only after a successful save does it unmount or remove. Decision 8 keeps
that behaviour exactly as it is:

- a dirty Workspace is saved before it is released (no discard, no silent loss);
- a failed save refuses the close, keeps the resources, and shows
  **Not saved: *code*** on that session's row;
- `unmount --discard` remains only in the re-mount/restore paths where it exists
  today, never on a normal close.

**Implementation.** Nothing to change in #185/#186: this is the current code.
The **Session** tag already ships; the remaining ownership UI is a separate
design (`session-ownership-ui.md`).

## Not mapping decisions

- The session/project ownership UI (row mark, row hiding, the hero chip) is a
  separate deferred design (`session-ownership-ui.md`).
- Split view, Trajectory parity and the brand inks are decided elsewhere
  (`refinement-decisions.md`).
