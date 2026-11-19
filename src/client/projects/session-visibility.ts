/**
 * Match the native DSH history rule: unused drafts are not conversations. The
 * draft open on screen (`openId`) still shows, so a new session from the row's
 * `+` appears, selected, until it is left unused.
 */
export function visibleProjectSessions<T extends { sessionId: string }>(sessions: T[], summaries: Record<string, { blank?: boolean }>, openId?: string): T[] {
  return sessions.filter((session) => session.sessionId === openId || summaries[session.sessionId]?.blank !== true)
}

/**
 * Whether DSH can archive a listed conversation (RV4 FAIL 2): DSH holds it (a
 * local log: `local`), and it is not running (a bound Sandbox, or an
 * execution that is active or activating). A conversation found only in the
 * Store (`stored`, another home's) is not DSH's to archive, so its row offers
 * no Archive.
 */
export function archivable(session: { local?: boolean | undefined, state?: string | undefined, executionState?: string | undefined }): boolean {
  if (session.local !== true || session.state === 'stored') return false
  return session.state !== 'bound' && session.executionState !== 'active' && session.executionState !== 'activating'
}
