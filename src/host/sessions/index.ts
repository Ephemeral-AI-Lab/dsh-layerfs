/**
 * Project + scratch-folder workspaces, session binding, checkpoints and the
 * LayerFS session store. STUB: built by the sessions workstream.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-layerfs-sessions'
export const inject = ['layerfs', 'layerfsRemote']

export function apply(_ctx: Context): void {}
