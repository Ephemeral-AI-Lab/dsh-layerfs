// PR #42 review fixes: New machine opens while a VM platform still needs setup,
// Doctor tabs keep their problem marks, a Sandbox page's Refresh reads the
// Sandbox again, and the Doctor head counts a stopped machine as stopped.
//   node --test test/pr42-review-fixes.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = (path) => readFileSync(join(root, path), 'utf8')
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-pr42-'))
after(() => rmSync(out, { recursive: true, force: true }))

const file = join(out, 'entry.mjs')
await build({
  stdin: { contents: "export { canAddMachine } from './src/client/machines/model.ts'", resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'silent',
  external: ['react', 'react-dom', 'clsx', '@deepseek-ai/*'],
})
const M = await import(pathToFileURL(file).href)

const platform = (name, how, ready, missing = []) => ({ platform: name, how, ready, missing })

test('New machine opens while a VM platform still needs its install or setup', () => {
  // Lima not installed yet: the dialog is where its install step shows
  assert.equal(M.canAddMachine([platform('host', 'built-in', true), platform('lima', 'created', false, ['lima'])]), true)
  assert.equal(M.canAddMachine([platform('apple-container', 'created', true)]), true)
  // only built-ins (or a platform the host leaves out): nothing to create
  assert.equal(M.canAddMachine([platform('host', 'built-in', true), platform('docker', 'built-in', true)]), false)
  assert.equal(M.canAddMachine([]), false)
  for (const path of ['src/client/storage/StoragePage.tsx', 'src/client/storage/HomeOverview.tsx']) {
    assert.match(src(path), /canAddMachine\(fleet\.platforms\)/, path)
    assert.doesNotMatch(src(path), /p\.ready && !p\.missing\.length/, path)
  }
})

test('Doctor tabs keep a mark for a problem, a notice or a stopped machine, not only a running check', () => {
  const bar = src('src/client/ui/TabBar.tsx')
  assert.match(bar, /\{x\.tone \? <span className=\{css\.dot\}/)
  assert.doesNotMatch(bar, /x\.tone === 'ongoing' \? <span className=\{css\.dot\}/)
})

test('a Sandbox page passes the global Refresh to its sandbox read', () => {
  assert.match(src('src/client/machines/SandboxDetail.tsx'), /useSandboxRead\(name, listed\?\.state, listed\?\.workspaces, refreshKey\)/)
})

test('a disabled New session menu item gives its reason through MenuItemButton', () => {
  const table = src('src/client/storage/ProjectTable.tsx')
  assert.match(table, /<MenuItemButton disabled=\{!!blockedSession\} disabledReason=\{blockedSession\}/)
  assert.doesNotMatch(table, /<span title=\{blockedSession\}>/)
})
