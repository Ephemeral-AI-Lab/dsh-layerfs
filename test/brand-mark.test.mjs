// One LayerFS mark, one definition for its two brand inks: the glyph's tones
// live in ui/brand.module.css on body (so the rail follows DSH's theme), the
// Sandbox hub draws that same component, and no other client file carries a
// brand hex. Mounted through mini-react like test/workspace-terminal-header.
//   node --test test/brand-mark.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const client = join(root, 'src', 'client')
const brandRel = 'src/client/ui/brand.module.css'
const brandFile = join(root, brandRel)
const BRAND_HEX = /#(?:93B1E0|2F5BB5)/i

mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-brand-mark-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { LayerfsGlyph } from './src/client/overview/glyph.tsx'",
      "export * as marks from './src/client/views/marks.tsx'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'brand-mark.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'brand-mark.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, files)
    else files.push(full)
  }
  return files
}

const find = (tree, pred) => M.elements(tree).filter(pred)
const paths = (tree) => find(tree, (e) => e.type === 'path')
const circles = (tree) => find(tree, (e) => e.type === 'circle')
const svgOf = (view) => find(view.tree, (e) => e.type === 'svg')[0]

test('the two brand inks exist only in ui/brand.module.css, declared on body so the rail follows the theme', () => {
  const holders = walk(client)
    .filter((file) => BRAND_HEX.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file))
    .sort()
  assert.deepEqual(holders, [brandRel], 'the brand hexes are defined once; every other file names the --lfs-* inks instead')

  const css = readFileSync(brandFile, 'utf8')
  assert.match(css, /:global\(body\)\s*\{/, 'declared on body: DSH declares --dsw-alias-label-primary on body, not :root')
  assert.match(css, /--lfs-light:\s*#93B1E0\s*;/)
  assert.match(css, /--lfs-dark:\s*color-mix\(in oklab, #2F5BB5 82%, var\(--dsw-alias-label-primary, #000\)\)\s*;/)
})

test('LayerfsGlyph draws the mark in the two brand inks: the A light, the rail dark', () => {
  const view = M.mount(M.LayerfsGlyph, {})
  const svg = svgOf(view)
  assert.equal(svg.props.width, 16)
  assert.equal(svg.props.height, 16)
  assert.equal(svg.props.viewBox, '6 6 188 188')
  assert.equal(svg.props['aria-hidden'], 'true')
  assert.equal(svg.props.focusable, 'false')

  const [a, rail] = paths(view.tree)
  assert.equal(paths(view.tree).length, 2)
  assert.equal(a.props.style.fill, 'var(--lfs-light)')
  assert.equal(a.props.style.stroke, 'var(--lfs-light)')
  assert.equal(a.props.style.fillOpacity, 1, 'the A is opaque in colour')
  assert.equal(a.props.strokeWidth, '2')
  assert.equal(rail.props.style.stroke, 'var(--lfs-dark)')
  assert.equal(rail.props.style.fill, undefined, 'the rail path is a stroke, not a fill')
  assert.equal(rail.props.strokeWidth, '10.5')

  assert.equal(circles(view.tree).length, 3)
  for (const node of circles(view.tree)) assert.equal(node.props.style.fill, 'var(--lfs-dark)')
})

test('mono uses currentColor for both tones, and a string size lands on the svg (the hub passes 56%)', () => {
  const mono = M.mount(M.LayerfsGlyph, { mono: true })
  const [a, rail] = paths(mono.tree)
  assert.equal(a.props.style.fill, 'currentColor')
  assert.equal(a.props.style.stroke, 'currentColor')
  assert.equal(a.props.style.fillOpacity, 0.45)
  assert.equal(rail.props.style.stroke, 'currentColor')
  for (const node of circles(mono.tree)) assert.equal(node.props.style.fill, 'currentColor')

  const hub = M.mount(M.LayerfsGlyph, { size: '56%', className: 'hub-mark' })
  const svg = svgOf(hub)
  assert.equal(svg.props.width, '56%')
  assert.equal(svg.props.height, '56%')
  assert.equal(svg.props.className, 'hub-mark')
})

test('the Sandbox hub draws LayerfsGlyph, and marks.tsx no longer exports a second mark', () => {
  assert.equal('LayerfsMark' in M.marks, false, 'LayerfsMark must be gone, not a second copy')
  assert.equal(typeof M.marks.Whale, 'function', 'the whale illustration stays')

  const sandbox = readFileSync(join(client, 'views', 'SandboxView.tsx'), 'utf8')
  assert.match(sandbox, /import \{ LayerfsGlyph \} from '\.\.\/overview\/glyph\.tsx'/)
  assert.match(sandbox, /<LayerfsGlyph size="56%" \/>/)
  assert.doesNotMatch(sandbox, /LayerfsMark/)
})
