/**
 * The add-workspace flow's occupant: instead of a host folder, the operator
 * picks a LayerFS project (or Scratch), or creates one. The project's
 * scratch-folder workspace is prepared on the host and its anchor directory is
 * handed back to ui-workspace as the picked path, which registers (or reuses)
 * the DSH workspace and starts a session there.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import type { PickerKey } from './locale.ts'
import { listProjects, messageOf, NewProjectForm, remoteMachine, waitProject, type ProjectRow } from './NewProjectForm.tsx'
import css from './picker.module.css'

type Translate = (key: PickerKey, params?: Record<string, string | number>) => string

/** Owner share of ui-workspace's directory-flow holes (`DirectoryFlowOwnerProps`). */
export interface DirectoryFlowOwnerProps {
  open: boolean
  busy: boolean
  onPicked: (path: string) => void
  onCancel: () => void
  onError: (message: string) => void
}


export function ProjectPicker(props: DirectoryFlowOwnerProps & { api: LayerfsApi, t: Translate }): ReactNode {
  const { open, busy, api, t } = props
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const [scratchKey, setScratchKey] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    setLoadError(null)
    listProjects(api).then(({ rows: list, scratchKey: key }) => {
      setScratchKey(key)
      setRows(list)
    }, (e) => setLoadError(messageOf(e)))
  }, [api])

  useEffect(() => {
    if (!open) { setChoosing(null); setError(null); setCreating(false); return }
    load()
  }, [open, load])

  const choose = async (key: string | null) => {
    setChoosing(key ?? 'scratch')
    setError(null)
    try {
      const out = key === null || key === scratchKey
        ? await api.op<{ anchor: string }>('sessions.prepareScratch', { navigate: false })
        : await api.op<{ anchor: string }>('sessions.prepare', { project: key })
      props.onPicked(out.anchor)
    } catch (e) {
      setError(messageOf(e))
      setChoosing(null)
    }
  }

  const pending = busy || choosing !== null
  const projects = (rows ?? []).filter((r) => r.key !== scratchKey)
  return (
    <Modal open={open} onClose={() => { if (!pending) props.onCancel() }} title={creating ? t('newProjectTitle') : t('title')}
      description={creating ? undefined : t('description')} closeLabel={t('close')} className={css.modal}
      footer={creating ? null : (
        <div className={css.footer}>
          <Button variant="outline" disabled={pending} onClick={() => setCreating(true)}>{t('newProject')}</Button>
          <Button variant="ghost" disabled={pending} onClick={props.onCancel}>{t('cancel')}</Button>
        </div>
      )}>
      {creating ? (
        <NewProjectForm api={api} t={t} scratchKey={scratchKey} withSource={false} optionalSource onBack={() => setCreating(false)}
          onStarted={async (job, key) => { await waitProject(api, job); await choose(key) }} />
      ) : (
        <div className={css.body}>
          <ul className={css.list} aria-label={t('scratch')}>
            <li>
              <button type="button" className={css.row} disabled={pending} onClick={() => { void choose(null) }}>
                <span className={css.rowMain}>
                  <span className={css.rowName}>{t('scratch')}</span>
                  <span className={css.rowMeta}>{t('scratchBody')}</span>
                </span>
                {choosing === 'scratch' ? <StateDot state="ongoing" size={13} /> : null}
              </button>
            </li>
          </ul>
          <div className={css.label}>{t('projects')}</div>
          {loadError ? (
            <div className={css.stack}>
              <div className={css.error} role="alert">{t('loadFailed', { message: loadError })}</div>
              <Button variant="outline" size="sm" className={css.selfStart} onClick={load}>{t('retry')}</Button>
            </div>
          ) : rows === null ? <div className={css.muted}>{t('loading')}</div>
            : projects.length === 0 ? <div className={css.muted}>{t('empty')}</div> : (
              <ul className={css.list} aria-label={t('projects')}>
                {projects.map((p) => {
                  const remote = remoteMachine(p)
                  return (
                    <li key={p.key}>
                      <button type="button" className={css.row} disabled={pending || !!remote} onClick={() => { void choose(p.key) }}>
                        <span className={css.rowMain}>
                          <span className={css.rowName}>{p.name ?? p.key.split('/')[1]}</span>
                          <span className={css.rowMeta}>{remote ? t('onMachine', { machine: remote }) : p.store ?? p.key.split('/')[0]}</span>
                        </span>
                        {choosing === p.key ? <StateDot state="ongoing" size={13} /> : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          {error ? <div className={css.error} role="alert">{error}</div> : null}
        </div>
      )}
    </Modal>
  )
}
