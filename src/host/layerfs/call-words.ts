/**
 * How this plugin words and tags a LayerFS call (docs/specs/layerfs-logs.md):
 * the redacted CLI words a receipt keeps, the saved version a 2.0 answer names,
 * the receipt id and its `LAYERFS_LOGS_TAG`, and which calls LayerFS's own call
 * log keeps (only those have their output kept in `<state>/trace/outputs`).
 *
 * `makeReceipt` is self-contained (no imports, no module references) because
 * the managed `bin/sdk.mjs` embeds its source.
 */

/**
 * The call as canonical, redacted CLI words: family, call, positionals, then
 * `--options`; `--` dropped; front-end switches (`--json`, `--progress`,
 * `--events`, `--text`) dropped; Bool options as a bare `--name` when true and
 * nothing when false; content sent on stdin as `<N bytes>` after the
 * positionals. Values of `--message --old --new --password --url`, the
 * `workspace exec` command and `store|backup connect` URLs become `<N bytes>`;
 * other values are cut to 200 characters with `…`.
 */
export function renderCall(argv: readonly string[], inputBytes?: number | null, bools?: readonly string[]): string[] {
  const SWITCHES = ['--json', '--progress', '--events', '--text', '-h', '--help']
  const BOOLS = ['allow-missing', 'discard', 'force', 'include-attribution', 'include-encoding', 'include-storage', 'paths-only', 'stream', 'quick', 'write-test', ...(bools ?? []).map((name) => name.replaceAll('_', '-'))]
  const SECRET = ['message', 'old', 'new', 'password', 'url', 'command', 'key']
  // With the call table's Bool names known, every other option takes the next word, even one
  // starting with `--` (an `--old` text); without it only the redacted names always do.
  const table = !!bools && bools.length > 0
  const size = (value: string) => `<${Buffer.byteLength(value, 'utf8')} bytes>`
  const cut = (value: string) => { const chars = Array.from(value); return chars.length > 200 ? `${chars.slice(0, 200).join('')}…` : value }
  const family = String(argv[0] ?? ''), call = String(argv[1] ?? '').replaceAll('_', '-')
  const positionals: string[] = [], options: string[] = []
  let rest = false
  for (let at = 2; at < argv.length; at++) {
    const word = String(argv[at])
    if (rest || word === '-' || !word.startsWith('-')) { positionals.push(word); continue }
    if (word === '--') { rest = true; continue }
    if (SWITCHES.includes(word)) continue
    let name: string, value: string | undefined, explicit = false
    if (word === '-m') name = 'message'
    else if (word.startsWith('--')) {
      const equal = word.indexOf('=')
      name = equal < 0 ? word.slice(2) : word.slice(2, equal)
      if (equal >= 0) { value = word.slice(equal + 1); explicit = true }
    } else { options.push(cut(word)); continue }
    name = name.replaceAll('_', '-')
    if (value === undefined) {
      if (BOOLS.includes(name) || at + 1 >= argv.length || (String(argv[at + 1]).startsWith('--') && !table && !SECRET.includes(name))) { options.push(`--${name}`); continue }
      value = String(argv[++at])
    }
    if ((explicit || BOOLS.includes(name)) && (value === 'true' || value === 'false')) { if (value === 'true') options.push(`--${name}`); continue }
    options.push(`--${name}`, SECRET.includes(name) ? size(value) : cut(value))
  }
  const secretAt = (family === 'workspace' && call === 'exec') || ((family === 'store' || family === 'backup') && call === 'connect') ? 1 : -1
  const words = positionals.map((word, index) => index === secretAt ? size(word) : cut(word))
  if (typeof inputBytes === 'number' && inputBytes >= 0) words.push(`<${inputBytes} bytes>`)
  return [family, call, ...words, ...options]
}

/**
 * A receipt's `kind` (the display word for what the call did, see
 * `displayKind`) and the saved version a 2.0 answer names: every saving call answers `commit` (66 hex) and
 * `unchanged` when nothing was made. A publication's Commit is main's, kept
 * as `layer`.
 */
export function savedFields(argv: readonly string[], result: any): { kind?: string, commit?: string, layer?: string } {
  const out: { kind?: string, commit?: string, layer?: string } = {}
  if (!result || typeof result !== 'object' || Array.isArray(result)) return out
  const id = typeof result.commit === 'string' && /^[a-f0-9]{66}$/.test(result.commit) ? result.commit as string : undefined
  if (!id) return out
  const operation = `${argv[0] ?? ''}.${String(argv[1] ?? '').replaceAll('-', '_')}`
  const unchanged = result.unchanged === true
  const saves = ['file.write', 'file.edit', 'file.apply', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp', 'workspace.commit']
  if (saves.includes(operation)) return { kind: unchanged ? 'UpToDate' : 'Committed', commit: id }
  if (operation === 'branch.fork') return { kind: 'Forked', commit: id }
  if (operation === 'branch.merge') return { kind: unchanged ? 'UpToDate' : 'Merged', commit: id }
  if (operation === 'branch.publish') return { kind: unchanged ? 'UpToDate' : 'Added', layer: id }
  return out
}

/**
 * One receipt id and its tag `dsh:<sessionId>:<receiptId>`. The id is
 * `<scope>.<random>` inside a tool call (scope names the call) and `<random>`
 * otherwise. The random part shrinks to keep the tag within 128 bytes; a tag
 * that still does not fit, or holds control characters, is left out.
 */
export function makeReceipt(sessionId: string, scope: string | undefined, random: string): { id: string, tag?: string } {
  const prefix = `dsh:${sessionId}:${scope ? `${scope}.` : ''}`
  const room = 128 - Buffer.byteLength(prefix, 'utf8')
  const id = `${scope ? `${scope}.` : ''}${random.slice(0, Math.max(8, Math.min(random.length, room)))}`
  const tag = `dsh:${sessionId}:${id}`
  // eslint-disable-next-line no-control-regex
  return Buffer.byteLength(tag, 'utf8') <= 128 && !/[\u0000-\u001f\u007f]/.test(tag) ? { id, tag } : { id }
}

/**
 * Whether LayerFS's own call log keeps a line for this call, so the plugin
 * tags it and keeps its output: calls that are not table calls write no line
 * (#659 L1, L10); nor does the `logs` family, nor the quiet calls (the log's
 * reader and clearer, and the monitoring reads `sandbox files`, `machine files`,
 * `machine stats`, `machine log`; layerfs-project#178), so a poll or a folder
 * read adds nothing to the Logs page.
 */
export function loggable(argv: readonly string[]): boolean {
  if (!(argv.length >= 2 && /^[a-z][a-z_]*$/.test(argv[0] ?? '') && /^[a-z][a-z_-]*$/.test(argv[1] ?? ''))) return false
  if (argv[0] === 'help' || argv[0] === 'logs') return false
  // the 2.0 calls LayerFS's own log skips (their rows say `quiet`): the call log's reader and clearer, and the monitoring reads
  if (argv[0] === 'home' && ['log', 'clear-log', 'clear_log'].includes(argv[1] ?? '')) return false
  if (argv[0] === 'machine' && ['stats', 'log'].includes(argv[1] ?? '')) return false
  return !((argv[0] === 'sandbox' || argv[0] === 'machine') && argv[1] === 'files')
}
