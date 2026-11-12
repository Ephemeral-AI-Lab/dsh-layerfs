/** Additive annotations beside the native DSH conversation, without replacing tool views. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { SavedProjectFiles } from '../files/ProjectFiles.tsx'
import css from './session.module.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

interface Invocation {
  id: string
  origin: 'tool' | 'host'
  sessionId: string
  project: string
  turn?: number
  toolCallId?: string
  operation: string
  outcome: 'success' | 'refusal' | 'unknown'
  versions: { kind: 'Commit' | 'Layer', id: string, effect: 'created' | 'unchanged' | 'referenced' }[]
  error?: string
  captureGap?: string
  arguments?: { paths?: string[] }
}

/** Branch operations have user-facing action names; internal branch identities stay hidden. */
function operationLabel(operation: string, t: Translate): string {
  const name = operation.replaceAll(' ', '.')
  if (name === 'branch.fork') return t('operationStart')
  if (name === 'branch.merge') return t('operationMerge')
  if (name === 'branch.publish') return t('operationPublish')
  return operation
}

export function TurnActivity({ sessionId, turn, api, t, open }: {
  sessionId: string
  turn: { turn: number, start?: { sessionId?: string } }
  api: LayerfsApi
  t: Translate
  open: () => void
}): ReactNode {
  const [invocations, setInvocations] = useState<Invocation[]>([])
  const [selected, setSelected] = useState<{ project: string, version: string } | null>(null)
  useEffect(() => {
    let live = true
    const load = () => api.op<{ invocations: Invocation[] }>('session.annotations', { sessionId }).then((value) => {
      if (live) setInvocations((value.invocations ?? []).filter((item) => item.turn === turn.turn
        // A fork's inherited history belongs to the original session, not to a coincident turn number.
        && (!turn.start?.sessionId || item.sessionId === turn.start.sessionId)))
    }, () => { if (live) setInvocations([]) })
    void load()
    const reload = (event: { data?: any }) => { if (!event.data?.sessionId || event.data.sessionId === sessionId) void load() }
    const offs = ['layerfs-session', 'layerfs-checkpoint', 'layerfs-operation', 'connection'].map((name) => api.onEvent(name, reload))
    return () => { live = false; offs.forEach((off) => off()) }
  }, [api, sessionId, turn.turn, turn.start?.sessionId])

  if (!invocations.length) return null
  return (
    <div className={css.turnActivity}>
      <details>
        <summary>{t('projectActivity', { n: invocations.length })}</summary>
        <ul className={css.activityList}>
          {invocations.map((item) => (
            <li key={item.id} className={css.activityItem}>
              <div className={css.pointMeta}>
                <span>{operationLabel(item.operation, t)}</span>
                <span className={css.muted}>{item.origin === 'host' ? t('hostSave') : item.toolCallId ? t('toolCall', { id: item.toolCallId }) : t('unassociatedCall')}</span>
              </div>
              {item.arguments?.paths?.length ? <div className={css.muted}>{item.arguments.paths.join(' · ')}</div> : null}
              {item.captureGap ? <div className={css.muted}>{t('captureGap')}</div> : null}
              {item.outcome !== 'success' ? <div className={css.error}>{t(item.outcome === 'refusal' ? 'operationFailed' : 'operationUnknown')}</div> : null}
              {item.operation.replaceAll(' ', '.') !== 'workspace.exec' && item.outcome === 'success' ? item.versions.map((version) => (
                <Button key={`${version.kind}:${version.id}:${version.effect}`} variant="ghost" size="sm" title={`${version.kind} ${version.id}`} onClick={() => setSelected({ project: item.project, version: version.id })}>
                  {t(version.effect === 'created' ? 'createdCheckpoint' : version.effect === 'unchanged' ? 'unchangedCheckpoint' : 'referencedCheckpoint', { id: version.id.slice(0, 10) })}
                </Button>
              )) : null}
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="sm" onClick={open}>{t('allCheckpoints')}</Button>
      </details>
      <Modal open={selected !== null} onClose={() => setSelected(null)} title={t('savedFilesTitle', { id: selected?.version.slice(0, 10) ?? '' })} closeLabel={t('close')} className={css.savedFilesModal}>
        {selected ? <div className={css.savedFiles}><SavedProjectFiles api={api} project={selected.project} version={selected.version} t={t} /></div> : null}
      </Modal>
    </div>
  )
}
