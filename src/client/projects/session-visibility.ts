/**
 * Match the native DSH history rule: unused drafts are not conversations. The
 * draft open on screen (`openId`) still shows, so a new session from the row's
 * `+` appears, selected, until it is left unused.
 */
export function visibleProjectSessions<T extends { sessionId: string }>(sessions: T[], summaries: Record<string, { blank?: boolean }>, openId?: string): T[] {
  return sessions.filter((session) => session.sessionId === openId || summaries[session.sessionId]?.blank !== true)
}
