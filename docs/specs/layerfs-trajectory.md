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

Parity owed (decided 2026-11-24, `docs/specs/refinement-decisions.md`):
system-prompt and request-header records, prompt diffs, tool schemas, token
usage, and assistant text streaming are not rendered yet and are to be added to
this view; until then they remain visible only in the stock Trajectory of normal
sessions. (The earlier list said "live tool output"; stock streams assistant
text, not tool output.) All of them come from session-log events this view
already reads, so no DSH change is needed for parity.

Seam request: the stock trajectory exposes no inner slot
(`@deepseek-ai/dsh-client-ui-trajectory` registers only `conversation.view`), so
inline LayerFS rows force this whole view. A public tool-call-level slot in the
stock Trajectory would let those rows move there and retire this view.

## 3. Data

`src/shared/trajectory.ts` is the contract.

- `session.trajectory {sessionId, since?, before?}` → `TrajectoryAnswer`: per
  turn, records in log order (user/context/assistant previews of at most 300 characters; tool
  calls with a one-line argument summary, a result preview, error and timing,
  and their receipts as `ops`), orphan calls (receipts whose call is not in the
  loaded log), host ops, checkpoints, and `counts`. `since` answers
  `{unchanged: true}`; `before` reads the next older page; a cold first page of
  a long session may be a window (section 4).
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

## 4. A cold first page reads a window (B9-C)

A long session's log is read whole by today's parse: 754.8 ms for the measured
47,132,322 B / 12,876-event log, plus 399.4 ms for its 40.7 MB
`receipts.jsonl`, 92.7 ms to build the first page and 18.9 ms to page it
(Node 24.22.2, this box). The first page is capped at 400 records and 250 KiB,
so a cold read does not need either file whole. Decided 2026-11-26: option C,
the tail window — the smallest change that removes the log parse without a
worker or a second parser. It is explicit that the first answer is a window.

**When.** Only for a session DSH has **not** loaded whose log is at least
`TAIL_LOG_BYTES` (8 MiB), with the split receipts layout (`receipts.jsonl`
beside the log). A loaded session, a shorter log, or a legacy combined sidecar
keeps the whole parse. When a half-migrated session has both, the split file
wins for the whole path (`receiptsFor`) as well as for the window, so the two
answers cannot diverge. Receipts are read, not the sidecar's `invocations`
array, so the first page never parses the receipts file whole; the OBSERVATION
row's counter comes from the sidecar metadata.

**What is read.** The log's tail from a `turn/start` to EOF (`TAIL_START_BYTES`
= 2 MiB first, doubled until it holds the newest 400 records), trimmed to the
turn of the oldest record a page can keep, plus `receipts.jsonl`'s rows for
those turns (a binary search finds the first row of the window's turn, then one
read). Every turn in the window is complete, so record content, call/result
pairing, step timing and per-turn totals are exactly the whole parse's for
those turns. Two details keep page parity:

- **Duplicate tool calls.** A `tool/call` whose callId first appeared before
  the window is a repeat; the whole parse keeps the first occurrence, so the
  window's dropped prefix seeds the seen-call set (`seenCalls`) and the repeat
  is not a record, a `recordTotal` or a `counts` entry.
- **The prompt predecessor.** The page's first `request/header` needs its
  predecessor's tool catalog: the last header before the window is read as a
  **seed** (its `seq` and tools), so `toolsChanged` and
  `promptChanged.previousSeq` match the whole build. That seed carries no
  system text, so if a system message or a surface replacement sits between the
  seeded header and the window the window falls back to the whole parse. A page
  `system/message` needs the effective prompt text instead: the window reaches
  back to the last system message's turn, or the whole parse runs.

A stat is a point in time. The reader re-stats before and after its read; a log
or receipts file that grew meanwhile is read again from its current end (up to
three times, then the whole parse), so a page never comes from a slice that
ends at an old size. The window and its revision name the identity actually
read — size, mtime, inode and ctime — and not the caller's stat.

**The answer says so.** A windowed first page carries `windowed: true`,
`windowFromSeq` (the window's oldest event seq) and `recordTotalKnown: false`;
`recordTotal` counts the records in the window (402 on the measured session),
and `counts`/`opsTotal` are window values too. `hasMore` is always true.
Everything the page carries (records, checkpoint strip, the observation row)
is identical to the whole build's first page: 397 records, 255,626 bytes whole
and 255,719 windowed — the 93 bytes are the three window fields, the window's
`recordTotal`, `counts` and `revision`. The OBSERVATION row itself (the folded
read counter) is session-wide, not a window figure, and the UI says so.

**Older history stays exact.** The client's first "Load older records
(window)" (the existing `{before}` cursor, unchanged) runs the whole parse once
and answers with the session's full `recordTotal` (3,314) and `counts`; every
later older page reuses that answer. It is one page, not a load of the whole
history — the label says so, and the next presses keep walking. Merging it
adopts the whole answer's `counts`, and any record the whole page also carries
takes the whole build's copy (its `opsTotal` is complete). Walking the measured
session takes 18 pages / 4.185 MiB at the 250 KiB byte budget and reaches every
record exactly once, each page strictly older than its cursor. The first older
page paying the whole parse (~755 ms + ~399 ms here) is the accepted trade.

**`since` stays cheap.** The window is cached per session keyed by both files'
identity; a poll that passes `since` computes the same revision from the cache
(two stats, ~0.1 ms) and answers `unchanged` 25/25, as before. A whole-log
parse cached by a record read does not switch the first page back to the whole
log: the window input, and so its revision, stays.

**Fallback to the whole parse (`windowed` absent).** The tail is used only when
it can be read safely. The whole parse runs when: the log is under 8 MiB; the
session is loaded; there is no split `receipts.jsonl` (legacy combined
sidecar); the header is not a v4 session header; the file is not JSONL; a row
lacks an integer `seq` or the seqs do not increase; a line other than a torn
last one does not parse; a prompt line (a request header) is longer than 16 MiB
(`LINE_MAX_BYTES`) and cannot be read; a surface replacement's endpoints
predate the window after the window has shown a prompt state it would reset; a
page `system/message` has no earlier system message; a prompt state change sits
between the seeded header and the window; the window would be the whole log
(its first event, or turn 1 with no record before it); or the file keeps
changing while it is read. A fallback answer is today's answer, never a partial
page passed off as the session. `windowed` is omitted rather than `false` (the
contract is `windowed?: true`), so a reader tests presence, not the value; a
fallback answer never carries `windowFromSeq` or `recordTotalKnown` either.

**Limits.** A receipt without a `turn` is not part of any window's turns; DSH
stamps `turn` on every tool receipt, so a window call's ops are not lost this
way, but a hand-written turn-less receipt would be attached at turn 0 by the
whole build and not by a window. A window is only as fresh as the last stat: a
writer that appends while the page is read is caught by the re-stat and read
again, and an append after the answer moves the next read's revision.

**UI.** Window numbers are never shown as session totals. The table footer says
`402 in the loaded window · Load older records (window)` and the action runs the
whole parse behind that cursor; the footer stays visible when a filter empties
the table, so the full history can still be loaded. The counts line gains "· in
the loaded window"; the phone summary says "N versions in the loaded window",
and a note under the toolbar says totals, counts and per-turn counts cover the
loaded records only, while the OBSERVATION row keeps counting the whole
session. After the merge, the footer returns to "Load older records (n not
loaded)" with the full counts.

## 5. Limits

- A call that only ran `workspace exec` made no version; its edits are saved
  by the turn's checkpoint. An unchanged turn calls only `workspace status` and
  records no checkpoint.
- A session that is not loaded has no records; its calls come from receipts.

## 6. Files

| File | Role |
| --- | --- |
| `src/shared/trajectory.ts` | the contract |
| `src/host/sessions/trace.ts` | builder, detail, `versionBranch`, `summarize` |
| `src/host/sessions/trajectory-tail.ts` | the cold first page's log/receipts windows and their cache |
| `src/host/sessions/index.ts` | the ops; the window decision and the sidecar counter |
| `src/client/views/TrajectoryView.tsx` and parts, `trajectory.module.css`, `trajectory-model.ts` | the view |
| `src/client/views/index.tsx` | LayerFS/DSH mode and the switch order |
| `src/client/views/stock-trajectory.ts` | suspends/resumes DSH's stock Trajectory entry; the Inspect target |
| `test/trajectory.test.mjs`, `test/trajectory-model.test.mjs`, `test/trajectory-window.test.mjs`, `test/trajectory-window-ui.test.mjs`, `test/e2e-trajectory.mjs` | tests |
| `test/perf/trajectory-tail.perf.mjs` | the measured whole-vs-window numbers |
