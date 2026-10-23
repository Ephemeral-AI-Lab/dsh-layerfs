// dsh records source: the Host plugin appends each SDK trace line an agent's
// bash call wrote to that agent's own session, as an ignorable plugin record:
//
//   { type: "plugin:layerfs/call", data: { agent: { id, name }, line } }
//   { type: "plugin:layerfs/project", data: { project, binding } }
//
// `agent.id` is the session id (a subagent's own); `name` is what the views
// show (the subagent's label, or "main" for the root session). The line is
// the SDK trace line unchanged; its `step` is the bash call id (the group).
export const CALL = "plugin:layerfs/call";
export const PROJECT = "plugin:layerfs/project";

/** Trace lines from records, each with `agent` set to the agent's name. */
export function recordLines(records) {
  const out = [];
  for (const r of records) {
    if (!r || r.type !== CALL || !r.data || !r.data.line) continue;
    const agent = r.data.agent || {};
    out.push({ ...r.data.line, agent: agent.name || agent.id || "main", agentId: agent.id || null });
  }
  return out;
}

/** The project a session's records bind it to: the latest project record. */
export function recordProject(records) {
  let project = null;
  for (const r of records) if (r && r.type === PROJECT && r.data) project = r.data.project;
  return project;
}
