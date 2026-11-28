/**
 * The presets state folder of one LayerFS home: `<home>/preset`, inside the
 * home it describes and named for no client (docs/specs/homes.md §5). A
 * preset's ownership manifest (`demo-fixtures.json`) records the identity of
 * the home it built in, and the runner refuses to clean up any other home with
 * it; keeping the state in that home makes the pairing hold by construction.
 */
import { join } from 'node:path'

export function presetStateFor(home: string): string {
  return join(home, 'preset')
}
