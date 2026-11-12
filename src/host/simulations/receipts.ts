/** Decode the canonical foreground bash value without rewriting its native tool result. */
export function parseSimulationBashReceipt(result: any, { events = false }: { events?: boolean } = {}): Record<string, any> {
  const value = result?.value
  if (result?.isError || value?.kind !== 'foreground' || value?.exitCode !== 0 || value?.aborted || value?.timedOut || value?.stdout?.truncated || typeof value?.stdout?.text !== 'string') {
    throw new Error('The LayerFS command did not return a complete successful result; inspect its tool result before continuing.')
  }
  const lines = value.stdout.text.trim().split('\n').filter((line: string) => line.trim())
  let receipt: any
  let final = false
  for (const line of lines) {
    let frame: any
    try { frame = JSON.parse(line) } catch { throw new Error('Malformed LayerFS JSON receipt') }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid LayerFS receipt frame')
    if (final) throw new Error('LayerFS emitted data after its final result')
    if (!events) { receipt = frame; final = true; continue }
    if ('result' in frame || 'refusal' in frame) {
      final = true
      if (frame.refusal !== undefined && frame.refusal !== null) throw new Error('LayerFS refused the requested operation')
      receipt = frame.result
    } else if ('progress' in frame) {
      // Progress stays in the real tool output; it has no saved-version meaning.
    } else if (!['stdout', 'stderr'].includes(frame.stream) || !Object.hasOwn(frame, 'bytes')) {
      throw new Error('Unknown LayerFS execution frame')
    }
  }
  if (!final || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Missing complete LayerFS operation receipt')
  return receipt
}
