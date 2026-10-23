# Exact bounded commands and outcomes

Exit 124 means timeout; nonzero means FAIL. Earlier failures are retained.

### backup-default-profile

```json
{
  "label": "backup-default-profile",
  "timeout": 30,
  "args": [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "$p = Join-Path $env:USERPROFILE '.dsh/profiles/web'; $b = Join-Path $env:USERPROFILE '.dsh/profile-backups/layerfs-428-20261024-0521'; New-Item -ItemType Directory -Path $b -ErrorAction Stop | Out-Null; Copy-Item -LiteralPath \"$p/package.json\",\"$p/cordis.patch.yml\" -Destination $b; Get-FileHash \"$b/package.json\",\"$b/cordis.patch.yml\"; if ($env:DSH_HOME) { throw 'DSH_HOME override is set' }"
  ],
  "exit_code": 0,
  "elapsed_s": 0.297,
  "at": "2026-10-24T05:21:51.942228"
}
```

### build-01-diagnosis

```json
{
  "label": "build-01-diagnosis",
  "timeout": 30,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "25",
    "bash",
    "-s"
  ],
  "stdin": "set -eu\nr=/home/yifan/.cache/layerfs-worktrees/layerfs-428-verification-c2c22458d2d3\ncat \"$r\"/builds/build-linux-*/receipt.json\ntail -25 \"$r\"/builds/build-linux-*/output.log\ndocker ps -a --filter label=layerfs.worktree=layerfs-428-verification-c2c22458d2d3\n",
  "exit_code": 0,
  "elapsed_s": 6.984,
  "at": "2026-10-24T05:22:14.926496"
}
```

### build-linux-01

```json
{
  "label": "build-linux-01",
  "timeout": 118,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "--signal=INT",
    "--kill-after=8",
    "110",
    "bash",
    "-s"
  ],
  "stdin": "set -eu\ncd /home/yifan/layerfs-428-verification\nexport LAYERFS_CONSTRUCTION_WORKERS=1\nexec python3 tools/worktree.py build --resources /home/yifan/.cache/layerfs-worktrees/layerfs-428-verification-c2c22458d2d3/resources.json --platform linux --profile release --jobs 2\n",
  "exit_code": 0,
  "elapsed_s": 100.391,
  "at": "2026-10-24T05:21:48.782287"
}
```

### bundle-identity

```json
{
  "label": "bundle-identity",
  "timeout": 30,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "25",
    "bash",
    "-s"
  ],
  "stdin": "set -eu\nb=/home/yifan/.cache/layerfs-worktrees/layerfs-428-verification-c2c22458d2d3/artifacts/build-linux-e068b8575eaf4c4cb34dde4d356ca072\nsha256sum \"$b/manifest.json\"\nls -l \"$b/api/runtime/src/worker/server.js\" \"$b/layerfs-daemon\" \"$b/layerfs.node\"\ndocker image inspect --format '{{.Id}}' layerfs-428-verification:node24\ndf -B1 /var/lib/docker\n",
  "exit_code": 0,
  "elapsed_s": 0.188,
  "at": "2026-10-24T05:22:27.869290"
}
```

### clone-layerfs-windows

```json
{
  "command": "git clone --single-branch --branch claude/issue428-sdk-packages-cd9412 https://github.com/Ephemeral-AI-Lab/layerfs.git ../layerfs-428-verification",
  "timeout_s": 110,
  "exit_code": 0,
  "elapsed_s": 35.844,
  "at": "2026-10-24T05:18:53.136406"
}
```

### clone-layerfs-wsl

```json
{
  "label": "clone-layerfs-wsl",
  "timeout": 110,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "105",
    "bash",
    "-s"
  ],
  "stdin": "set -eu\ngit clone --no-hardlinks /mnt/c/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification /home/yifan/layerfs-428-verification\ngit -C /home/yifan/layerfs-428-verification checkout --detach 3c21c62c6edf800d3aabb8ecd83620a75ecf7084\ngit -C /home/yifan/layerfs-428-verification status --short\n",
  "exit_code": 0,
  "elapsed_s": 14.875,
  "at": "2026-10-24T05:19:21.277693"
}
```

### clone-plugin

```json
{
  "command": "git clone https://github.com/Ephemeral-AI-Lab/dsh-layerfs.git ../dsh-layerfs",
  "timeout_s": 110,
  "exit_code": 0,
  "elapsed_s": 4.906,
  "at": "2026-10-24T05:17:42.660496"
}
```

### collect-report-evidence

```json
{
  "label": "collect-report-evidence",
  "timeout": 110,
  "args": [
    "python",
    "C:/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify/collect.py"
  ],
  "exit_code": 0,
  "elapsed_s": 2.641,
  "at": "2026-10-24T05:26:01.412142"
}
```

### configure-default-profile

```json
{
  "label": "configure-default-profile",
  "timeout": 30,
  "args": [
    "node",
    "--input-type=module",
    "-e",
    "import fs from 'node:fs'; import path from 'node:path';\nconst p=path.join(process.env.USERPROFILE,'.dsh/profiles/web');\nconst file=path.join(p,'package.json');const pkg=JSON.parse(fs.readFileSync(file,'utf8'));\npkg.dependencies['dsh-layerfs']='link:C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs/packages/dsh-layerfs';\nfs.writeFileSync(file,JSON.stringify(pkg,null,2)+'\\n');\nconst link=path.join(p,'node_modules/dsh-layerfs');\nif(!fs.lstatSync(link).isSymbolicLink())throw Error('Expected existing plugin junction');\nconsole.log('Previous junction:',fs.readlinkSync(link));fs.unlinkSync(link);\nfs.symlinkSync('C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs/packages/dsh-layerfs',link,'junction');\nconst patch=path.join(p,'cordis.patch.yml');let text=fs.readFileSync(patch,'utf8');\ntext=text.replace('sha256:0751d2c2245af1c311a24565c63f73378eed5f08fa39be7a68da2193192b0c51','sha256:9781a93410ef8f32b0b4ceaa99bd9ff33b731958d2a0aee4a7e2fe7717877863').replace('/home/yifan/dsh-layerfs-wsl/build','/home/yifan/.cache/layerfs-worktrees/layerfs-428-verification-c2c22458d2d3/artifacts/build-linux-e068b8575eaf4c4cb34dde4d356ca072').replace('containerPrefix: layerfs-windows-','containerPrefix: layerfs-');\nfs.writeFileSync(patch,text);console.log('Plugin junction and layerfs-host settings updated; other patch entries preserved.');"
  ],
  "exit_code": 0,
  "elapsed_s": 0.046,
  "at": "2026-10-24T05:22:42.168182"
}
```

### export-bundle-evidence

```json
{
  "label": "export-bundle-evidence",
  "timeout": 30,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "25",
    "bash",
    "-s"
  ],
  "stdin": "set -eu\nr=/home/yifan/.cache/layerfs-worktrees/layerfs-428-verification-c2c22458d2d3\nout=/mnt/c/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify\ncp \"$r/artifacts/build-linux-e068b8575eaf4c4cb34dde4d356ca072/manifest.json\" \"$out/bundle-manifest.json\"\ncp \"$r/resources.json\" \"$out/linux-resources.json\"\ncp \"$r/builds/build-linux-e068b8575eaf4c4cb34dde4d356ca072/output.log\" \"$out/linux-build-output.log\"\npython3 /home/yifan/layerfs-428-verification/tools/cleanup.py check\n",
  "exit_code": 0,
  "elapsed_s": 0.688,
  "at": "2026-10-24T05:25:17.660024"
}
```

### failed-session-agents

```json
{
  "label": "failed-session-agents",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-fa9c9fc6-0392-47df-9f41-7c845d7d83b2"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.062,
  "at": "2026-10-24T05:47:22.388951"
}
```

### failed-session-checkpoints

```json
{
  "label": "failed-session-checkpoints",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-398224c2-317d-4090-92b3-822502eb0968"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.062,
  "at": "2026-10-24T05:47:22.434082"
}
```

### failed-session-conflicts

```json
{
  "label": "failed-session-conflicts",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-f3f60148-36bb-4f84-bb01-a8f41d377f12"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.047,
  "at": "2026-10-24T05:47:22.374633"
}
```

### failed-session-crew

```json
{
  "label": "failed-session-crew",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-99a5d1f8-8f5a-48c9-8448-d5e9391c2496"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.062,
  "at": "2026-10-24T05:47:22.432082"
}
```

### failed-session-depot

```json
{
  "label": "failed-session-depot",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-1f058590-32f7-41f7-92f1-01054847b6c3"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.046,
  "at": "2026-10-24T05:47:22.423568"
}
```

### failed-session-merge

```json
{
  "label": "failed-session-merge",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-baea6a46-1d21-43b0-b38e-a1a549377a21"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.063,
  "at": "2026-10-24T05:47:22.370634"
}
```

### failed-session-parallel

```json
{
  "label": "failed-session-parallel",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-7664600f-60fc-43fd-b116-7560dc4de0e2"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.063,
  "at": "2026-10-24T05:47:22.370634"
}
```

### failed-session-sandbox

```json
{
  "label": "failed-session-sandbox",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-b94d77c3-464a-4134-90d1-79b743dc9313"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.047,
  "at": "2026-10-24T05:47:22.389958"
}
```

### failed-session-shop

```json
{
  "label": "failed-session-shop",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-bc10d629-d1b4-4c38-b8f3-ae9bc3dcd1cc"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.062,
  "at": "2026-10-24T05:47:22.414062"
}
```

### failed-session-tour

```json
{
  "label": "failed-session-tour",
  "timeout": 120,
  "args": [
    "node",
    "tools/checks/run.mjs",
    "C:/Users/yifan/.dsh/profiles/web",
    "session-87de4d51-2f60-47b5-a957-f93bfdd1c565"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.078,
  "at": "2026-10-24T05:47:02.450131"
}
```

### git-bash-capabilities

```json
{
  "label": "git-bash-capabilities",
  "timeout": 30,
  "args": [
    "E:/Git/bin/bash.exe",
    "-c",
    "command -v node; command -v jq; command -v timeout; command -v cygpath; node --version"
  ],
  "exit_code": 0,
  "elapsed_s": 0.109,
  "at": "2026-10-24T05:27:56.567822"
}
```

### inventory

```json
{
  "command": "git config --get core.autocrlf; git -C ../deepseek-harness rev-parse HEAD; git -C ../deepseek-harness status --short; Get-Content ../deepseek-harness/package.json -TotalCount 45; Get-ChildItem $env:USERPROFILE/.dsh -Force | Select-Object Name; wsl -d Ubuntu -- bash -lc uname",
  "timeout_s": 110,
  "exit_code": 0,
  "elapsed_s": 10.703,
  "at": "2026-10-24T05:17:35.905359"
}
```

### native-cli-final-01

```json
{
  "label": "native-cli-final-01",
  "timeout": 120,
  "args": [
    "node",
    "packages/host/tests/windows-cli.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 0,
  "elapsed_s": 0.688,
  "at": "2026-10-24T05:46:41.243178"
}
```

### native-cli-sandbox-01

```json
{
  "label": "native-cli-sandbox-01",
  "timeout": 120,
  "args": [
    "node",
    "C:/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify/native-cli-sandbox.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 1.266,
  "at": "2026-10-24T05:44:32.911353"
}
```

### native-cli-sandbox-02

```json
{
  "label": "native-cli-sandbox-02",
  "timeout": 120,
  "args": [
    "node",
    "C:/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify/native-cli-sandbox.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 0.234,
  "at": "2026-10-24T05:44:39.664575"
}
```

### native-cli-sandbox-03

```json
{
  "label": "native-cli-sandbox-03",
  "timeout": 120,
  "args": [
    "node",
    "C:/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify/native-cli-sandbox.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 0.188,
  "at": "2026-10-24T05:44:54.741444"
}
```

### native-cli-sandbox-04

```json
{
  "label": "native-cli-sandbox-04",
  "timeout": 120,
  "args": [
    "node",
    "C:/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify/native-cli-sandbox.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 0.187,
  "at": "2026-10-24T05:45:02.067050"
}
```

### native-cli-sandbox-05

```json
{
  "label": "native-cli-sandbox-05",
  "timeout": 120,
  "args": [
    "node",
    "C:/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify/native-cli-sandbox.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 0.187,
  "at": "2026-10-24T05:45:36.844184"
}
```

### native-cli-sandbox-06

```json
{
  "label": "native-cli-sandbox-06",
  "timeout": 120,
  "args": [
    "node",
    "C:/Users/yifan/AppData/Local/Temp/layerfs-428-20261024-verify/native-cli-sandbox.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 0,
  "elapsed_s": 0.703,
  "at": "2026-10-24T05:46:07.039073"
}
```

### native-host-tests-01

```json
{
  "label": "native-host-tests-01",
  "timeout": 120,
  "args": [
    "node",
    "packages/host/tests/host.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 0.688,
  "at": "2026-10-24T05:42:53.376590"
}
```

### native-host-tests-02

```json
{
  "label": "native-host-tests-02",
  "timeout": 120,
  "args": [
    "node",
    "packages/host/tests/host.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 1.609,
  "at": "2026-10-24T05:43:02.839081"
}
```

### native-sdk-launcher-01

```json
{
  "label": "native-sdk-launcher-01",
  "timeout": 120,
  "args": [
    "node",
    "packages/mock/tests/windows-shell.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 0,
  "elapsed_s": 0.343,
  "at": "2026-10-24T05:43:28.725343"
}
```

### native-windows-cli-01

```json
{
  "label": "native-windows-cli-01",
  "timeout": 120,
  "args": [
    "node",
    "packages/host/tests/windows-cli.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 1,
  "elapsed_s": 0.469,
  "at": "2026-10-24T05:42:37.951692"
}
```

### native-windows-cli-02

```json
{
  "label": "native-windows-cli-02",
  "timeout": 120,
  "args": [
    "node",
    "packages/host/tests/windows-cli.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "exit_code": 0,
  "elapsed_s": 0.687,
  "at": "2026-10-24T05:42:47.318373"
}
```

### npm-api-install

```json
{
  "label": "npm-api-install",
  "timeout": 110,
  "args": [
    "cmd.exe",
    "/d",
    "/c",
    "npm install"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification/api",
  "exit_code": 0,
  "elapsed_s": 7.609,
  "at": "2026-10-24T05:20:00.792595"
}
```

### npm-cli-install

```json
{
  "label": "npm-cli-install",
  "timeout": 110,
  "args": [
    "cmd.exe",
    "/d",
    "/c",
    "npm --prefix api/agent/cli install"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
  "exit_code": 0,
  "elapsed_s": 1.781,
  "at": "2026-10-24T05:20:20.383390"
}
```

### patched-linux-mock-tests

```json
{
  "label": "patched-linux-mock-tests",
  "timeout": 120,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "110",
    "/usr/local/bin/node",
    "/mnt/c/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs/packages/mock/tests/mock.mjs"
  ],
  "exit_code": 0,
  "elapsed_s": 1.282,
  "at": "2026-10-24T05:31:28.376162"
}
```

### patched-mock-tests-01

```json
{
  "label": "patched-mock-tests-01",
  "timeout": 120,
  "args": [
    "node",
    "packages/mock/tests/mock.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 0.703,
  "at": "2026-10-24T05:29:47.901216"
}
```

### patched-mock-tests-02

```json
{
  "label": "patched-mock-tests-02",
  "timeout": 120,
  "args": [
    "node",
    "packages/mock/tests/mock.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 0.672,
  "at": "2026-10-24T05:30:15.264879"
}
```

### patched-mock-tests-03

```json
{
  "label": "patched-mock-tests-03",
  "timeout": 120,
  "args": [
    "node",
    "packages/mock/tests/mock.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 0,
  "elapsed_s": 0.703,
  "at": "2026-10-24T05:30:59.456992"
}
```

### patched-windows-shell-01

```json
{
  "label": "patched-windows-shell-01",
  "timeout": 120,
  "args": [
    "node",
    "packages/mock/tests/windows-shell.mjs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 0,
  "elapsed_s": 0.531,
  "at": "2026-10-24T05:29:48.782684"
}
```

### pin-layerfs-windows

```json
{
  "label": "pin-layerfs-windows",
  "timeout": 110,
  "args": [
    "git",
    "checkout",
    "--detach",
    "3c21c62c6edf800d3aabb8ecd83620a75ecf7084"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
  "exit_code": 0,
  "elapsed_s": 0.656,
  "at": "2026-10-24T05:19:06.057149"
}
```

### pin-plugin

```json
{
  "command": "git -C ../dsh-layerfs checkout --detach 56fc353",
  "timeout_s": 110,
  "exit_code": 0,
  "elapsed_s": 4.39,
  "at": "2026-10-24T05:17:51.923929"
}
```

### plugin-build

```json
{
  "label": "plugin-build",
  "timeout": 110,
  "args": [
    "cmd.exe",
    "/d",
    "/c",
    "pnpm build"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 0,
  "elapsed_s": 2.781,
  "at": "2026-10-24T05:20:37.758703"
}
```

### plugin-install

```json
{
  "label": "plugin-install",
  "timeout": 110,
  "args": [
    "cmd.exe",
    "/d",
    "/c",
    "pnpm install"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 0,
  "elapsed_s": 2.656,
  "at": "2026-10-24T05:20:27.854045"
}
```

### plugin-pin-check

```json
{
  "label": "plugin-pin-check",
  "timeout": 110,
  "args": [
    "cmd.exe",
    "/d",
    "/c",
    "pnpm run check:layerfs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 0,
  "elapsed_s": 0.359,
  "at": "2026-10-24T05:20:38.479028"
}
```

### prepare-linux

```json
{
  "label": "prepare-linux",
  "timeout": 118,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "--signal=INT",
    "--kill-after=8",
    "110",
    "bash",
    "-s"
  ],
  "stdin": "set -eu\ncd /home/yifan/layerfs-428-verification\nexport CARGO_NET_RETRY=0 LAYERFS_CONSTRUCTION_WORKERS=1\nexec python3 tools/worktree.py prepare --resources /home/yifan/.cache/layerfs-worktrees/layerfs-428-verification-c2c22458d2d3/resources.json --platform linux\n",
  "exit_code": 0,
  "elapsed_s": 5.797,
  "at": "2026-10-24T05:19:52.837301"
}
```

### profile-plugin-add

```json
{
  "label": "profile-plugin-add",
  "timeout": 110,
  "args": [
    "cmd.exe",
    "/d",
    "/c",
    "pnpm --dir C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness dsh plugin --profile web add link:C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs/packages/dsh-layerfs"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 10.75,
  "at": "2026-10-24T05:22:03.042854"
}
```

### register-linux

```json
{
  "label": "register-linux",
  "timeout": 110,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "105",
    "bash",
    "-s"
  ],
  "stdin": "set -eu\ncd /home/yifan/layerfs-428-verification\npython3 -B core/tools/check_fuser_integrity.py\npython3 tools/worktree.py register --worktree /home/yifan/layerfs-428-verification --owner issue428-windows-verification-20261024 --build-image rust:1.85.1-bookworm --runtime-image layerfs-428-verification:node24 --sandbox-image layerfs-428-verification:node24\n",
  "exit_code": 0,
  "elapsed_s": 0.375,
  "at": "2026-10-24T05:19:41.325140"
}
```

### runtime-image-build

```json
{
  "label": "runtime-image-build",
  "timeout": 115,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "110",
    "bash",
    "-s"
  ],
  "stdin": "set -eu\ndf -B1 /var/lib/docker\ndocker build -t layerfs-428-verification:node24 /mnt/c/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs/tools/runtime\ndocker image inspect --format '{{.Id}}' layerfs-428-verification:node24\n",
  "exit_code": 0,
  "elapsed_s": 4.187,
  "at": "2026-10-24T05:19:30.057739"
}
```

### shell-resolution-diagnostic

```json
{
  "label": "shell-resolution-diagnostic",
  "timeout": 30,
  "args": [
    "node",
    "--import",
    "tsx/esm",
    "--input-type=module",
    "-e",
    "import {resolvePwshPath} from './packages/shell/pwsh-local/src/resolve.ts';import {existsSync} from 'node:fs';import {join} from 'node:path';console.log(JSON.stringify({shell:resolvePwshPath(),layerfsCandidates:process.env.PATH.split(';').flatMap(p=>['layerfs.exe','layerfs.cmd','layerfs.bat','layerfs'].map(n=>join(p,n))).filter(existsSync),shimDirectoryOnParentPath:process.env.PATH.includes('dsh-layerfs\\\\packages\\\\host\\\\src\\\\bin'),scope:'parent environment, not a scenario agent'},null,2));"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness",
  "exit_code": 0,
  "elapsed_s": 0.078,
  "at": "2026-10-24T05:24:55.483900"
}
```

### shell-source-diagnostic

```json
{
  "label": "shell-source-diagnostic",
  "timeout": 30,
  "args": [
    "node",
    "--input-type=module",
    "-e",
    "import { resolvePwshPath } from './packages/shell/pwsh-local/lib/resolve.js'; import {existsSync} from 'node:fs'; import {join} from 'node:path';const path=process.env.PATH;console.log(JSON.stringify({shell:resolvePwshPath(),pluginShimOnPath:path.split(';').some(x=>x.includes('dsh-layerfs')&&x.endsWith('bin')),layerfsCandidates:path.split(';').flatMap(p=>['layerfs.exe','layerfs.cmd','layerfs.bat','layerfs'].map(n=>join(p,n))).filter(existsSync),path},null,2));"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness",
  "exit_code": 1,
  "elapsed_s": 0.031,
  "at": "2026-10-24T05:24:33.469419"
}
```

### start-dsh-web

```json
{
  "label": "start-dsh-web",
  "timeout": 30,
  "args": [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "$ErrorActionPreference='Stop'; if(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue){throw '3080 already owned'}; $out=Join-Path $env:TEMP 'layerfs-428-20261024-verify/dsh-web.stdout.log'; $err=Join-Path $env:TEMP 'layerfs-428-20261024-verify/dsh-web.stderr.log'; $proc=Start-Process -FilePath 'cmd.exe' -ArgumentList '/d /c pnpm --dir C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness dsh web --no-open --port 3080' -WorkingDirectory 'C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs' -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru; $proc.Id | Set-Content (Join-Path $env:TEMP 'layerfs-428-20261024-verify/dsh-web.pid'); Write-Output \"Started PID $($proc.Id)\""
  ],
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 0,
  "elapsed_s": 0.953,
  "at": "2026-10-24T05:22:53.953512"
}
```

### start-patched-dsh-web

```json
{
  "label": "start-patched-dsh-web",
  "timeout": 30,
  "args": [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "$ErrorActionPreference='Stop'; $out=Join-Path $env:TEMP 'layerfs-428-20261024-verify/patched-web.stdout.log'; $err=Join-Path $env:TEMP 'layerfs-428-20261024-verify/patched-web.stderr.log'; $proc=Start-Process -FilePath 'cmd.exe' -ArgumentList '/d /c pnpm --dir C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness dsh web --no-open --port 3080' -WorkingDirectory 'C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs' -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru; $proc.Id | Set-Content (Join-Path $env:TEMP 'layerfs-428-20261024-verify/patched-web.pid'); Write-Output \"Started PID $($proc.Id)\""
  ],
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 0,
  "elapsed_s": 0.25,
  "at": "2026-10-24T05:30:16.375156"
}
```

### stop-owned-web-for-scenario-fix

```json
{
  "label": "stop-owned-web-for-scenario-fix",
  "timeout": 30,
  "args": [
    "taskkill",
    "/PID",
    "6832",
    "/T",
    "/F"
  ],
  "exit_code": 0,
  "elapsed_s": 0.141,
  "at": "2026-10-24T05:30:15.743260"
}
```

### test-plugin

```json
{
  "label": "test-plugin",
  "timeout": 120,
  "args": [
    "cmd.exe",
    "/d",
    "/c",
    "pnpm test"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 0.484,
  "at": "2026-10-24T05:20:44.047746"
}
```

### test-windows

```json
{
  "label": "test-windows",
  "timeout": 120,
  "args": [
    "cmd.exe",
    "/d",
    "/c",
    "pnpm run test:windows"
  ],
  "cwd": "C:/Users/yifan/code/Ephemeral-AI-Lab/dsh-layerfs",
  "env": {
    "LAYERFS_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/layerfs-428-verification",
    "DSH_SOURCE": "C:/Users/yifan/code/Ephemeral-AI-Lab/deepseek-harness"
  },
  "exit_code": 1,
  "elapsed_s": 1.234,
  "at": "2026-10-24T05:20:43.185802"
}
```

### web-readiness

```json
{
  "label": "web-readiness",
  "timeout": 65,
  "args": [
    "node",
    "--input-type=module",
    "-e",
    "const end=Date.now()+60000;while(Date.now()<end){try{const r=await fetch('http://127.0.0.1:3080',{signal:AbortSignal.timeout(1500)});console.log('HTTP',r.status);process.exit(0)}catch{} await new Promise(r=>setTimeout(r,2000));}console.error('No HTTP listener within 60 s readiness window');process.exit(1)"
  ],
  "exit_code": 0,
  "elapsed_s": 8.125,
  "at": "2026-10-24T05:23:26.125656"
}
```

### windows-bash-prerequisites

```json
{
  "label": "windows-bash-prerequisites",
  "timeout": 30,
  "args": [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "Get-Command git,bash,jq -ErrorAction SilentlyContinue | Select-Object Name,Source; Test-Path 'C:/Program Files/Git/bin/bash.exe'; & 'C:/Program Files/Git/bin/bash.exe' -c 'command -v node; command -v jq; command -v timeout; node --version'"
  ],
  "exit_code": 1,
  "elapsed_s": 0.469,
  "at": "2026-10-24T05:27:46.982373"
}
```

### wsl-info

```json
{
  "command": "wsl -d Ubuntu -- bash -lc 'uname -a; id; command -v node python3 docker; node --version; python3 --version; ls -l /dev/fuse; docker version; df -h /; ls -d ~/code/* ~/.cache/layerfs-worktrees/* 2>/dev/null'\n",
  "timeout_s": 110,
  "exit_code": 1,
  "elapsed_s": 6.672,
  "at": "2026-10-24T05:18:09.221030"
}
```

### wsl-storage-detail

```json
{
  "label": "wsl-storage-detail",
  "timeout": 110,
  "args": [
    "wsl",
    "-d",
    "Ubuntu",
    "--",
    "timeout",
    "105",
    "bash",
    "-s"
  ],
  "stdin": "set -eu\ndocker ps -a --format '{{.ID}} {{.Names}} {{.Status}}'\nfindmnt -T /var/lib/docker\ndf -B1 /var/lib/docker\nls -la /home/yifan\ncat ~/.cache/layerfs-worktrees/layerfs-35da0b81b957/resources.json\n",
  "exit_code": 0,
  "elapsed_s": 7.047,
  "at": "2026-10-24T05:18:57.874596"
}
```

### wsl-storage

```json
{
  "command": "wsl -d Ubuntu -- bash -lc 'docker context inspect default; docker info --format \"{{.DockerRootDir}}\"; docker images --no-trunc; docker ps -a --format \"{{.ID}} {{.Names}} {{.Status}}\"; findmnt -T /var/lib/docker; df -B1 /var/lib/docker; ls -la /home/yifan; cat ~/.cache/layerfs-worktrees/layerfs-35da0b81b957/resources.json'\n",
  "timeout_s": 110,
  "exit_code": 0,
  "elapsed_s": 0.562,
  "at": "2026-10-24T05:18:17.887102"
}
```
