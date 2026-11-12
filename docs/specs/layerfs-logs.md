# LayerFS Logs page and checkpoint binding

> **Status:** Implemented with the plugin stand-in (native LayerFS lines are
> used when the pinned CLI has the `logs` family). Depends on LayerFS
> [#659](https://github.com/Ephemeral-AI-Lab/layerfs/issues/659) (spec in
> [layerfs#660](https://github.com/Ephemeral-AI-Lab/layerfs/pull/660),
> `core/docs/issues/659/README.md`) for the native call log; until a pinned
> CLI has it, a plugin stand-in writes the same lines. Written 2026-11-12 from
> read-only studies of this repository.

## 1. Outcome

- A **Logs** entry under the LayerFS sidebar group opens a page listing the
  LayerFS calls made on this machine: time, client, the call as a CLI
  command, outcome, duration, the saved version, and, for calls made by a
  project session, which session, turn and checkpoint they belong to.
- **Reset** clears the history after a confirm.
- Every **checkpoint** is bound to the call that saved it, so a checkpoint
  can show its calls and a log line can show its checkpoint.

## 2. The line

The native format of #659 §4, unchanged:

```json
{"v":1,"at":1793000004120,"ms":212,"client":"cli","argv":["workspace","commit","ws-demo-3f1","--message","<31 bytes>"],"outcome":"ok","kind":"Committed","commit":"c0ffee…","tag":"dsh:s_4d2a:a91e…"}
```

This plugin spawns the CLI for every call, including the SDK-style
`ctx.layerfs.lfs.<family>.<call>` path, so every line it causes has
`client: "cli"`. Lines from Connect, a terminal or a Python script on the
same home appear with their own `client` and no `dsh:` tag.

## 3. Source of lines

| Pinned CLI | Read and reset | Written by |
| --- | --- | --- |
| has the `logs` family (#659) | `ctx.layerfs.lfs.logs.list` / `.reset` on `LAYERFS_HOME/trace/calls.jsonl` | LayerFS, for every client of the home |
| does not | the stand-in, `$DSH_HOME/layerfs/trace/calls.jsonl` | this plugin only: `execute()` and the managed `agent-bin/layerfs` wrapper |

- The stand-in uses #659's format, rendering, redaction (§5 there) and
  answer shapes, so the page and ops do not change when the native call
  log arrives. It reads LayerFS's file only through the CLI, never by
  hand.
- Stand-in writing: `execute()` (`src/host/layerfs/cli.ts:169`) appends after
  the call, skipping `discovery` calls; content travels on stdin
  (`cli.ts:310-314`), so the line takes argv and adds `<N bytes>` for it.
  The `managedCli` wrapper (`src/host/layerfs/tracing.ts:155-172`) appends
  the same line for agent shells.
- Detection: the `logs` family in the pinned CLI's table
  (`layerfs --version --json` capabilities or `help logs`), checked when the
  CLI pin changes.

## 4. Tag and receipts

- **Tag:** `dsh:<sessionId>:<receiptId>`, ASCII, at most 128 bytes, one new
  receipt id per call, for calls inside a project session's trace context:
  agent tool calls (`origin: tool`) and host saves (`origin: host`).
- **Host tag:** every other non-discovery call the plugin makes through
  `execute()` (Machines, Storage and Presets pages, storage jobs, simulation
  setup, and Store archive writes under `withoutTraceContext`,
  `src/host/sessions/store.ts:120-219`) gets `dsh:-:<random>` (`hostTag`), so
  its line can be matched to its stored output (§6a). `-` is never a session
  id: `parseTag` answers nothing for host tags, so they build no receipt, get
  no session label and never match a `dsh:<sessionId>:` prefix. Agent shells
  outside a session context stay untagged.
- **Simulation tag:** a simulation's setup steps and its final verification
  reads run outside any session context; they pass
  `dsh-sim:<runId>:<stepKey>` (setup) and `dsh-sim:<runId>:verify` as
  `execute`'s `tag` option (`src/host/simulations/runtime.ts`, the setup and
  verification `execute()` calls). `execute` keeps a caller's tag only when it
  is a valid `dsh-sim:` tag (≤128 bytes, no `:` in the run id, no control
  characters) and only outside a trace context; anything else gets a host tag.
  `parseTag` answers nothing for them (never a session); `isDshTag` accepts
  them, so their outputs are kept (§6a), and `logs.list` labels such a line
  `sim: {runId, stepKey, sessionId?}`, `sessionId` being the run's root
  session (the binding whose `simulation.runId` matches, without
  `rootSessionId`). Filter one run with the tag prefix `dsh-sim:<runId>:`.
- **SDK path:** `traceInvocation` already makes the receipt id before the
  call (`tracing.ts:113`); it passes the tag to `execute`, which sets
  `LAYERFS_LOGS_TAG` in the child's environment (`executeRaw` merges
  `options.env`, `cli.ts:208`) and removes an inherited one when there is
  no context.
- **Agent shells:** `DSH_LAYERFS_TRACE_CONTEXT` stays per shell
  (`src/host/sessions/index.ts:190`); the wrapper makes the receipt id per
  call and sets `LAYERFS_LOGS_TAG` for its child.
- **Receipt** (session sidecar `layerfs.json`, `invocations[]`,
  `Invocation` in `src/host/layerfs/tracing.ts`): self-sufficient, because
  the log and the outputs are per machine and resettable while sessions move
  between machines through the session store. The Logs page renders a call
  from its receipt alone when this machine's log has no line for it (§5a).

  ```ts
  { id, origin: 'tool' | 'host', sessionId, project, turn?, toolCallId?,
    operation, outcome: 'success' | 'refusal' | 'unknown', versions, captureGap?,
    at,        // start, ms since the epoch (the line's `at`)
    ms,        // duration in ms (the line's `ms`)
    argv,      // the line's redacted words, made portable (below)
    tag?,      // the LAYERFS_LOGS_TAG it carried, dsh:<sessionId>:<id>
    code?,     // the line's outcome when not ok (refusal code, Failed, Unknown)
    kind?,     // the result kind (the line's `kind`)
    execId?,   // workspace exec: its --exec-id
    exit?,     // workspace exec: the command's exit code (null: killed), when known
    step?,     // { runId, stepKey }: the simulation script step of the tool call
    imported?, // true: arrived through a store import, never in this machine's log
  }
  ```

  Both writers fill the same fields: `traceInvocation` (SDK path; `at`/`ms`
  are the line's own when `logged()` writes one, `exit` is the result's
  `exit_code`) and `receiptFromLine` (agent shells; `exit` comes from the
  call's stored output, the `exit_code` of its final `{result}` frame, when
  the output is kept and not cut). Older receipts may lack the call fields or
  hold `arguments`, `startedAt`, `finishedAt`, `source` and `error`; they are
  read as they are and never written.
- **Portable argv** (`portableArgv`): the call log words (already redacted
  by `renderCall`: secrets as `<N bytes>`, values cut at 200 characters),
  then values that name files on the calling machine become `<local path>`:
  `--from`, `--source`, `--dir`, `--path`, `--file`, `--out`, `--output`,
  `--cwd`, `--root` values, the source of `project init|import`, and any
  absolute path under the home or temp folder, `/Users/`, `/home/`,
  `/private/`, `/tmp/`, `/var/folders/`, `/Volumes/`, `/root/`, `~/` or a
  `file://` URL. Project paths (`/src/a.ts`) stay.
- **Bounds:** a receipt's argv keeps at most 32 words (then `<N more>`); past
  1 KiB of JSON its words beyond 40 characters are cut, so one receipt stays
  under about 2 KiB. The count is not capped: one receipt per LayerFS call
  the session made, as before; the sidecar travels whole with the session.
- **Shared bindings and subagents:** the tag carries the caller's own
  session id, not the parent's (receipts already use it,
  `src/host/sessions/index.ts:90`).
- **Read dedup:** one shared read process carries the first caller's tag
  (`cli.ts:342-347`); harmless, reads never bind to checkpoints.

## 5. Checkpoint binding

A checkpoint (`src/host/sessions/state.ts:74-92`) gains `receipt?: string`,
the receipt id of the call that saved or referenced it. A commit id alone
cannot bind: the same commit is named by the source turn, a later restore,
a branch's base and every `UpToDate` save.

| Checkpoint | Call | Binding |
| --- | --- | --- |
| `turn`, `manual`, `idle` | the host `workspace.commit` in `checkpoint()` (`service.ts:764-790`, inside `hostOperation`) | `receipt` from the `record` callback of `hostOperation` (`service.ts:409-419`). `Committed` → saved; `UpToDate` → `changed: 0`, shown as unchanged. A failed save keeps `commit: null`, the line keeps the refusal code. |
| `restore` | `branch.fork` in `forkAt` (`service.ts:821`, `:844`), untraced today | wrap in `hostOperation`; the checkpoint shows as "references" an existing version. |
| child `base` from `branchAt` | `branch.fork` (`service.ts:886`), untraced today | same as restore. |
| unchanged turn | none (`service.ts:775` returns early) | no checkpoint, no line. |

Agent `branch.merge` and `branch.publish` lines map to a receipt but no
checkpoint; they show session and turn only.

**Join for a log line** (host side, in `logs.list`): split `tag` into
session id and receipt id → that session's sidecar receipt (origin, turn,
tool call) → the checkpoint whose `receipt` matches (kind, turn). A line
without a `dsh:` tag but with a `commit` is matched against checkpoints by
commit and shown only as "references checkpoint", never "saved".

**From a checkpoint:** "Calls" opens the Logs page filtered by
`tag = dsh:<sessionId>:<receipt>`; a turn's calls use the prefix
`dsh:<sessionId>:` plus the turn's receipt ids. An imported session shows its
receipts (§5a); no lines means "reset on this machine", not an error.

The receipt's `step` labels the line `dsh.step = {runId, stepKey}`, joining a
scripted tool call to its script step without the simulation's private
journal: the `tools/execute` hook (`src/host/sessions/index.ts`) asks
`ctx.layerfsSimulations?.stepOfCall(sessionId, callId)`, which answers
`{runId, stepKey}` for a scripted `tool` action of that session.

## 5a. Receipt fallback and import

- **Import merge:** a store import (`src/host/sessions/store.ts`, the
  sidecar `updateSidecar`) keeps every other sidecar field's semantics
  (stored values replace local ones) but merges `invocations` by id
  (`mergeInvocations`): local receipts stay in order, an incoming receipt
  with a known id updates it field by field, new ones are appended with
  `imported: true`.
- **Fallback:** `logs.list` with a session tag (`dsh:<sessionId>:` or an exact
  `dsh:<sessionId>:<receipt>`) reads the active source first; once that has
  no more lines for the filter, the session's `imported` receipts follow,
  newest first, each rendered as a line (`receiptLine`: `at`, `ms`, `argv`,
  `outcome` = `ok` or `code`, `kind`, the first version as `commit`/`layer`,
  `tag`; `client: 'cli'`) with `source: 'receipt'`, passing the same filters
  and labelled by the same §5 join. Receipts whose tag this machine's log
  does hold (a session re-imported where it ran) are skipped. Paging goes on
  with a `receipt:<offset>` cursor. Receipts without `at` give no line.
- Only imported receipts fall back: a session that ran here and whose log was
  Reset stays empty. Their output is never on this machine, so the detail
  shows "No output kept" (`output` is set only when a file exists).

## 6. Host

- **Ops** (`src/host/remote.ts:54-62`), dotted like `runtime.*` and
  `simulation.*`:
  - `logs.list {cursor?, limit?, op?, project?, client?, tag?, outcome?,
    since?, writes?}` → `{lines, next, has_more, skipped, source:
    "layerfs" | "plugin"}`; each line may carry `dsh: {sessionId, turn,
    toolCallId?, origin, step?, checkpoint?: {kind, turn, changed}}` from the
    §5 join (sidecars read once per session per page), `sim: {runId,
    stepKey, sessionId?}` for a `dsh-sim:` tag (§4), and `source: 'receipt'`
    for a line rebuilt from an imported receipt (§5a).
  - `logs.reset {}` → `{removed}`.
- `writes` filters on the client until #659 Q1 is answered: it hides lines
  whose op is in a fixed read list (`*.list`, `*.get`, `*.status`,
  `file.read`, `file.stat`, `commit.diff`, …).
- **Event:** after each stand-in append, `ctx.layerfs.emit('logs', {at})`,
  coalesced to one per second. With the native log the page reloads on its
  own actions and on focus, since LayerFS writes from other processes.

## 6a. Outputs

LayerFS's own call log never stores what a call printed; this plugin keeps it
for the calls it makes itself (only calls made through DSH, never other
clients of the home), in both stand-in and native modes.

- **Where:** `$DSH_HOME/layerfs/trace/outputs/` (0700), one file per call
  (0600) named by a SHA-256 of its `dsh:` tag (session or host), holding a
  `CallOutput` (`src/shared/logs.ts`): exit code, stdout, stderr, full byte
  counts, `truncated` flags and, for a refused call (exit 125), the parsed
  `refusal` (code, message, detail). Written after the call ends, before its
  line, best effort: a failed write never changes the call's outcome.
- **Caps:** stdout and stderr each at most `OUTPUT_MAX` (64 KiB): the head of
  stdout, the tail of stderr, cut on UTF-8 boundaries. stdin (file content,
  JSON arguments) is never stored. The store holds at most 2000 files and
  64 MiB; about one write in 50 prunes the oldest first
  (`src/host/layerfs/call-output.ts`).
- **SDK path** (`executeRaw`): the raw stdout/stderr. For `--events` calls
  (`workspace exec`) stdout is the decoded bytes of the exec `stdout` frames
  followed by the final result/refusal frame as its last line (kept whole when
  it fits), and stderr gets the exec `stderr` frames plus the CLI's own stderr.
- **Agent shells:** the managed wrapper tees its child's stdout/stderr into
  bounded buffers while passing every byte through unchanged (backpressure and
  signal forwarding kept) and writes the file for its tag on close. A tagged
  call spawns and pipes in native mode too (no exec). Raw stdout, also for
  `--events` calls. The sandbox policy already lets shells write `<root>/trace`.
- **Ops:** `logs.output {tag}` → `CallOutput | {missing: true}` (`missing`
  when never kept, pruned or reset); the tag must be a `dsh:` tag of at most
  128 bytes without control characters, else `InvalidInput`. `logs.list` sets
  `output: true` on lines whose tag has a file (one stat per line).
- **Reset** (`logs.reset`) also empties `outputs/`, in both modes.
- **Risk:** stdout can hold what a call reads (`file read` content, listings,
  exec output), so secrets in project files or command output can land here,
  local and owner-only, until pruned or Reset.

## 7. Client

- **Sidebar:** `registerLogs(ctx, api, group)` copies the Presets
  registration (`src/client/presets/index.tsx:42-57`): a child row of the
  LayerFS group (`createSidebarGroup().whileExpanded`,
  `src/client/overview/group.ts:61-70`), `order: 9.75` after Presets (9.5),
  `PANEL_ID = 'layerfs-logs'`, a 16px inline SVG wrapped in `ChildGlyph`
  (`src/client/overview/child.tsx:9`). Called after `registerPresets` in
  `src/client/index.tsx`.
- **Page** (`LogsPage.tsx`), built like `PresetsPage.tsx`: `Page` /
  `PageHead` / `LoadError` / `Loading` / `Empty` from `src/client/ui`.
  - Filters: project search (`Input` with `IconSearchOutlineRegular`), op
    (`MenuSelect`), client (`SegmentedControl`), outcome, and a **Writes
    only** `Checkbox`, on by default.
  - Table (`Card` + table styles as `src/client/storage/Storage.module.css:274-300`):
    time · client · command (argv as a shell string, monospace) · outcome ·
    ms · saved (`kind` + short commit) · session (session title, turn,
    checkpoint kind; opens the session).
  - Paging: a "More" row appending `next` pages
    (`src/client/files/ProjectHistory.tsx:116-123`).
  - **Reset:** a `Modal` confirm with Cancel autofocused and a danger
    primary (`src/client/presets/PresetsPage.tsx:156-168`). With the native
    log the copy says it clears the history for every client of this
    LayerFS home.
  - A note when `source` is `plugin`: only calls made through DSH appear.
- **Session panel:** removed (no LayerFS side panel, see
  `docs/specs/conversation-views.md` §6). A call's detail still offers
  "Calls of this checkpoint".
- Copy in `src/client/logs/locale.ts` (`NS = 'layerfsLogs'`, `en` and `zh`).
  CSS Modules with `--dsw-alias-*` tokens only.

## 8. Files

| File | Change |
| --- | --- |
| `src/shared/logs.ts` (new) | `CallLine`, `logs.list` args and answer types. |
| `src/host/layerfs/call-log.ts` (new) | Stand-in: render, redact, append (O_APPEND, 0600), rotate at 16 MiB, list, reset. |
| `src/host/layerfs/call-output.ts` (new) | Outputs (§6a): bounded capture, record, write and prune, read, clear. |
| `src/host/logs/index.ts` (new) | `logs.list` / `logs.reset` ops, source detection, §5 join, `logs` event. |
| `src/host/layerfs/cli.ts` | `CliSpec.callLog`; append in `execute()`; `LAYERFS_LOGS_TAG` per call. |
| `src/host/layerfs/tracing.ts` | Tag from the receipt id; wrapper sets the tag and appends; drop `operationArguments`, `firstPositional` / `invocationProject`, the CLI-output parsing in the wrapper once native lines carry `kind`/`commit`. |
| `src/host/service.ts` | Pass `callLog` (`join(root, 'trace', 'calls.jsonl')`). |
| `src/host/sessions/service.ts` | `Checkpoint.receipt`; `forkAt` / `branchAt` in `hostOperation`. |
| `src/host/sessions/state.ts` | `receipt?: string` on `Checkpoint`. |
| `src/host/session-persistence.ts` | Smaller receipt (§4). |
| `src/host/index.ts` | `ctx.plugin(logs)`. |
| `src/client/logs/{index.tsx,LogsPage.tsx,locale.ts,logs.module.css}` (new) | Sidebar entry and page. |
| `src/client/index.tsx` | `registerLogs(ctx, api, group)`. |
| `docs/specs/homes.md` | `trace/calls.jsonl` under `$DSH_HOME/layerfs` (stand-in). |
| `docs/specs/project-sessions.md` §5–§6 | Tag, smaller receipt, checkpoint `receipt`. |
| `AGENTS.md` | The `logs/` area in Layout. |

## 9. Tests

- `test/call-log.test.mjs`: format and redaction match #659 §5; rotation;
  reset; filters, paging, stale cursor; the wrapper and `execute()` write
  one line each with the same tag as their receipt.
- `test/call-output.test.mjs`: caps and truncation, host tags, success and
  refusal outputs, `--events` capture, the wrapper's byte-identical tee,
  pruning, Reset, `logs.output` validation and `missing`, `logs.list` `output`.
- `test/receipt-logs.test.mjs`: receipt fields from both writers (time,
  duration, portable redacted argv, tag, code, kind, exec id and exit, step),
  argv bounds, the import merge by id, the `logs.list` receipt fallback
  (paging, filters, dedup, no fallback after a local Reset), `dsh-sim:` tags
  and their labels and outputs, `stepOfCall`.
- `test/sessions.test.mjs`: a turn-end save's checkpoint carries `receipt`;
  restore and branch checkpoints carry the fork's receipt; `UpToDate` binds
  as unchanged; archive writes are untagged.
- `test/e2e-sessions.mjs`: open the Logs page, see the session's
  `workspace.commit` line labelled with its turn, follow "Calls" from a
  checkpoint, Reset with confirm.

## 10. Open points

- The working tree currently moves Projects out of the LayerFS group
  (uncommitted edits to `src/client/index.tsx` and `src/client/projects/`),
  leaving Storage and Presets as its children; Logs joins them.
- Simulation setup and verification calls are tagged `dsh-sim:` (§4);
  the runtime's `workspace exec-cancel` on abort gets no `dsh-sim:` tag
  (a session tag inside a trace context, else a host tag).
- Whether the page should default to this machine's DSH calls only
  (`tag` prefix `dsh:`) when the native log also holds other clients.
