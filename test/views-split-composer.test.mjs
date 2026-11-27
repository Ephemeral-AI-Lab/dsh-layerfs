// The split view's composer: a DSH pane shown beside a project session keeps
// its own composer when one of the LayerFS tabs is open. Files, History,
// Sandbox and Stats hide the composer only once `session.state` confirms the
// session is in a project (`binding` set); Loading, a failed read and a plain
// session leave it restorable. The audit Trajectory already gates this way.
//   node --test test/views-split-composer.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-views-split-composer-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount } from 'react'",
      "export { FilesView, HistoryView } from './src/client/views/FileViews.tsx'",
      "export { StatsView } from './src/client/views/StatsView.tsx'",
      "export { SandboxView } from './src/client/views/SandboxView.tsx'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'split-composer.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'split-composer.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

// `useRootState` polls every 10 s while visible; these mounts never wait that
// long, and visibility is safe.
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms, ...rest) => (ms === 10_000 ? 0 : realSetInterval(fn, ms, ...rest))
globalThis.document = { visibilityState: 'hidden' }
test.after(() => { globalThis.setInterval = realSetInterval; delete globalThis.document })

const t = (key) => key
const storageT = (key) => key
const VIEWS = [
  ['FilesView', M.FilesView],
  ['HistoryView', M.HistoryView],
  ['StatsView', M.StatsView],
  ['SandboxView', M.SandboxView],
]

/** A fake LayerfsApi answering `session.state`; `onEvent` keeps the views quiet. */
function harness(answer) {
  const reads = []
  return {
    reads,
    api: {
      op: async (name, args) => {
        reads.push({ name, sessionId: args.sessionId })
        return { sessionId: args.sessionId, ...answer }
      },
      onEvent: () => () => {},
    },
  }
}

/** The composer seam: records hides and returns a release that records itself. */
function composer() {
  const hides = []
  const releases = []
  const hideComposer = () => {
    hides.push(hideComposer)
    return () => releases.push(1)
  }
  return { hideComposer, hides, releases }
}

// Each mount gets its own session: `useQuery` keeps the last `session.state`
// answer for a cache key (`session.state:<root>`) across mounts, as it must
// for a tab switch, so sharing an id would seed a mount with another's answer.
function propsOf(api, hideComposer, sessionId) {
  return { api, sessionId, t, storageT, sessions: undefined, hideComposer }
}

for (const [name, View] of VIEWS) {
  test(`${name}: a session with no project binding keeps the split view's composer`, async () => {
    const { api, reads } = harness({ binding: null, project: null })
    const { hideComposer, hides, releases } = composer()
    const view = M.mount(View, propsOf(api, hideComposer, `session-plain-${name}`))
    await view.settle()
    assert.equal(reads.length, 1, 'the view read its session once')
    assert.equal(reads[0].name, 'session.state')
    assert.equal(hides.length, 0, 'a plain session (or one still loading) does not hide the composer')
    // A re-render with the same answer still does not.
    view.render()
    assert.equal(hides.length, 0)
    view.unmount()
    assert.equal(releases.length, 0, 'no hide, so nothing to release')
  })

  test(`${name}: a confirmed project binding hides the composer once and releases on unmount`, async () => {
    const { api } = harness({ binding: { kind: 'project', project: 'p', branch: 'dsh.x' }, project: 'p' })
    const { hideComposer, hides, releases } = composer()
    const view = M.mount(View, propsOf(api, hideComposer, `session-project-${name}`))
    await view.settle()
    assert.equal(hides.length, 1, 'a project session hides the composer')
    view.render()
    assert.equal(hides.length, 1, 'a re-render with the same answer does not hide it twice')
    assert.equal(releases.length, 0)
    view.unmount()
    assert.equal(releases.length, 1, 'unmounting releases the composer')
  })
}
