// B9-C: a cold Trajectory first page for a long, unloaded session reads the
// newest window of the log and of `receipts.jsonl` instead of both files whole,
// and says so (`windowed`, `windowFromSeq`, `recordTotalKnown`); an older page
// reads the whole log once and is exact.
//   node --test test/trajectory-window.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTrajectory, pageTrajectory, trajectoryReader } from '../src/host/sessions/trace.ts'
import { FIRST_PAGE_BYTES, FIRST_PAGE_RECORDS, PREVIEW_MAX } from '../src/shared/trajectory.ts'
import { mayReadTail, readReceiptsWindow, readTrajectoryWindow, tailFile, tailPageReader } from '../src/host/sessions/trajectory-tail.ts'
import { withReceiptMeta } from '../src/host/layerfs/tracing.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const dir = mkdtempSync(join(root, 'lib', '.test-trajectory-window-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))

const LIMITS = { minBytes: 1, startBytes: 128 * 1024 }
const SID = 'session-window'
const pageBytes = (value) => Buffer.byteLength(JSON.stringify(value))
const recordsOf = (page) => page.turns.flatMap((turn) => turn.records)
let fixture = 0

const ev = (seq, type, data) => ({ seq, type, data, time: 1000 + seq })
const txt = (text) => ({ type: 'text', text })
const header = (tools) => ({ config: { provider: 'deepseek', model: 'deepseek-chat' }, tools })

/**
 * One long session: `turns` turns of four records each (a user message, an
 * assistant message and two tool calls), a request header and/or a system
 * message on the turns named, and a receipt per tool call.
 */
function makeSession({ turns = 400, headersAt = [], systemsAt = [], edits = [], text = 'x' } = {}) {
  const events = []
  const receipts = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn++) {
    const at = { turn, startSeq: seq }
    events.push(ev(++seq, 'turn/start', { turn }))
    if (systemsAt.includes(turn)) events.push(ev(++seq, 'system/message', { turn, step: 1, message: { content: [txt(`system prompt ${turn}`)], source: { kind: 'system-prompt' } } }))
    if (headersAt.includes(turn)) events.push(ev(++seq, 'request/header', { header: header(turn <= 300 ? [{ name: 'bash', description: 'run' }] : [{ name: 'bash', description: 'run' }, { name: 'read', description: 'read' }]) }))
    events.push(ev(++seq, 'step/start', { turn, step: 1 }))
    events.push(ev(++seq, 'user/message', { source: { kind: 'user' }, content: [txt(`ask ${turn} ${text.repeat(60)}`)] }))
    events.push(ev(++seq, 'assistant/message', { turn, step: 1, message: { content: [txt(`answer ${turn} ${text.repeat(60)}`)] } }))
    for (let c = 0; c < 2; c++) {
      const callId = `call_${turn}_${c}`
      events.push(ev(++seq, 'tool/call', { turn, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command: `read ${turn} ${c} ${'z'.repeat(40)}` }) }))
      events.push(ev(++seq, 'tool/result', { turn, step: 1, message: { toolCallId: callId, content: [txt(`ok ${turn} ${c}`)] } }))
      receipts.push({
        id: `r_${turn}_${c}`, origin: 'tool', sessionId: SID, project: 'st/p', turn, toolCallId: callId,
        operation: 'file.read', outcome: 'success', versions: [], argv: ['file', 'read', 'st/p', 'dsh.s', `/f-${turn}-${c}`],
        at: 1000 + seq,
      })
    }
    events.push(ev(++seq, 'step/end', { turn, step: 1 }))
    events.push(ev(++seq, 'turn/end', { turn }))
    at.endSeq = seq
  }
  for (const edit of edits) edit(events)
  fixture += 1
  const base = join(dir, `session-${fixture}`)
  mkdirSync(base, { recursive: true })
  const logPath = join(base, 'session.v4.jsonl')
  const receiptsPath = join(base, 'receipts.jsonl')
  writeFileSync(logPath, `${[JSON.stringify({ type: 'session', version: 4, id: SID }), ...events.map((event) => JSON.stringify(event))].join('\n')}\n`)
  writeFileSync(receiptsPath, `${receipts.map((receipt) => JSON.stringify(receipt)).join('\n')}\n`)
  return { base, logPath, receiptsPath, events, receipts }
}

/** The records `buildTrajectory` would keep: record event seqs, oldest first. */
function recordSeqs(events) {
  const out = []
  const calls = new Set()
  for (const event of events) {
    const data = event?.data
    if (!Number.isInteger(event?.seq)) continue
    if (event.type === 'user/message') { if (data) out.push(event.seq) }
    else if (event.type === 'assistant/message') { if (Number.isInteger(data?.turn)) out.push(event.seq) }
    else if (event.type === 'system/message') { if (data?.message && Number.isInteger(data?.turn)) out.push(event.seq) }
    else if (event.type === 'request/header') { if (data?.header) out.push(event.seq) }
    else if (event.type === 'tool/call') { if (Number.isInteger(data?.turn) && data.callId && !calls.has(data.callId)) { calls.add(data.callId); out.push(event.seq) } }
  }
  return out
}

const base = (session) => ({ sessionId: SID, project: 'st/p', branch: 'dsh.s', checkpoints: [] })

/** The windowed input a cold first page would build from. */
function windowInput(session, window, receipts) {
  return { ...base(session), events: window.events, invocations: receipts, window: { fromSeq: window.fromSeq, fromTurn: window.fromTurn, logKey: 'test', ...(window.prompt ? { prompt: window.prompt } : {}) } }
}

const wholeInput = (session) => ({ ...base(session), events: session.events, invocations: session.receipts })

test('mayReadTail: the 8 MB threshold, split receipts, a loaded session and a cached whole parse gate the tail', () => {
  assert.equal(mayReadTail(8 * 1024 * 1024 - 1, { loaded: false, splitReceipts: true }), false, 'below 8 MB')
  assert.equal(mayReadTail(8 * 1024 * 1024, { loaded: false, splitReceipts: true }), true)
  assert.equal(mayReadTail(20 * 1024 * 1024, { loaded: true, splitReceipts: true }), false, 'a loaded session has its events')
  assert.equal(mayReadTail(20 * 1024 * 1024, { loaded: false }), false, 'a legacy combined sidecar keeps the whole parse')
  assert.equal(mayReadTail(20 * 1024 * 1024, { loaded: false, splitReceipts: true }), true, 'a cached whole parse does not move the first page\'s window')
  assert.equal(mayReadTail(4, { loaded: false, splitReceipts: true }, 1), true, 'the threshold is a parameter')
})

test('a log window starts at a turn/start, holds the newest records, and seeds the request before the page', () => {
  // Headers only at turn 40 and turn 380: the page's request at 380 has its
  // predecessor outside the window, so the window must carry it as a seed.
  const session = makeSession({ headersAt: [40, 380] })
  const window = readTrajectoryWindow(session.logPath, statSync(session.logPath).size, LIMITS)
  assert.ok(window, 'the tail is readable')
  assert.equal(window.events[0].type, 'turn/start', 'a window starts at a turn boundary')
  assert.equal(window.fromSeq, window.events[0].seq)
  assert.ok(window.fromTurn <= 380)
  assert.ok(window.bytes > 0 && window.bytes < statSync(session.logPath).size, `read ${window.bytes} of ${statSync(session.logPath).size}`)
  assert.ok(window.prompt, 'the header before the page is seeded')
  assert.equal(window.prompt.seq, session.events.filter((event) => event.type === 'request/header')[0].seq, 'the seed is the previous header')
  // The window still holds every record the page can keep.
  assert.ok(recordSeqs(window.events).length >= FIRST_PAGE_RECORDS)

  const receipts = readReceiptsWindow(session.receiptsPath, window.fromTurn)
  assert.ok(receipts, 'the receipts window is readable')
  assert.ok(receipts.bytes < statSync(session.receiptsPath).size, `read ${receipts.bytes} of ${statSync(session.receiptsPath).size}`)
  assert.ok(receipts.receipts.length > 0)
  assert.ok(receipts.receipts.every((receipt) => receipt.turn >= window.fromTurn), 'only the window\'s turns')
})

test('the windowed first page is the whole-log first page, and says its totals are the window\'s', () => {
  const session = makeSession({ headersAt: [40, 380] })
  const window = readTrajectoryWindow(session.logPath, statSync(session.logPath).size, LIMITS)
  const receipts = readReceiptsWindow(session.receiptsPath, window.fromTurn).receipts
  const fromWindow = pageTrajectory(buildTrajectory(windowInput(session, window, receipts), { newest: FIRST_PAGE_RECORDS }))
  const fromWhole = pageTrajectory(buildTrajectory(wholeInput(session), { newest: FIRST_PAGE_RECORDS }))

  assert.deepEqual(recordsOf(fromWindow), recordsOf(fromWhole), 'the newest records are identical, the seed included')
  // The only thing a windowed page may add to the whole-log page is its shape
  // (three fields and the window's recordTotal).
  const added = pageBytes(fromWindow) - pageBytes(fromWhole)
  assert.ok(added > 0 && added < 200, `${added} bytes of window shape`)
  assert.ok(pageBytes(fromWindow) <= FIRST_PAGE_BYTES, `${pageBytes(fromWindow)} UTF-8 bytes`)
  assert.equal(fromWindow.windowed, true)
  assert.equal(fromWindow.windowFromSeq, window.fromSeq)
  assert.equal(fromWindow.recordTotalKnown, false)
  assert.equal(fromWindow.recordTotal, recordSeqs(window.events).length, 'the window\'s record count')
  assert.ok(fromWindow.recordTotal < fromWhole.recordTotal, `${fromWindow.recordTotal} of ${fromWhole.recordTotal}`)
  assert.equal(fromWhole.windowed, undefined)
  assert.equal(fromWhole.recordTotalKnown, undefined)
  assert.equal(fromWindow.hasMore, true, 'a window always has an older page')
  assert.equal(fromWindow.olderBefore, recordsOf(fromWindow)[0].seq)
  assert.deepEqual(fromWindow.checkpoints, fromWhole.checkpoints, 'every checkpoint tick rides along, from the sidecar not the log')
  // A request record whose catalog changed still says so: the seed supplied the
  // predecessor the window does not hold.
  const request = recordsOf(fromWindow).find((record) => record.kind === 'request' && record.toolsChanged)
  assert.ok(request, 'the page carries the request with its tool change')
  assert.equal(request.promptChanged, 'tools')
  assert.deepEqual(request.toolsChanged, { added: ['read'], removed: [], changed: [] })
  assert.equal(request.previousSeq, session.events.filter((event) => event.type === 'request/header')[0].seq, 'the seed named the real predecessor')
})
test('a CJK-heavy window keeps its page inside the UTF-8 byte budget, not a char count', () => {
  const session = makeSession({ headersAt: [380], text: '中'.repeat(PREVIEW_MAX) })
  const window = readTrajectoryWindow(session.logPath, statSync(session.logPath).size, LIMITS)
  assert.ok(window, 'multi-byte text does not move a byte offset or a line boundary')
  const receipts = readReceiptsWindow(session.receiptsPath, window.fromTurn).receipts
  const page = pageTrajectory(buildTrajectory(windowInput(session, window, receipts), { newest: FIRST_PAGE_RECORDS }))
  const fromWhole = pageTrajectory(buildTrajectory(wholeInput(session), { newest: FIRST_PAGE_RECORDS }))
  assert.deepEqual(recordsOf(page), recordsOf(fromWhole))
  assert.ok(pageBytes(page) <= FIRST_PAGE_BYTES, `${pageBytes(page)} UTF-8 bytes`)
  assert.ok(pageBytes(page) > JSON.stringify(page).length * 1.5, 'UTF-8 bytes exceed the UTF-16 char count')
})

test('a short log, or one whose window would be the whole file, answers whole (windowed false)', () => {
  const session = makeSession({ turns: 8 })
  const size = statSync(session.logPath).size
  assert.equal(readTrajectoryWindow(session.logPath, size, { minBytes: size + 1, startBytes: 128 * 1024 }), undefined, 'below the threshold')
  assert.equal(readTrajectoryWindow(session.logPath, size, { minBytes: 1, startBytes: size * 2 }), undefined, 'a window that reaches the file start is the whole log')
  assert.equal(readTrajectoryWindow(session.logPath, size, { minBytes: 1, startBytes: size }), undefined)
  const fromWhole = pageTrajectory(buildTrajectory(wholeInput(session), { newest: FIRST_PAGE_RECORDS }))
  assert.equal(fromWhole.windowed, undefined)
  assert.equal(fromWhole.recordTotalKnown, undefined)
})

test('malformed logs fall back to the whole parse: no header, a bad line, a missing seq, a JSON array', () => {
  const session = makeSession({ headersAt: [380] })
  const original = readFileSync(session.logPath, 'utf8')
  const write = (name, text) => { const path = join(dir, `${name}.jsonl`); writeFileSync(path, text); return path }
  const size = statSync(session.logPath).size
  const lines = original.split('\n')

  const noHeader = write('no-header', lines.slice(1).join('\n'))
  assert.equal(readTrajectoryWindow(noHeader, statSync(noHeader).size, LIMITS), undefined, 'no v4 session header')

  const badHeader = write('bad-header', original.replace('"version":4', '"version":3'))
  assert.equal(readTrajectoryWindow(badHeader, statSync(badHeader).size, LIMITS), undefined, 'a v3 header is not a v4 log')

  // A broken line in the tail (not the last one) is not a torn append.
  const broken = lines.slice()
  broken[broken.length - 20] = '{"type":"user/message",'
  const badLine = write('bad-line', broken.join('\n'))
  assert.equal(readTrajectoryWindow(badLine, statSync(badLine).size, LIMITS), undefined, 'an unparsable line in the window')

  const noSeq = lines.slice()
  const dropped = JSON.parse(noSeq[noSeq.length - 30])
  delete dropped.seq
  noSeq[noSeq.length - 30] = JSON.stringify(dropped)
  const missing = write('missing-seq', noSeq.join('\n'))
  assert.equal(readTrajectoryWindow(missing, statSync(missing).size, LIMITS), undefined, 'a row without an integer seq')

  const notJsonl = write('not-jsonl.jsonl', 'this is not a session log\n')
  assert.equal(readTrajectoryWindow(notJsonl, statSync(notJsonl).size, LIMITS), undefined, 'not JSONL')

  // A torn final line is an append in progress, not a wrong page.
  const torn = write('torn', `${original}${JSON.stringify({ type: 'assistant/message', seq: 999999 })}`.slice(0, -8))
  assert.equal(readTrajectoryWindow(torn, statSync(torn).size, LIMITS)?.fromSeq !== undefined, true, 'a torn last line is dropped')
  assert.ok(size > 0)
})

test('a prompt replacement whose endpoints predate the window falls back once the window held a prompt state', () => {
  const session = makeSession({
    headersAt: [380],
    edits: [(events) => {
      // The page itself is edited: a replacement pointing before the window.
      const lastHeader = events.filter((event) => event.type === 'request/header').at(-1)
      const target = events.find((event) => event.type === 'user/message' && event.data && event.seq > lastHeader.seq)
      target.surfaceOp = { op: 'replace', startSeq: 1, endSeq: 1 }
    }],
  })
  assert.equal(readTrajectoryWindow(session.logPath, statSync(session.logPath).size, LIMITS), undefined, 'a replacement the window cannot interpret')
})

test('a page system message is anchored to the real previous prompt, or the whole parse runs', () => {
  const noEarlier = makeSession({ systemsAt: [400], headersAt: [400] })
  assert.equal(readTrajectoryWindow(noEarlier.logPath, statSync(noEarlier.logPath).size, LIMITS), undefined, 'no earlier system message to anchor')

  const earlier = makeSession({ systemsAt: [20, 400], headersAt: [400] })
  const window = readTrajectoryWindow(earlier.logPath, statSync(earlier.logPath).size, LIMITS)
  assert.ok(window, 'the window reaches back to the earlier prompt')
  assert.ok(window.fromTurn <= 20, `anchored at turn ${window.fromTurn}`)
  assert.ok(window.events.some((event) => event.type === 'system/message' && event.seq < window.events.at(-1).seq), 'the page\'s system message has a predecessor in the window')
})

test('receipts windows are exact and fall back on a broken tail line', () => {
  const session = makeSession({ headersAt: [380] })
  const window = readTrajectoryWindow(session.logPath, statSync(session.logPath).size, LIMITS)
  const kept = session.receipts.filter((receipt) => receipt.turn >= window.fromTurn)
  const read = readReceiptsWindow(session.receiptsPath, window.fromTurn)
  assert.deepEqual(read.receipts, kept)
  assert.ok(read.bytes < statSync(session.receiptsPath).size)

  const lines = readFileSync(session.receiptsPath, 'utf8').split('\n')
  lines[lines.length - 3] = '{not a receipt'
  const broken = join(dir, 'receipts-broken.jsonl')
  writeFileSync(broken, lines.join('\n'))
  assert.equal(readReceiptsWindow(broken, window.fromTurn), undefined, 'an unparsable receipt line in the window')
})

test('the tail cache answers a since poll and a repeat without reading the files again', () => {
  const session = makeSession({ headersAt: [40, 380] })
  const files = {
    logPath: session.logPath, logKey: tailFile(session.logPath).key, logSize: statSync(session.logPath).size,
    receiptsPath: session.receiptsPath, receiptsKey: tailFile(session.receiptsPath).key, receiptsSize: statSync(session.receiptsPath).size,
  }
  const reader = tailPageReader(2, LIMITS)
  const cold = reader(SID, files)
  assert.ok(cold, 'the cold read found the tails')
  assert.equal(cold.cached, false)
  assert.ok(cold.logBytes > 0 && cold.receiptBytes > 0)
  assert.ok(cold.window.prompt, 'the cache keeps the seed')

  // A warm read costs no bytes, even after the files are gone: a `since` poll
  // must not re-read the tails before it can answer `unchanged`.
  rmSync(session.logPath)
  rmSync(session.receiptsPath)
  const warm = reader(SID, files)
  assert.ok(warm, 'served from the cached window')
  assert.equal(warm.cached, true)
  assert.equal(warm.logBytes, 0)
  assert.equal(warm.receiptBytes, 0)
  assert.equal(warm.events, cold.events)
  assert.equal(warm.window.fromSeq, cold.window.fromSeq)
})

/**
 * A `since` poll with the window cache warm: `trajectoryRevision` is stable and
 * the reader answers `unchanged` 25/25 times, as today's whole-log path does.
 */
test('since answers unchanged 25/25 from a warm window, and a grown log is a new revision', () => {
  const session = makeSession({ headersAt: [40, 380] })
  const files = {
    logPath: session.logPath, logKey: tailFile(session.logPath).key, logSize: statSync(session.logPath).size,
    receiptsPath: session.receiptsPath, receiptsKey: tailFile(session.receiptsPath).key, receiptsSize: statSync(session.receiptsPath).size,
  }
  const tails = tailPageReader(2, LIMITS)
  const read = trajectoryReader(8)
  const input = () => {
    const page = tails(SID, files)
    return windowInput(session, { ...page.window, events: page.events }, page.invocations)
  }
  const first = read(input())
  assert.equal(first.windowed, true)
  for (let i = 0; i < 25; i++) assert.deepEqual(read(input(), { since: first.revision }), { sessionId: SID, revision: first.revision, unchanged: true })
  const grown = input()
  grown.window.logKey = 'grown'
  grown.events = grown.events.concat([ev(999999, 'turn/start', { turn: 401 }), ev(1000000, 'turn/end', { turn: 401 })])
  assert.notEqual(read(grown, { since: first.revision }).revision, first.revision, 'a grown log is not unchanged')
})

test('load older after a windowed first page reads the whole log once and reaches every record exactly once', () => {
  const session = makeSession({ headersAt: [40, 380] })
  const window = readTrajectoryWindow(session.logPath, statSync(session.logPath).size, LIMITS)
  const receipts = readReceiptsWindow(session.receiptsPath, window.fromTurn).receipts
  let builds = 0
  const read = trajectoryReader(8, (input, scope) => { builds += 1; return buildTrajectory(input, scope) })
  const first = read(windowInput(session, window, receipts))
  assert.equal(first.windowed, true)
  assert.equal(first.recordTotal, recordSeqs(window.events).length)
  assert.ok(first.olderBefore !== undefined)

  const full = buildTrajectory(wholeInput(session))
  const older = read(wholeInput(session), { before: first.olderBefore })
  assert.equal(older.windowed, undefined, 'the older page reads the whole log')
  assert.equal(older.recordTotal, recordSeqs(session.events).length)
  assert.equal(older.recordTotalKnown, undefined)
  const seen = recordsOf(first).map((record) => record.seq)
  const walk = [older]
  while (walk.at(-1).hasMore) walk.push(read(wholeInput(session), { before: walk.at(-1).olderBefore }))
  for (const page of walk) seen.push(...recordsOf(page).map((record) => record.seq))
  assert.equal(seen.length, new Set(seen).size, 'no record repeats')
  assert.equal(seen.length, recordSeqs(session.events).length, 'every record is reached')
  // The whole parse is reused: the windowed first page and the first older page
  // each built once; every later older page came from that answer.
  assert.equal(builds, 2, `${builds} builds for ${walk.length + 1} pages`)
  assert.ok(walk.length >= 1, 'the first older page reads the whole log')
  assert.ok(walk.every((page) => page.recordTotal === recordSeqs(session.events).length), 'every older page carries the full total')
})

test('the observation row rides through a window from the sidecar counter', () => {
  const session = makeSession({ headersAt: [380] })
  const window = readTrajectoryWindow(session.logPath, statSync(session.logPath).size, LIMITS)
  const receipts = readReceiptsWindow(session.receiptsPath, window.fromTurn).receipts
  const counter = { version: 1, reads: { 'workspace.status': { count: 12, lastOutcome: 'success' } }, readsTotal: 12, dropped: 0, cap: 65536, truncated: false, lastAt: 1900 }
  const withCounter = (rows) => withReceiptMeta(rows, counter)
  const fromWindow = pageTrajectory(buildTrajectory({ ...windowInput(session, window, withCounter(receipts)), invocations: withCounter(receipts) }, { newest: FIRST_PAGE_RECORDS }))
  const fromWhole = pageTrajectory(buildTrajectory({ ...wholeInput(session), invocations: withCounter(session.receipts) }, { newest: FIRST_PAGE_RECORDS }))
  const observation = (page) => recordsOf(page).find((record) => record.kind === 'observation')
  assert.ok(observation(fromWindow), 'the window carries the observation row')
  assert.deepEqual(observation(fromWindow), observation(fromWhole), 'identical in both builds')
  assert.equal(fromWindow.recordTotal, recordSeqs(window.events).length + 1, 'the window total counts the observation')
})
