# Local Windows verification network deployment

This is a retained machine-specific verification deployment, not a shipped proxy
setting or a portable network default. No Store is kept on a Windows mount.

The pinned LayerFS SDK/runtime does not expose Sandbox proxy environment or
network settings. Its Docker containers inherit image environment variables, so
this local derived image supplies HTTPS_PROXY/https_proxy and localhost NO_PROXY.
The underlying scenario commands and frozen dependency versions are unchanged.

## Current restart-safe deployment

After all ten rows passed and the worker reported zero active calls, the relay
source was copied to `/home/yifan/.local/share/dsh-layerfs-proxy/relay.mjs` on
WSL's local filesystem. The active container keeps the original name but is now
`6841933b7df6965b742829b12a44a75df48edd4b35a30bd5fcf48904474a5675`, with
`--restart unless-stopped` and that stable read-only source mount. The original
container was stopped and retained as `layerfs-428-proxy-20261024-original`.
No Store, unrelated container or volume was removed.

A deliberate container restart succeeded, followed by one successful crates.io
config GET from a fresh bridge container (20-second outer timeout, 15-second curl
limit). Exact creation, restart and verification commands and outputs are in
[persistent-relay.json](persistent-relay.json). Use its creation command with
this stable source path when reproducing this particular deployment. The image,
bridge-only binding, upstream proxy and security restrictions are unchanged.

This survives relay container restarts and Docker restart policy applies when
Docker starts. It does not start Windows, WSL, Docker or the external upstream
proxy itself. A full machine reboot was NOT_RUN. If the upstream proxy or bridge
address changes, update this deployment deliberately while runs are idle. Do not
hardcode these local addresses into the plugin's standard image.

## Original identities and result (historical)


- Base runtime: `sha256:b9eeeaefd7edc6771193b2100f7afd904e4182faad66c776a866b25019082667`.
- Local derived image: `sha256:2b6690982aed26bebcb004c803db64d8769d5c1d10559d4062046af7a78d5390`.
- Tag: `layerfs-428-verification:scenarios-proxy`.
- Relay: `layerfs-428-proxy-20261024`, container
  `8bdaddb77841a3bf6c1d570d0d96a1cafe46d358caac715c240c67b68fa1c797`;
  Linux PID 66877 at capture.
- Build passed in 1.281 seconds; a new bridge container fetched
  `https://index.crates.io/config.json` once in 1.985 seconds with curl's 15-second
  limit. See `image-build.json`, `image-build.log`, `connectivity.json`, and
  `connectivity.log`. This is connectivity evidence, not a completed Depot run.

## Network scope and lifecycle

Docker network inspection reported bridge gateway `172.17.0.1`, subnet
`172.17.0.0/16`. The relay binds **only** `172.17.0.1:15237`, not all interfaces.
It forwards opaque TCP streams without logging request bytes or credentials to
`127.0.0.1:15236` in WSL's host network. That endpoint depends on the existing
Windows loopback proxy, available through WSL mirrored networking. Neither that
proxy nor Windows firewall settings were changed.

These addresses and port numbers are local choices. Inspect the target machine's
Docker bridge and existing proxy before reproducing elsewhere. Do not reuse the
literal addresses as platform defaults or expose this relay publicly.

The relay is retained running for this deployment, with `--restart no`, a
read-only filesystem, all capabilities dropped, and `no-new-privileges`. Its only
mount is the relay source file, read-only. It creates no Store or volume. The
copied source here preserves the original temporary source used by the running
container; moving or deleting that original source may break a future restart.

## Exact commands executed

The commands below are PowerShell commands and refer to this machine's original
retained temporary paths. All invocations had explicit limits. The image build
also ran through the verification runner with a 120-second outer timeout.

```powershell
wsl -d Ubuntu -- timeout 15 docker run -d --name layerfs-428-proxy-20261024 --restart no --network host --read-only --cap-drop ALL --security-opt no-new-privileges -v /mnt/c/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify/proxy-relay.mjs:/relay.mjs:ro --entrypoint node sha256:b9eeeaefd7edc6771193b2100f7afd904e4182faad66c776a866b25019082667 /relay.mjs
wsl -d Ubuntu -- timeout 110 docker build -t layerfs-428-verification:scenarios-proxy /mnt/c/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify/proxy-runtime
wsl -d Ubuntu -- timeout 20 docker run --rm --name layerfs-428-proxy-check-20261024 sha256:2b6690982aed26bebcb004c803db64d8769d5c1d10559d4062046af7a78d5390 curl --fail --silent --show-error --max-time 15 https://index.crates.io/config.json
wsl -d Ubuntu -- timeout 10 ss -ltn
```

The image build log records the exact resolved base digest. Dockerfile, relay
source and lifecycle metadata are copied alongside this document. For a later
reproduction, use these copied artifacts as the build context and relay mount;
verify the base tag still resolves to the recorded base digest first. A rebuilt
image's digest can differ because build attestations are newly generated.

## Release only this task's relay

These cleanup commands have **not** been executed: the active deployment needs
the relay. After its dependent runs are stopped and the deployment no longer
uses this proxy image, release only this exact container:

```powershell
wsl -d Ubuntu -- timeout 15 docker stop -t 5 layerfs-428-proxy-20261024
wsl -d Ubuntu -- timeout 15 docker rm layerfs-428-proxy-20261024
```

No other container, volume, image or proxy process is selected by these commands.
