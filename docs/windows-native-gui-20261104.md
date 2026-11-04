# Windows-native GUI acceptance — 2026-11-04

> **Status:** Dated functional verification on the isolated 3081 test GUI. Not release qualification.

## Scope and identities

Real Tabbit browser clicks on http://127.0.0.1:3081/; production 3080 was not used.
LayerFS checkout: 72c44d5337d6c8b3e47015b08e46fcdca1f3cf5e.
Plugin parent: 382a2ed232cdeeebcf75d12c204c4f8212a2ea19.
Harness: ce7073d51254c26cd63b22a60835b8f948deb447, inspected read-only.
The plugin checkout already contained uncommitted theme/asset changes. They were not edited or staged by this change, but the live bundle includes them; this is not a clean-build/release claim.
[layerfs.json](../layerfs.json) pins fabefdf87a4fa4742897998c2ece883013939184, not the tested checkout. The pin check failed as expected; no pin was silently updated.

Raw command receipts, browser programs, source/bundle hashes and three retained screenshots are in D:/workspace/layerfs/tmp/gui-3081-20261104/ (identity.json and numbered *-command.json).

## Verified by visible GUI interaction

- LayerFS sidebar entry opens the native1 project.
- History draws the main L6 timeline, one Branch, seven Layers and 42 Commits.
- Files lists the root; clicking agent-written.md displays "agent-path write".
- Blame shows that line attributed to C7, comparing 37 versions.
- The browser list/read/blame URLs use saved id 32569fa170f69562dae81ec974268fd47f5d126740979c004da9ed514bd71d39a1 and all return HTTP 200. Earlier probes with guessed ids do not establish that file routes are defective.
- Storage renders 266 KB on disk, 156 KB raw history, 1.4x dedupe and 6.0x compression.
- Sandboxes renders "native route · 0 Workspaces · up to 16 mounts per instance" and explains there is no Sandbox family.
- All projects renders four projects, Store calls in-process and host free disk.

## Found and fixed: false Docker warning in All projects

Before: Health treated every engine level other than "ok" as "not answering", although the native host correctly returned engine.level: "not-used". The idle heading promised a Sandbox on the next mount and showed an unknown Docker volume size.

Fix: accept "not-used" in the Overview type; render "not used · Windows-native", "no container sweep needed", "Native projects · no containers required" and "Store local". Daemon-route text is unchanged. No host restart, settings change, SDK mutation or container was needed.

The real-browser regression is [native-overview.tabbit.js](../packages/client/tests/native-overview.tabbit.js). The final browser receipt is 23-final-regression-command.json, status "PASS native overview GUI", read at 2026-11-04T00:35:54.402Z. The rebuilt bundle hash is d4184b7ab1cae1146183ef309b538ae36daa76ae46e0673c10f475d87e5416d5.

## Not qualified / limitations

- No GUI mount, edit/save, Commit or unmount controls are available on the native page. The file viewer is read-only; Refresh is not a lifecycle operation. Host [projectAction](../packages/host/src/runtime.js) delegates existing unmount/discard/stop actions; this test did not fake a lifecycle through API calls.
- The "0 Workspaces" display is the host's empty Sandbox-derived list, not proof that all independently created native instances are globally discovered.
- Thus **GUI read/display acceptance passes; a native GUI Workspace lifecycle does not**. It needs separate implementation/integration, tracked as task 6930e4ec4d. Main task 3b7a154bc4 was not closed here.
- Agent skills injection, agent-initiated mutations, retained/crash states and cross-user behavior were not tested.
- This task did not change project data, create a session, run a model or make a Store mutation.

## Preserved failures and checks

- Standard Chrome browser harness could not connect without remote-debugging consent. The user chose Tabbit; no consent was bypassed.
- Locator-role/name guesses and a detached node caused automation failures; the file tab was then opened using a freshly observed bounding box and real mouse click.
- A browser-program regex syntax error was corrected before dispatching the click.
- Screenshot capture after bundle reload timed out. The correction is established by DOM text, live browser response and regression receipt, not a fabricated after-image. Earlier History/Storage/native-page screenshots were retained byte-for-byte.
- Unrelated /__dsh_a2a/state 401 and /layerfs-mock 404 warnings were observed and not claimed fixed.
- node tools/build-client.mjs: PASS, outputs only plugin client artifacts.
- Scoped client tests: historycache, playback (16 steps), initlimit and scenario-projects: PASS under explicit foreground timeouts.
- No dependency installation, profile edit, server restart or Harness source/build change was performed.
