/**
 * The fixes a doctor finding can offer as buttons: the commands its suggested
 * action names that the host runs itself (`machine start|stop`, `sandbox
 * close`), Close for a Sandbox whose finding is an error with no command
 * (its daemon or forward is gone), and Start for a built-in machine that was
 * never started (doctor's `machine.provider` warning). Anything else stays as
 * text to copy.
 *
 * Also the setup check's findings (docs/specs/layerfs-setup.md §4.3): each
 * `layerfs home get` warning, fixed only in the Set up LayerFS modal (Runtime
 * for the bundle and daemon, LayerFS folder for the home). A folder others can
 * read is a note, not a warning.
 */

export type SetupSection = 'runtime' | 'folder' | 'machines'

export type FindingFix =
  | { kind: 'start' | 'stop' | 'close', name: string }
  /** Opens the Set up LayerFS modal at `name`, its section. */
  | { kind: 'setup', name: SetupSection }

const COMMAND = /layerfs\s+(machine\s+start|machine\s+stop|sandbox\s+close)\s+([A-Za-z0-9][\w.-]*)/g
/** doctor's `machine.provider` warning for a built-in machine that never ran: "docker was never started; Start creates its worker container". */
const NEVER_STARTED = /\bnever\s+(?:been\s+)?started\b/i

export function findingFixes(finding: { severity: 'error' | 'warning' | 'note', fix: string | null, message?: string, target?: { kind: string, name: string } | null }): FindingFix[] {
  const fixes: FindingFix[] = []
  const add = (fix: FindingFix) => { if (!fixes.some((f) => f.kind === fix.kind && f.name === fix.name)) fixes.push(fix) }
  for (const m of (finding.fix ?? '').matchAll(COMMAND)) {
    const verb = m[1]!.replace(/\s+/g, ' ')
    add({ kind: verb === 'machine start' ? 'start' : verb === 'machine stop' ? 'stop' : 'close', name: m[2]! })
  }
  const target = finding.target
  if (!fixes.length && finding.severity === 'error' && target?.kind === 'sandbox' && target.name) add({ kind: 'close', name: target.name })
  if (!fixes.length && finding.severity === 'warning' && target?.kind === 'machine' && target.name && NEVER_STARTED.test(finding.message ?? '')) add({ kind: 'start', name: target.name })
  return fixes
}

/** One `home get` warning as Health shows it: its severity and the setup section that fixes it. */
export interface SetupFinding { code: string, severity: 'warning' | 'note', message: string, section: SetupSection }

/**
 * The setup check's warnings (`setup.status` `warnings`, LayerFS's `{code,
 * message}`) as findings: HomeMode is a note; the other Home codes open the
 * LayerFS folder section, the Bundle and Daemon codes (and any code this page
 * does not know) the Runtime section.
 */
export function setupFindings(warnings: readonly { code: string, message: string }[] | null | undefined): SetupFinding[] {
  return (warnings ?? []).map((w) => ({
    code: w.code,
    severity: w.code === 'HomeMode' ? 'note' : 'warning',
    message: w.message,
    section: w.code.startsWith('Home') ? 'folder' : 'runtime',
  }))
}
