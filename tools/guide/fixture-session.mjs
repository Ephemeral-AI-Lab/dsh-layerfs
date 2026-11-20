#!/usr/bin/env node
// Guide fixture: one project conversation with a few LayerFS writes, on a dev
// server started with the fake-llm overlay (the keyless scripted model).
//   DSH_LAYERFS_DEV_DIR=<dev dir> node tools/guide/fixture-session.mjs <store>/<project>
// Prints the session id. The project must exist on that dev server.
import { openDev, runTurn } from '../e2e-lib.mjs'

const project = process.argv[2]
if (!project?.includes('/')) { console.error('usage: fixture-session.mjs <store>/<project>'); process.exit(2) }
const exec = (command) => `bash: "$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" ${JSON.stringify(command)} --stream`

const { browser, page, logs } = await openDev()
try {
  const placed = await page.evaluate(async (k) => window.__dshLayerfs.openProjectSession(k), project)
  await page.waitForTimeout(1500)
  const turns = [
    exec('mkdir -p notes && printf "# Guide notes\\n\\nWritten by the guide fixture.\\n" > notes/guide.md'),
    exec('printf "first draft\\n" > notes/draft.txt && ls notes'),
    exec('printf "second draft\\n" >> notes/draft.txt && cat notes/draft.txt'),
  ]
  for (const message of turns) {
    const turn = await runTurn(page, { message, newSession: false, timeoutMs: 120000 })
    if (!turn.ok) throw new Error(`turn failed: ${turn.error}`)
  }
  console.log(JSON.stringify({ sessionId: placed.sessionId, workspaceId: placed.workspaceId }))
} catch (error) {
  console.error(String(error?.stack ?? error), logs.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
}
