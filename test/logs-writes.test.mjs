// The Logs page over the native call log: the default read asks for one page,
// "Only writes" finds every write (wherever it is in the log) with a cursor
// over the filtered set, "More" neither skips nor repeats, and one filtered
// request never scans more than FILTER_BUDGET native pages (a partial scan says
// so and carries on from a cursor instead of truncating or claiming empty).
//   node --test test/logs-writes.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { FILTER_BUDGET, readCalls } from '../src/host/logs/source.ts'
import { isWrite } from '../src/shared/logs.ts'

const line = (at, argv, outcome = 'ok') => ({ v: 1, at, ms: 2, client: 'cli', argv, outcome, tag: 'dsh:-:x' })
const read = (i) => line(i, i % 3 === 0 ? ['project', 'get', 'demo/app'] : ['branch', 'list', 'demo/app'])
const write = (i, argv = ['file', 'write', 'demo/app', 'main', `/f${i}`], outcome = 'ok') => line(i, argv, outcome)

/**
 * A fake native home: `home.log --detail` pages over `lines` newest first,
 * applies its own filters, and counts the CLI calls the host makes.
 */
function nativeHome(lines, { delay = 0 } = {}) {
  let calls = 0
  const lfs = {
    nativeLogs: async () => true,
    discovery: async () => ({
      calls: [{ family: 'home', call: 'log', options: ['call', 'client', 'tag', 'outcome', 'since', 'limit', 'cursor'].map((name) => ({ name })) }],
    }),
    lfs: {
      home: {
        log: async ({ limit = 100, cursor, call, client, tag, outcome, since } = {}) => {
          calls++
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
          const filtered = lines.filter((entry) => {
            if (call && (call.includes('.') ? `${entry.argv[0]}.${entry.argv[1]}` !== call : entry.argv[0] !== call)) return false
            if (client && entry.client !== client) return false
            if (tag && (tag.endsWith(':') ? !entry.tag?.startsWith(tag) : entry.tag !== tag)) return false
            if (outcome && entry.outcome !== outcome) return false
            if (typeof since === 'number' && entry.at < since) return false
            return true
          })
          const start = cursor ? Number(cursor) : 0
          const page = filtered.slice(start, start + limit)
          const next = start + page.length < filtered.length ? String(start + page.length) : undefined
          return {
            items: page.map((entry) => ({
              logged_at: new Date(entry.at).toISOString(), duration_ms: entry.ms, client: entry.client, argv: entry.argv,
              outcome: entry.outcome === 'ok' ? 'ok' : 'refused', ...(entry.outcome === 'ok' ? {} : { error: entry.outcome }),
            })),
            ...(next ? { next_cursor: next } : {}), skipped: 0,
          }
        },
      },
    },
  }
  return { lfs, calls: () => calls }
}

/** Writes/refusals/reads interleaved, `n` lines newest first. */
function fixture(n) {
  const lines = []
  for (let i = 0; i < n; i++) {
    if (i % 62 === 0) lines.push(write(i))
    else if (i % 311 === 0) lines.push(write(i, ['branch', 'fork', 'demo/app', 'main', `b${i}`], 'Conflict'))
    else lines.push(read(i))
  }
  return lines
}

const wanted = (lines) => lines.filter((entry) => isWrite(entry.argv)).map((entry) => entry.at).sort((a, b) => a - b)

test('the default read is one CLI page, and a refresh is one more (not a whole-log scan)', async () => {
  const { lfs, calls } = nativeHome(fixture(2168))
  const first = await readCalls(lfs, { limit: 100 })
  assert.equal(calls(), 1, 'one home log page for the default view')
  assert.equal(first.lines.length, 100)
  assert.equal(first.has_more, true)
  assert.ok(first.next, 'a cursor to the next page')
  assert.ok(first.lines.some((entry) => entry.argv[0] === 'project'), 'the default view is not the writes-only filter')
  await readCalls(lfs, { limit: 100 })
  assert.equal(calls(), 2, 'the event re-read asks for one page again, not the whole log')
})

test('Only writes returns the same set as isWrite, refusals included, over the filtered cursor', async () => {
  const lines = fixture(2168)
  const { lfs, calls } = nativeHome(lines)
  let page = await readCalls(lfs, { limit: 100, writes: true })
  assert.equal(page.has_more, false, '41 writes fit one page; the scan reached the end')
  assert.equal(page.next, undefined)
  assert.deepEqual(page.lines.map((entry) => entry.at).sort((a, b) => a - b), wanted(lines))
  assert.ok(page.lines.some((entry) => entry.outcome === 'Conflict'), 'a refused write is still a write')
  assert.equal(calls(), 3, 'three native pages of 1000 over 2168 lines')
})

test('Only writes stops at its page budget, and its cursor resumes after the last scanned page', async () => {
  const lines = Array.from({ length: 12_000 }, (_, i) => read(i))
  lines[lines.length - 1] = write(11_999, ['file', 'write', 'demo/app', 'main', 'the-only-one'])
  const { lfs, calls } = nativeHome(lines)
  const first = await readCalls(lfs, { limit: 100, writes: true })
  assert.ok(calls() <= FILTER_BUDGET, `one request reads at most ${FILTER_BUDGET} native pages`)
  assert.equal(calls(), FILTER_BUDGET, 'the only write is not in the newest pages, so the budget is used')
  assert.deepEqual(first.lines, [], 'nothing matched in the scanned part')
  assert.equal(first.has_more, true, 'older lines are unscanned')
  assert.equal(first.partial, true, 'the page says its scan stopped at the budget')
  assert.ok(first.next, 'a cursor resuming after the last scanned page')
  const second = await readCalls(lfs, { limit: 100, writes: true, cursor: first.next })
  assert.ok(calls() - FILTER_BUDGET <= FILTER_BUDGET, 'the follow-up is bounded too')
  assert.deepEqual(second.lines.map((entry) => entry.argv.at(-1)), ['the-only-one'], 'the write at the end is reached')
  assert.equal(second.has_more, false)
  assert.equal(second.partial, undefined, 'the scan reached the end')
  assert.equal(second.next, undefined)
  assert.equal(calls(), FILTER_BUDGET + 4, 'the remaining 4000 lines are four native pages')
})

test('an empty filtered answer means the scan reached the log end, not the budget', async () => {
  const lines = Array.from({ length: 21_000 }, (_, i) => read(i))
  const { lfs, calls } = nativeHome(lines)
  let page = await readCalls(lfs, { limit: 100, writes: true })
  let requests = 1
  assert.equal(page.lines.length, 0)
  assert.equal(page.has_more, true, 'a budgeted, unmatched scan proves nothing about older lines')
  assert.equal(page.partial, true)
  assert.equal(calls(), FILTER_BUDGET)
  while (page.partial && page.next) {
    page = await readCalls(lfs, { limit: 100, writes: true, cursor: page.next })
    requests++
    assert.ok(requests <= 4, 'the walk ends')
  }
  assert.deepEqual(page.lines, [], 'no write exists')
  assert.equal(page.has_more, false, 'the whole log was scanned before saying so')
  assert.equal(page.partial, undefined)
  assert.equal(page.next, undefined)
  assert.equal(calls(), 21, '21 native pages over 21000 lines')
  assert.equal(requests, 3, 'ceil(21 / 8) bounded requests')
})

test('a walk across several budgeted scans has no gap and no repeat', async () => {
  // 30000 lines, four writes spread further apart than one budget covers.
  const lines = Array.from({ length: 30_000 }, (_, i) => read(i))
  const at = [500, 9_000, 17_000, 29_999]
  for (const i of at) lines[i] = write(i, ['file', 'write', 'demo/app', 'main', `w${i}`])
  const { lfs, calls } = nativeHome(lines)
  const got = []
  let page = await readCalls(lfs, { limit: 100, writes: true })
  got.push(...page.lines.map((entry) => entry.at))
  let requests = 1
  while (page.partial && page.next) {
    assert.equal(page.partial, true)
    page = await readCalls(lfs, { limit: 100, writes: true, cursor: page.next })
    got.push(...page.lines.map((entry) => entry.at))
    requests++
    assert.ok(requests <= 6, 'the walk ends')
  }
  assert.deepEqual([...got].sort((a, b) => a - b), at, 'every write exactly once, in order')
  assert.equal(new Set(got).size, got.length, 'no repeated line')
  assert.equal(page.has_more, false)
  assert.equal(calls(), 30, '30000 lines / 1000 per native page, spread over the walk')
  assert.equal(requests, 4, 'four bounded requests')
})

test('a write past the old 5000-line cap is found; has_more is then false', async () => {
  const lines = fixture(6218)
  // Only one write, at the very end of the log.
  for (let i = 0; i < lines.length; i++) if (i !== lines.length - 1) lines[i] = read(i)
  lines[lines.length - 1] = write(6217, ['file', 'write', 'demo/app', 'main', 'the-only-one'])
  const { lfs, calls } = nativeHome(lines)
  const page = await readCalls(lfs, { limit: 100, writes: true })
  assert.deepEqual(page.lines.map((entry) => entry.argv.at(-1)), ['the-only-one'], 'the only write, at line 6218, is on page 1')
  assert.equal(page.has_more, false, 'nothing more to find')
  assert.equal(page.next, undefined)
  assert.equal(calls(), 7, '6218 lines / 1000 per native page, inside the budget')
  assert.equal(page.partial, undefined, 'the scan reached the end')
})

test('has_more says there is another matching write, not that a page was full', async () => {
  // Exactly 100 writes and then only reads: the 100th write fills the page, but
  // no write follows, so there is no second page.
  const lines = [...Array.from({ length: 100 }, (_, i) => write(i)), ...Array.from({ length: 500 }, (_, i) => read(100 + i))]
  const { lfs, calls } = nativeHome(lines)
  const page = await readCalls(lfs, { limit: 100, writes: true })
  assert.equal(page.lines.length, 100)
  assert.equal(page.has_more, false, 'no write may follow, so no More row')
  assert.equal(page.next, undefined)
  assert.equal(calls(), 1, 'the scan proved it within the one native page')
})

test('More over a filtered set has no gap and no repeat, even when a scan holds more than a page', async () => {
  const lines = Array.from({ length: 1500 }, (_, i) => write(i))
  const { lfs } = nativeHome(lines)
  const got = []
  let page = await readCalls(lfs, { limit: 100, writes: true })
  let pages = 1
  got.push(...page.lines.map((entry) => entry.at))
  while (page.has_more && page.next) {
    page = await readCalls(lfs, { limit: 100, writes: true, cursor: page.next })
    pages++
    got.push(...page.lines.map((entry) => entry.at))
    assert.ok(pages <= 20, 'the walk ends')
  }
  assert.deepEqual([...got].sort((a, b) => a - b), lines.map((entry) => entry.at))
  assert.equal(new Set(got).size, got.length, 'no repeated line')
  assert.equal(pages, 15)
})
