// Regressions from the phone pass (#48), driven through the components:
//  - the nav bar's crumb strip scrolls to its end only when the path changes, not on
//    every re-render (a 15 s poll, a job's progress) that hands it a new crumbs array;
//  - the History fork-base row is highlighted by the current selection only, not by
//    the deep link it was opened with;
//  - the History lanes spread to 34 px at rest and 40 px zoomed with a mouse, and to
//    48 px only on the touch layout (the media condition of src/client/ui/responsive.css).
// Each test fails on fb09854 and passes after the fix.
//   node --test test/ui-regressions-pr48.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-ui-pr48-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements } from 'react'",
      "export { NavBar } from './src/client/storage/Nav.tsx'",
      "export { ProjectHistory } from './src/client/files/ProjectHistory.tsx'",
      "export { HistoryGraph } from './src/client/files/HistoryGraph.tsx'",
      "export * as graph from './src/client/files/HistoryGraph.tsx'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'ui.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'ui.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

/** Stubs the browser globals a component touches in its effects; returns the restore. */
function browser() {
  const had = { window: globalThis.window, document: globalThis.document }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, querySelector: () => null }
  return () => {
    if (had.window === undefined) delete globalThis.window; else globalThis.window = had.window
    if (had.document === undefined) delete globalThis.document; else globalThis.document = had.document
  }
}

// ---------------------------------------------------------------- nav bar crumbs

test('nav bar: a re-render with the same path keeps a swiped crumb strip; a new path scrolls to its end', () => {
  const restore = browser()
  const history = { current: 'overview', canBack: false, canForward: false, open() {}, back() {}, forward() {}, forget() {} }
  const crumbs = () => [{ key: 'root', label: 'Home' }, { key: 'section:stores', label: 'Stores' }, { key: 'store:demo', label: 'demo', id: 'store:demo' }]
  const props = (list) => ({ t: (k) => k, history, crumbs: list, sessions: undefined, onSession() {}, jump: [], jobs: [], findings: [], refreshing: false, add: [], onOpen() {} })
  const view = M.mount(M.NavBar, props(crumbs()))
  try {
    const ol = M.elements(view.tree).find((e) => e.type === 'ol')
    assert.ok(ol?.props.ref, 'the crumb list has a ref')
    // The strip as a phone draws it: wider than the bar, swiped back to show an ancestor.
    const strip = { scrollLeft: 40, scrollWidth: 600 }
    ol.props.ref.current = strip
    view.render(props(crumbs())) // a poll: a new array, the same path
    assert.equal(strip.scrollLeft, 40, 'a re-render with the same crumbs must not snap the strip back')
    view.render(props([...crumbs(), { key: 'store:demo/p', label: 'p', id: 'store:demo/p' }]))
    assert.equal(strip.scrollLeft, 600, 'a new page scrolls the strip to its end')
  } finally { view.unmount(); restore() }
})

// ---------------------------------------------------------------- History fork-base row

const C0 = `c0${'0'.repeat(62)}`, C1 = `c1${'1'.repeat(62)}`
const commit = (id, parent) => ({ id, branch: 'main', message: `m-${id.slice(0, 2)}`, at: null, parent })

/** A host with main (C0 ← C1) and an empty Branch `feat` still at its fork point C1. */
function historyApi() {
  const calls = []
  return {
    calls,
    call: async (method, path) => {
      calls.push(path)
      if (path.includes('commit=')) return { item: { ...commit(C1, C0), sourceBranch: 'main' }, changes: [], nextChanges: null }
      if (path.includes('count=1')) return { head: C1, count: 0 }
      if (path.includes('branch=main')) return { items: [commit(C1, C0), commit(C0, null)], next: null, head: C1 }
      return { branches: [{ name: 'main', head: C1, base: C0, forkedFrom: null }, { name: 'feat', head: C1, base: C1, forkedFrom: C1 }], next: null }
    },
    op: async () => ({}),
    onEvent: () => () => {},
  }
}
const forkRow = (tree) => M.elements(tree).find((e) => e.type === 'button' && e.props.title?.endsWith(`· ${C1}`))

test('History: a deep link at the fork point highlights its row only while it is the selection', async () => {
  const restore = browser()
  const api = historyApi()
  const view = M.mount(M.ProjectHistory, { api, project: 's/p', t: (k) => k, initialBranch: 'feat', initialCommit: C1, exportChip: false })
  try {
    let tree = await view.settle()
    tree = await view.settle()
    const row = forkRow(tree)
    assert.ok(row, 'the empty Branch shows its fork-base row')
    assert.equal(row.props['data-selected'], true, 'the deep-linked fork point is selected')
    assert.equal(row.props['aria-current'], 'true')
    // Another Commit is selected while the empty Branch stays open.
    const graphEl = M.elements(tree).find((e) => e.type === M.HistoryGraph)
    assert.ok(graphEl, 'the graph is drawn')
    graphEl.props.onSelect(C0, 'feat')
    tree = view.render()
    const after = forkRow(tree)
    assert.ok(after, 'the fork-base row is still shown')
    assert.equal(after.props['data-selected'], undefined, 'the row is no longer selected once another Commit is')
    assert.equal(after.props['aria-current'], undefined)
    // Pressing the row selects it again.
    after.props.onClick()
    tree = view.render()
    assert.equal(forkRow(tree).props['data-selected'], true)
  } finally { view.unmount(); restore() }
})

// ---------------------------------------------------------------- History lane gap

test('History lanes: 34 px at rest and 40 px zoomed with a mouse; 48 px only on the touch layout', () => {
  const { laneGap, TOUCH_QUERY } = M.graph
  assert.equal(typeof laneGap, 'function', 'the lane gap is one function the graph uses')
  // A tall pane with three lanes: the height alone would spread them past every cap.
  assert.equal(laneGap(900, 3, 0, false), 34, 'desktop at rest stops at GAP_MAX')
  assert.equal(laneGap(900, 3, 26, false), 40, 'desktop zoomed all the way in stops at GAP_ZOOMED')
  assert.equal(laneGap(900, 3, 0, true), 48, 'touch at rest spreads to 48')
  assert.equal(laneGap(900, 3, 26, true), 48, 'touch zoomed spreads to 48')
  // A short pane keeps the floor on both.
  assert.equal(laneGap(60, 9, 0, false), 16)
  assert.equal(laneGap(60, 9, 0, true), 16)
  // The touch layout is the one the plugin's touch tokens use.
  const responsive = readFileSync(join(root, 'src/client/ui/responsive.css'), 'utf8')
  assert.ok(responsive.includes(`@media ${TOUCH_QUERY} {`), `responsive.css switches its touch tokens on ${TOUCH_QUERY}`)
  const tsx = readFileSync(join(root, 'src/client/files/HistoryGraph.tsx'), 'utf8')
  assert.match(tsx, /const gap = laneGap\(size\.height, lanes, cam\.k, touch\)/, 'the graph draws with that gap')
})
