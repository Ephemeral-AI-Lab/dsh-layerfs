/**
 * The setup check's state in the browser (docs/specs/layerfs-setup.md §3-§4):
 * the host's `setup.status` answer, read on `setup-changed` / `runtime-changed`
 * events, and the Set up LayerFS modal's open state. Any view opens the modal
 * with `setupDialog.open(section)`; Later is remembered per viewer.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { LayerfsApi } from '../api.ts'
import { afterFirstPaint } from '../ui/first-paint.ts'
import { useQuery } from '../ui/use-query.ts'

/** A piece's verdict against the CLI's build. */
export type Verdict = 'matches' | 'other' | 'unknown' | 'missing'

export interface Piece {
  readonly path: string | null
  readonly commit: string | null
  readonly dirty: boolean | null
  readonly verdict: Verdict
}

/** `outdated`: an older LayerFS's folder, which LayerFS 2.0 does not convert (moved aside by hand, `fix`). */
export type HomeState = 'missing' | 'current' | 'outdated' | 'unknown'
export type SetupNeed = 'runtime' | 'folder' | 'build'

/** `setup.status` (host service.ts `SetupStatus`). */
export interface SetupStatus {
  readonly at: number
  readonly runtime: {
    readonly ok: boolean
    readonly cli: string | null
    readonly daemon: string | null
    readonly bundle: string | null
    readonly home: string
    readonly source: 'config' | 'settings' | 'env' | 'home' | 'none'
    readonly version: string | null
    readonly commit: string | null
    /** The Store formats this build writes, by engine (LayerFS #804); null or absent from a build that does not say. */
    readonly formats?: Readonly<Record<string, number>> | null
    readonly sdk: { readonly dir: string, readonly commit: string } | null
    readonly sdkDir: string | null
    readonly error: { readonly code: string, readonly message: string } | null
  }
  readonly folder: {
    readonly path: string
    readonly state: HomeState
    readonly layout: number | null
    readonly mode: string | null
    readonly modeOk: boolean | null
    readonly did: { readonly created: boolean, readonly at: number } | null
    /** A folder that is not ready, in LayerFS's words (`home get` `message` and `fix`). */
    readonly message?: string | null
    readonly fix?: string | null
    /** The LayerFS folder (docs/specs/layerfs-folder.md) and where it came from. */
    readonly root: string
    readonly rootSource: 'config' | 'env' | 'pointer' | 'default'
    /** A folder chosen in the setup modal that takes effect after a restart, or null. */
    readonly next: string | null
    /** The DSH x LayerFS home: its path, `<root>/dsh` when another DeepSeek Harness owns it, where it moved from. */
    readonly dsh: { readonly path: string, readonly taken: string | null }
  }
  readonly pieces: { readonly cli: Piece | null, readonly daemon: Piece | null, readonly bundle: Piece | null }
  readonly warnings: readonly { readonly code: string, readonly message: string }[]
  readonly needs: readonly SetupNeed[]
  readonly mixedAllowed: boolean
  readonly daemonRecordable: boolean
  readonly error: { readonly code: string, readonly message: string } | null
}

/** `runtime.installed` (host service.ts `InstalledView`). */
export interface InstalledRuntime {
  readonly id: string
  readonly cli: string
  readonly daemon: string | null
  readonly bundle: string | null
  readonly at: number
  readonly version: string | null
  readonly commit: string | null
  readonly dirty: boolean | null
  readonly pieces: { readonly daemon: Piece | null, readonly bundle: Piece | null }
  readonly sdk: boolean
  readonly active: boolean
  readonly error: string | null
}

/** How long the folder reads "created just now" after the setup check did it. */
export const JUST_NOW_MS = 10 * 60_000

/** What the setup check did to the folder lately (created it), else null. */
export const lately = (s: SetupStatus): 'created' | null => {
  const did = s.folder.did
  if (!did || Date.now() - did.at > JUST_NOW_MS) return null
  return did.created ? 'created' : null
}

/** The modal's sections, top to bottom (the rail). */
export type SetupSection = 'runtime' | 'folder' | 'machines'

let open: SetupSection | null = null
let laterShown = false
const listeners = new Set<() => void>()
const notify = () => { for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

const LATER_KEY = 'dsh-layerfs:setup-later'

/** Opening, closing and Later of the Set up LayerFS modal. */
export const setupDialog = {
  /** Open the modal at a section (Runtime when none is named). */
  open(section: SetupSection = 'runtime'): void { open = section; notify() },
  close(): void { if (open) { open = null; notify() } },
  get: (): SetupSection | null => open,
  subscribe,
  /** Later: closes the modal and remembers it for this viewer (Center keeps a "Finish setting up" card). */
  later(): void {
    try { window.localStorage?.setItem(LATER_KEY, String(Date.now())) } catch { /* per-viewer convenience only */ }
    open = null
    notify()
  },
  /** Whether this viewer chose Later (the modal does not open by itself). */
  deferred(): boolean {
    try { return !!window.localStorage?.getItem(LATER_KEY) } catch { return false }
  },
  /** Done: forget Later. */
  done(): void {
    try { window.localStorage?.removeItem(LATER_KEY) } catch { /* per-viewer convenience only */ }
    open = null
    notify()
  },
  /** Opens by itself at most once per page load, and only when something required is missing. */
  autoOpen(status: SetupStatus | null): void {
    if (laterShown || !status || status.needs.length === 0 || this.deferred()) return
    laterShown = true
    const first: SetupSection = status.needs.includes('runtime') || status.needs.includes('build') ? 'runtime' : 'folder'
    if (!open) { open = first; notify() }
  },
}

/** The modal's open section, or null. */
export function useSetupDialog(): SetupSection | null {
  return useSyncExternalStore(subscribe, () => open)
}

const EVENTS = ['setup-changed', 'runtime-changed', 'connection']

/**
 * How long a `setup.status` answer may serve the sidebar's other mounts (the
 * modal, Home's decoration). The check changes only on setup events, which
 * clear the shared answer; 10 s covers the boot→panel gap on the shared 3194
 * rig (2.7 s when quiet, ~7 s under load). While the modal is open its 5 s
 * poll and Check/Check again are forced reads, so being open never waits out
 * this age. This is a client answer age, not a host TTL.
 */
export const SETUP_SHARE_MAX_AGE_MS = 10_000

/**
 * `setup.status`, kept across remounts and reread on setup events; `visible`
 * also rereads every 5 s while the page is visible (the modal, Settings).
 * `afterPaint` holds the first read for {@link afterFirstPaint}: Home's second
 * mount decorates the first card, while the boot mount decides whether the
 * setup modal opens at once, so only one of them may run at first paint. The
 * read is shared while in flight, and it still starts on mount and is fresh.
 */
export function useSetupStatus(api: LayerfsApi, visible = false, afterPaint = false) {
  const [tick, bump] = useTick()
  /** Set by `check`: Check/Check again is a forced read, past the shared answer. */
  const forced = useRef(false)
  const load = () => {
    const options = forced.current
      ? { share: true as const, fresh: true }
      : { share: { maxAgeMs: SETUP_SHARE_MAX_AGE_MS } }
    forced.current = false
    return api.op<SetupStatus>('setup.status', undefined, options)
  }
  const read = useQuery(
    () => (afterPaint ? afterFirstPaint().then(load) : load()),
    [api, afterPaint],
    { refresh: [tick], cache: 'op setup.status' },
  )
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    // coalesced: a save emits runtime-changed and setup-changed together
    const offs = EVENTS.map((type) => api.onEvent(type, () => { clearTimeout(timer); timer = setTimeout(bump, 500) }))
    return () => { clearTimeout(timer); for (const off of offs) off() }
  }, [api])
  useEffect(() => {
    if (!visible) return
    // The open modal's own 5 s poll is a read, not a share: it must see a
    // runtime or folder change that no event reported.
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      forced.current = true
      bump()
    }, 5000)
    return () => clearInterval(id)
  }, [visible])
  // Check/Check again reads the host; an event tick (`bump`) may reuse a recent answer.
  const check = () => { forced.current = true; bump() }
  return { ...read, check }
}

/** `runtime.installed`, reread on setup events. */
export function useInstalled(api: LayerfsApi) {
  const [tick, bump] = useTick()
  const read = useQuery(() => api.op<{ runtimes: InstalledRuntime[], pinned: string | null, source: string, root: string }>('runtime.installed'), [api], { refresh: [tick], cache: 'op runtime.installed' })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const offs = ['setup-changed', 'runtime-changed'].map((type) => api.onEvent(type, () => { clearTimeout(timer); timer = setTimeout(bump, 500) }))
    return () => { clearTimeout(timer); for (const off of offs) off() }
  }, [api])
  return { ...read, check: bump }
}

function useTick(): [number, () => void] {
  const [n, set] = useState(0)
  return [n, () => set((x) => x + 1)]
}
