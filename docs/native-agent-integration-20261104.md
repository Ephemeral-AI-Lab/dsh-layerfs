# Native agent public SDK integration — 2026-11-04

> **Status:** Dated functional verification of contributor-injected separate agent scripts. Not a live model/tool-scheduler or machine-wide native discovery qualification.

## Explicit public entrypoints

For a bound project, and only when the configured route is native with nativeWorkspace deployment, the existing bash environment contributor exposes:

- DSH_LAYERFS_RUNTIME: URL of [agent/runtime.js](../packages/host/src/agent/runtime.js), which loads the existing DSH-to-LAYERFS environment mapper and re-exports @layerfs/runtime unchanged.
- DSH_LAYERFS_NATIVE_WORKSPACE: JSON with administrator-selected product executable/host/WinFsp/restrictedLauncher/workRoot. It contains no instance handle, secret or authority to borrow a host-owned instance.

DSH_LAYERFS_SDK, DSH_LAYERFS_BACKEND, project selection and call trace remain the existing wrappers. SDK LayerFS.open and importing the runtime wrapper do not create a native instance or replace global transport. Non-native/unconfigured calls do not receive the native runtime/deployment variables.

An agent script explicitly opens its own runtime and its own direct Store client in the SAME process, creates an instance, and binds the original handle via public runtime.native.bindClient. It must explicitly unmount, close the instance and close both client/runtime before the script ends. Another script cannot reconstruct the old handle from an id. Retained/uncertain ownership is not re-created or auto-retried; keep the original process alive if it has not safely closed. There is no new Store RPC, no WSL fallback, no host HTTP forwarding and no global discovery.

```js
const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK);
const { LayerFSRuntime } = await import(process.env.DSH_LAYERFS_RUNTIME);
const { workRoot, ...executables } = JSON.parse(process.env.DSH_LAYERFS_NATIVE_WORKSPACE);
const { mkdirSync } = await import("node:fs");
const { join } = await import("node:path");
const { randomUUID } = await import("node:crypto");
mkdirSync(workRoot, { recursive: true, mode: 0o700 });
const project = process.env.DSH_LAYERFS_PROJECT;
const runtime = await LayerFSRuntime.open({ home: process.env.LAYERFS_HOME, native: true, sweep: false });
const client = await LayerFS.open(project);
const instance = await runtime.native.create({ project, ...executables, work: join(workRoot, randomUUID()) });
const binding = await runtime.native.bindClient(client, instance, { commitScope: "published" });
// Mount an existing non-main Branch; execute through instance.workspace(ws.path).exec(executable, argv).
// Consume stdout/stderr and command.finished; observe original Close before normal unmount.
// Explicit client.workspace.commit(ws), client.workspace.unmount(ws), instance.close(),
// client.close(), runtime.close() complete the successful lifecycle. No implicit retry/discard.
```

## Real proof

[native-agent-real.mjs](../packages/host/tests/native-agent-real.mjs) creates a fresh native Store/home, a real detached Session (public Session.create) and the actual plugin BindingStore/Collector/contributor. It passes only the contributor-selected DSH variables, plus the pinned addon test selection, to a separate Node process. No preexisting LAYERFS_* environment is inherited. The child uses only injected URLs and public SDK/runtime/backend APIs; it does not import internal control bindings.

The child checks: importing/opening creates no instance; unregistered SDK mount refuses Unsupported; a fabricated host handle refuses NoSuchSandbox; two independent SDK clients bind to one ORIGINAL child-owned instance; a restricted command writes Chinese UTF-8; Dirty preserves the mount; the other registered client commits, unmounts and reads the same path; original close acknowledges tokenClosed/desktopClosed/processExit=0. Both agent and parent runtimes finish closed.

The parent independently reopens the Store after child exit, verifies exact content/head/message, and polls the real trace Collector. Methods include workspace.mount, workspace.commit, workspace.unmount and backend status. The Host runtime has no native instance listed: child ownership is deliberately process-local, not misreported as a globally known Workspace.

Proof and binaries: D:/workspace/layerfs/tmp/native-agent-integration-20261104/actual-final/result.json and child-result.json; stdout/stderr/exit at child-command.json. Exact parent/child PIDs, published head, invocation arguments, product paths and wrapper URLs are recorded in result.json; exact text is "agent subprocess original owner 中文\n". Five product hashes are pinned in the result. Test invocations are foreground with explicit <=120s wall time and a child-specific 85s timeout.

## Preserved failures / limits

- actual-first: the plain session-record fixture was rejected by the real Session private receiver; replaced with the public detached Session object, not a monkey patch.
- actual-second: a missing work parent caused native path admission InvalidInput before create; the child now explicitly creates its configured workRoot, never replaces the fresh work target.
- actual-third PASS and the final proof (extended to record argv/product paths/wrapper URLs) use fresh independent Stores; no failed mutation is replayed.
- This is real native executable/Store/script-process integration with real contribution and records, but no live model was called, no tool scheduler launched the child, and no GUI host handle was transferred. It is not a proof of resumable native ownership across script exits or host crashes.
- Existing dirty theme/assets and LayerFS pin difference remain disclosed; no dependency/profile/Harness or production 3080 change.
