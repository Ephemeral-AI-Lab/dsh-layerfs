/**
 * The sidebar's Projects page: every LayerFS project as a card holding its
 * sessions. A session opens with `sessions.open` (imported first when it is
 * only stored in the project); "New session" goes through
 * `openProjectSession`, which places the session in the selected workspace —
 * no project workspaces are made. Plain folder workspaces stay in the
 * Workspaces list — this page is the LayerFS half of the sidebar.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { listProjects, messageOf, NewProjectForm, remoteMachine, waitProject, type ProjectInitJob, type ProjectRow } from '../picker/NewProjectForm.tsx'
import type { PickerKey } from '../picker/locale.ts'
import { useHostEvents } from '../storage/hooks.ts'
import { useQuery } from '../files/use-query.ts'
import { Card, Empty, Loading, Page, PageHead, Section } from '../ui/index.tsx'
import css from './projects.module.css'
import type { ProjectsT } from './locale.ts'

interface SessionRow {
  sessionId: string
  title: string | null
  local: boolean
  updatedAt: number
}

interface ProjectEntry {
  project: ProjectRow
  sessions: SessionRow[] | null
  sessionsError: string | null
}

type Translate<K extends string> = (key: K, params?: Record<string, string | number>) => string

const nameOf = (key: string) => key.split('/')[1] ?? key

export function ProjectsPage({ api, t, tp }: { api: LayerfsApi, t: ProjectsT, tp: Translate<PickerKey> }): ReactNode {
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [running, setRunning] = useState<{ key: string, error: string | null } | null>(null)

  const read = useQuery(async (): Promise<{ entries: ProjectEntry[], scratchKey: string | null }> => {
    const { rows, scratchKey } = await listProjects(api)
    const projects = (rows ?? []).filter((r) => r.key !== scratchKey)
    const entries = await Promise.all(projects.map(async (project) => {
      try {
        const list = await api.op<{ sessions: SessionRow[] }>('sessions.list', { project: project.key })
        return { project, sessions: list.sessions ?? [], sessionsError: null }
      } catch (error) {
        return { project, sessions: null, sessionsError: messageOf(error) }
      }
    }))
    return { entries, scratchKey }
  }, [api])
  useHostEvents(api, ['layerfs-session', 'layerfs-workspaces-changed', 'storage'], () => read.reload())

  const follow = async (job: ProjectInitJob, key: string) => {
    setDialog(null)
    setRunning({ key, error: null })
    try {
      await waitProject(api, job)
      setRunning(null)
      await api.openProjectSession(key)
    } catch (error) {
      setRunning({ key, error: messageOf(error) })
    }
  }

  const openSession = (entry: ProjectEntry, session: SessionRow) => {
    void api.op('sessions.open', { sessionId: session.sessionId, project: entry.project.key, workspaceId: api.selectedWorkspaceId() })
  }
  const newSession = (entry: ProjectEntry) => {
    setBusy(entry.project.key)
    void api.openProjectSession(entry.project.key).finally(() => setBusy(null))
  }

  const when = (at: number) => at ? new Date(at).toLocaleString() : ''

  return (
    <Page label={t('title')}>
      <PageHead title={t('title')} intro={t('intro')} actions={(
        <>
          <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={() => setDialog('new')}>{t('newEmpty')}</Button>
          <Button variant="outline" size="sm" icon={<IconFolderOpenOutlineRegular size={13} />} onClick={() => setDialog('import')}>{t('importProject')}</Button>
        </>
      )} />
      {running ? (
        <div className={css.emptySessions} role={running.error ? 'alert' : 'status'}>
          {running.error ? t('importFailed', { message: running.error }) : (
            <span className={css.rowMeta}><StateDot state="ongoing" size={12} /> {t('importing', { name: nameOf(running.key) })}</span>
          )}
        </div>
      ) : null}
      {read.loading && !read.data ? <Loading label={t('loading')} />
        : read.error ? (
          <Card tone="danger">
            <div className={css.emptySessions} role="alert">{t('loadFailed', { message: messageOf(read.error) })}</div>
            <div className={css.emptySessions}><Button variant="outline" size="sm" onClick={read.reload}>{t('retry')}</Button></div>
          </Card>
        )
        : !read.data?.entries.length ? <Empty title={t('emptyTitle')} icon={<LayerfsGlyph size={28} />}>{t('emptyBody')}</Empty>
        : (
          <div className={css.list}>
            {read.data.entries.map((entry) => {
              const remote = remoteMachine(entry.project)
              return (
                <Section key={entry.project.key} headless title={entry.project.name ?? nameOf(entry.project.key)}>
                  <Card>
                  <div className={css.head}>
                    <span className={css.headIcon}><LayerfsGlyph size={16} /></span>
                    <div className={css.headMain}>
                      <span className={css.headTitle}>{entry.project.name ?? nameOf(entry.project.key)}</span>
                      <span className={css.headSub}>
                        {remote ? t('onMachine', { machine: remote }) : entry.project.store ?? entry.project.key.split('/')[0]}
                      </span>
                    </div>
                    <span className={css.headActions}>
                      <Button variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === entry.project.key}
                        onClick={() => newSession(entry)}>{t('newSession')}</Button>
                    </span>
                  </div>
                  {entry.sessionsError ? <div className={css.emptySessions} role="alert">{t('sessionsError', { message: entry.sessionsError })}</div>
                    : !entry.sessions?.length ? <div className={css.emptySessions}>{t('noSessions')}</div>
                    : (
                      <ul className={css.rows}>
                        {entry.sessions.map((session) => (
                          <li key={session.sessionId}>
                            <button type="button" className={css.row} onClick={() => openSession(entry, session)}>
                              <span className={css.rowMain}>
                                <span className={css.rowTitle}>{session.title ?? t('sessionUntitled')}</span>
                                {!session.local ? <span className={css.rowSub}>{t('storedHint')}</span> : null}
                              </span>
                              <span className={css.rowMeta}>
                                {!session.local ? <span title={t('storedHint')}>{t('stored')}</span> : null}
                                <span>{when(session.updatedAt)}</span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </Section>
              )
            })}
          </div>
        )}
      <Modal open={dialog !== null} onClose={() => setDialog(null)} title={dialog === 'import' ? t('importTitle') : t('newEmptyTitle')} closeLabel={t('close')} className={css.modal}>
        {dialog !== null ? (
          <NewProjectForm api={api} t={tp} scratchKey={read.data?.scratchKey ?? null} withSource={dialog === 'import'} backLabel={t('cancel')}
            onBack={() => setDialog(null)} onStarted={follow} />
        ) : null}
      </Modal>
    </Page>
  )
}
