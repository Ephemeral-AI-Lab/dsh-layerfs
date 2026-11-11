#!/usr/bin/env node
// One fake-model chat turn through the real dev web UI (needs the dev server
// started with DSH_LAYERFS_DEV_OVERLAY=dev/fake-llm.overlay.yml).
//   node tools/e2e-chat.mjs [--workspace <title>] [--message <text>] [--approve click|none]
//                           [--expect <regex>] [--shot out.png] [--size 1280x820] [--timeout ms]
// Prints JSON { ok, sessionId, texts, approvals, error? }; exits 1 when not ok.
import { openDev, runTurn } from './e2e-lib.mjs'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const { browser, page, logs } = await openDev({ size: opt('--size', '1280x820') })
let result
try {
  result = await runTurn(page, {
    workspace: opt('--workspace'),
    message: opt('--message', 'bash: echo hello > hello.txt').replace(/\\n/g, '\n'),
    approve: opt('--approve', 'click'),
    timeoutMs: Number(opt('--timeout', '60000')),
    ...opt('--expect') ? { expect: new RegExp(opt('--expect')) } : {},
  })
} catch (e) {
  result = { ok: false, error: String(e?.stack ?? e) }
}
const shot = opt('--shot')
if (shot) await page.screenshot({ path: shot })
const { transcript, ...summary } = result
console.log(JSON.stringify({ ...summary, ...argv.includes('--transcript') ? { transcript } : {}, consoleErrors: logs }, null, 2))
await browser.close()
process.exit(result.ok ? 0 : 1)
