#!/usr/bin/env node
// B9-C in process, no server and no browser: a cold Trajectory first page for a
// long, unloaded session, read from the newest window of the log and of
// `receipts.jsonl` instead of both files whole. Reports, over a copy of a real
// session:
//   - today's whole-log parse + first-page build + page, and the log/receipts
//     parse split (which cost the window removes);
//   - the windowed first page: log bytes read, receipts bytes read, the window
//     shape (`windowed`/`windowFromSeq`/`recordTotal`/`recordTotalKnown`), build
//     and page time, page bytes;
//   - parity: the newest records and the page JSON against the whole-log page;
//   - the older-page walk: full totals after the first `{ before }`, and every
//     record reached exactly once.
// `--windowed` is the host decision the plugin makes; a legacy combined sidecar
// (no `receipts.jsonl`) is reported as falling back to the whole parse.
//
//   node test/perf/trajectory-tail.perf.mjs [--log /tmp/longlog/session.v4.jsonl]
//        [--dir /tmp/longlog] [--reps 5]
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildTrajectory, pageTrajectory, trajectoryReader } from '../../src/host/sessions/trace.ts'
import { mayReadTail, tailFile, tailPageReader } from '../../src/host/sessions/trajectory-tail.ts'
import { FIRST_PAGE_BYTES, FIRST_PAGE_RECORDS } from '../../src/shared/trajectory.ts'

const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const LOG = flag('--log', '/tmp/longlog/session.v4.jsonl')
const DIR = flag('--dir', dirname(LOG))
const SIDE = flag('--sidecar', join(DIR, 'layerfs.json'))
const REPS = Number(flag('--reps', 5))
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const time = (fn) => { const at = performance.now(); const value = fn(); return { ms: performance.now() - at, value } }
const bytes = (value) => Buffer.byteLength(JSON.stringify(value))
const recordsOf = (page) => page.turns.flatMap((turn) => turn.records)

const logSize = statSync(LOG).size
const side = JSON.parse(readFileSync(SIDE, 'utf8'))
const receiptsPath = join(DIR, 'receipts.jsonl')
const hasReceipts = existsSync(receiptsPath)
const base = { sessionId: side.sessionId ?? 'perf', project: side.project ?? null, branch: side.codeBranch ?? null, checkpoints: side.checkpoints ?? [] }
const allowed = mayReadTail(logSize, { loaded: false, splitReceipts: hasReceipts })
if (!allowed) {
  console.log(JSON.stringify({
    logBytes: logSize, splitReceipts: hasReceipts,
    fallback: hasReceipts ? 'below the 8 MB threshold' : 'no receipts.jsonl (legacy combined sidecar): the host runs the whole parse',
  }, null, 2))
  process.exit(0)
}

// ---- today: read and parse the whole log, then the whole receipts file
const wholeParse = time(() => readFileSync(LOG, 'utf8').split('\n').slice(1).filter(Boolean).map((line) => JSON.parse(line)))
const events = wholeParse.value
const receiptsParse = time(() => readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
const receipts = receiptsParse.value
const fullInput = { ...base, events, invocations: receipts }
const wholeBuild = median(Array.from({ length: REPS }, () => time(() => buildTrajectory(fullInput, { newest: FIRST_PAGE_RECORDS })).ms))
const fullAnswer = buildTrajectory(fullInput, { newest: FIRST_PAGE_RECORDS })
const wholePage = median(Array.from({ length: REPS }, () => time(() => pageTrajectory(fullAnswer)).ms))
const fullPage = pageTrajectory(fullAnswer)

// ---- B9-C: the log and receipts windows
const files = { logPath: LOG, logKey: tailFile(LOG).key, logSize, receiptsPath, receiptsKey: tailFile(receiptsPath).key, receiptsSize: statSync(receiptsPath).size }
const tails = tailPageReader()
const cold = time(() => tails('perf-page', files))
const page0 = cold.value
if (!page0) {
  console.log(JSON.stringify({ logBytes: logSize, error: 'the tail window could not be read; the whole parse is what runs' }, null, 2))
  process.exit(1)
}
const windowInput = {
  ...base, events: page0.events, invocations: page0.invocations,
  window: { fromSeq: page0.window.fromSeq, fromTurn: page0.window.fromTurn, logKey: page0.window.logKey, ...(page0.window.prompt ? { prompt: page0.window.prompt } : {}) },
}
const windowBuild = median(Array.from({ length: REPS }, () => time(() => buildTrajectory(windowInput, { newest: FIRST_PAGE_RECORDS })).ms))
const windowAnswer = buildTrajectory(windowInput, { newest: FIRST_PAGE_RECORDS })
const windowPage = median(Array.from({ length: REPS }, () => time(() => pageTrajectory(windowAnswer)).ms))
const page = pageTrajectory(windowAnswer)
const warm = time(() => tails('perf-page', files))

const sameSeqs = JSON.stringify(recordsOf(fullPage).map((record) => record.seq)) === JSON.stringify(recordsOf(page).map((record) => record.seq))
const sameRecords = JSON.stringify(recordsOf(fullPage)) === JSON.stringify(recordsOf(page))
const sameTurns = JSON.stringify(fullPage.turns.map((turn) => [turn.turn, turn.records.length, turn.totalRecords])) === JSON.stringify(page.turns.map((turn) => [turn.turn, turn.records.length, turn.totalRecords]))

// ---- load older: the windowed first page, then the whole parse and its pages
let builds = 0
const read = trajectoryReader(8, (input, scope) => { builds += 1; return buildTrajectory(input, scope) })
const first = read(windowInput)
const walk = recordsOf(first).map((record) => record.seq)
let next = first
let pages = 1
let firstOlderMs = 0
while (next.hasMore && next.olderBefore !== undefined) {
  const at = performance.now()
  const older = read(fullInput, { before: next.olderBefore })
  if (pages === 1) firstOlderMs = performance.now() - at
  walk.push(...recordsOf(older).map((record) => record.seq))
  next = older
  pages++
}
const unique = new Set(walk)
const fullTotal = buildTrajectory(fullInput).turns.flatMap((turn) => turn.records).length

console.log(JSON.stringify({
  logBytes: logSize, events: events.length, receipts: receipts.length,
  today: {
    parseLogMs: round(wholeParse.ms), parseReceiptsMs: round(receiptsParse.ms),
    buildMs: round(wholeBuild), pageMs: round(wholePage),
    firstPageRecords: recordsOf(fullPage).length, firstPageBytes: bytes(fullPage), recordTotal: fullPage.recordTotal,
  },
  window: {
    logBytesRead: page0.logBytes, receiptBytesRead: page0.receiptBytes, coldMs: round(cold.ms), warmMs: round(warm.ms, 2),
    fromSeq: page0.window.fromSeq, fromTurn: page0.window.fromTurn,
    promptSeq: page0.window.prompt?.seq ?? null,
    events: page0.events.length, receipts: page0.invocations.length,
    buildMs: round(windowBuild), pageMs: round(windowPage),
    firstPageRecords: recordsOf(page).length, firstPageBytes: bytes(page),
    recordTotal: page.recordTotal, recordTotalKnown: page.recordTotalKnown, windowed: page.windowed,
    pageFitsBudget: bytes(page) <= FIRST_PAGE_BYTES,
  },
  parity: { sameSeqs, sameRecords, sameTurns, pageBytesDelta: bytes(page) - bytes(fullPage) },
  counts: { window: windowAnswer.counts, whole: fullAnswer.counts },
  older: {
    firstOlderPageMs: round(firstOlderMs), pages, builds,
    walkRecords: walk.length, uniqueRecords: unique.size, fullRecordTotal: fullTotal,
    exact: walk.length === unique.size && unique.size === fullTotal,
  },
}, null, 2))
