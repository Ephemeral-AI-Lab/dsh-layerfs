# LayerFS setup: handoff (batches B, C, H, U)

Spec: [`layerfs-setup.md`](layerfs-setup.md). A1 was done before this
(`7aaf2a1feb`, LayerFS worktree `.claude/worktrees/home-setup-a1`, branch
`claude/home-setup-a1`).

## What was done

### LayerFS (branch `claude/home-setup-a1`, local only, not pushed)

<!-- LAYERFS -->

### dsh-layerfs (branch `layerfs-setup`, worktree `../dsh-layerfs-setup`)

- `66eff2b` H + U: the setup check and home gate (host), the Set up
  LayerFS modal, shared runtime picker, Center/Settings/Health/Add machine/
  docker socket/Runs on changes (UI).
<!-- DSH -->

## Checks

<!-- CHECKS -->

## Decisions

- §6.1 / A2 skipped (needs the LayerFS maintainers). Without it, any CLI
  call still opens (creates or converts) the home, so the plugin's **home
  gate** does it instead: before the first call it asks `home get` once; a
  folder that needs converting refuses every call `Uninitialized` (503)
  until Convert in the setup modal; a read on a missing folder runs
  `home init` first. Presets and simulations go through the same gate.
  The read guard that blocked home setup on Linux is gone (it is this gate).
- §6.2: a docker machine records its socket on its next start only.
- §6.3: runtimes come only from the LayerFS app; the picker lists
  `<home>/runtime`, and "Other build…" takes paths (copied into the home as
  before). No Install-from-build.
- **No rail in the setup modal** (the user, 2026-11-17: "we do not need the
  side bar"): one column, each section's state in words beside its title;
  machine cards refined (mark, name, state tag, role, facts, actions). Spec
  §4.1 updated.
- Build verdicts are computed by the plugin with LayerFS's `matches` rule
  from the same stamps (`--version --json`, `bundle.json` `source.head`/
  `source.dirty`, the daemon's `layerfs-build-identity:<commit>:clean|dirty`
  read from the file), so runtimes whose CLI predates `home get` and a
  candidate daemon at save time get one too. The active bundle verdict comes
  from `home get` when the CLI has it (it resolves `LAYERFS_BUNDLE`, else the
  cache).
- A runtime without its own Linux bundle is judged by the bundle LayerFS
  would use (the cache one); if that is from another build, Done is blocked
  ("From mixed builds"), as the spec's "no `matches: false`" says. Revisit if
  native-only users should pass.
- "Created/Converted just now" shows for 10 minutes after the setup check
  did it.
- Center: while setup misses something required after Later, it is the
  head card's first need (one place), not a second card; with nothing set
  up, the setup card replaces the error box.
- Preset runner/machine-stop messages now name Center → Settings → Change…
  (they named a page that no longer exists); this diverges those copied
  Connect files by one line each.
- `scripts/dev.mjs` gains `DSH_LAYERFS_DEV_NO_RUNTIME=1` (the "no runtime"
  state on a side server).
<!-- DECISIONS -->

## Left

- **A2** (§2.7, reads never change the home): needs the LayerFS
  maintainers' agreement.
- **Pushing the LayerFS branch** `claude/home-setup-a1` (A1, B, C): needs
  the user's OK.
<!-- LEFT -->
