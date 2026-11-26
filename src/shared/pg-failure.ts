export type PgFailureKind = 'record' | 'server' | 'login' | 'privilege' | 'store' | 'daemon_dns'

export interface MissingPrivilege {
  role: string
  privilege: string
  count: number | null
}

export function missingPrivilege(message: string | undefined): MissingPrivilege | null {
  const m = /\brole\s+(.+?)\s+lacks\s+(.+?)(?:\s+\((\d+)\s+privilege\(s\)\s+missing(?:\s+in\s+all)?\))?$/i.exec((message ?? '').trim())
  if (!m) return null
  return { role: m[1]!.trim(), privilege: m[2]!.trim(), count: m[3] ? Number(m[3]) : null }
}

const isLoginRejection = (code: string | undefined, text: string): boolean =>
  code === 'Rejected'
  || /\bRejected\b/i.test(text)
  || /password authentication failed|authentication failed|SQLSTATE 28/i.test(text)

export function classifyPgFailure(code: string | undefined, message: string | undefined, step?: string | undefined): PgFailureKind | null {
  const text = message ?? ''
  if (step === 'record' || code === 'Outdated') return 'record'
  if (/pack persistence:\s*Refused\s*\{\s*status:\s*"Closed"\s*\}/i.test(text)) return 'daemon_dns'
  if (step === 'database' || /SQLSTATE 3D000/i.test(text) || text.includes('holds another Store than')) return 'store'
  if (step === 'authentication' || step === 'login') return 'login'
  if (step === 'transport' || step === 'handshake') return 'server'
  if (/\black(s)?\b/i.test(text) && (code === 'Denied' || step === 'write' || step === 'store' || /\brole\s+.+?\s+lacks\b/i.test(text))) return 'privilege'
  if (isLoginRejection(code, text)) return 'login'
  if (/the server refused the session|PostgreSQL server refused the connection/i.test(text)) return null
  if (code === 'Unavailable') return 'server'
  if (code === 'Unknown' && /did not answer in time|timed out/i.test(text)) return 'server'
  if (/cannot reach PostgreSQL Store|PostgreSQL server unreachable|did not answer|timed out|connection refused|no connection to the server|ECONNREFUSED|ETIMEDOUT/i.test(text)) return 'server'
  return null
}

export type SessionFailureCode =
  | 'store_removed'
  | 'machine_blocked'
  | 'store_unresolved'
  | 'store_missing_file'
  | 'pg_no_login'
  | 'pg_outdated'
  | 'pg_unreachable'
  | 'pg_wrong_login'
  | 'pg_privilege'
  | 'pg_store_mismatch'
  | 'pg_daemon_dns'
  | 'store_broken'
  | 'store_busy'
  | 'store_unknown'

export interface SessionFailure {
  readonly code: SessionFailureCode
  readonly store?: string
  readonly machine?: string
  readonly reason?: string
  readonly detail?: string
  readonly fix?: string
  readonly interrupted?: boolean
}
