// The runtime-context block a LayerFS project session's agent reads (src/host/sessions/prompt.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'dsh-layerfs-prompt-'))
await build({ stdin: { contents: "export * from './src/host/sessions/prompt.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(root, 'prompt.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
const { projectContext } = await import(pathToFileURL(join(root, 'prompt.mjs')))

const bound = { project: 'acme/app', machine: 'docker', branch: 'dsh.abc', sandbox: 'dsh-abc', ws: 'dsh-abc:main', scratch: '/tmp/scratch' }

test('names every project setting with its value and variable', () => {
  const text = projectContext(bound, { checkpoints: true })
  assert.match(text, /^## LayerFS project session/)
  assert.match(text, /\*\*not\*\* in the local working directory/)
  for (const [value, variable] of [['"acme/app"', '$DSH_LAYERFS_PROJECT'], ['"dsh-abc:main"', '$DSH_LAYERFS_WS'], ['"dsh.abc"', '$DSH_LAYERFS_BRANCH']]) {
    const row = text.split('\n').find((line) => line.includes(variable) && line.startsWith('|'))
    assert.ok(row?.includes(value), `${variable} row shows ${value}: ${row}`)
  }
  assert.match(text, /\| Machine \| "docker" \|/)
  assert.match(text, /\$DSH_LAYERFS_CLI` \/ `\$DSH_LAYERFS_SDK/)
  assert.match(text, /Load the `dsh-layerfs` skill before your first LayerFS call/)
  assert.match(text, /with `file` calls on the session Branch/)
  assert.match(text, /mount, exec, commit, unmount/)
  assert.match(text, /relative to the Workspace root, never its mount path/)
  assert.match(text, /\| Session Sandbox [^|]*\| "dsh-abc" \|/)
  assert.match(text, /never exec in, commit or unmount dsh's Workspace/)
  assert.doesNotMatch(text, /workspace exec "\$DSH_LAYERFS_WS"/)
  assert.match(text, /never read, write or `cd` into them directly/)
  assert.doesNotMatch(text, /checkpoint controls/)
})

test('a main agent and a subagent are told different checkpoint and sharing rules', () => {
  const main = projectContext(bound, { checkpoints: true })
  const sub = projectContext(bound, { checkpoints: true, subagent: true })
  assert.match(main, /At the end of every turn in which it moved/)
  assert.match(main, /\*\*Subagents\*\* you start share/)
  assert.match(sub, /Your own turns record none/)
  assert.match(sub, /\*\*You are a subagent:\*\*/)
  assert.doesNotMatch(sub, /At the end of every turn/)
})

test('missing values read as not set, and checkpoints off is said', () => {
  const text = projectContext({ project: 'acme/app', scratch: '/s' }, { checkpoints: false })
  assert.match(text, /\| \(not running\) \|/)
  assert.match(text, /\| \(not mounted yet\) \|/)
  assert.match(text, /\| Machine \| \(unknown\)/)
  assert.match(text, /Checkpoints are off/)
})

test('the Sandbox falls back to the Workspace handle', () => {
  assert.match(projectContext({ ...bound, sandbox: undefined }, { checkpoints: true }), /\| Session Sandbox [^|]*\| "dsh-abc" \|/)
})
