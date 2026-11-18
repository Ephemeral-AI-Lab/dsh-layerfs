/**
 * Decode the canonical foreground bash value without rewriting its native tool
 * result (2.0: stdout is one result JSON). `workspace exec` (`exec`) exits with
 * the command's own code beside its result: a non-zero exit (125 included) is
 * the command's when the result's `exit_code` says the same; LayerFS's own
 * refusal (exit 125) prints no result on stdout.
 */
export function parseSimulationBashReceipt(result: any, { exec = false }: { exec?: boolean } = {}): Record<string, any> {
  const value = result?.value
  const exitCode = value?.exitCode
  const commandsOwn = exec && Number.isInteger(exitCode) && exitCode !== 0
  if (result?.isError || value?.kind !== 'foreground' || (exitCode !== 0 && !commandsOwn) || value?.aborted || value?.timedOut || value?.stdout?.truncated || typeof value?.stdout?.text !== 'string') {
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
    receipt = frame; final = true
  }
  if (!final || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Missing complete LayerFS operation receipt')
  if (commandsOwn && (receipt.exit_code !== exitCode || typeof receipt.error === 'string')) throw new Error('The LayerFS command did not return a complete successful result; inspect its tool result before continuing.')
  return receipt
}
