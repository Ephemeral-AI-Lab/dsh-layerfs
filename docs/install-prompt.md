# Install prompt: dsh-layerfs on the latest LayerFS `layerfs_v2_0_0`

Give everything below the line to a coding agent (Claude Code or similar) on the
machine where DeepSeek Harness runs. Fill in the three values at the top first. The
steps are the same as the README's Install section.

---

Install the **dsh-layerfs** DeepSeek Harness plugin, and a LayerFS runtime built from
the **latest `layerfs_v2_0_0`** of Ephemeral-AI-Lab/layerfs, then pin that runtime
and prove that it matches the remote tip.

Inputs (ask me for any that are missing, and don't guess them):

- `WORK`: an absolute folder to put the checkouts in, e.g. `~/src`.
- `DSH_PROFILE`: the DSH profile to install into (normally `web`).
- `DSH_RUNNING`: whether a `dsh web` server is running now, and how it was started
  (its command, cwd and `DSH_HOME`).

## Rules

- Don't modify DeepSeek Harness or LayerFS sources. dsh-layerfs is a DSH plugin, and
  LayerFS is only built here, never edited.
- Don't hand-edit the LayerFS home (`~/.layerfs`, or `LAYERFS_HOME`). Only the DSH
  app (the Runtime → Change dialog or the host API) and the `layerfs` CLI change it.
- Build LayerFS with **`--profile release`** in every step. Both build tools default
  to debug, and a debug daemon makes docker Workspaces several times slower.
- Before restarting a running `dsh web`, or stopping a docker/Lima machine that has
  open Sandboxes or mounted Workspaces, tell me what will be interrupted and wait
  for my OK. Never unmount with `--discard` or remove Store contents.
- Never print the `dsh web` URL token into chat or files.
- Use Node ≥ 24. Every command that waits gets a timeout. Report failures with their
  output and don't retry blindly.

## Steps

1. **Plugin.** In `WORK`:
   ```sh
   git clone -b layerfs_v2_0_0 https://github.com/Ephemeral-AI-Lab/dsh-layerfs.git
   cd dsh-layerfs && npm install && node scripts/build.mjs
   npx tsc -p tsconfig.json && node --test test/*.test.mjs
   dsh plugin --profile "$DSH_PROFILE" add link:$PWD
   ```
   If dsh-layerfs is already cloned, `git fetch` and fast-forward
   `layerfs_v2_0_0` instead, and merge rather than overwrite any local changes. The
   unit tests must all pass.

2. **LayerFS at the tip.** Clone `https://github.com/Ephemeral-AI-Lab/layerfs` into
   `WORK/layerfs` if it's missing, then:
   ```sh
   git -C "$WORK/layerfs" fetch origin layerfs_v2_0_0
   TIP=$(git -C "$WORK/layerfs" rev-parse origin/layerfs_v2_0_0)
   git -C "$WORK/layerfs" worktree add --detach "$WORK/layerfs-v2-tip" "$TIP"
   ```
   Read `WORK/layerfs-v2-tip/AGENTS.md` and `docs/general/parallel-worktrees.md`.
   Register the worktree with `python3 tools/worktree.py register --worktree
   "$WORK/layerfs-v2-tip" --owner dsh-layerfs-runtime --build-image … --runtime-image
   … --sandbox-image …`, using the LayerFS build, runtime and sandbox images already
   installed on this host (the doc says how to find them). Keep the printed
   `resources.json` path as `R`.

3. **Build the macOS pair and SDK addon** (prints the sealed build folder; keep it as `B`):
   ```sh
   python3 tools/worktree.py build --resources "$R" --platform macos --profile release \
     --features layerfs-cli/postgresql,layerfs-cli/tls,layerfs-daemon/postgresql,layerfs-node/postgresql,layerfs-node/tls
   ```

4. **Build the Linux bundle** into its own folder, so the shared default under
   `~/.cache/layerfs/bundle/` isn't overwritten:
   ```sh
   for s in daemon worker helper seal; do
     python3 tools/linux_bundle.py $s --resources "$R" --profile release --dest "$WORK/layerfs-bundles/$TIP" || break
   done
   ```
   The bundle lands in `<dest>/<version>/linux-<arch>/`, e.g.
   `$WORK/layerfs-bundles/$TIP/2.0.0/linux-aarch64`. Keep that folder (the one holding
   `bundle.json`) as `BUNDLE`.

5. **Prove it's the tip, built as release:**
   ```sh
   "$B/layerfs" --version --json          # commit == $TIP; features include machine, postgresql, tls
   git ls-remote https://github.com/Ephemeral-AI-Lab/layerfs layerfs_v2_0_0   # still $TIP
   grep -E '"profile"|"head"' "$BUNDLE/bundle.json"   # "release", head == $TIP
   ```
   If the branch moved during the build, start again from step 2 with the new tip.

6. **SDK for agents** (in the dsh-layerfs checkout):
   ```sh
   node scripts/install-sdk.mjs "$B"      # must say "(macos, release)" and $TIP
   ```

7. **Pin.**
   - **`dsh web` running:** open DSH → the LayerFS sidebar row → Center → Settings →
     Runtime → **Change…**. Give it `$B/layerfs`, `$B/layerfs-daemon` and `BUNDLE`.
     It copies them into `~/.layerfs/runtime/<version>-<sha>/` and pins those copies.
   - **Not running:** start `dsh web` with `DSH_LAYERFS_CLI=$B/layerfs`,
     `DSH_LAYERFS_DAEMON=$B/layerfs-daemon` and `DSH_LAYERFS_BUNDLE=$BUNDLE`.

   A host restart is needed only if the plugin's host code changed since `dsh web`
   started; follow the rule above before restarting.

8. **Machines.** Every docker or Lima machine needs a worker of the new build.
   1. List its Sandboxes.
   2. With my OK, commit (don't discard) any dirty Workspace, then unmount the
      Workspaces and close the Sandboxes.
   3. Stop and start the machine.
   4. If the new CLI refuses with "worker … of another build", pin the previous
      runtime briefly to close and stop, then pin the new one and start.

9. **Verify on the running app:**
   - Runtime status shows commit `$TIP`.
   - A `layerfs file stat` through the agent wrapper
     (`$DSH_HOME/layerfs/agent-bin/layerfs`, which becomes a `#!/bin/bash` script after
     the first agent shell) succeeds against a docker Store.
   - No call is refused as "of another build".
   - Logs shows lines with source `layerfs`.

## Report

Report:
- `$TIP`, `B` and `BUNDLE`;
- the CLI's `--version --json`;
- the bundle's profile and head;
- the SDK install line;
- the pinned runtime id;
- each machine you restarted, and what was open on it;
- the test results;
- anything you skipped and why.

## Updating later

When `layerfs_v2_0_0` moves, repeat steps 2–9 in the same worktree
(`git -C "$WORK/layerfs-v2-tip" fetch origin layerfs_v2_0_0 && git -C
"$WORK/layerfs-v2-tip" checkout --detach origin/layerfs_v2_0_0`), with a new bundle
folder per commit.
