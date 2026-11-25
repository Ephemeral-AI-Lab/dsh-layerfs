# Refinement decisions

Status: **settled** — the owner's calls, 2026-11-24. Evidence: the code review of
`layerfs_v2_0_0` at `07dfd9d` plus the fixes landed above it. These are the
decisions the refinement's groups 3–5 and 9 build on; each section records the
call, what it changes and the work it creates.

## Scope: the two work items first

The current work is #185 (session open) and #186 (conversation tabs). Only two
of these decisions touch them:

- #185 keeps today's per-session Sandbox (decision 1) and only labels it; a
  project-owned Sandbox is not part of either work item.
- #186 takes the brand cleanup as polish; the Trajectory parity list is out of
  its acceptance, so only the `stock.suspend()` guard ships with it.
- The split view is documentation only (decision 2).

Trajectory parity stays out of these work items; the per-session Sandbox is
the model, and no project-owned Sandbox work is planned.

## 1. Sandbox ownership: per-session (kept)

**Decision.** Keep today's model: one Sandbox per root session, named
`dsh-<session>`, with one Workspace named `main` on that session's branch. A
project-owned Sandbox (one per project and machine, option B) was considered
and **not** chosen: it would need project-level naming, sharding at 16
Workspaces, a shared failure domain and a host lifecycle migration, while the
Sandboxes page can show the per-session Sandbox honestly with a **Session**
tag. Revisit only if the container count becomes a real constraint; the design
for that option is kept in `project-session-sandbox-mapping.md` as a future
note, not a plan.

**Consequences.**

- No host change: `sandboxOf(sessionId)`, `mount` and `close` stay as they are;
  closing a session checkpoints and then removes its Sandbox; the idle timer
  (30 minutes) is the automatic close.
- The per-session Sandbox is identified on the project's Sandboxes tab by the
  **Session** tag (`sandboxInfo.sessionId`), not hidden and not re-modelled.
- No sharding, no project-level machine, no cross-session remount.
- The mapping decisions in `project-session-sandbox-mapping.md` are written for
  this model.

**Follow-up.** Nothing in #185/#186: the **Session** tag already ships, and
groups 5 and 9 show the same model. If project-owned Sandboxes are ever
revisited, the prerequisites are in the mapping note.

## 2. Split view: keep the global mode, document the DSH-side deviation

**Decision.** LayerFS mode still turns on when any visible conversation is a
project session. In a mixed split view the DSH pane gets the five LayerFS tabs,
the LayerFS audit Trajectory, and loses its composer while one of those tabs is
open. Accepted and documented as a deviation from a plain DSH session, not
engineered around.

**Amendment (owner, 2026-11-24).** The composer is restored to DSH behaviour:
the DSH pane keeps its own composer while one of those tabs is open. A tab
hides the composer only once `session.state` confirms the session is in a
project, so a DSH session beside a project session in split view is not treated
as a project session for the composer. The deviation stands for the five tabs
and the LayerFS audit Trajectory, and the per-session seam request stays open.

**Why.** DSH's tab row is global and `conversation.view` has no per-session
scope. The faithful fix is a DSH seam (a per-session view registration or a tab
row filter); that seam is recorded as a request. Until it exists, moving the
mode to "every visible conversation is a project" would take the tabs away from
the project pane, which the owner rejected.

**Consequences.** The guide (en and zh) states the deviation; a known-deviation
entry records it; the mode stays on `some`. The per-session seam request stays
open: if DSH ships it, both panes can be right.

## 3. Trajectory: keep the custom view and reach parity

**Decision.** The plugin's Trajectory stays and reaches parity with DSH's
stock Trajectory, and a seam request goes to DSH for a tool-call-level slot
inside the stock trajectory. The custom view is what
ships until that seam exists; once it does, the inline LayerFS rows can move
onto the stock view and the custom one becomes a candidate for retirement (or
a thinner annotation layer over the stock view).

**Parity list** (from `layerfs-trajectory.md` §2, corrected 2026-11-24):
system-prompt and request-header records, prompt diffs, tool schemas, token
usage, and assistant text streaming. The earlier list said "live tool output";
that is not a feature of DSH's stock trajectory (it streams assistant text, not
tool output), so it is replaced rather than copied.

Feasibility: all five read from the session log (`system/message`,
`request/header`, `step/end` usage, `tool/call`), which `session.trajectory`
already opens, so they need no DSH change. The tool-call-level slot request is
separate: it would move the inline LayerFS rows onto the stock view.

- Host: `session.trajectory` carries the extra records and fields;
  `session.trajectory.record` serves them at the same 64 KiB cut.
- Client: record rows and the inspector render them.
- Tests: a fixture session covering each parity item, and an e2e that a project
  session still has exactly one Trajectory tab and Chat's Inspect still lands.
- Guard, independent of parity: when `stock.suspend()` cannot find the stock
  entry (a DSH rename or someone else's disable), withdraw the plugin's
  trajectory entry instead of leaving two tabs; add the DSH-upgrade e2e.

**Seam request to DSH.** A public slot that renders inside (or directly under)
each tool-call row of the stock Trajectory, with the call's id and owner props,
and ideally a lane seat in its timeline. Today
`@deepseek-ai/dsh-client-ui-trajectory` registers only `conversation.view`;
there is no inner seat, which is why the plugin renders the whole view. What it
unblocks: inline LayerFS calls, version chips and refusal links on the stock
Trajectory, so project sessions keep DSH's token usage, prompt diffs and live
tool output without duplicating that UI.

**Follow-up.** Parity is a later slice: it is not part of #186's Trajectory
acceptance. The guard ships with #186; the seam request is recorded here and in
`layerfs-trajectory.md` for the DSH hand-off.

## 4. Brand colours: a named exception with one source

**Decision.** The two brand blues stay fixed across themes and are an explicit
exception to the token rule; they are defined once and both mark components use
that source.

**Consequences.** `LayerfsMark` (`views/marks.tsx`) and `LayerfsGlyph`
(`overview/glyph.tsx`) collapse into one component (a size prop) using the
existing `--lfs-light` / `--lfs-dark`; the literals live only as that fallback;
the tone lint allowlists those two values; the whale drops its `#fff` /
`#0f0f0f` fallbacks and uses `--dsw-static-*` directly.

**Follow-up.** Small cleanup in group 4's polish slice; no product behaviour.

## Deferred design

The project ↔ conversation ↔ Sandbox ↔ Workspace mapping is recorded in
`docs/specs/project-session-sandbox-mapping.md`; it settles the per-session
Sandbox model (option A), so no mapping question is open.

Session/project ownership in the sidebar and the New Session hero (the row
mark, the DOM row hiding, the hero chip and the per-row `session.place` reads)
is deferred to its own design: see `docs/specs/session-ownership-ui.md`.

## What this unblocks

- Group 3: Sandbox host work, session rows and readiness.
- Group 4: the split-view acceptance (deviation documented), Trajectory parity
  slices, one mark component.
- Groups 5 and 9: the Sandboxes tab and page show the session-owned Sandbox
  with the **Session** tag; no project-owned model.

## Caveats carried from the review

- The findings and file:line references were read from `07dfd9d`; the composer
  and split-view behaviours were not reproduced on a live build. The composer
  fix above `07dfd9d` is covered by a unit test that runs the real `SlotCore`
  election; a live approval on a LayerFS tab is still to be observed.
- The GitHub token used for the review has `repo` and `read:org`, not
  `read:project`, so the project board's per-item status could not be read.
