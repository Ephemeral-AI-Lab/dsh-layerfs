# Native Workspace ownership in the plugin — 2026-11-04

> **Status:** Dated implementation checkpoint. Host lifecycle slice verified; GUI/agent lifecycle integration remains in progress.

## Ownership

The plugin keeps only references to the original runtime.native.create handle and the SDK client explicitly registered by runtime.native.bindClient with commitScope "published". Runtime/Session retain the process, pipes, capacity and terminal receipts. No worker, Store RPC, second mount implementation, handle reconstruction, implicit restart or retry is introduced.

Each explicit create uses a fresh unique work path under the configured private workRoot. GET/list never creates anything. A separate SDK client stays open for this instance and is not subject to TreeReader quiet-minute eviction. Client close happens only after the original instance confirms close. Failed/unknown create and bind remain visible; an unreturned handle cannot be recreated from an id. Snapshot during a pending operation declares workspacesKnown=false, rather than presenting absence as evidence of no mounts.

## Configuration and routes

The existing host Config now declares route (native/worker). Native Workspace creation additionally requires nativeWorkspace with absolute executable, host, winfsp, restrictedLauncher and workRoot. These are administrator-selected deployment fields; HTTP requests cannot choose executables or work roots. No instance starts on plugin load, status reads or mount fallback.

Behind the existing Host/Origin and browser-auth checks:

- GET /layerfs/project/<name>/native: this-host-runtime observations and retained custody.
- POST the same route: action=create, mount, status, commit, unmount or close. Only operation-specific fields are accepted. Instance/project identity must match the original owner.
- GET /layerfs/project/<name>/runtime: includes native observations, not Sandbox-derived invented zero counts.
- discard=true requires confirm equal to the original mount path; force teardown is not offered.
- Project removal refuses busy while any original native instance for that project remains held, before evicting clients or deleting data.

The scope is this running host runtime, not machine-wide discovery or cross-process transferable capability. Agent processes cannot directly bind to the host process-local instance handle. Agent integration must preserve that boundary; it is not solved by forwarding Store calls over HTTP.

## Verification

- [native-real.mjs](../packages/host/tests/native-real.mjs): real native Store, product parent/WinFsp/restricted binaries; fresh independent Store/home; create→list→mount→write→Dirty refusal→Commit→readback→normal unmount→terminal close. Also missing/main Branch before effects, foreign project refusal, MountsActive and project-removal busy. Exact SDK status bigint values are projected as decimal strings.
- Final real proof: D:/workspace/layerfs/tmp/native-product-owner-20261104/actual-final/result.json, PASS, runtime_closed=true. No fake product state. Product binaries match earlier pinned proofs; hashes are in the result.
- [native-owner.mjs](../packages/host/tests/native-owner.mjs): unit boundary checks for wrong identity/fields, one in-flight mutation, pending snapshot certainty, unknown create custody, no implicit create/replay. Fake runtime is explicitly limited to unit contract verification.
- [native-routes.mjs](../packages/host/tests/native-routes.mjs): existing browser auth, missing project, configured-only creation, no read-side effects and original runtime projection.
- Existing host.mjs and agent.mjs regressions PASS. node --check and git diff --check PASS. All tests run in the foreground under explicit <=120s timeouts.

Preserved first FAIL: an immediate clean-unmount proof expected Dirty but Windows still held kernel references, so the product correctly returned reversible Busy/serviceKept=true. The test now observes original handles=0/active=0 after Close (bounded readiness wait), then makes one unmount attempt. No product refusal was weakened and no failed mutation was replayed. First raw result remains at actual-first/result.json; later outputs are fresh directories.

## Not yet delivered

GUI controls, native editing/execution input, lifecycle validation in 3081, and true agent-process integration are not qualified by this host slice. No host restart/profile deployment was performed in this checkpoint. Existing local theme/assets edits are unrelated and excluded from the commit.
