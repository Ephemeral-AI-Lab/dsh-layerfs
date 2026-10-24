// A session without a LayerFS project: pick any project (the folder's imports
// first) or Init one from the folder. The choice holds until an agent's first bash call
// uses it; after that the session's project is fixed.
import { useEffect, useState } from 'react'
import { api, type SessionView, type Status } from './api.ts'
import { InitDialog, type Directories } from './InitDialog.tsx'
import { MESSAGE } from './ui.ts'

const button = {
  font: 'inherit',
  fontSize: 13,
  padding: '5px 12px',
  borderRadius: 6,
  border: '1px solid var(--dsh-color-border, #8884)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
} as const

export function Setup({
  sessionId,
  view,
  onChange,
  directories,
}: {
  sessionId: string
  view: SessionView
  onChange: (next?: SessionView) => void
  directories: () => Directories | undefined
}) {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [initing, setIniting] = useState(false)
  useEffect(() => {
    api.status().then(setStatus, (e: Error) => setError(e.message))
  }, [])

  const act = (label: string, run: () => Promise<SessionView | void>) => async () => {
    setBusy(label)
    setError(null)
    try {
      onChange((await run()) || undefined)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const choose = (project: string | null) =>
    act(project ? `Choosing ${project}…` : 'Saving…', () => api.choose(sessionId, project))

  if (!view.folder)
    return <div style={MESSAGE}>This session has no workspace folder, so it has no LayerFS project.</div>
  if (status && !status.configured) {
    return (
      <div style={MESSAGE}>
        LayerFS is not set up on this dsh Host. Missing settings of <code>layerfs-host</code>:{' '}
        {status.missing.join(', ')}.
      </div>
    )
  }
  const locked = !!view.choice?.locked,
    none = view.choice && view.choice.project === null
  return (
    <div style={{ ...MESSAGE, display: 'grid', gap: 14, maxWidth: 560 }}>
      <div>
        <b>LayerFS</b> keeps a versioned copy of <code>{view.folder}</code>: agents fork Branches, test them in
        Sandboxes and merge them, and this tab draws what they did.
        {none ? ' This session is set to work without LayerFS.' : ''}
      </div>
      {view.choices.projects.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span>LayerFS projects</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {view.choices.projects.map((p) => (
              <button
                key={p.name}
                style={button}
                disabled={!!busy || locked}
                onClick={choose(p.name)}
                title={`${p.empty ? 'started empty' : `imported from ${p.source}`} · volume ${p.volume}`}
              >
                Use {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div>
        <button style={button} disabled={!!busy || locked} onClick={() => setIniting(true)}>
          Init LayerFS…
        </button>
      </div>
      {initing && (
        <InitDialog
          folder={view.folder}
          directories={directories()}
          onClose={() => setIniting(false)}
          onDone={(project) => {
            setIniting(false)
            void act(`Choosing ${project.name}…`, () => api.choose(sessionId, project.name))()
          }}
        />
      )}
      {busy && <div>{busy}</div>}
      {error && <div style={{ color: 'var(--dsh-color-fg-danger, #d33)' }}>{error}</div>}
    </div>
  )
}
