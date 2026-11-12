// The Doctor job list's per-report summary, which the Overview's Health grid
// reads instead of each full report.
//   node --test test/doctor-summary.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { testHost } from './routes-helper.mjs'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(tmpdir(), 'dsh-doctor-summary-'))
await build({ absWorkingDir: root, entryPoints: ['src/host/routes/doctor.ts'], outfile: join(out, 'doctor.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning' })
const { DoctorManager, summarize } = await import(pathToFileURL(join(out, 'doctor.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const report = (over = {}) => ({ ok: true, complete: true, truncated: false, counts: {}, mode: 'quick', operation: 'integrity', target: { kind: 'store', name: 's1' }, findings: [], checks: [], ...over })

test('summarize counts findings, failed checks, unverified and skipped checks', () => {
  const s = summarize(report({
    ok: false,
    complete: false,
    findings: [{ severity: 'error', message: 'bad header', fix: 'layerfs store pull s1' }, { severity: 'warning', message: 'stale lease' }],
    checks: [
      { id: 'a', outcome: 'fail', severity: 'error', message: 'bad header' },
      { id: 'b', outcome: 'fail', severity: 'error', message: 'second' },
      { id: 'c', outcome: 'pass', message: 'ok' },
      { id: 'd', outcome: 'skipped', message: 'quick' },
      { id: 'e', outcome: 'unknown', message: 'deadline' },
    ],
  }))
  assert.deepEqual(s, {
    ok: false, complete: false, mode: 'quick', errors: 2, warnings: 1, unverified: 1, skipped: 1,
    findings: [{ severity: 'error', message: 'bad header', fix: 'layerfs store pull s1' }, { severity: 'warning', message: 'stale lease', fix: null }],
  })
})

test('summarize falls back to failed checks when a report names no findings', () => {
  const s = summarize(report({ ok: false, checks: [{ id: 'x', outcome: 'fail', severity: 'warning', message: 'slow', fix: 'retry' }] }))
  assert.equal(s.warnings, 1)
  assert.deepEqual(s.findings, [{ severity: 'warning', message: 'slow', fix: 'retry' }])
  assert.deepEqual(summarize(null), { ok: false, complete: false, mode: null, errors: 0, warnings: 0, unverified: 0, skipped: 0, findings: [] })
})

test('the job list carries a summary for each kept report, never the report', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-home-'))
  try {
    const { host } = testHost({ lfs: { spec: {} }, root: home, home, discovery: async () => ({ identity: { version: 't' }, commands: ['doctor store integrity'] }) })
    const run = async () => report({ findings: [{ severity: 'warning', message: 'stale lease' }] })
    const doctor = new DoctorManager(host, run)
    const job = await doctor.launch({ target: 'store.integrity', name: 's1', quick: true, key: 'k1' })
    for (let i = 0; i < 50 && doctor.get(job.id).state !== 'completed'; i++) await new Promise((r) => setTimeout(r, 10))
    const [listed] = doctor.list()
    assert.equal(listed.state, 'completed')
    assert.equal(listed.report, undefined)
    assert.equal(listed.hasReport, true)
    assert.equal(listed.summary.warnings, 1)
    assert.equal(listed.summary.mode, 'quick')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
