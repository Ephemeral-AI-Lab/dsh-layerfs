# Test speed-ups for dsh-layerfs

How to keep checking a change proportional to the change. It waives nothing in
`AGENTS.md`: side verification first, then merge into the checkout 3080 links
and check on 3080. LayerFS's own guide is `docs/general/test-speed.md` in the
LayerFS repo (on `layerfs_v2_0_0`).

## Where the time goes

Measured 2026-11-20 at `4c361bc` (Node 24.21.0, macOS host):

| Step | Cost |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | 5 s |
| `node --test test/*.test.mjs` | 56 s wall for 801 tests (212 s of test time across parallel files) |
| The ten slowest unit tests | 42% of the test time; they wait out real budgets and timeouts (e.g. in `test/cli-lanes.test.mjs`) |
| The other unit tests | 703 of 801 finish in under 0.1 s |

The unit suite is cheap. The expensive steps are the e2e scripts on a side
server, LayerFS runtime rebuilds, 3080 restarts and UI checks on 3080.

## The loop

1. **Typecheck and the affected test files while fixing.** Find them by import:
   `grep -l '<changed module path>' test/*.test.mjs`, then
   `node --test <those files>`. Run the whole unit suite before each merge into
   the 3080 checkout; at about a minute, it needs no further scoping.
2. **Build when a server will load it.** Use `node scripts/build.mjs --watch`
   on your side server so client changes hot-reload; host changes need a side
   server restart.
3. **Run only the e2e scripts that cover the change,** on one side server kept
   for the whole task. Reset its private home only when a script needs it.
4. **Rebuild the LayerFS runtime only when the LayerFS commit changes.** A
   plugin-only fix runs on the pinned runtime.

## 3080

- **Client-only changes need no restart:** rebuild in the 3080 checkout and
  they hot-reload. Collect host changes and restart 3080 once for them, at a
  moment when no other agent is mid-test.
- **Check only the areas the change touched,** plus a short smoke of the pages
  it shares with them. A full UI pass is for a release or a runtime switch.
- **Split UI checks into two agents:** a read-only one that can run alongside
  other work, and a mutating one that acts one step at a time on its own
  prefixed resources.
- **Script repeated checks** with `tools/shot.mjs --steps` modules and keep them
  beside the task, so a recheck reruns the same steps instead of redoing them by hand.

## Writing fast tests

- **Inject time budgets.** A test about a timeout should pass a small budget or
  a fake clock, not wait for the production budget; the slowest current tests
  spend most of their time waiting.
- **Keep each test file independent,** so `node --test` can run files in
  parallel and a single file can run alone.
