/**
 * LayerFS's built-in host machine (layerfs #835): this computer itself, named
 * by its OS (`macos-host` on macOS, `linux-host` on Linux), with platform
 * `host`. Its Sandboxes run on the `process` backend on macOS (host
 * processes over loopback NFS) and on `namespaces` on Linux. LayerFS refuses
 * both names for a new machine or Sandbox, so a name alone says it is the
 * host. Like any machine it can be stopped and started (`machine stop` /
 * `machine start`); a new home starts with it enabled.
 *
 * Prefer the runtime's own answers: a listed machine is the host when its
 * `platform` is `host`. A name is the host when it is one of the two names.
 * {@link hostNameFor} is only for the default a caller needs before it has
 * read anything (a Store with no machine recorded yet, a plan).
 */

export const HOST_PLATFORM = 'host'
/** The macOS host machine's Sandbox backend (Linux's is `namespaces`). */
export const PROCESS_BACKEND = 'process'

export type HostMachineName = 'macos-host' | 'linux-host'

/** Whether a machine name is the host machine's. */
export const isHostName = (name: string | null | undefined): name is HostMachineName =>
  name === 'macos-host' || name === 'linux-host'

/** Whether a machine (a list row, a record) is the host: by its platform, else by its name. */
export const isHostMachine = (m: { name?: string | null, machine?: string | null, platform?: string | null } | null | undefined): boolean =>
  !!m && (m.platform === HOST_PLATFORM || isHostName(m.name ?? m.machine))

/** The host machine's name on an OS: LayerFS's `macos`/`linux` or Node's `darwin`/`linux`; null where there is none (Windows). */
export const hostNameFor = (os: string | null | undefined): HostMachineName | null =>
  os === 'macos' || os === 'darwin' ? 'macos-host' : os === 'linux' ? 'linux-host' : null

/** The host machine among listed machines, by platform. */
export const hostOf = <M extends { name: string, platform?: string | null }>(machines: readonly M[] | null | undefined): M | undefined =>
  (machines ?? []).find((m) => m.platform === HOST_PLATFORM) ?? (machines ?? []).find((m) => isHostName(m.name))
