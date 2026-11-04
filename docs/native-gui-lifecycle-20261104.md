# Native GUI lifecycle and text window — 2026-11-04

> **Status:** Implementation candidate; real original-Session editor tested. Full 3081 GUI lifecycle and agent-process integration not yet qualified.

## Changes after the reviewed host owner slice

The native Sandboxes page now consumes the this-host-runtime native instance observations, exposes explicit create/mount/Commit/clean-unmount/confirmed-discard/close, and does not substitute Sandbox-derived zero counts. A pending/unknown snapshot is visibly not a complete mount listing. Client submission is guarded against duplicate in-flight actions; refusals display the original code and state explicitly that no retry occurred.

The small text editor loads/saves a UTF-8 window through the exact original instance.workspace(path) Session.exec handle. It launches the fixed host Node executable and the shipped native-text-command.cjs source; executable and command selection are never HTTP fields. Workspace path resolution stays on the original mount handle. Text path validation rejects parent/dot components, streams/backslashes, trailing dot/space, reserved device names, and symbolic links observed in each component. Native restricted process/stream ownership and output completion are reused; both outputs are drained before terminal completion.

The GUI window is at most 16 KiB (not a Store/file/Workspace size cap). Larger or binary files refuse in this GUI editor; use explicit native commands for those. Bytes are UTF-8, including a BOM, and empty text remains valid. Saving changes only the active Workspace; Commit remains an explicit separate action. The loaded content digest detects a stale ordinary editor save; a new file uses exclusive create. This is not an atomic CAS against concurrent external mutation or path renames, and does not claim a stronger isolation boundary than the original restricted native process. A concurrent writer/rename still requires a future product contract.

## Tests

- Native editor product proof: D:/workspace/layerfs/tmp/native-product-owner-20261104/editor-sealed/result.json. Real WinFsp/Store/parent/restricted binaries, original runtime instance, readText→writeText with Chinese UTF-8, stale revision EditorRefused, parent path InvalidInput, Dirty reversible, explicit original Commit, Store/history readback, clean unmount and acknowledged close; runtime_closed=true.
- packages/host/tests/native-text.mjs: standalone fixed-command contracts, exact UTF-8/empty/BOM, stale/new-file semantics, size/binary/device/symlink/path refusals and invalid inputs before native command launch.
- native-owner.mjs adds failed-bind coverage: returned original handle stays visible and explicitly closable; no reconstruction or automatic retry.
- Existing native-routes/host/agent regressions pass. Client bundle build and historycache/playback pass. GUI clicks remain to be performed after candidate review and controlled 3081 startup.

## Delivery state and limits

The reviewed host slice is 54a8fb81328b6b96fde043cc7276ced3f25357c2, with independent same-SHA PASS from dsh/9af264d0 (direct-eed60931), pushed and read back at fork/main. This follow-up GUI/editor candidate needs its own review because it changes execution input and control fields. 3081 was not listening at the check; no test host was started, restarted or reconfigured here. Harness remains read-only and 3080 untouched. Existing unrelated theme/asset modifications remain excluded.

Agent-process control is not implemented by this host owner: runtime.native.bindClient is explicitly process-local. No new Store RPC or cross-process impersonation has been added. Task 6930e4ec4d and goal-78d1178c remain active until GUI lifecycle and agent-path verification are complete.
