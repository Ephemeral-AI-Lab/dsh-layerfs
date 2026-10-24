// What the terminals print under each command line (cli.js has the command
// lines and which terminal prints each call), and the bubble over the agent
// that made it. Plain data; the views escape and colour it (classes "good",
// "bad", "mark", "dim").

/** Terminal engine line classes, as the views name them. */
export const LINE_CLASS = { err: "bad", warn: "mark", ok: "good", info: "good" };
export const outLines = (rec) => rec.lines.map((x) => ({ t: x.t, c: LINE_CLASS[x.c] || "" }));
export const callsOf = (rec, skip) =>
  rec.calls
    .filter((c) => !skip || !skip.has(c.call))
    .map((c) => ({ call: c.call, code: c.outcome.code, timing: c.outcome.timing, script: c.script }));

/** The node a call created, for attribution and the flying block. */
export function nodeOf(o) {
  if (!o.ok) return null;
  const r = o.result;
  return o.code === "Committed" || o.code === "Merged"
    ? r.head
    : o.code === "Added"
      ? r.publishedLayer.id
      : o.code === "Initialized"
        ? r.main.headLayer
        : null;
}

/** Outcome lines under a command. Live and replayed results carry fewer
 * fields than the simulator's, so anything else is optional here. */
export function outcome(call, o, shOut, args = {}) {
  const L = (t, c = "") => ({ t, c });
  if (shOut) {
    const out = shOut.map((x) => L(x.t, /^(<{7}|={7}|>{7})/.test(x.t) ? "mark" : x.c === "err" ? "bad" : ""));
    if (o.ok && o.result.truncated) out.push(L("… output truncated at 1 MiB per stream", "dim"));
    out.push(
      !o.ok
        ? L(`✕ ${o.code}  ${o.refusal.message}`, "bad")
        : o.result.process
          ? L(`● running in background as ${o.result.process}`, "good")
          : L(`[exit ${o.result.exitCode}]`, o.result.exitCode ? "bad" : "good"),
    );
    return out;
  }
  if (!o.ok)
    return [
      L(`✕ ${o.code}  ${o.refusal.message}`, "bad"),
      ...(o.refusal.conflicts || []).map((c) => L(`  conflict ${c.path}`, "mark")),
    ];
  const r = o.result;
  switch (o.code) {
    case "Initialized":
      return [L(`Initialized ${r.project} → main @ ${r.main.headLayer}`, "good")];
    case "Forked":
      return [L(`${r.branch} ← ${r.head || r.base}`, "good")];
    case "Committed":
      return [
        L(
          `Committed ${r.head}${r.merged ? ` · merged with ${r.merged.head || r.merged.from || "the head"}` : ""}`,
          "good",
        ),
      ];
    case "UpToDate":
      return [L("UpToDate · nothing new to commit")];
    case "Merged":
      return [
        L(`Merged → ${r.branch} @ ${r.head}${r.fastForward ? " · fast-forward" : ""} · inputs untouched`, "good"),
      ];
    case "Added":
      return [
        L(
          `Published ${r.source ? `${r.source.branch}@${r.source.commit}` : args.branch} → main @ ${r.publishedLayer.id}`,
          "good",
        ),
      ];
    case "Mounted":
      return [L(`mounted ${r.branch}@${r.base} → ${r.sandbox}:${r.path}`)];
    case "Unmounted":
      return [L("unmounted")];
    case "Stopped":
      return [L(`${r.process} ${r.status || "stopped"}`)];
    case "Ready":
      return [L(`Ready ${r.id} · a new machine with its own localhost`, "good")];
    case "Closed":
      return [L(`Closed ${r.id}`)];
  }
  // a replayed call has ids, never content
  if (o.replay) {
    if (r.process) return [L(`● running in background as ${r.process}`, "good")];
    if (call === "sandbox.exec") return [L(`[exit ${r.exitCode}]`, r.exitCode ? "bad" : "good")];
    return [L(o.code)];
  }
  if (call === "fs.read")
    return [L(`${(r.text || "").split("\n").length} lines${r.snapshot ? " · " + r.snapshot : ""}`)];
  if (call === "process.cancel") return [L(`${args.process} stopped`)];
  return [L(o.code)];
}

/** The bubble over an agent after its call: [text, class], or null. */
export function bubbleOf(last) {
  const o = last.o,
    r = o.result;
  if (!o.ok) return [o.code === "Conflict" ? "Conflict!" : o.code, "bad"];
  if (o.code === "Committed") return [r.head, "good"];
  if (o.code === "Merged") return [`merge → ${r.head}`, "good"];
  if (o.code === "Added") return [`→ ${r.publishedLayer.id}`, "good"];
  if (o.code === "Forked") return ["fork", ""];
  if (o.code === "Mounted") return ["mount", ""];
  if (o.code === "Ready") return [`+ ${r.id}`, "good"];
  if (o.code === "Closed") return [`× ${r.id}`, ""];
  if (o.code === "running") return ["● dev server", "good"];
  if (o.code === "Stopped" || last.call === "process.cancel") return ["■ stopped", ""];
  if (last.call === "sandbox.exec" && r && r.process) return ["● dev server", "good"];
  if (last.call === "sandbox.exec" && r && r.exitCode != null)
    return r.exitCode
      ? [`exit ${r.exitCode}`, "bad"]
      : /npm (test|run test)/.test((last.step && last.step.sh) || "")
        ? ["✓ tests", "good"]
        : null;
  return null;
}
