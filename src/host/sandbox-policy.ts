/**
 * DSH's sandbox policy with LayerFS session roots. Replaces the `sandbox-policy`
 * row (bundle patch): for a session bound by dsh-layerfs, the workspace-write
 * root is the session's own Workspace mount (its working directory) instead of
 * `header.cwd`, and the project's scratch-folder workspace stays writable. Every
 * other session resolves exactly as the stock service does.
 */
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'

export const name = 'dsh-layerfs-sandbox-policy'

export default class LayerfsSandboxPolicy extends (SandboxPolicyService as any) {
  resolve(request: any = {}): any {
    const base = super.resolve(request)
    const id = request?.session?.id
    if (!id) return base
    const sessions = (this as any).ctx.get?.('layerfsSessions')
    let b = sessions?.binding?.(String(id))
    if (b?.kind === 'shared' && b.parent) b = sessions.binding(b.parent) ?? b
    if (!b || b.state !== 'bound') return base
    const root = b.kind === 'project' && b.mount ? b.mount : b.scratch
    const extra = [...(base.additionalWritableRoots ?? [])]
    for (const dir of [b.anchor, b.scratch]) if (dir && dir !== root && !extra.includes(dir)) extra.push(dir)
    return { ...base, workspaceRoot: root, additionalWritableRoots: extra }
  }
}
