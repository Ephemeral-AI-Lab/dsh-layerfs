// Confirms removing a LayerFS project: the name must be typed (spaces around
// it are ignored). Remove stays disabled, and looks it, until the name
// matches; Enter confirms. The Host deletes the project's volume and LayerFS
// home entry and forgets it; it refuses while a Sandbox still uses the volume.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type Project } from './api.ts'

const line = 'var(--dsh-color-border, #8884)'
const muted = 'var(--dsh-color-fg-muted, #8a8a8a)'
const danger = 'var(--dsh-color-fg-danger, #d33)'
const button = { font: 'inherit', fontSize: 12, padding: '4px 12px', borderRadius: 6, border: `1px solid ${line}`, background: 'transparent', color: 'inherit', cursor: 'pointer' } as const
const off = { opacity: 0.45, cursor: 'not-allowed' } as const

export function RemoveDialog({ project, onDone, onClose }: { project: Project, onDone: () => void, onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const matches = typed.trim() === project.name
  const remove = async () => {
    if (!matches || busy) return
    setBusy(true); setError(null)
    try { await api.remove(project.name); onDone() } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  return createPortal(
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form role="dialog" aria-label={`Remove ${project.name}`} onSubmit={(e) => { e.preventDefault(); void remove() }}
        style={{ width: 460, maxWidth: 'calc(100vw - 32px)', display: 'grid', gap: 12, padding: 20, borderRadius: 14, background: 'var(--dsh-color-bg, #fff)', color: 'var(--dsh-color-fg, #111)', border: `1px solid ${line}`, fontSize: 13, lineHeight: 1.5, boxShadow: '0 12px 40px rgba(0,0,0,.25)' }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Remove {project.name}?</div>
        <div>This deletes the project's volume <code>{project.volume}</code>: every Branch, Commit and Layer in it. It can't be undone.</div>
        <div style={{ color: muted }}>The workspace folder, its files and the sessions' transcripts stay. Sessions that used this project have no LayerFS project afterwards. Close the project's Sandboxes first; removal is refused while one runs.</div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ color: muted }}>Type <b>{project.name}</b> to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoFocus spellCheck={false} autoCapitalize="off" autoComplete="off" aria-invalid={typed !== '' && !matches}
            style={{ ...button, cursor: 'text', padding: '6px 8px' }} />
          {typed !== '' && !matches && <span style={{ fontSize: 12, color: muted }}>That isn't the project's name yet.</span>}
        </label>
        {error && <div role="alert" style={{ color: danger }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={{ ...button, ...(busy ? off : {}) }} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" style={{ ...button, background: danger, color: '#fff', border: '1px solid transparent', ...(busy || !matches ? off : {}) }} disabled={busy || !matches}
            title={matches ? undefined : `Type ${project.name} first`}>{busy ? 'Removing…' : 'Remove project'}</button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
