# Refinement decisions (open)

Status: **open** — four calls the dsh-layerfs refinement needs before the UI
work that depends on them (groups 3, 4, 5 and 9 of the plan, issues #185–#193).
Recorded 2026-11-24 from a code review of `layerfs_v2_0_0` at `07dfd9d`, plus
the two fixes landed above it (composer election, checkpoint-only content
reads). Each section states the current behaviour, the evidence, the options
and a recommendation; the decision itself is the owner's.

Nothing here changes behaviour. The affected work stops at the seam each
decision names rather than guessing.

## 1. Sandbox ownership: session-owned (hidden) or project-owned?

**Current.** Every project session gets its own Sandbox named from the session
(`sandboxOf`, `src/host/sessions/service.ts:48`), recorded as `Binding.sandbox`
(`src/host/sessions/state.ts:29`), created and mounted on activation
(`service.ts:494`, `service.ts:507`), and removed when the session closes
(`service.ts:1179`). Import recreates the same name (`sessions/store.ts:484`).
The name is asserted by `test/sessions.test.mjs:339`.

**Tension.** Both the guide (sandbox.md) and groups 5 and 9 state "Sandboxes
belong to projects", yet the host keeps one Sandbox per conversation. One
container/VM per conversation, each exposing 16 Workspaces, is the largest
resource multiplier in the product. Group 3's UX checklist already asks for
this decision before UI builds on it.

**Options.**

- **A — keep session-owned, hide it.** Keep the current lifecycle, but mark the
  per-session Sandbox in `sandbox list` output and keep it out of every project
  surface (Sandboxes tab, Home counts, Store usage). The conversation's
  Sandbox tab keeps showing it. Cheap, no data migration, but the resource
  cost stays and "project-owned" remains untrue in the model.
- **B — project-owned, per-session Workspace.** One Sandbox per project and
  machine (name from the project identity), one Workspace per session on its
  branch. Matches the guide, cuts idle containers to one per project, but
  needs a migration path for open sessions, changes `close` (no Sandbox to
  remove), and makes cross-session sandbox states visible to each other.
- **C — hybrid.** Project-owned by default, a session may opt into its own
  Sandbox (isolation). Most flexible, most states to explain.

**Blocks.** Group 4's Sandbox tab copy and group 9's Sandbox page (card,
Workspaces grid, terminals), and group 5's Sandboxes tab.

**Recommendation.** Decide before either tab is rebuilt: A if the resource
cost is acceptable for now (fastest, no migration), B if "Sandboxes belong to
projects" is to be true in the model. Either way, stop deleting the Sandbox on
an idle close until the decision is made, so a session does not lose its
Workspaces to a policy that may change.

## 2. Split view: keep DSH native, or keep the tabs?

**Current.** LayerFS mode is on while **any** visible conversation is a project
session (`views/index.tsx:135-145`), and DSH's tab row is global. Consequences
for the DSH pane of a split view:

- it gets the five LayerFS tabs (Trajectory, Files, History, Sandbox, Stats);
  the last four show "Not in a LayerFS project";
- its Trajectory is the plugin's lighter one, because the stock row's browser
  entry is suspended window-wide through the Loader (`stock-trajectory.ts`);
- `docs/specs/layerfs-trajectory.md` §2 lists what the lighter one does not
  copy (system prompt and request headers, prompt diffs, tool schemas, token
  usage, live tool output);
- every non-Trajectory view hides the composer unconditionally
  (`FileViews.tsx:105,125`, `StatsView.tsx:16`, `SandboxView.tsx:303`), so a
  DSH session that clicks one of those tabs loses its own composer even though
  the tab says it is not a project.

This is the sharpest conflict with "leave a user's ordinary DSH experience
unchanged".

**Options.**

- **A — enter LayerFS mode only when every visible conversation is a project
  session** (`some` → `every`). The DSH pane stays stock in a mixed split; the
  project pane keeps Chat only until the DSH pane is closed. Small change, no
  seam; the cost is that the project pane loses its tabs exactly when it is
  shown beside a plain session.
- **B — ask DSH for a per-session seam**: a `conversation.view` registration
  scoped to a session, or a per-session tab-row filter. Then both panes are
  right. This is the documented seam limit (`conversation-views.md` §1) and the
  repo rule says report it instead of working around it.
- **C — keep the current global mode**, document the DSH-side change as a
  known deviation in the guide, and keep the lighter Trajectory.

**Blocks.** Group 4's "Split view with a DSH session" acceptance item and the
Trajectory switch; also `docs/specs/conversation-views.md` (it currently
describes four tabs and a stock Trajectory).

**Recommendation.** File the seam request (B) now; use A as the interim so a
plain DSH session is never downgraded. Also fix the unconditional composer
hiding regardless of the decision: a view that shows "Not in a LayerFS
project" must not take the DSH session's composer away.

## 3. Trajectory: replace DSH's stock one, or extend it?

**Current.** A custom Trajectory view (`src/client/views/TrajectoryView.tsx`,
~430 lines plus `TrajectoryInspector`, `TrajectoryTimeline`, `TrajectoryParts`,
`trajectory-model`) registers with the stock id `trajectory` at priority -1 and
suspends DSH's own browser entry while LayerFS mode is on
(`stock-trajectory.ts`). Chat's Inspect target is re-seated to the custom view.

**Tension.** `docs/specs/project-sessions.md` §7 and §10 describe the opposite
approach: keep DSH's trajectory and add LayerFS annotations to the existing
tool cards through the turn-tail slot. The custom view duplicates a DSH
surface, will drift with every DSH release, and costs the listed features in
project sessions as well as in split view.

**Options.**

- **A — keep replacing.** Accept the parity debt; write the parity checklist
  (the features `layerfs-trajectory.md` says are not copied), and add a
  DSH-upgrade e2e that fails when the stock entry id or package name moves, so
  the suspension does not silently stop working. The custom view is the only
  one with the LayerFS lane, call rows and version chips; extending may not be
  able to draw them.
- **B — extend the stock view.** Restore the stock Trajectory for project
  sessions and add LayerFS rows under tool calls through the public turn-tail
  slot (the model in `project-sessions.md` §10). Less UI to maintain and no
  split-view downgrade, but it loses the custom four-lane timeline, the
  LayerFS-only filters and the custom inspector unless DSH exposes seats for
  them.
- **C — extend first, replace later.** Ship the annotation layer on the stock
  view now and keep the custom view behind a flag for the richer audit
  experience.

**Blocks.** Group 4's Trajectory checklist, the split-view decision (a replace
decision forces C or a seam there), and `conversation-views.md` §1.

**Recommendation.** Decide on parity requirements: if the four-lane timeline
and LayerFS-only filters are product requirements, A with the parity checklist
and upgrade test; if the audit value is the per-call rows, B is the cheaper and
more DSH-faithful long-term path.

## 4. Brand colours: exception or tokens?

**Current.** The LayerFS mark fills literal `#93B1E0` / `#2F5BB5`
(`views/marks.tsx:43-47`); the whale uses `--dsw-static-*` with `#fff` /
`#0f0f0f` fallbacks (`views/marks.module.css:5-6`). Everything else follows
`--dsw-alias-*` tokens.

**Options.**

- **A — brand exception.** Keep the exact blues (the mark is LayerFS's own
  drawing, recognisable across themes) but name them: a small brand module with
  two CSS custom properties, referenced by the SVG, plus a lint allowlist
  entry. One documented exception, no raw hex in components.
- **B — tokenise.** Map the mark to the nearest `--dsw-static-*`/`--dsw-alias-*`
  values per theme. Consistent with the design system, but the mark changes
  colour with the app's palette and stops matching layerfs.ai brand assets.

**Recommendation.** A, limited to the two mark inks; remove the whale's hex
fallbacks (the tokens exist) and let the lint catch future literals.

## Verification status and caveats

- The found problems and their file:line references were read from the code at
  `07dfd9d`; the composer and split-view behaviours have not been reproduced
  on a live build. The composer fix that landed above `07dfd9d` is covered by a
  unit test that runs the real `SlotCore` election against DSH's three
  takeovers; no live approval on a LayerFS tab has been observed yet.
- The GitHub token used for the review has `repo` and `read:org` only, not
  `read:project`, so the project board's per-item status and ordering could not
  be read. Priorities in this note follow the issue text, not the board.

## Landed while this note was written (context)

- `Conversation tabs: approvals outrank the hidden composer` — the hidden
  composer entry moved from -100 to 100, above approval, question and subagent
  takeovers (chains elect ascending).
- `Conversation tabs: content views reread on checkpoints, not every session
  read` — `contentTick` for Files, History and Stats; `tick` still drives the
  session read and the unsaved line.
- `Conversation views spec: the hidden composer yields by ascending priority`.
