// A small hook runtime for behaviour tests of client components without a DOM
// (RV4 NOTE 12/13: drive the component, do not match its source text).
// `react` and `react/jsx-runtime` resolve to MINI_REACT below; react-dom, clsx
// and the DSH packages are stubbed with exactly the names each importer uses.
// A component is called with its props; its JSX comes back as plain
// `{ type, props }` elements (function components inside it are not called),
// its effects run after each render, and a state change asks for a re-render.
import { readFileSync } from 'node:fs'

const MINI_REACT = `
export const Fragment = Symbol.for('mini.fragment')
export function jsx(type, props, key) { return { type, props: props ?? {}, key } }
export const jsxs = jsx
export const createElement = (type, props, ...children) => jsx(type, { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) })
let cur = null
const slot = () => { if (!cur) throw new Error('a hook outside mount()'); return cur.i++ }
export function useState(init) {
  const c = cur, i = slot()
  if (!(i in c.s)) c.s[i] = typeof init === 'function' ? init() : init
  return [c.s[i], (v) => { const next = typeof v === 'function' ? v(c.s[i]) : v; if (!Object.is(next, c.s[i])) { c.s[i] = next; c.dirty = true } }]
}
export function useReducer(reducer, init) { const [s, set] = useState(init); return [s, (a) => set((x) => reducer(x, a))] }
export function useRef(v) { const c = cur, i = slot(); if (!(i in c.s)) c.s[i] = { current: v }; return c.s[i] }
export function useEffect(fn, deps) {
  const c = cur, i = slot(), prev = c.s[i]
  if (!prev || !deps || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]))) c.fx.push({ at: i, fn })
  c.s[i] = deps ?? []
}
export const useLayoutEffect = useEffect
export function useCallback(fn, deps) {
  const c = cur, i = slot(), prev = c.s[i]
  if (!prev || !deps || deps.length !== prev[1].length || deps.some((d, k) => !Object.is(d, prev[1][k]))) c.s[i] = [fn, deps ?? []]
  return c.s[i][0]
}
export const useMemo = (fn) => fn()
export const useId = () => 'mini-id'
export const useSyncExternalStore = (_subscribe, get) => get()
export const createContext = (value) => ({ value })
export const useContext = (context) => context?.value
export const memo = (c) => c
export const startTransition = (fn) => fn()

/** Mounts a function component: render() calls it again; effects run after each render. */
export function mount(Component, props) {
  const c = { s: [], i: 0, fx: [], dirty: false, props, tree: null, cleanups: [], unmounted: false }
  const render = (next) => {
    if (c.unmounted) throw new Error('render() after unmount()')
    if (next !== undefined) c.props = next
    cur = c; c.i = 0; c.fx = []; c.dirty = false
    try { c.tree = Component(c.props) } finally { cur = null }
    // Keep each effect's cleanup so unmount() can run it, as React does.
    for (const { at, fn } of c.fx) {
      const cleanup = fn()
      if (typeof cleanup === 'function') c.cleanups[at] = cleanup
      else delete c.cleanups[at]
    }
    return c.tree
  }
  render()
  return {
    get tree() { return c.tree },
    get dirty() { return c.dirty },
    render,
    /** Lets pending promises settle, then renders again when a state changed. */
    async settle() { for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 0)); if (c.dirty) render(); return c.tree },
    /** Unmounts: runs every effect cleanup still in place (the latest run of each effect). */
    unmount() {
      if (c.unmounted) return
      c.unmounted = true
      const cleanups = c.cleanups
      c.cleanups = []
      for (const cleanup of cleanups) cleanup?.()
    },
  }
}

/** Every element in a tree (depth first), with its props. */
export function elements(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) elements(n, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  elements(node.props?.children, out)
  for (const [k, v] of Object.entries(node.props ?? {})) if (k !== 'children' && v && typeof v === 'object' && 'type' in v && 'props' in v) elements(v, out)
  return out
}
/** The text inside an element. */
export function text(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return text(node.props?.children)
}
`

/** esbuild plugin: the mini runtime for react, and per-importer stubs for react-dom, clsx and the DSH packages. */
export const miniReact = {
  name: 'mini-react',
  setup(b) {
    b.onResolve({ filter: /^react(\/jsx-runtime|\/jsx-dev-runtime)?$/ }, () => ({ path: 'mini-react', namespace: 'mini' }))
    b.onLoad({ filter: /.*/, namespace: 'mini' }, () => ({ contents: MINI_REACT, loader: 'js' }))
    b.onResolve({ filter: /^clsx$/ }, () => ({ path: 'clsx', namespace: 'mini-clsx' }))
    b.onLoad({ filter: /.*/, namespace: 'mini-clsx' }, () => ({ contents: 'export default function clsx(...a) { return a.flat().filter((x) => typeof x === \'string\' && x).join(\' \') }', loader: 'js' }))
    b.onResolve({ filter: /^(react-dom|@deepseek-ai\/.*)(\/.*)?$/ }, (a) => ({ path: `${a.path}|${a.importer}`, namespace: 'mini-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'mini-stub' }, (a) => {
      const [spec, importer] = a.path.split('|')
      const source = readFileSync(importer, 'utf8')
      const names = new Set()
      const quoted = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      for (const m of source.matchAll(new RegExp(`import\\s+(type\\s+)?([^'";]*?)\\s+from\\s+['"]${quoted}['"]`, 'g'))) {
        if (m[1]) continue
        const braces = /\{([^}]*)\}/.exec(m[2])
        for (const part of braces ? braces[1].split(',') : []) {
          const w = part.trim()
          if (!w || w.startsWith('type ')) continue
          names.add(w.split(/\s+as\s+/)[0].trim())
        }
      }
      // a stub component renders as an element named for it, so a test finds `Button` by its props
      const lines = ['const make = (name) => function Stub(props) { return { type: name, props: props ?? {} } }', 'export default make(\'default\')', ...[...names].map((n) => `export const ${n} = make(${JSON.stringify(n)})`)]
      return { contents: lines.join('\n'), loader: 'js' }
    })
  },
}
