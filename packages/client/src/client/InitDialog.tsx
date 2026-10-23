// Init LayerFS for a workspace folder. The source is the workspace folder by
// default; another folder can be browsed to and picked: in the page when dsh
// composes the browse picker, else in the Host's native folder dialog. Either way the new project becomes the workspace folder's
// default, the project new sessions there use until they choose another.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type InitJob, type Project } from './api.ts'
import { InitProgress } from './Progress.tsx'

interface Entry { name: string, path: string, hidden: boolean }
interface Listing { path: string, home: string, crumbs: Entry[], entries: Entry[], truncated: boolean }
/** What the dialog uses of dsh's workspace navigation (read with ctx.get). */
export interface Directories { listDirectory(path?: string): Promise<Listing>, pickDirectory?(): Promise<string | null> }

const line = 'var(--dsh-color-border, #8884)'
const muted = 'var(--dsh-color-fg-muted, #8a8a8a)'
const button = { font: 'inherit', fontSize: 12, padding: '4px 12px', borderRadius: 6, border: `1px solid ${line}`, background: 'transparent', color: 'inherit', cursor: 'pointer' } as const
const primary = { ...button, background: 'var(--dsh-color-fg, #111)', color: 'var(--dsh-color-bg, #fff)', border: '1px solid transparent' } as const
const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path

export function InitDialog({ folder, directories, onDone, onClose }: {
  folder: string
  directories?: Directories
  onDone: (project: Project) => void
  onClose: () => void
}) {
  const [source, setSource] = useState(folder)
  const [browsing, setBrowsing] = useState<Listing | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<InitJob | null>(null)

  const open = async (path?: string) => {
    setError(null)
    try {
      setBrowsing(await directories!.listDirectory(path))
    } catch (e) {
      // dsh composes one picker: without the browse one, its native dialog picks
      const code = (e as { rpcError?: { code?: string } }).rpcError?.code ?? (e as Error).message
      if (browsing || !/unavailable/.test(code) || !directories!.pickDirectory) { setError((e as Error).message); return }
      try { const picked = await directories!.pickDirectory(); if (picked) setSource(picked) } catch (err) { setError((err as Error).message) }
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [busy, onClose])

  const init = async () => {
    setBusy(true); setError(null)
    try { onDone((await api.init(folder, name.trim() || undefined, source, setJob)).project) } catch (e) { setError((e as Error).message); setBusy(false); setJob(null) }
  }

  return createPortal(
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div role="dialog" aria-label="Init LayerFS" style={{ width: 520, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column', gap: 12, padding: 20, borderRadius: 14, background: 'var(--dsh-color-bg, #fff)', color: 'var(--dsh-color-fg, #111)', border: `1px solid ${line}`, fontSize: 13, lineHeight: 1.5, boxShadow: '0 12px 40px rgba(0,0,0,.25)' }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Init LayerFS</div>

        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ color: muted }}>Import files from</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', padding: '6px 8px', borderRadius: 6, border: `1px solid ${line}` }}>{source}</code>
            {source !== folder && <button style={button} disabled={busy} onClick={() => { setSource(folder); setBrowsing(null) }}>Use the workspace</button>}
            {directories && !browsing && <button style={button} disabled={busy} onClick={() => { void open(source) }}>Choose folder…</button>}
          </div>
        </div>

        {browsing && (
          <div style={{ display: 'grid', gap: 6, border: `1px solid ${line}`, borderRadius: 8, padding: 8, minHeight: 0 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, fontSize: 12 }}>
              {browsing.crumbs.map((c, i) => (
                <span key={c.path}>
                  {i > 0 && <span style={{ color: muted }}> / </span>}
                  <button style={{ ...button, border: 'none', padding: '1px 3px' }} onClick={() => { void open(c.path) }}>{i === 0 ? c.name : base(c.path)}</button>
                </span>
              ))}
            </div>
            <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid' }}>
              {browsing.entries.filter((e) => !e.hidden).map((e) => (
                <button key={e.path} onClick={() => { void open(e.path) }} style={{ ...button, border: 'none', textAlign: 'left', borderRadius: 4, padding: '3px 6px' }}>▸ {e.name}</button>
              ))}
              {browsing.entries.every((e) => e.hidden) && <span style={{ color: muted, padding: '3px 6px' }}>No folders here.</span>}
              {browsing.truncated && <span style={{ color: muted, padding: '3px 6px' }}>More folders than shown.</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={button} onClick={() => setBrowsing(null)}>Cancel</button>
              <button style={primary} onClick={() => { setSource(browsing.path); setBrowsing(null) }}>Import from {base(browsing.path)}</button>
            </div>
          </div>
        )}

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ color: muted }}>Project name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${base(source)} (default)`} disabled={busy} style={{ ...button, cursor: 'text', padding: '6px 8px' }} />
        </label>

        <div style={{ color: muted }}>
          New sessions in <code style={{ overflowWrap: 'anywhere' }}>{folder}</code> use the project until they choose another{source !== folder ? '; its first version holds the files of the folder above' : ''}.
        </div>
        {job && busy && <InitProgress job={job} />}
        {error && <div style={{ color: 'var(--dsh-color-fg-danger, #d33)' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={button} disabled={busy} onClick={onClose}>Cancel</button>
          <button style={primary} disabled={busy || !!browsing} onClick={() => { void init() }}>{busy ? 'Initializing…' : 'Init'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
