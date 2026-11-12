# Model-like simulation for LayerFS project sessions

Status: implemented through DSH's public plugin interfaces. The installed DSH
version does not expose a public hook to lock every model selector during an
active script; conflicting routes are rejected before script tools run. This
remaining host limitation is described in the repository README.

This extends [Project sessions](project-sessions.md). Simulation supplies the
initial actions of ordinary DSH agents through a model adapter. Sessions,
conversations, tools, project ownership, storage and subsequent LLM use retain
their ordinary meanings.

## 1. Product contract

A simulation model reads a prepared script and emits agent actions through the
normal DSH runtime. Tools execute real commands, produce real results and change
real LayerFS project files. The adapter makes no remote model requests.

The model selector displays the active script's readable name, for example
`Billing release`, backed by a route such as `simulation/<script-id>`. Its details
identify the script and allow inspection. Do not present a real LLM provider as
the source of script-driven actions or invent model reasoning or token usage.

The conversation uses the ordinary DSH renderer and working/idle states. Do not
add simulation badges, percentage progress, CLI counters, task dashboards or a
separate transcript viewer. Normal errors and tool results remain visible. Raw
commands and results remain intact; internal branch names are not promoted into
navigation or controls.

Every parent and child session has its own script. When the script ends for any
reason, a real LLM can continue the same session from the actual history.
Switching drivers does not create a new session or change its owner.

### Terminal-state contract

A script session is *active* only while this host is running, stopping or
handing off its script. Every other state is terminal: `completed`, `stopped`,
`interrupted` (host restart, import of a running session) and `failed` (setup,
tool or settlement failure, or Stop with no confirmed version). In every
terminal state:

- The script never runs again for that session. The adapter refuses it and its
  route is no longer offered in the model list.
- The session is not locked. Restore, fork, forget and new messages work as for
  any project session; there is no recovery or reconcile step.
- The session, and each of its children, is switched back to its remembered real
  model with session-local selection (DSH's global default is never changed).
  After a restart this happens when the agent is next created from disk, using
  the sidecar's remembered route, else the current default selection.
- The next real-model message binds a working copy *as if fresh*: from the
  confirmed continuation version when one exists (clean completion or clean
  stop), otherwise from the project's current `main`, exactly like a new project
  session. Uncertain operations are not reconciled or replayed; the journal and
  evidence stay as they are.
- Human messages queued during the run are delivered once the real model is
  selected.

## 2. Workflow

1. The user submits `/simulation --project <preset> --machine <machine>
   [--mixed]`. This is a host command, not an LLM prompt. Validate arguments,
   check that a usable real model is selected (nothing is created otherwise) and
   prepare immutable scripts before executing mutations.
2. Create the run's fresh Store/project using Connect's recipe, then create
   ordinary project-owned DSH sessions. Open the first conversation as soon as
   it exists. Setup failures are reported through the command's normal error
   result; partially created resources remain recorded.
3. Establish project ownership before the first turn, select local scratch and
   remember each session's ordinary model route, including reasoning settings.
   A fresh child inherits the parent's remembered real route, not its script
   route. Select scripts through session-local model selection; automatic script
   activation/restoration must never change DSH's global default model.
4. Submit the script's natural work request as a normal user message. The adapter
   emits normal tool calls, delegation and replies. The DSH loop executes tools
   and persists their real results before the script advances.
5. Reuse each child's session for subsequent assignments. One request may include
   many tool calls and assignments; these do not manufacture additional turns.
   Preserve Connect's maximum of ten user request/response turns per agent.
6. At completion, settle active work and retain the confirmed continuation file
   context. Restore the remembered ordinary model route. The user may choose a
   different real model and send another message in the same session.

While a script owns execution, model changes are unavailable until it reaches a
terminal state.
Normal messages may use DSH's existing queue, but must not be consumed as script
instructions. Dispatch queued follow-ups only after a real model is selected and
the continuation context is ready. Never automatically rerun the script on a
normal follow-up or on reopening a completed conversation.

Script identity is bound to the run and agent before the first model request.
Delegation explicitly selects the child's own authorized script route; stock
inheritance of the parent's route is insufficient. Use continuable DSH children
and the public child model-selection policy. Enable the subagent tool's
`modelSelection` configuration and authorize the exact child routes through
`allowedModels` before its first request. Auxiliary requests such as titles
must never advance the script cursor or execute tools.

## 3. Stop and handoff

The ordinary Stop button cancels the current scripted session, its queued script
assignments and its active descendants. It stops further dispatch and settles
in-flight operations. Stopping a child stops its whole root family, which ends
as `stopped` like a stopped root.

Each root conversation's last turn waits only for its own conversation's tasks
and children, so stopping one root never fails the others. The compiled plan does
chain conversations: each later conversation's first release forks from the main
published by the previous conversation's last release. Earlier (upstream)
conversations therefore continue unaffected; a later conversation whose
prerequisites belong to a stopped conversation ends as `stopped` with an
explanation (not as a dependency failure) and is continuable by a real model.
The whole-project verification runs once, when every task of the run has a
confirmed receipt; a run in which any conversation stopped before finishing is
not verified.

Stop remains available during dependency waits and between script turns, until
the driver settles. Its cancellation must reach the driver and future dispatch,
not merely the current adapter request. Cancel script-owned inbox entries while
retaining human follow-ups behind the handoff gate. The stock DSH cancel and
child interrupt acknowledgements are requests, not proof of this completion;
neither alone clears future script work or recursively settles descendants.
Use a script-scoped admission gate that can release cleanly for LLM continuation;
do not use teardown-only `drainDescendants` on a continuing root, because its
admission cutoff lasts until that root leaves the agent registry.

DSH tells a parent when a child settles (`subagent-settled` notice): as a follow-up
that wakes an idle parent, or as steering while the parent is busy. A wake of an
idle agent always opens a turn, so a stopping root whose children settled after
it went idle would show an empty turn. So a stopping root stays busy until its
live children settle (at most 35 s, longer than a remote execution's cancellation).
A cancelled model step (any wait or pacing pause) or tool call holds it. A root
that was already idle, for example after explaining a failure, is held through a
DSH maintenance task started before Stop cancels the children. Notices are taken
out of the inbox at once and held: those already queued when Stop begins, and
those that arrive later. So no turn opens. After the handoff they are injected for
the real model's next turn without waking it.

Scripted commands that open the Store (`file`, `branch`, `commit`, `project`, `store
stats`, the host's `storeOfCall` rule) hold the host's per-Store lane while their
bash runs. Sandbox and workspace commands go through the daemon and never take the
lane. The lane is re-entrant within one async chain, and waiting for it ends when
the tool call is aborted. A finished run's in-memory calls and bindings are released.
A dormant child still holding parked human input keeps its binding until its
continuation owner reopens it.

For `workspace.exec`, request LayerFS execution cancellation and verify the
outcome; killing the local CLI process alone does not prove remote termination.
Uncertain cancellation or mutation outcomes are recorded in the journal and end
the script without a continuation pin (`failed`); the session then continues
under a real model from the project's current files. Do not report a clean stop
while work may still run.

Stop preserves logs, confirmed mutations, receipts and resources needed for
inspection. It never rolls back completed work or deletes the user's scratch.
Record terminal tool results and the normal turn end before releasing execution.
Each root conversation has one continuation context; native children share it,
consistent with the ordinary project-session model.

Handoff requires:

- One active driver per session: simulation or LLM.
- No active script commands or scheduled callbacks that can mutate after handoff.
- Standard DSH history available to the selected LLM.
- An exact saved project file context, identified from confirmed receipts.
- A normal project workspace established from that context before LLM tools run.

`plan.json` names each root's intended continuation target as a reference to a
saved-version receipt. Persist its project, typed Commit/Layer ID and necessary
internal selector in the sidecar. Children inherit the root target. Do not select
it from the last command or a mutable branch name. A run that ends without a
confirmed target continues from the project's current `main` instead.

Before handoff, release or isolate resources assigned to that root conversation.
Remaining script work cannot write its new workspace or depend on mutable state
the LLM can change. If ownership overlaps, settle the affected work first. Derive
the LLM workspace from the pinned version and preserve the workload's retained
resources; model switching alone does not release resource ownership.

Never claim uncommitted workload changes are part of an earlier commit: an open
workload workspace prevents a stopped run from selecting an older pin, and the
real model starts from current `main`. A last observed command timestamp is not
evidence of a continuation pin.

The LLM continues the conversation; it does not inherit or resume the private
script queue. A child continues through DSH's native continuable-child mechanism
and requires its root's shared context; it cannot independently resume a branch
workspace or become an unrelated root session. Continuing a parent must not
automatically restart its stopped children.

## 4. One session format and one transcript

Use stock DSH sessions for parents and children, including native parent linkage,
turns, model selection, messages, tool calls/results and event ordering. The model
adapter emits actions; it does not write fabricated transcript events around
operations performed outside the tool runtime.

| Information | Authoritative location |
| --- | --- |
| Requests, replies, tools, delegation, model changes | Standard DSH session log |
| Project ownership, invocation/version links, script reference, continuation context | Existing `layerfs.json` sidecar |
| Immutable script instructions and workload dependencies | Private run package |
| Attempt, cancellation and resource evidence | One private execution journal |

No separate conversation, execution, operations or checkpoint transcript formats
are introduced. The private journal records scheduling facts and receipt
references; it must not duplicate messages or full tool output. Existing receipt
spools may be used for durable delivery, then drained into the ordinary recorder.

Work requests describe the project objective. Assistant replies summarize only
confirmed work. Do not emit fake thinking, claim application tests ran because
fixture files were written, or replace failures with a successful-looking reply.

Each agent-tool CLI invocation maps to its actual session, turn and tool-call ID.
Setup, verification and host cleanup have host origin and run/step identities;
they must not invent session tool calls when none exist.
Use the existing invocation recorder and checkpoint eligibility rules. In
particular, `workspace.exec` has no checkpoint link. Archive writes have no
user-facing code checkpoint. Avoid duplicate receipts from overlapping capture
paths.

## 5. Minimal storage layout

Project sessions use the project-session home already defined by the parent
specification. The diagram is logical: the stock backend retains its native cwd
partitioning and filenames beneath the project root.

```text
<project-session-home>/                 # Default <DSH_HOME>/layerfs/project-sessions
  owners.json
  projects/<project-key>/sessions/
    <native DSH session layout>/
      <standard DSH session files>
      layerfs.json
```

Parents and children are ordinary session records, each with its own log and
sidecar. Their relationship uses DSH metadata, not nested transcript folders.
Normal workspace sessions remain under `<DSH_HOME>/sessions/`. User-selected
scratch contains no session internals.

Keep private execution inputs and evidence in one run directory:

```text
<plugin-root>/simulations/<run-id>/
  manifest.json                        # Identity, hashes, inputs, execution owner
  plan.json                            # Setup, dependencies, verification expectations
  source/                              # Immutable project import files
  agents/<agent-key>/
    script.json                        # This agent's turns and actions
    commands/*.sh                      # Only where shell files are needed
  journal.jsonl                        # Attempts, receipts, bindings, owned resources
```

Simplify Connect's package by placing setup and verification definitions in
`plan.json`, execution ownership in an exclusively claimed manifest, and runtime
session/resource mappings in the journal. Do not add separate `sessions.json`,
`resources.json`, status files or a second receipt database. Derived views may be
cached, but the journal remains authoritative for execution recovery. Execution
ownership must be claimed atomically before the first operation; a display-state
change alone cannot transfer ownership or permit replay.

Manifest hashes cover immutable definitions, excluding the separately claimed
owner field. Claim ownership with an exclusive filesystem operation or serialized
atomic compare-and-replace, never an unchecked read/write. No standalone or second
host executor may claim an already-owned package.

Serialize journal appends. Durably flush an attempt intent before spawning a
mutation, then durably record its structured outcome and resource facts before
dispatching dependents. Include returned handles, version IDs and resource
identities needed for recovery; transcript references alone are insufficient.
An intent without a confirmed outcome is uncertain and cannot be replayed. On
recovery, tolerate an incomplete final record only; earlier corruption blocks
execution. Persist session bindings before their first tool dispatch, and record
terminal driver/handoff state so an idle gap cannot look like completion.

Each `script.json` describes exactly one agent, its readable model name, stable
logical identity, requests, ordered actions and references to shared dependencies.
The journal binds that identity to the actual DSH session ID. Repeated assignments
use the same script/session pair. Commands and replies may resolve confirmed
receipt values; immutable definitions are never rewritten into runtime state.

The sidecar stores a small script reference: run ID, agent key, script ID/name,
content hash and remembered ordinary model route. Extend the existing continuation
metadata only as needed to preserve the exact saved file context. Do not copy the
workload graph, journal or transcript into it. Local paths and machine handles
remain local.

## 6. Project execution and portability

Project ownership must be independent of how execution resources are managed.
While a simulation script is active, the compiled workload owns its branches,
mounts and explicit saves. Suppress automatic session branch/mount creation and
turn-end/close saves that would add unplanned workload mutations. Apply this
policy to descendants, recovery and all lifecycle entry points. Normal LLM-driven
project sessions retain their ordinary policy.

Keep Connect's dependency ordering, per-agent serialization, shared concurrency
budget and per-sandbox workspace lifecycle admission. Each visible command must
execute through the normal DSH tool pipeline and be validated/admitted exactly
once. Handles and saved-version selectors come from confirmed receipts.

Archive the standard DSH log and its sidecar through the existing project session
store. Ordinary reading and LLM continuation must work without the local run
package. Script inspection is available when its hash-verified source exists;
missing source is shown as unavailable without preventing history access.
Executable script resumption on another installation is outside this scope.

After tool settlement, persist the pinned continuation context, terminal driver
state and session-local model restoration, then explicitly schedule an archive
snapshot containing those changes. Do not rely on an earlier final `turn/end`
mirror. Archive failure retains local history and pending/error state. Import
must resolve the immutable pin when establishing a normal workspace; mounting
the current head of the archived branch is insufficient. An imported running
script becomes `interrupted` and continues under a real model from the project's
current `main`.

Separate workload graph verification from explicitly identified internal session
archive branches, then verify archive integrity independently. Conversation
archiving must not invalidate an otherwise exact workload-history check.

A host restart retains history and marks unfinished execution interrupted. It
does not replay attempted mutations or reopen a remote model request. The
session's real model is selected again, queued human messages are delivered, and
the next message continues from the project's current `main`. Development uses
private `.dev*/` roots only.

## 7. Acceptance criteria

1. Launch opens ordinary project conversations with their own script names in the
   model selector and no simulation progress UI.
2. Every parent and child has a distinct script and normal DSH session identity;
   repeated assignments reuse the correct child history.
3. Actual tools, results, model transitions and turn boundaries survive reload
   through the stock DSH format. No second transcript exists.
4. Stop prevents further dispatch, cancels descendants, settles active work and
   distinguishes confirmed cancellation from uncertain outcomes.
5. After any terminal state, sending input continues the same session under its
   real model, against its confirmed file context or else the project's main. An
   integration test demonstrates the LLM reading prior results and executing a
   subsequent real tool call without script replay or late script mutations.
6. Normal project ownership, scratch semantics, archive/import and normal
   workspace sessions retain the behavior in the parent specification.
7. Confirmed eligible operations link to exact tool calls. `workspace.exec`,
   archive writes and failed/uncertain operations gain no invented checkpoints.
8. Filesystem and Mixed workloads retain exact expected code history without
   extra automatic mounts/saves; internal archive history is verified separately.
9. Restart and missing run-package cases retain readable histories, restore the
   real model and never replay uncertain work. Imported logs can continue under an LLM
   after selecting local scratch and establishing the saved project context.
10. Stop works during dependency waits and between turns. Queued script work and
    descendants cannot resume after it; human follow-ups remain available.
11. Automatic script selection/restoration leaves the global model default
    unchanged. Each child uses its own script and retains a real-model fallback.
12. Injected crashes before spawn and after mutation preserve uncertain intents
    without replay. Final archive/import preserves the pin and terminal handoff;
    remaining script-driven conversations cannot mutate the LLM continuation
    workspace; native LLM children retain ordinary shared-context behavior.

## 8. Migration boundary

Port Connect's compiler/recipes, scheduling, lifecycle admission and execution
validation. Replace its Pi provider/session publication with DSH's public LLM,
agent, tool, command and subagent seams. Reuse dsh-layerfs's existing persistence,
annotation recorder and archive store. No DSH fork or reference-repository edits.

First prove one parent/child workload, Stop and same-session LLM handoff; then
port all profiles and run Filesystem, Mixed, interruption and portability checks.
The proof must use the installed public seams for native Stop routing (including
waits), child-specific script selection and continuation, session-local model
changes, and pin-aware binding. These are implementation requirements, not claims
that unextended stock UI/controller behavior already provides them. If a required
seam is unavailable, report the specific gap before broader implementation; do
not introduce a parallel conversation runtime to hide it.
