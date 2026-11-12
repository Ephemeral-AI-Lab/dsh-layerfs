import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'

const source = readFileSync(new URL('../src/client/projects/read-deadline.ts', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node24' })
const { ReadDeadlineError, readWithDeadline } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('a stalled read settles at the UI deadline instead of leaving loading permanent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const read = readWithDeadline(new Promise(() => {}))
  const rejected = assert.rejects(read, ReadDeadlineError).then(() => { settled = true })
  t.mock.timers.tick(19_999)
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await rejected
})

test('a stalled project does not block another project read or replay the first read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let complete
  let starts = 0
  const original = new Promise((resolve) => { starts++; complete = resolve })
  const stalled = readWithDeadline(original)
  const rejected = assert.rejects(stalled, ReadDeadlineError)
  assert.deepEqual(await readWithDeadline(Promise.resolve(['another session'])), ['another session'])
  t.mock.timers.tick(20_000)
  await rejected
  complete(['late session'])
  assert.deepEqual(await original, ['late session'])
  assert.equal(starts, 1, 'a UI timeout neither restarts nor cancels the underlying operation')
  assert.deepEqual(await readWithDeadline(Promise.resolve(['retried read'])), ['retried read'])
})

test('a read refusal keeps its original error', async () => {
  const refusal = new Error('project unavailable')
  await assert.rejects(readWithDeadline(Promise.reject(refusal)), (error) => error === refusal)
})
