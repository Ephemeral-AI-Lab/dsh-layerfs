// Unit tests for UI-197 (SQLite Backup & Restore):
// replaceRefusal branches, needsNewFileName / actionOf / storeBackups,
// StoreBackups & BackupsDialog rendering, and host backupAndWait custom filename.
//   node --test test/backup-restore-ui.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-backup-restore-ui-'))

const stubPlugin = {
  name: 'ui197-test-stubs',
  setup(b) {
    b.onResolve({ filter: /^@deepseek-ai\/.*$/ }, (a) => ({ path: `${a.path}|${a.importer}`, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
      const [spec, importer] = a.path.split('|')
      const text = readFileSync(importer, 'utf8')
      const names = new Set()
      const quoted = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      for (const m of text.matchAll(new RegExp(`import\\s+(type\\s+)?([^'";]*?)\\s+from\\s+['"]${quoted}['"]`, 'g'))) {
        if (m[1]) continue
        const braces = /\{([^}]*)\}/.exec(m[2])
        for (const part of braces ? braces[1].split(',') : []) {
          const w = part.trim()
          if (!w || w.startsWith('type ')) continue
          names.add(w.split(/\s+as\s+/)[0].trim())
        }
      }
      const rich = {
        Button: `({ variant, size, type = 'button', icon, children, className, title, 'aria-label': ariaLabel, 'aria-disabled': ariaDisabled, 'aria-describedby': ariaDescribedBy, disabled }) => createElement('button', { type, 'data-variant': variant, className, title, 'aria-label': ariaLabel, 'aria-disabled': ariaDisabled ? 'true' : undefined, 'aria-describedby': ariaDescribedBy, disabled: !!disabled }, icon, children)`,
        Tooltip: `({ label, disabled, children }) => createElement('span', { 'data-tooltip-disabled': disabled ? 'true' : 'false', 'data-tooltip-label': label }, children)`,
        Modal: `({ open, title, description, children }) => open ? createElement('div', { role: 'dialog', 'aria-label': title, 'data-description': description }, children) : null`,
        StateDot: `({ state }) => createElement('span', { 'data-state-dot': state })`,
        Input: `({ value, placeholder }) => createElement('input', { value, placeholder })`,
        relativeTime: `() => '2m ago'`,
      }
      const lines = [
        `import { createElement } from 'react'`,
        `const fallback = ({ children }) => createElement('span', null, children)`,
        `export default fallback`,
        ...[...names].map((n) => `export const ${n} = ${rich[n] ?? 'fallback'}`),
      ]
      return { contents: lines.join('\n'), loader: 'js' }
    })

    const stubHooks = {
      'machines/context.tsx': `export const useMachinesContext = () => ({ api: { call: async () => ({}) }, useMachines: (s) => s({ data: null, loading: false, error: null }), t: (k) => k }); export const useMachinesMaybe = () => null`,
      'ui/use-query.ts': `export const useQuery = () => ({ data: undefined, loading: false, error: null, reload: () => {} })`,
      'storage/hooks.ts': `export const useHostEvents = () => {}`,
      'projects/hooks.ts': `export const useProjectSessions = () => ({ data: null })`,
    }
    b.onResolve({ filter: /^\.\.?\/.*$/ }, (a) => {
      const resolved = join(a.resolveDir, a.path).replace(/\\/g, '/')
      for (const k of Object.keys(stubHooks)) {
        if (resolved.endsWith(`src/client/${k}`)) return { path: k, namespace: 'hook-stub' }
      }
    })
    b.onLoad({ filter: /.*/, namespace: 'hook-stub' }, (a) => ({ loader: 'js', contents: stubHooks[a.path] }))
  },
}

await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export { replaceRefusal } from './src/client/storage/dialogs.tsx'
      export { actionOf, needsNewFileName, storeBackups, freshName } from './src/client/storage/store-backups.ts'
      export { StoreBackups } from './src/client/storage/StoreLinks.tsx'
      export { BackupsDialog } from './src/client/storage/BackupDialogs.tsx'
      export { locales } from './src/client/storage/locale.ts'
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: join(out, 'ui197.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.module.css': 'local-css', '.css': 'css' },
  plugins: [stubPlugin],
  logLevel: 'error',
})

await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/host/routes/storage.ts')],
  outfile: join(out, 'host-storage.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  logLevel: 'error',
})

const M = await import(pathToFileURL(join(out, 'ui197.mjs')).href)
const { Storage } = await import(pathToFileURL(join(out, 'host-storage.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const makeT = (lang) => (key, vars) => fill(M.locales[lang][key] ?? key, vars)
const tEn = makeT('en')
const tZh = makeT('zh')

const makeStore = (name, over = {}) => ({
  name, kind: 'sqlite', machine: 'native', state: 'ready',
  projects: ['app'], projectsCount: 1, size: { bytes: 8192 },
  links: [{ bucket: 'lab', file: `${name}`, last: { op: 'backup', at: 1000, bytes: 8192 } }],
  ownConnections: [], ...over,
})

const noopActions = () => ({
  push: () => {}, pull: () => {}, move: () => {}, backup: () => {}, backupPick: () => {},
  backupTo: () => {}, restore: () => {}, remove: () => {}, disconnect: () => {}, start: () => {},
  addProject: () => {}, editConnection: () => {}, check: () => {}, connectMachine: () => {},
  removeOwn: () => {}, newOnServer: () => {}, retry: () => {}, dismiss: () => {}, openMachine: () => {},
})

test('replaceRefusal covers every refusal reason and allows current / bucket_changed', () => {
  const ready = makeStore('notes')
  assert.match(M.replaceRefusal(makeStore('remote', { machine: 'docker' }), 'current', 'lab', tEn, { listed: true }), /pull it to LayerFS Home first/)
  assert.match(M.replaceRefusal(makeStore('notes', { state: 'busy' }), 'current', 'lab', tEn, { listed: true }), /is busy/)
  assert.match(M.replaceRefusal(makeStore('notes', { state: 'blocked', blockedBy: { machine: 'docker', reason: 'stopped' } }), 'current', 'lab', tEn, { listed: true }), /is not ready: Start machine docker first/)
  assert.match(M.replaceRefusal(ready, 'current', 'lab', tEn, { listed: true, heldBy: ['held-box'] }), /held by Sandbox held-box/)
  assert.match(M.replaceRefusal(ready, 'current', 'other-bucket', tEn, { listed: true }), /has no link to other-bucket/)
  assert.match(M.replaceRefusal(ready, undefined, 'lab', tEn, { listed: false }), /has not been listed yet/)
  assert.match(M.replaceRefusal(ready, undefined, 'lab', tEn, { listed: false, bucketError: { code: 'AuthFailed', message: '403' } }), /could not be listed/)
  assert.match(M.replaceRefusal(ready, 'missing', 'lab', tEn, { listed: true, file: 'gone-copy' }), /gone-copy is missing from lab/)
  assert.match(M.replaceRefusal(ready, 'unknown', 'lab', tEn, { listed: true }), /could not verify whether notes changed/)
  assert.match(M.replaceRefusal(ready, undefined, 'lab', tEn, { listed: true }), /could not verify whether notes changed/)
  assert.match(M.replaceRefusal(ready, 'store_changed', 'lab', tEn, { listed: true }), /changed since its last transfer/)
  assert.match(M.replaceRefusal(ready, 'both_changed', 'lab', tEn, { listed: true }), /changed since its last transfer/)

  assert.equal(M.replaceRefusal(ready, 'bucket_changed', 'lab', tEn, { listed: true }), null)
  assert.equal(M.replaceRefusal(ready, 'current', 'lab', tEn, { listed: true }), null)
  assert.match(M.replaceRefusal(ready, undefined, 'lab', tZh, { listed: false }), /尚未列出内容/)
})

test('actionOf, needsNewFileName, and storeBackups handle conflict, bucket_changed, and bucket errors', () => {
  assert.equal(M.actionOf('both_changed'), 'again')
  assert.equal(M.actionOf('missing'), 'again')
  assert.equal(M.actionOf('store_changed'), 'update')
  assert.equal(M.actionOf('bucket_changed'), 'restore')
  assert.equal(M.needsNewFileName('missing'), true)
  assert.equal(M.needsNewFileName('both_changed'), true)
  assert.equal(M.needsNewFileName('bucket_changed'), true)
  assert.equal(M.needsNewFileName('store_changed'), false)
  assert.equal(M.needsNewFileName('current'), false)
  assert.equal(M.needsNewFileName(undefined), false)

  const store = makeStore('notes')
  const rows = M.storeBackups(store, [{
    name: 'lab', provider: 'minio', url: 's3://lab', files: null,
    error: { code: 'Unreachable', message: 'connection refused' },
  }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].bucketError?.code, 'Unreachable')
  assert.equal(rows[0].bucketError?.message, 'connection refused')
})

test('StoreBackups renders unlisted dashed pill, disabled Restore reason, missing without Restore, and conflict actions', () => {
  const s = makeStore('notes', {
    links: [
      { bucket: 'unlisted-b', file: 'notes', last: { op: 'backup', at: 1000, bytes: 4096 } },
      { bucket: 'missing-b', file: 'gone', last: { op: 'backup', at: 1000, bytes: 4096 } },
      { bucket: 'conflict-b', file: 'div', last: { op: 'backup', at: 1000, bytes: 4096 } },
    ],
  })
  const view = {
    stores: [s], machines: [], buckets: [
      { name: 'unlisted-b', provider: 'minio', url: 's3://u', files: null },
      { name: 'missing-b', provider: 'minio', url: 's3://m', files: [{ file: 'gone', store: 'notes', missing: true }] },
      { name: 'conflict-b', provider: 'minio', url: 's3://c', files: [{ file: 'div', store: 'notes', behind: true, changed: true, missing: false, bytes: 4096 }] },
    ],
    jobs: [], auths: [],
  }
  const html = renderToStaticMarkup(createElement(M.StoreBackups, {
    store: s, view, t: tEn, now: 2000, on: noopActions(), onOpen: () => {}, onListBucket: () => {},
  }))
  assert.match(html, /data-dashed="true"[^>]*>Not listed</)
  assert.match(html, /List the bucket first to check this backup before restoring/)
  assert.match(html, /Back up as new file…/)
  const missingCard = html.slice(html.indexOf('data-backup-link="missing-b"'), html.indexOf('data-backup-link="conflict-b"'))
  assert.doesNotMatch(missingCard, /Restore…/)
  const conflictCard = html.slice(html.indexOf('data-backup-link="conflict-b"'))
  assert.match(conflictCard, /Back up as new file…/)
  assert.match(conflictCard, /Restore…/)
})

test('BackupsDialog renders conflict dual actions and accessible disabled reasons when blocked', () => {
  const s = makeStore('div', {
    state: 'blocked', blockedBy: { machine: 'docker', reason: 'stopped' },
    links: [{ bucket: 'lab', file: 'div', last: { op: 'backup', at: 1000, bytes: 4096 } }],
  })
  const view = {
    stores: [s], machines: [],
    buckets: [{ name: 'lab', provider: 'minio', url: 's3://lab', files: [{ file: 'div', store: 'div', behind: true, changed: true, missing: false, bytes: 4096 }] }],
    jobs: [], auths: [],
  }
  const html = renderToStaticMarkup(createElement(M.BackupsDialog, {
    api: { call: async () => ({}) }, t: tEn, view, store: 'div', onClose: () => {}, done: () => {}, onDialog: () => {},
  }))
  assert.match(html, /Back up as new file…/)
  assert.match(html, /Restore…/)
  assert.match(html, /Start machine docker first/)
  assert.match(html, /Back up to another bucket/)
  assert.match(html, /aria-disabled="true"/)
})

test('host Storage.backupAndWait preserves custom linked file name', async () => {
  const calls = []
  const lfs = {
    store: {
      get: async (store) => ({ store, backups: [{ bucket: 'other', file: 'wrong' }, { bucket: 'lab', file: 'custom-v2' }] }),
    },
    backup: {
      create: async (store, bucket, opts) => { calls.push({ store, bucket, file: opts.file }); return { ok: true } },
      list: async () => ({ files: [] }),
    },
  }
  const svc = new Storage({
    home: join(out, 'home'),
    jobs: join(out, 'jobs'),
    stats: join(out, 'stats'),
    lfs: () => lfs,
    emit: () => {},
    log: () => {},
  })
  await svc.backupAndWait('custom-name', 'lab')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { store: 'custom-name', bucket: 'lab', file: 'custom-v2' })
})

test('host Storage: a reconnect drops the running listing and lists again with the new key', async () => {
  const gates = []
  let lists = 0
  const lfs = {
    backup: {
      list: () => { lists++; return new Promise((resolve) => gates.push(resolve)) },
      connect: async () => ({ outcome: 'rotated' }),
    },
    store: { list: async () => ({ items: [] }) },
  }
  const svc = new Storage({ home: join(out, 'home-relist'), jobs: join(out, 'jobs-relist'), stats: join(out, 'stats-relist'), lfs: () => lfs, emit: () => {}, log: () => {} })
  svc.view = async () => ({})
  const first = svc.listBucket('lab')
  void svc.listBucket('lab', { force: true }) // a relist asked behind the running one
  await svc.connectBucket({ name: 'lab', url: 'http://minio:9000/lab', accessKey: 'a', secretKey: 'b' })
  assert.equal(lists, 2, 'the reconnect starts a fresh listing at once')
  gates[0]({ items: [{ bucket: 'lab', file: 'old-key' }] })
  await first
  gates[1]({ items: [{ bucket: 'lab', file: 'new-key' }] })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(lists, 2, 'the dropped relist does not fire again later')
  assert.deepEqual(svc.listings.get('lab').items.map((i) => i.file), ['new-key'], 'the old key\'s answer is dropped')
})
