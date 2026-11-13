#!/usr/bin/env node
// Install the LayerFS Node SDK (`@layerfs/node` and its native addon) that project
// sessions get as `$DSH_LAYERFS_SDK`, from a sealed LayerFS build:
//
//   node scripts/install-sdk.mjs <sealed build dir> [--out <dir>]
//
// The build dir is what `python3 tools/worktree.py build --platform macos` prints in
// a LayerFS worktree of `layerfs_v2_0_0` (it holds manifest.json, layerfs.node and
// api/node/src). Every copied file is checked against the manifest's sha256. The SDK
// lands in `<out>/<commit>/` (default `.layerfs-sdk/` in this checkout, git-ignored);
// the host uses the one whose commit equals the pinned CLI's, so build it from the
// same `layerfs_v2_0_0` commit as the CLI (`layerfs --version --json`).
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const out = resolve(outAt >= 0 ? args.splice(outAt, 2)[1] : join(dirname(fileURLToPath(import.meta.url)), '..', '.layerfs-sdk'))
const [from] = args
if (!from || args.length !== 1) {
  console.error('usage: node scripts/install-sdk.mjs <sealed LayerFS build dir> [--out <dir>]')
  process.exit(2)
}
const build = resolve(from)
const manifest = JSON.parse(readFileSync(join(build, 'manifest.json'), 'utf8'))
const commit = manifest?.source?.head
if (manifest.status !== 'sealed' || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error(`${build}: not a sealed LayerFS build with a source commit`)
const hashes = new Map(Array.isArray(manifest.files) ? manifest.files : Object.entries(manifest.files ?? {}))
// The SDK itself: the addon, the package manifests (ESM "type") and its sources.
const wanted = [...hashes.keys()].filter((path) => path === 'layerfs.node' || path === 'api/package.json' || path === 'api/node/package.json' || /^api\/node\/src\/[^/]+$/.test(path))
for (const need of ['layerfs.node', 'api/node/package.json', 'api/node/src/index.js', 'api/node/src/native.js']) {
  if (!wanted.includes(need)) throw new Error(`${build}: the sealed build has no ${need}`)
}
const target = join(out, commit)
const staging = `${target}.${process.pid}.tmp`
rmSync(staging, { recursive: true, force: true })
for (const path of wanted) {
  const source = join(build, path)
  const sum = createHash('sha256').update(readFileSync(source)).digest('hex')
  if (sum !== hashes.get(path)) throw new Error(`${path}: sha256 ${sum} does not match the manifest`)
  mkdirSync(dirname(join(staging, path)), { recursive: true })
  copyFileSync(source, join(staging, path))
}
writeFileSync(join(staging, 'sdk.json'), JSON.stringify({
  commit, version: manifest.version, platform: manifest.platform, profile: manifest.profile,
  build: manifest.build_id ?? null, from: build, files: wanted.map((path) => [path, hashes.get(path)]),
}, null, 2) + '\n')
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
renameSync(staging, target)
console.log(`Installed the LayerFS Node SDK ${commit.slice(0, 10)} (${manifest.platform}, ${manifest.profile}) at ${target}`)
