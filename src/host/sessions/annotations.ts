/** The `session.annotations` answer's shape policy, in the sessions adapter. */
import type { SessionSidecar } from '../session-persistence.ts'

/**
 * A sidecar's metadata as the `session.annotations` answer: every stored field
 * except the lazy `invocations` array, which is omitted **without being read**.
 * `readSidecar` keeps that array lazy for exactly this reason — a long session
 * holds tens of MB of receipts, and a metadata reader must not pay for the
 * clone or the serialization. Title, checkpoints, the `receipts` counter and
 * `archive` are plain values and are copied as they are.
 *
 * The projection belongs here, not in the persistence driver (DIP-1): the DSH
 * file format is the driver's business, while the shape of an op answer is the
 * adapter's. The type-only import keeps the shape checked without a runtime
 * dependency on the driver.
 */
export function sidecarMetadata(sidecar: SessionSidecar | undefined): Record<string, any> {
  const meta: Record<string, any> = {}
  if (!sidecar) return meta
  for (const key of Object.keys(sidecar)) if (key !== 'invocations') meta[key] = sidecar[key]
  return meta
}
