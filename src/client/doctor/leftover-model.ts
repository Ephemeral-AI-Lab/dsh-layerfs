/**
 * The leftovers of a `layerfs doctor` report as the Health page lists them
 * (layerfs-project#180). Pure: no React.
 */
import type { DoctorFinding, Leftover, LeftoverWalk } from '../storage/types.ts'

/** The command that removes a leftover: its id is `<machine>:<kind>:<name>`, never a path. */
export const fixCommand = (leftover: Pick<Leftover, 'id'>): string => `layerfs doctor fix ${leftover.id}`

/** LayerFS's fix sentence without the command it starts with (the command is shown on its own, to copy). */
export function fixCondition(fix: string | null, leftover: Pick<Leftover, 'id'>): string | null {
  if (!fix) return null
  const lead = `\`${fixCommand(leftover)}\``
  const rest = fix.startsWith(lead) ? fix.slice(lead.length).trim() : fix
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : null
}

/** The sweep's findings that are leftovers, in LayerFS's order. */
export const leftoverFindings = (findings: readonly DoctorFinding[]): (DoctorFinding & { leftover: Leftover })[] =>
  findings.filter((f): f is DoctorFinding & { leftover: Leftover } => !!f.leftover)

/** The walked machines that have something LayerFS only counts, or whose walk stopped early. */
export const walksToShow = (walks: readonly LeftoverWalk[] | undefined): LeftoverWalk[] =>
  (walks ?? []).filter((w) => w.imageLocks > 0 || w.unmountMarkers > 0 || !w.complete)
