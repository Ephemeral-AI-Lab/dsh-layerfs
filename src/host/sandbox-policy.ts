/**
 * DSH's sandbox policy with LayerFS session roots. Replaces the `sandbox-policy`
 * row (bundle patch): for a session bound by dsh-layerfs, the workspace-write
 * root is the selected local scratch folder; the project mount, the call log
 * directories the managed CLI appends to, and the parts of the private LayerFS home that
 * belong to this session's execution (its project's Store, the Sandbox records
 * folder so it can create Sandboxes of its own, its machine) also stay writable.
 * Other Stores and machines in the same home stay read-only: a session drives them
 * only through the host. Every other
 * session resolves exactly as the stock service does.
 */
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_MACHINE } from './layerfs/machine-records.ts'

/** A writable root must exist before the policy names it (DSH refuses a missing one). */
const ensureDir = (dir: string): string | undefined => { try { mkdirSync(dir, { recursive: true }); return dir } catch { return undefined } }

export const name = 'dsh-layerfs-sandbox-policy'

const isDir = (path: string) => { try { return statSync(path).isDirectory() } catch { return false } }
/** A plain name component (no traversal), as LayerFS names Stores, Sandboxes and machines. */
const component = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && value !== '..' ? value : undefined

/**
 * The LayerFS home directories one bound session's managed CLI writes. With
 * `createSandboxes`, the whole `sandbox/` records folder instead of the session
 * Sandbox's alone: an agent may create (and close) Sandboxes of its own for more
 * Workspace room (skill `methods/sandbox.md`), and `sandbox create` makes
 * `sandbox/<name>/`, which needs its parent writable. The skill keeps it to this
 * project's Sandboxes and never the session's own.
 */
export function sessionHomeRoots(home: string | undefined, binding: { project?: string, sandbox?: string, machine?: string }, options: { createSandboxes?: boolean } = {}): string[] {
  if (!home || !existsSync(home)) return []
  const store = component(binding.project?.split('/')[0])
  const sandbox = component(binding.sandbox)
  const machine = component(binding.machine ?? HOST_MACHINE)
  // Directories only: DSH refuses a policy whose extra writable roots are not existing
  // directories (every command then fails), so the home lock `layerfs.lock` that
  // `sandbox create` opens for writing cannot be granted on its own (FIX-LOG F10).
  return [
    store && join(home, 'store', store),
    options.createSandboxes ? join(home, 'sandbox') : sandbox && join(home, 'sandbox', sandbox),
    machine && join(home, 'machine', machine),
  ].filter((dir): dir is string => !!dir && isDir(dir))
}

export default class LayerfsSandboxPolicy extends (SandboxPolicyService as any) {
  resolve(request: any = {}): any {
    const base = super.resolve(request)
    const id = request?.session?.id
    if (!id) return base
    const sessions = (this as any).ctx.get?.('layerfsSessions')
    let b = sessions?.binding?.(String(id))
    if (b?.kind === 'shared' && b.parent) b = sessions.binding(b.parent) ?? b
    const layerfs = (this as any).ctx.get?.('layerfs')
    const home = layerfs?.home
    if (b?.state !== 'bound') return base
    const root = b.scratch, mount = b.mount
    const owned = sessionHomeRoots(home, b, { createSandboxes: true })
    const extra = [...(base.additionalWritableRoots ?? [])]
    // What the managed CLI and SDK write: call outputs (`<state>/trace/outputs`) and LayerFS's own call log (`<home>/trace`).
    const trace = layerfs?.state ? ensureDir(join(layerfs.state, 'trace')) : undefined
    const homeTrace = layerfs?.home && isDir(join(layerfs.home, 'trace')) ? join(layerfs.home, 'trace') : undefined
    for (const dir of [mount, trace, homeTrace, ...owned]) if (dir && dir !== root && !extra.includes(dir)) extra.push(dir)
    return { ...base, workspaceRoot: root, additionalWritableRoots: extra }
  }
}
