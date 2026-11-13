/**
 * DSH's stock Trajectory in LayerFS mode (docs/specs/layerfs-trajectory.md §2).
 *
 * DSH's tab row lists every `conversation.view` entry of an id, shadowed ones
 * included, so the LayerFS trajectory cannot simply shadow the stock tab. While
 * LayerFS mode is on, this suspends the stock row's browser entry
 * (`@deepseek-ai/dsh-client-ui-trajectory`) through the cordis Loader's public
 * `Entry.update({ disabled })`: its tab, Conversation target and stores go away
 * with its fiber, and come back when the entry is enabled again in DSH mode.
 * Nothing is persisted: the bundle row and the host half stay as they are, and
 * a reload starts in DSH mode.
 *
 * Chat's "Inspect" opens the view whose Conversation target has
 * `toolCallFocus`; while the stock target is gone this registers the same
 * target (no event definitions feed it: the LayerFS view reads
 * `session.trajectory`).
 */
import { TRAJECTORY_VIEW } from './TrajectoryView.tsx'

const STOCK_PACKAGE = '@deepseek-ai/dsh-client-ui-trajectory'

interface LoaderEntry {
  readonly options: { name?: string, disabled?: unknown }
  readonly disabled: boolean
  update(options: { disabled: true | null }): Promise<void>
}

export interface StockTrajectory {
  /** Suspend the stock entry and seat the inspection target; false when there was no live stock entry. */
  suspend(): Promise<boolean>
  /** Re-enable the entry this suspended, after removing the inspection target. */
  resume(): Promise<void>
}

export function stockTrajectory(ctx: any): StockTrajectory {
  let suspended: LoaderEntry | null = null
  let target: (() => void) | null = null

  const find = (): LoaderEntry | undefined => {
    const loader = ctx.get?.('loader')
    if (typeof loader?.entries !== 'function') return undefined
    for (const entry of loader.entries() as Iterable<LoaderEntry>) {
      if (entry?.options?.name === STOCK_PACKAGE && typeof entry.update === 'function') return entry
    }
    return undefined
  }

  const seatTarget = () => {
    const views = ctx.get?.('uiConversation')?.views
    if (typeof views?.register !== 'function') return
    try {
      target = views.register({
        target: TRAJECTORY_VIEW,
        toolCallFocus: (callId: string) => callId,
        create: () => ({ empty: null, replace: () => null, apply: () => null }),
      })
    } catch {
      // The stock target is still seated (its fiber did not stop): Inspect keeps using it.
      target = null
    }
  }

  return {
    async suspend() {
      if (suspended) return true
      const entry = find()
      // Disabled by the bundle or by someone else: not ours to toggle.
      if (!entry || entry.disabled) return false
      await entry.update({ disabled: true })
      suspended = entry
      seatTarget()
      return true
    },
    async resume() {
      target?.()
      target = null
      const entry = suspended
      suspended = null
      if (entry) await entry.update({ disabled: null })
    },
  }
}
