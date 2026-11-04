# Native GUI lifecycle and text window — 2026-11-04

> **Status:** Dated functional verification. Real 3081 GUI create/mount/edit/save/Commit/unmount/close passed on 2026-11-04; agent-process integration remains unqualified.

## Changes after the reviewed host owner slice

The native Sandboxes page now consumes the this-host-runtime native instance observations, exposes explicit create/mount/Commit/clean-unmount/confirmed-discard/close, and does not substitute Sandbox-derived zero counts. A pending/unknown snapshot is visibly not a complete mount listing. Client submission is guarded against duplicate in-flight actions; refusals display the original code and state explicitly that no retry occurred.

The small text editor loads/saves a UTF-8 window through the exact original instance.workspace(path) Session.exec handle. It launches the fixed host Node executable and the shipped native-text-command.cjs source; executable and command selection are never HTTP fields. Workspace path resolution stays on the original mount handle. Text path validation rejects parent/dot components, streams/backslashes, trailing dot/space, reserved device names, and symbolic links observed in each component. Native restricted process/stream ownership and output completion are reused; both outputs are drained before terminal completion.

The GUI window is at most 16 KiB (not a Store/file/Workspace size cap). Larger or binary files refuse in this GUI editor; use explicit native commands for those. Bytes are UTF-8, including a BOM, and empty text remains valid. Saving changes only the active Workspace; Commit remains an explicit separate action. The loaded content digest detects a stale ordinary editor save; a new file uses exclusive create. This is not an atomic CAS against concurrent external mutation or path renames, and does not claim a stronger isolation boundary than the original restricted native process. A concurrent writer/rename still requires a future product contract.

## Tests

- Native editor product proof: D:/workspace/layerfs/tmp/native-product-owner-20261104/editor-sealed/result.json. Real WinFsp/Store/parent/restricted binaries, original runtime instance, readText→writeText with Chinese UTF-8, stale revision EditorRefused, parent path InvalidInput, Dirty reversible, explicit original Commit, Store/history readback, clean unmount and acknowledged close; runtime_closed=true.
- packages/host/tests/native-text.mjs: standalone fixed-command contracts, exact UTF-8/empty/BOM, stale/new-file semantics, size/binary/device/symlink/path refusals and invalid inputs before native command launch.
- native-owner.mjs adds failed-bind coverage: returned original handle stays visible and explicitly closable; no reconstruction or automatic retry.
- Existing native-routes/host/agent regressions pass. Client bundle build and historycache/playback pass. The actual GUI click proof is recorded below.

## Delivery state and limits

The reviewed host slice is 54a8fb81328b6b96fde043cc7276ced3f25357c2, with independent same-SHA PASS from dsh/9af264d0 (direct-eed60931), pushed and read back at fork/main. The GUI/editor slice later received its own same-SHA review and was exercised on 3081 as recorded below. Before deployment 3081 was not listening; no existing host was restarted. Harness remains read-only and 3080 untouched. Existing unrelated theme/asset modifications remain excluded.

Agent-process control is not implemented by this host owner: runtime.native.bindClient is explicitly process-local. No new Store RPC or cross-process impersonation has been added. The GUI gap task 6930e4ec4d can now close for this tested lifecycle. Goal-78d1178c stays active for agent-path integration and qualification.

## Real GUI verification — completed 2026-11-04 12:41 +08:00

Tested commit d53604e2cf6fefceba196dd33a0968ec11fca01b received independent same-SHA PASS from dsh/9af264d0 (direct-86092fa5) before push/deployment; fork/main readback matched. Both host ownership and GUI/editor code are now delivered. The 3081 listener had stopped before this task; a managed test host was started with an explicit command-line patch. No profile file was changed, no existing host was killed/restarted, and 3080/Harness checkout stayed untouched.

An SDK-only setup fork created fresh test Branch gui-native-20261104-1236 in the existing native1 test project; setup is not GUI proof. Every lifecycle action below was a visible Tabbit GUI click on 3081:

1. Create native instance: one original resident native instance appeared. The first automation wait expired before the page finished updating; the instance was inspected and reused, never created again.
2. Mount Branch: the new Branch mounted in the GUI-created instance; one original owned session appeared.
3. Load text window at /gui-proof.txt, type Chinese UTF-8 text and Save to Workspace: writeText: Saved; dirty inodes/entries were visible. Save did not Commit.
4. Unmount cleanly before Commit: original product refused Dirty (HTTP 409, service retained). No automatic retry or forced teardown.
5. Explicit Commit Workspace with message GUI native lifecycle acceptance 2026-11-04: Committed head 12f5ff54dc8085ce74f0247398916f595d7e02f11af7765456f323745b9af5c0c9.
6. Unmount cleanly after Commit, then Close instance: Unmounted and close acknowledged. The native API returned instances: [] and the GUI showed 0 native instances / 0 owned sessions.
7. A separate public SDK process read the saved Branch file after close: exact text "GUI native lifecycle proof 中文\n" and the exact Commit head/message above. Main was not published or otherwise changed by this test. The test Branch is intentionally retained as evidence.

Evidence retained at D:/workspace/layerfs/tmp/native-product-owner-20261104/: gui05..gui13-command.json (real clicks/acknowledgements), gui-branch-setup.json (SDK setup only), gui-readback.json (independent process), gui-lifecycle.png (actual final screenshot), and gui-summary.json (source/version/verdict). Startup option-placement failure and loading timeout/aborted GET remain in separate raw receipts. Initial launcher --patch placement was wrong; it was corrected using explicit --profile web and launcher options before application args, without editing Harness.

This qualifies one instance and one small-text lifecycle through the plugin GUI, including Dirty protection. It does not qualify machine-wide discovery, host-crash recovery, forced unmount, large/binary GUI editing, concurrent external writer/rename atomicity, or agent-process borrowing of host-owned handles. The native scope remains this-host-runtime. Existing dirty theme/assets remain disclosed in the earlier acceptance record.
