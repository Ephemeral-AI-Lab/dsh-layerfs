// The fix lines LayerFS's doctor now emits (layerfs-project#159), against the
// page's allow list (`runnableFix`, `parseFix`, `chainFix` in src/shared/doctor.ts):
// a line is a button only when the page can run it or open its dialog; a line with
// a `<...>` placeholder, a daemon path, a restore, a move or a read stays text to copy.
//   node --test --test-timeout=60000 test/doctor-fixes-159.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'dsh-doctor-fixes-159-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export * from './src/shared/doctor.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'doctor.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning',
})
const W = await import(pathToFileURL(join(out, 'doctor.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const copyOnly = (line) => {
  assert.equal(W.runnableFix(line), null, line)
  assert.equal(W.parseFix(line), null, line)
  assert.equal(W.chainFix(line), null, line)
}

test('a record fix and a read the page runs or opens', () => {
  assert.deepEqual(W.runnableFix('layerfs machine remove old'), { kind: 'removeMachine', machine: 'old' })
  assert.equal(W.removesSomething(W.runnableFix('layerfs machine remove old')), true)
  assert.deepEqual(W.runnableFix('layerfs machine doctor docker'), { kind: 'doctor', machine: 'docker' })
  assert.deepEqual(W.runnableFix('layerfs sandbox remove exp-1'), { kind: 'removeSandbox', sandbox: 'exp-1' })
  assert.equal(W.removesSomething(W.runnableFix('layerfs sandbox remove exp-1')), true, 'it loses uncommitted Workspace changes: it asks a second press')
  assert.deepEqual(W.runnableFix('layerfs machine stop m1 && layerfs machine start m1'), { kind: 'restart', machine: 'm1' })
  assert.equal(W.parseFix('layerfs machine stop m1 && layerfs machine start m1').kind, 'restart')
})

test('a connect line opens its dialog, which never takes a secret from the line', () => {
  assert.deepEqual(W.runnableFix('layerfs store connect pg postgres://h/db --user app --password-stdin'), { kind: 'connection', store: 'pg' })
  assert.deepEqual(W.runnableFix('layerfs store connect pg <url>'), { kind: 'connection', store: 'pg' })
  assert.deepEqual(W.runnableFix('layerfs store connect pg <url> --user <user> --password-stdin'), { kind: 'connection', store: 'pg' })
  assert.deepEqual(W.runnableFix('layerfs backup connect bk https://acct.r2.example.com/bk --access-key AKIA --key-stdin'), { kind: 'connectBucket', bucket: 'bk', url: 'https://acct.r2.example.com/bk' })
  assert.deepEqual(W.runnableFix("layerfs backup connect bk 'r2://a/b' --access-key 'k 1' --key-stdin"), { kind: 'connectBucket', bucket: 'bk', url: 'r2://a/b' })
})

test('a line with a placeholder where the name or the address is stays text', () => {
  copyOnly('layerfs backup connect bk <url> --access-key <key> --key-stdin')
  copyOnly('layerfs backup connect <bucket> <url> --access-key <key> --key-stdin')
  copyOnly('layerfs store connect <s> <url> --user <user> --password-stdin')
  copyOnly('layerfs machine remove <m>')
  copyOnly('layerfs machine doctor <m>')
  copyOnly('layerfs sandbox remove <x>')
  copyOnly('layerfs backup restore <bucket> <file> st')
  copyOnly('layerfs backup restore <bucket> <file> <store>')
})

test('a restore, a move, a daemon update and a live read stay text to copy', () => {
  copyOnly('layerfs backup restore bk store-2026.tar st')
  copyOnly('layerfs store move st m2')
  copyOnly('layerfs machine update native --daemon /usr/local/bin/layerfsd')
  copyOnly("layerfs machine update native --daemon '/opt/my dir/layerfsd'")
  copyOnly('layerfs sandbox doctor exp-1')
  copyOnly('layerfs store get st --with live')
})

test('no chain makes a button of a line the page cannot run in every step', () => {
  copyOnly('layerfs machine stop m1 && layerfs store move st m1')
  copyOnly('layerfs machine stop m1 --force && layerfs machine start m1')
  copyOnly('layerfs machine remove old && layerfs machine remove <m>')
  copyOnly('layerfs sandbox doctor x && layerfs sandbox remove x')
  assert.equal(W.runnableFix('layerfs store remove s && layerfs machine remove m').kind, 'chain')
})
