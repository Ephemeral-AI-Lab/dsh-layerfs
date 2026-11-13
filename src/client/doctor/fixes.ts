/**
 * The fixes a doctor finding can offer as buttons: the commands its suggested
 * action names that the host runs itself (`machine start|stop`, `sandbox
 * close`), and Close for a Sandbox whose finding is an error with no command
 * (its daemon or forward is gone). Anything else stays as text to copy.
 */

export interface FindingFix { kind: 'start' | 'stop' | 'close', name: string }

const COMMAND = /layerfs\s+(machine\s+start|machine\s+stop|sandbox\s+close)\s+([A-Za-z0-9][\w.-]*)/g

export function findingFixes(finding: { severity: 'error' | 'warning', fix: string | null, target?: { kind: string, name: string } | null }): FindingFix[] {
  const fixes: FindingFix[] = []
  const add = (fix: FindingFix) => { if (!fixes.some((f) => f.kind === fix.kind && f.name === fix.name)) fixes.push(fix) }
  for (const m of (finding.fix ?? '').matchAll(COMMAND)) {
    const verb = m[1]!.replace(/\s+/g, ' ')
    add({ kind: verb === 'machine start' ? 'start' : verb === 'machine stop' ? 'stop' : 'close', name: m[2]! })
  }
  const target = finding.target
  if (!fixes.length && finding.severity === 'error' && target?.kind === 'sandbox' && target.name) add({ kind: 'close', name: target.name })
  return fixes
}
