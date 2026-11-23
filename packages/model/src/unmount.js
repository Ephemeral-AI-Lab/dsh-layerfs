// The normal unmount's abort-path observation (layerfs #501,
// tokenaissance/layerfs#2) as an Entities value: the `unmount` telemetry
// section a daemon puts in a traced unmount's `Observed` reply, which the SDK
// trace line carries under `daemon`. An unmount that never stalled carries no
// section, and no other call carries one.
//
//   daemon: [{ timing: [...], unmount: {
//     stage: "Join" | "Abort" | "Revoke" | "Close",
//     abort: "Written" | "Short" | "Failed",
//     bytes: <a Short write's count>, errno: <a Failed write's errno>,
//     detached, loops_exited, loops_joined, active, retained, waited_ms } }]
//
// Plain data with no I/O: the use case counts it (unmount-count.js) and the
// Host's adapter journals it (packages/host/src/unmount-journal.js).

/** The boundaries the daemon reports; any other value is still counted. */
export const STAGES = Object.freeze(["Join", "Abort", "Revoke", "Close"]);
/** The abort write's dispositions; any other value is still counted. */
export const ABORTS = Object.freeze(["Written", "Short", "Failed"]);
/** The section's stable keys, in the daemon's order; `bytes` or `errno` is present, never both. */
export const KEYS = Object.freeze(["stage", "abort", "bytes", "errno", "detached", "loops_exited", "loops_joined", "active", "retained", "waited_ms"]);

/** The abort-path section of a trace line's daemon telemetry, or null. */
export function sectionOf(line) {
  const telemetry = Array.isArray(line?.daemon) ? line.daemon : [];
  for (const report of telemetry) {
    const section = report?.unmount;
    if (section && typeof section === "object") return section;
  }
  return null;
}

// a counter the daemon sends as a nonnegative integer; anything else is no count
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/**
 * The outcome a traced unmount reports: the section's stable facts, plus the
 * reply that carried it (`Unmounted` on success, or the refusal's code, which
 * a retained stop answers as `Failed`), and nothing else. Null for a line
 * with no section, or a section with no string `stage` or `abort`.
 * @param {object} line an SDK trace line (its end phase)
 */
export function outcomeOf(line) {
  const section = sectionOf(line);
  if (!section || typeof section.stage !== "string" || typeof section.abort !== "string") return null;
  return {
    stage: section.stage,
    abort: section.abort,
    // a Short write owns its byte count; a Failed write owns its errno; never both
    ...(section.abort === "Short" ? { bytes: count(section.bytes) } : {}),
    ...(section.abort === "Failed" ? { errno: typeof section.errno === "string" ? section.errno : "" } : {}),
    detached: section.detached === true,
    loopsExited: count(section.loops_exited),
    loopsJoined: count(section.loops_joined),
    active: count(section.active),
    retained: count(section.retained),
    waitedMs: count(section.waited_ms),
    reply: line?.ok === true ? (typeof line.kind === "string" ? line.kind : "Unmounted") : (typeof line.code === "string" ? line.code : "Failed"),
  };
}
