/**
 * The presets state folder of one LayerFS home: `<home>/preset`, inside the
 * home it describes and named for no client (docs/specs/homes.md §5). A
 * preset's ownership manifest (`demo-fixtures.json`) records the identity of
 * the home it built in, and the runner refuses to clean up any other home with
 * it; keeping the state in that home makes the pairing hold by construction.
 *
 * Earlier builds kept it in the plugin root: `<root>/presets/homes/<digest of
 * the home's path>`. On first use that folder is moved into the home and the
 * absolute state path it recorded (the manifest's `state`, source paths in the
 * step journal) is rewritten to the new place, so the runner's checks still
 * match. The flat `<root>/presets` files predate per-home state and are not
 * consulted.
 */
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Text files in a presets state folder that record the folder's absolute path. */
const RECORDS_PATH = ['demo-fixtures.json', 'demo-steps.ndjson', 'demo-preset-jobs.json', 'environment-reset.json', 'machine-stop.json']

/** `<root>/presets/homes/<digest>`: where an earlier build kept this home's presets state. */
export function legacyPresetState(root: string, home: string): string {
  const path = existsSync(home) ? realpathSync(home) : resolve(home)
  return join(root, 'presets', 'homes', createHash('sha256').update(path).digest('hex').slice(0, 16))
}

/** Moves an earlier presets state folder into the home, rewriting the path it recorded. Never throws. */
function moveLegacy(legacy: string, target: string, home: string): void {
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 })
    const from = realpathSync(legacy)
    try { renameSync(legacy, target) } catch { cpSync(legacy, target, { recursive: true, preserveTimestamps: true }); rmSync(legacy, { recursive: true, force: true }) }
    chmodSync(target, 0o700)
    const to = realpathSync(target)
    for (const name of RECORDS_PATH) {
      const file = join(target, name)
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      // JSON-escaped and plain forms are the same here: these paths hold no characters JSON escapes
      if (text.includes(from)) writeFileSync(file, text.split(from).join(to), { mode: 0o600 })
    }
  } catch {}
}

export function presetStateFor(root: string, home: string): string {
  const target = join(home, 'preset')
  const legacy = legacyPresetState(root, home)
  if (!existsSync(target) && existsSync(legacy)) moveLegacy(legacy, target, home)
  return target
}
