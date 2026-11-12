/**
 * DSH's sandbox policy with LayerFS session roots. Replaces the `sandbox-policy`
 * row (bundle patch): for a session bound by dsh-layerfs, the workspace-write
 * root is the selected local scratch folder; the project mount, the managed
 * invocation receipt directory, and the parts of the private LayerFS home that
 * belong to this session's execution (its project's Store, its Sandbox, its
 * machine) also stay writable. Other Stores, Sandboxes and machines in the same
 * home stay read-only: a session drives them only through the host. Every other
 * session resolves exactly as the stock service does.
 */
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-layerfs-sandbox-policy'

const isDir = (path: string) => { try { return statSync(path).isDirectory() } catch { return false } }
/** A plain name component (no traversal), as LayerFS names Stores, Sandboxes and machines. */
const component = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && value !== '..' ? value : undefined

/** The LayerFS home directories one bound session's managed CLI writes. */
export function sessionHomeRoots(home: string | undefined, binding: { project?: string, sandbox?: string, machine?: string }): string[] {
  if (!home || !existsSync(home)) return []
  const store = component(binding.project?.split('/')[0])
  const sandbox = component(binding.sandbox)
  const machine = component(binding.machine ?? 'native')
  return [
    store && join(home, 'store', store),
    sandbox && join(home, 'sandbox', sandbox),
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
    if (!b || b.state !== 'bound') return base
    const root = b.scratch
    const extra = [...(base.additionalWritableRoots ?? [])]
    const layerfs = (this as any).ctx.get?.('layerfs')
    const receipts = layerfs?.root ? join(layerfs.root, 'invocation-receipts') : undefined
    const owned = sessionHomeRoots(layerfs?.home, b)
    for (const dir of [b.mount, receipts, ...owned]) if (dir && dir !== root && !extra.includes(dir)) extra.push(dir)
    return { ...base, workspaceRoot: root, additionalWritableRoots: extra }
  }
}
