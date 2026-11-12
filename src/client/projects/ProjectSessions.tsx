import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { messageOf } from '../picker/NewProjectForm.tsx'
import { useProjectSessions } from './hooks.ts'
import { ReadDeadlineError } from './read-deadline.ts'
import type { ProjectsT } from './locale.ts'
import css from './projects.module.css'

/** Session archives load independently; one unavailable project cannot hide the others. */
export function ProjectSessions({ api, project, projectId, t }: { api: LayerfsApi, project: string, projectId?: string, t: ProjectsT }): ReactNode {
  const read = useProjectSessions(api, project, true, projectId)
  const [error, setError] = useState<string | null>(null)
  const openSession = async (sessionId: string) => {
    setError(null)
    try { await api.op('sessions.open', { sessionId, project }) }
    catch (error) { setError(messageOf(error)) }
  }
  const when = (at: number) => at ? new Date(at).toLocaleString() : ''
  const sessions = read.sessions
  return <>
    {error ? <div className={css.emptySessions} role="alert">{t('actionFailed', { message: error })}</div> : null}
    {read.error ? <div className={css.emptySessions} role="alert">
      {t('archiveFailed', { message: read.error instanceof ReadDeadlineError ? t('readTimedOut') : messageOf(read.error) })}
      <Button variant="outline" size="sm" onClick={read.reload}>{t('retry')}</Button>
    </div> : read.loading ? <div className={css.emptySessions} role="status">{t('archiveLoading')}</div> : null}
    {!read.error && !read.loading && !sessions.length ? <div className={css.emptySessions}>{t('noSessions')}</div> : null}
    <ul className={css.rows}>
      {sessions.map((session) => (
        <li key={session.sessionId}>
          <button type="button" className={css.row} onClick={() => void openSession(session.sessionId)}>
            <span className={css.rowMain}>
              <span className={css.rowTitle}>{session.title ?? t('sessionUntitled')}</span>
              {!session.local ? <span className={css.rowSub}>{t('storedHint')}</span> : null}
            </span>
            <span className={css.rowMeta}>
              {session.executionState === 'interrupted' ? <span className={css.rowInterrupted} title={session.error ?? t('interruptedHint')}>{t('interrupted')}</span> : null}
              {!session.local ? <span title={t('storedHint')}>{t('stored')}</span> : null}
              <span>{when(session.updatedAt)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  </>
}
