/**
 * The sidebar's LayerFS group. DSH's `sidebar.panellist` is a flat list, so
 * the rows under LayerFS (Machines, Storage, Presets) are registered only
 * while the group is unfolded. Clicking the LayerFS row folds or unfolds it;
 * the fold is remembered in this browser.
 */
import type { Source } from '../machines/controller.ts'

const UNFOLDED_KEY = 'dsh-layerfs:sidebar-unfolded'

/** The group's fold, its toggle, and the rows that live under it. */
export interface SidebarGroup {
  /** Whether the rows under LayerFS show. */
  readonly unfolded: Source<boolean>
  toggle(): void
  /**
   * Keep a sidebar registration alive while the group is unfolded.
   * @param register - registers the row and returns its disposer.
   * @returns the disposer for the whole binding.
   */
  whileExpanded(register: () => () => void): () => void
}

function readUnfolded(): boolean {
  try {
    return window.localStorage?.getItem(UNFOLDED_KEY) !== '0'
  } catch (error) {
    // Storage refused (private mode): start unfolded.
    void error
    return true
  }
}

export function createSidebarGroup(): SidebarGroup {
  let value = readUnfolded()
  const listeners = new Set<() => void>()
  const unfolded: Source<boolean> = {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    unfolded,
    toggle() {
      value = !value
      try {
        window.localStorage?.setItem(UNFOLDED_KEY, value ? '1' : '0')
      } catch (error) {
        // The fold still applies to this page; it is just not remembered.
        void error
      }
      for (const l of [...listeners]) l()
    },
    whileExpanded(register) {
      let dispose: (() => void) | undefined
      const sync = (): void => {
        if (value && !dispose) dispose = register()
        else if (!value && dispose) { dispose(); dispose = undefined }
      }
      sync()
      const off = unfolded.subscribe(sync)
      return () => { off(); dispose?.(); dispose = undefined }
    },
  }
}
