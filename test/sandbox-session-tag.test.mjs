// The project Sandboxes tab's quiet **Session** tag, rendered through the
// small hook runtime in mini-react.mjs: a Sandbox a project binding owns gets
// the tag with its one tooltip sentence; one with no binding gets nothing.
//   node --test test/sandbox-session-tag.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-sandbox-session-tag-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { SessionTag } from './src/client/storage/parts.tsx'",
      "export { locales as storageLocales } from './src/client/storage/locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'tag.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'tag.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const tOf = (dict, lang) => (key, vars) => fill(dict[lang][key] ?? key, vars)
const t = tOf(M.storageLocales, 'en')

test('Session tag: a session-owned Sandbox gets one quiet tag with its tooltip; any other gets none', () => {
  const owned = M.mount(M.SessionTag, { sessionId: 'session-own', t })
  const tag = M.elements(owned.tree).find((e) => e.props?.['data-session-owned'] === 'session-own')
  assert.ok(tag, 'the tag names the owning session')
  assert.equal(M.text(tag), 'Session')
  assert.equal(tag.props.title, 'This Sandbox belongs to one conversation and is removed when it closes.')
  assert.equal(owned.tree.props['data-session-owned'], 'session-own')
  assert.match(String(owned.tree.props.className ?? ''), /sessionTag/)
  assert.equal(M.mount(M.SessionTag, { t }).tree, null, 'no binding: no tag, and no empty element')
  assert.equal(M.mount(M.SessionTag, { sessionId: '', t }).tree, null, 'an empty id is no owner')
})

test('Session tag: the words are in both dictionaries', () => {
  assert.equal(M.storageLocales.en.sessionOwned, 'Session')
  assert.equal(M.storageLocales.zh.sessionOwned, '会话')
  for (const lang of ['en', 'zh']) assert.ok(M.storageLocales[lang].sessionOwnedTitle, `${lang}.sessionOwnedTitle`)
})
