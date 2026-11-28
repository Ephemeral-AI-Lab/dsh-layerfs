// The prepared machine image cache reaches every LayerFS CLI as XDG_CACHE_HOME:
// the host's own spawn (cli.ts) and the managed CLI agents run (tracing.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('the cache home is passed as XDG_CACHE_HOME, and left alone when unset', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-image-cache-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  await build({ stdin: { contents: "export { execute } from './src/host/layerfs/cli.ts'; export { managedCli } from './src/host/layerfs/tracing.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(directory, 'cli.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
  const { execute, managedCli } = await import(pathToFileURL(join(directory, 'cli.mjs')))
  const binary = join(directory, 'fake-cli.mjs'), cache = join(directory, 'cache'), home = join(directory, 'home')
  mkdirSync(cache); mkdirSync(home)
  writeFileSync(binary, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ xdg: process.env.XDG_CACHE_HOME ?? null, root: process.env.LAYERFS_ROOT ?? null }))\n`, { mode: 0o700 })

  // the CLI gets the home's root (LAYERFS_ROOT): <directory>/home lives in <directory>
  const root = directory
  assert.deepEqual(await execute({ cli: binary, home, cacheHome: cache }, ['machine', 'list'], {}), { xdg: cache, root })
  assert.deepEqual(await execute({ cli: binary, home }, ['machine', 'list'], { env: { XDG_CACHE_HOME: '/host/cache' } }), { xdg: '/host/cache', root }, 'unset: the host value passes through')

  const managed = managedCli({ root: join(directory, 'root'), cli: binary, home, cacheHome: cache })
  const run = spawnSync(managed, ['machine', 'list'], { encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: '/host/cache' } })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout), { xdg: cache, root })
})
