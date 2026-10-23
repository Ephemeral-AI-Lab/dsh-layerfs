// Session records: each traced call is written to the calling agent's own
// Session as an ignorable plugin record, so it travels with the log (fork,
// resume, export) and never reaches the model.
import { appendPluginRecord } from "@deepseek-ai/dsh-session";
import { CALL, PROJECT } from "@dsh-layerfs/model/sources/records.js";

/**
 * @param {object} session the agent's live Session
 * @param {{ agent: { id: string, name: string }, project: string|null, line: object }} data
 */
export function appendCall(session, data) {
  return appendPluginRecord(session, CALL, data);
}

/** Records a root session's project binding when it locks. */
export function appendProject(session, data) {
  return appendPluginRecord(session, PROJECT, data);
}
