import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoreSizes } from '../src/host/routes/store-sizes.ts'

test('a Store whose machine does not answer keeps its last read size, marked stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-sizes-'))
  try {
    let now = 1000
    const sizes = new StoreSizes(dir, () => now)
    const size = { bytes: 300, file: 200, wal: 100 }
    assert.deepEqual(sizes.answer([{ name: 'a', size }, { name: 'b', size: null }]), [size, null])
    now = 5000
    assert.deepEqual(sizes.answer([{ name: 'a', size: null }]), [{ ...size, seen: 1000, stale: true }])
    // a restart reads the kept file
    const again = new StoreSizes(dir, () => now)
    assert.deepEqual(again.answer([{ name: 'a', size: null }]), [{ ...size, seen: 1000, stale: true }])
    // a Store no longer listed is forgotten
    again.answer([{ name: 'c', size: null }])
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'store-sizes.json'), 'utf8')), {})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
