/**
 * Files and History conversation views: the root session's LayerFS project in
 * the shared file views, opened on the session's branch.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { StatusDot } from '../ui/StatusDot.tsx'
import clsx from 'clsx'

import type { LayerfsApi } from '../api.ts'
import { ErrorState, Loading } from '../files/States.tsx'
import { unsavedCount } from './model.ts'
import { ProjectFiles } from '../files/ProjectFiles.tsx'
import { ProjectHistory } from '../files/ProjectHistory.tsx'
import { parseFocus, useRootState, type SessionsSource, type SessionStateView, type ViewFocus } from './hooks.ts'
import type { LiveStepsSource } from './live-step.ts'
import { branchLabel } from './branch-label.ts'
import type { Translate } from './locale.ts'
import type { StorageT } from '../storage/locale.ts'
import css from './views.module.css'

export const FILES_VIEW = 'layerfs-files'
export const HISTORY_VIEW = 'layerfs-history'
export const SANDBOX_VIEW = 'layerfs-sandbox'
export const STATS_VIEW = 'layerfs-stats'

/** What each view's registration injects. */
export interface ViewInjected {
  sessionId: string
  api: LayerfsApi
  t: Translate
  /** The Storage page's copy, for the views that mount its panels (Stats). */
  storageT: StorageT
  sessions: SessionsSource | undefined
  /** The running assistant step's streamed text (client-only; absent without a live session feed). */
  liveStep?: LiveStepsSource
  /** Hides the chat composer until the returned release runs. */
  hideComposer: () => () => void
}

/** LayerFS views have no composer: hide it while the view is mounted. */
export function useNoComposer(hideComposer: () => () => void, hide = true): void {
  useEffect(() => (hide ? hideComposer() : undefined), [hideComposer, hide])
}

/** DSH's owner share of a `conversation.view` entry. */
export interface ViewOwner {
  viewRequest?: { view: string, focus: string } | null
  openView?: (view: string, focus: string) => void
  completeViewRequest?: () => void
}

export type ViewProps = ViewInjected & ViewOwner

/** Loading, refusal and "not a project" states every view shares. */
export function Gate({ state, t, children }: {
  state: ReturnType<typeof useRootState>
  t: Translate
  children: (view: SessionStateView & { binding: NonNullable<SessionStateView['binding']> }, project: string) => ReactNode
}): ReactNode {
  const { view, error, reload } = state
  if (!view && error) return <div className={css.frame}><ErrorState title={t('readFailed')} error={error} retryLabel={t('retry')} onRetry={reload} /></div>
  if (!view) return <div className={css.frame}><Loading label={t('loading')} /></div>
  const project = view.binding?.project ?? view.project
  if (!view.binding || !project) {
    return (
      <div className={clsx(css.frame, css.empty)}>
        <p className={css.emptyTitle}>{t('notProjectTitle')}</p>
        <p className={css.emptyBody}>{t('notProjectBody')}</p>
      </div>
    )
  }
  return children(view as never, project)
}

/** Take this view's focus request once. */
function useFocus(id: string, { viewRequest, completeViewRequest }: ViewOwner): [ViewFocus | null, number] {
  const [focus, setFocus] = useState<[ViewFocus | null, number]>([null, 0])
  useEffect(() => {
    if (!viewRequest || viewRequest.view !== id) return
    setFocus(([, n]) => [parseFocus(viewRequest.focus), n + 1])
    completeViewRequest?.()
  }, [id, viewRequest, completeViewRequest])
  return focus
}

/** A phone's one-line "Files · this session": the strip collapses the tab into its More menu. */
export function ViewCrumb({ label, t }: { label: string, t: Translate }): ReactNode {
  return (
    <span className={css.viewCrumb}>
      <span className={css.viewCrumbName}>{label}</span>
      <span className={css.crumbSep}>·</span>
      <span>{t('sessionWorkspace')}</span>
    </span>
  )
}

function SessionLine({ view, t }: { view: SessionStateView, t: Translate }): ReactNode {
  const branch = view.binding?.branch
  // 2.0 `workspace status --detail`: `overlay { inode_count, entry_count }`; the changed entries, not the inodes
  const pending = unsavedCount(view.status?.overlay)
  const active = view.binding?.state === 'bound'
  return (
    <div className={css.sessionLine}>
      {branch ? <span className={css.branchChip} title={branch}><StatusDot state={active ? 'done' : 'idle'} size={8} />{branchLabel(view.binding, t)}</span> : null}
      {active ? <span className={clsx(css.muted, pending > 0 && css.warn)}>{pending > 0 ? t('unsaved', { n: pending }) : t('unsavedNone')}</span> : null}
      <ViewCrumb label={t('tabFiles')} t={t} />
    </div>
  )
}

export function FilesView(props: ViewProps): ReactNode {
  const { api, t, sessionId, sessions } = props
  const state = useRootState(api, sessionId, sessions)
  // Hide the composer only once the session is confirmed to be in a project:
  // a DSH pane in split view keeps it, as the audit Trajectory does.
  useNoComposer(props.hideComposer, !!state.view?.binding)
  const [focus, n] = useFocus(FILES_VIEW, props)
  return (
    <Gate state={state} t={t}>
      {(view, project) => (
        <div className={css.frame}>
          <SessionLine view={view} t={t} />
          <div className={css.fill}>
            <ProjectFiles key={`${project}:${n}`} api={api} project={project} t={t} tick={state.contentTick}
              initialBranch={focus?.branch ?? view.binding.branch} initialPin={focus?.commit} initialPath={focus?.path} />
          </div>
        </div>
      )}
    </Gate>
  )
}

export function HistoryView(props: ViewProps): ReactNode {
  const { api, t, sessionId, sessions, openView } = props
  const state = useRootState(api, sessionId, sessions)
  useNoComposer(props.hideComposer, !!state.view?.binding)
  // The Trajectory tab opens a version here: `{branch, commit}`.
  const [focus, n] = useFocus(HISTORY_VIEW, props)
  return (
    <Gate state={state} t={t}>
      {(view, project) => (
        <div className={css.frame}>
          <ViewCrumb label={t('tabHistory')} t={t} />
          <div className={css.fill}>
            <ProjectHistory key={`${project}:${n}`} api={api} project={project} t={t} tick={state.contentTick}
              initialBranch={focus?.branch ?? view.binding.branch} initialCommit={focus?.commit}
              onOpenFile={openView ? (branch, path, pin) => openView(FILES_VIEW, JSON.stringify({ branch, path, commit: pin })) : undefined} />
          </div>
        </div>
      )}
    </Gate>
  )
}
