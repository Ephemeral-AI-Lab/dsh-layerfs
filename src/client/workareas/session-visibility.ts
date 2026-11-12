/** Match the native DSH history rule: unused drafts are not conversations. */
export function visibleProjectSessions<T extends { sessionId: string }>(sessions: T[], summaries: Record<string, { blank?: boolean }>): T[] {
  return sessions.filter((session) => summaries[session.sessionId]?.blank !== true)
}
