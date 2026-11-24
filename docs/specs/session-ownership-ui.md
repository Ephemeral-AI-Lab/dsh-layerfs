# Session/project ownership in the sidebar and New Session (design needed)

Status: **design needed** — deferred by the owner on 2026-11-24 until the
session/project panel design exists (groups 1 and 3). Do not implement pieces
of it before that design: the row adapter, the ownership reads and the New
Session chip all move with it.

## What it covers

- The LayerFS mark on a project session's row in DSH's Workspaces list, and
  hiding that row from DSH's list so the session is found only under its
  project (`src/client/session/index.tsx` `RowMark`; `session.module.css`
  hides `[data-layerfs-project-owned]`).
- Every row's ownership read and its `layerfs-session` subscription —
  `RowMark`, the conversation presence reader (`src/client/views/index.tsx`)
  and the sidebar each ask `session.place` on their own.
- The New Session hero's project chip (`src/client/hero/HeroProject.tsx`): a
  failed `session.place` read is swallowed and the chip stays **No project**.

## Why deferred

- The row adapter hides DSH's own list entries through a DOM attribute and a
  `:global` CSS selector because DSH exposes no session-list filter
  (`project-sessions.md` §10). Whether that stays depends on the panel design:
  if project sessions remain visible in DSH's list with ownership shown another
  way, this adapter and its silent failure modes disappear.
- The hero chip is the same placement question as the New Session project
  control (group 3) and the sidebar sections (group 1). Designing its store and
  error state before the panel would likely be redone.
- The read-storm fix (one ownership store, filtered and coalesced events) is
  independent in principle, but the store's shape depends on what the panel
  shows (one project per session? a chip? a group?), so it is designed with it.

## Known issues (evidence at `07dfd9d`)

- Each row reads `session.place` on every `layerfs-session` event, unfiltered
  and not coalesced (`src/client/session/index.tsx:28-35`); a team run
  multiplies it by the number of rows.
- A DOM miss returns silently (`session/index.tsx:24`): nothing signals that
  ownership marks stopped working.
- A failed read in the hero is swallowed and the chip keeps saying **No
  project** (`HeroProject.tsx:100`).
- The mark is a plugin decoration on DSH's row; the hiding rule is a global CSS
  attribute selector.

## Questions the design must answer

1. Do project sessions stay out of DSH's Workspaces list, or stay visible with
   a mark? If they stay out, is there a DSH seam to ask for, or is the DOM
   adapter accepted with a detection signal (Doctor)?
2. Where does ownership live in the UI: the row mark, a chip, the project
   panel header, or only inside the conversation?
3. What does "unknown" look like when `session.place` cannot be read — keep
   the last answer with an error, or show a neutral state?
4. One read model for every consumer (sidebar rows, hero, conversation
   presence): a batch op, an event payload, or a client store?

## Safe prerequisites (not commitments)

- One ownership store with session-id filtering and at least 500 ms
  coalescing.
- Three states — project, not a project, unknown — with a visible Retry for a
  failed read.
- A logged signal when the DOM adapter misses (the Doctor can surface it).
