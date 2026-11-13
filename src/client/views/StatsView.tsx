/**
 * Stats conversation view: the root session's LayerFS project storage, the
 * same `ProjectStorage` panel as the Stats tab of the project's page in
 * Storage (docs/specs/conversation-views.md §6). It re-reads on the session's
 * checkpoints, so a new save shows up while the tab is open.
 */
import type { ReactNode } from 'react'
import { openStorage } from '../projects/navigation.ts'
import { ProjectStorage } from '../storage/ProjectStorage.tsx'
import { Gate, useNoComposer, type ViewProps } from './FileViews.tsx'
import { useRootState } from './hooks.ts'
import css from './views.module.css'

export function StatsView(props: ViewProps): ReactNode {
  const { api, t, storageT, sessionId, sessions } = props
  useNoComposer(props.hideComposer)
  const state = useRootState(api, sessionId, sessions)
  return (
    <Gate state={state} t={t}>
      {(_view, project) => (
        <div className={css.frame}>
          <div className={css.scroll}>
            <ProjectStorage key={project} api={api} t={storageT} project={project} tick={state.tick}
              hero={false} onOpenStore={(store) => openStorage(api, `store:${store}`)} />
          </div>
        </div>
      )}
    </Gate>
  )
}
