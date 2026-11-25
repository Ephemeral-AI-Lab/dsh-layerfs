#!/usr/bin/env node
// Build both faces: the host ESM plugin (lib/index.js) and the browser
// closure-factory bundle (lib/client.js) in the format dsh-client-modules
// serves: window.__ModuleLoader__.load({ id, factory: (require) => exports }).
import { build, context, stop } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'

import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const watch = process.argv.includes('--watch')
// Where every built file goes: `lib` (what the package serves), or DSH_LAYERFS_OUTDIR (absolute, or relative to the
// package root) to build beside a running server without touching the `lib/` it serves.
const outdir = resolve(root, process.env.DSH_LAYERFS_OUTDIR || 'lib')

// Shell-seeded platform modules plus runtime rows the client must share (packages/client/web/src/platform.ts).
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const hostOptions = {
  absWorkingDir: root,
  entryPoints: { index: 'src/host/index.ts', 'sandbox-policy': 'src/host/sandbox-policy.ts', 'session-persistence': 'src/host/session-persistence.ts', skills: 'src/host/skills.ts' },
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  external: ['@deepseek-ai/*', 'zod', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  logLevel: 'warning',
}

/** Wrap the CJS client output into the module-loader handoff and inject compiled CSS. */
const wrapClient = {
  name: 'dsh-client-wrap',
  setup(b) {
    b.onEnd(async (result) => {
      if (result.errors.length) return
      const files = result.outputFiles ?? []
      const js = files.find((f) => f.path.endsWith('client.js'))
      const css = files.find((f) => f.path.endsWith('client.css'))
      if (!js) return
      const style = css && css.text.trim()
        ? `(function(){if(typeof document==='undefined')return;var id=${JSON.stringify(pkg.name + '/client.css')};if(document.querySelector('style[data-plugin-css="'+id+'"]'))return;var t=document.createElement('style');t.dataset.plugin=${JSON.stringify(pkg.name)};t.dataset.pluginCss=id;t.textContent=${JSON.stringify(css.text)};document.head.appendChild(t);})();\n`
        : ''
      const out = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${style}${js.text}\n\t\treturn module.exports;\n\t}\n});\n`
      await mkdir(outdir, { recursive: true })
      await writeFile(join(outdir, 'client.js'), out)
    })
  },
}

const clientOptions = {
  absWorkingDir: root,
  entryPoints: { client: 'src/client/index.tsx' },
  outdir,
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.css': 'css', '.svg': 'text' },
  external: CLIENT_EXTERNALS,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  plugins: [wrapClient],
}

/**
 * Always let esbuild's service process exit with this script. The service is a
 * child process: when the wrapper is killed (a timeout, a cancelled agent step,
 * a disposed test shell) an undisposed service is orphaned, re-parented to PID 1
 * and — in a container whose PID 1 is `dsh web`, which has no reaper — stays a
 * zombie for the container's whole life. Repeated builds then fill the process
 * table and every full /proc scan (DSH's subprocess runner does one per 15 ms
 * poll) gets slower.
 */
async function shutDown(contexts = []) {
  for (const ctx of contexts) await ctx.dispose().catch(() => {})
  await stop().catch(() => {})
  // `stop()` asks the service to exit but does not wait for it: if this process
  // exits first, the service is re-parented (PID 1 here is `dsh web`, which
  // reaps nothing) and stays a zombie. On Linux /proc lists our children, so
  // wait for that list to drain before returning.
  try {
    const children = `/proc/self/task/${process.pid}/children`
    for (let i = 0; i < 60; i++) {
      if (!readFileSync(children, 'utf8').trim()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } catch { /* not Linux: nothing to wait on */ }
}

if (watch) {
  const host = await context(hostOptions)
  const client = await context(clientOptions)
  await Promise.all([host.watch(), client.watch()])
  console.log('watching')
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => { void shutDown([host, client]).finally(() => process.exit(0)) })
  }
} else {
  // Faces build independently: a broken one does not block the other.
  const only = process.argv.includes('--host') ? ['host'] : process.argv.includes('--client') ? ['client'] : ['host', 'client']
  const results = await Promise.allSettled(only.map((face) => build(face === 'host' ? hostOptions : clientOptions)))
  const failed = only.filter((_, i) => results[i].status === 'rejected')
  console.log(`built ${only.filter((f) => !failed.includes(f)).join(' + ') || 'nothing'}${failed.length ? `; FAILED: ${failed.join(', ')}` : ''}`)
  if (failed.length) process.exitCode = 1
  await shutDown()
}
