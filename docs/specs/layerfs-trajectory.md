# LayerFS trajectory: the Trajectory tab of a project session

> **Status:** Implemented (2026-11-13). Replaces the LayerFS tab of
> `layerfs-trace.md` (removed). Read only; nothing new is stored.

## 1. Outcome

Two modes, chosen by what is on screen:

- **DSH mode** (normal workspace sessions): DSH's stock Trajectory
  (`ui-trajectory` row), unchanged.
- **LayerFS mode** (a LayerFS project session, subagents included): this
  plugin's Trajectory, a lighter copy of DSH's that adds what each tool call
  did in LayerFS. Chat is unchanged.

In LayerFS mode:

- Every turn's user, context and assistant records and tool calls, with a
  timeline of four lanes: Input, Model, Tools, **LayerFS**.
- Under each tool call, the LayerFS calls it made and the 0..n saved versions
  they created (`+`), saved unchanged (`=`) or pointed at (`→`).
- Each turn ends with its checkpoint rows; DSH's own writes outside tool calls
  show as "By DSH" (reads are counted, not listed).
- A version opens the **History** tab on that commit. Chat's "Inspect" on a
  call opens this view on that call.

## 2. Switching modes without changing DSH

LayerFS mode is on while any conversation on screen is a LayerFS project
session (each mounted session header reports itself; `session.place` says
whether it has a project). The mode must hold for 150 ms before the Trajectory
switches, and a session keeps its last known answer while it is read again, so
switching conversations or a LayerFS event does not flap it.

DSH builds its tab row from every `conversation.view` entry, shadowed ones
included (`slots.entries`, `ui-conversation` `apply.ts` `viewTabs`), so an
entry that only shadows the stock Trajectory would show a second "Trajectory"
tab. So `src/client/views/index.tsx` switches modes in this order, keeping one
Trajectory tab on screen throughout:

- **On:** register this plugin's `conversation.view` `id: 'trajectory',
  order: 10, priority: -1` (it renders at once, shadowing the stock one), then
  suspend the stock row's browser entry `@deepseek-ai/dsh-client-ui-trajectory`
  with the cordis Loader's public `Entry.update({ disabled: true })`
  (`stock-trajectory.ts`). Its tab, Conversation target and stores stop with
  its fiber. A Conversation target `trajectory` with `toolCallFocus` and no
  event definitions takes the stock one's place, so Chat's "Inspect" opens
  this view with the call id as `viewRequest.focus`.
- **Off:** remove that target, re-enable the stock entry
  (`Entry.update({ disabled: null })`), then remove this plugin's entries.

Nothing is persisted: the bundle row and the host half (`remote.toolResults`)
stay as they are, an entry the bundle disabled is left alone, a reload starts
in DSH mode, and unloading this plugin re-enables the stock entry. DSH's
`ui-attachment` declares the stock package as a dependency; attachments keep
working while it is suspended (`test/e2e-trajectory.mjs`).

While LayerFS mode is on, a normal session shown beside a project session
(split view) also gets this view; it then shows its records without LayerFS
rows, controls or lane, and keeps its composer.

Not copied from DSH: system-prompt and request-header records, prompt diffs,
tool schemas, token usage, live tool output. Those stay in the stock
Trajectory of normal sessions.

## 3. Data

`src/shared/trajectory.ts` is the contract.

- `session.trajectory {sessionId}` → `TrajectoryAnswer`: per turn, records in
  log order (user/context/assistant previews of at most 300 characters; tool
  calls with a one-line argument summary, a result preview, error and timing,
  and their receipts as `ops`), orphan calls (receipts whose call is not in the
  loaded log), host ops, checkpoints, and `counts`.
- `session.trajectory.record {sessionId, seq}` → `TrajectoryDetail`: one record
  in full (arguments, result, text, thinking; each cut at 64 KiB), read when
  the inspector opens it.

Built by `buildTrajectory` / `trajectoryDetail` (`src/host/sessions/trace.ts`)
from the DSH session log, the session's `layerfs.json` receipts (joined by
`toolCallId`) and its checkpoints (joined to their save by `receipt`). A
version's Branch is read through its call (`versionBranch`): `file.*` name it,
`branch merge` the new branch, `branch fork` its source, a Layer is on `main`,
a `workspace commit` the session's Branch at that time.

Refresh: on `layerfs-operation`, `layerfs-checkpoint`, `layerfs-session` and
reconnect, and every 3 s while the session runs (shell receipts land when the
turn settles).

## 4. Limits

- A call that only ran `workspace exec` made no version; its edits are saved
  by the turn's checkpoint. An unchanged turn calls only `workspace status` and
  records no checkpoint.
- A session that is not loaded has no records; its calls come from receipts.

## 5. Files

| File | Role |
| --- | --- |
| `src/shared/trajectory.ts` | the contract |
| `src/host/sessions/trace.ts` | builder, detail, `versionBranch`, `summarize` |
| `src/host/sessions/index.ts` | the two ops |
| `src/client/views/TrajectoryView.tsx` and parts, `trajectory.module.css`, `trajectory-model.ts` | the view |
| `src/client/views/index.tsx` | LayerFS/DSH mode and the switch order |
| `src/client/views/stock-trajectory.ts` | suspends/resumes DSH's stock Trajectory entry; the Inspect target |
| `test/trajectory.test.mjs`, `test/trajectory-model.test.mjs`, `test/e2e-trajectory.mjs` | tests |
