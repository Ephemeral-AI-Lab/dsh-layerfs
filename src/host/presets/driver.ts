/**
 * The preset runner's CLI driver (Connect `tools/demo/drivers.mjs` `CliDriver`):
 * one raw argv per pinned-CLI process, reported as it starts. Preset calls
 * use their own admission lane, so Machines/Storage page reads are not
 * queued behind a build's history commands.
 */
import { discover, execute, type CliSpec } from '../layerfs/cli.ts'

/** What the runner, build and environment reset read from their driver. */
export interface PresetSpec extends CliSpec {
  /** The preset state folder (manifest, step journal, sample sources, receipts). */
  readonly state: string
  /** The matching native daemon, if pinned. */
  readonly daemon: string | null
}

export class CliDriver {
  /** Raised by the history scheduler while it runs (at most 16). */
  concurrency: number | undefined
  constructor(readonly spec: PresetSpec, private readonly report: (line: string) => void = () => {}) {}

  discover(): Promise<unknown> { return discover({ cli: this.spec.cli }) }

  invoke(argv: readonly string[], { input, read = false }: { input?: string, read?: boolean, onInvocation?: unknown } = {}): Promise<any> {
    this.report(`CLI: layerfs ${argv.join(' ')}`)
    const call = `${argv[0]}.${argv[1]}`
    const storeRead = read && ['file', 'branch', 'commit', 'project'].includes(argv[0]!) ? argv[2]?.split('/')[0] : undefined
    return execute(this.spec, argv, {
      input, read, storeRead, timeout: 120_000,
      lane: { name: 'presets', limit: Math.max(4, this.concurrency ?? 4) },
      onProgress: (progress: any) => { if (progress?.phase) this.report(`  ${call}: ${progress.phase}`) },
    })
  }
}
