// Init LayerFS for a folder. With a workspace folder, that folder is the
// source by default and the new project becomes its default, the project new
// sessions there use until they choose another. Without one (All projects'
// Import project, folder null) the folder chooser opens at once, the chosen
// folder is the source, and no workspace gets a default. Another folder can
// be browsed to and picked: in the page when dsh composes the browse picker,
// else in the Host's native folder dialog.
// An optional time limit (minutes; blank is LayerFS's 5 min default) bounds
// the Init. One that runs out offers to start again with a longer limit: the
// form refilled, for the user to start; nothing restarts on its own.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type InitJob, type Project } from './api.ts'
import { InitProgress, InitTimedOut } from './Progress.tsx'
import { limitFromMinutes, limitOf, minutes, nextMinutes, QUICK_MINUTES, timedOut } from './initLimit.ts'

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
  folder: string | null
  directories?: Directories
  onDone: (project: Project) => void
  onClose: () => void
}) {
  const [source, setSource] = useState(folder ?? '')
  const [browsing, setBrowsing] = useState<Listing | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<InitJob | null>(null)
  const [limit, setLimit] = useState('')
  const [failed, setFailed] = useState<InitJob | null>(null)

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
  // no workspace: choose the folder straight away
  useEffect(() => { if (folder === null && directories) void open() }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [busy, onClose])

  const init = async () => {
    const { ms, error: invalid } = limitFromMinutes(limit)
    if (invalid) { setError(invalid); return }
    setBusy(true); setError(null); setFailed(null)
    try { onDone((await api.init(folder, name.trim() || undefined, source, setJob, false, ms)).project) } catch (e) { setError((e as Error).message); setFailed((e as { job?: InitJob }).job ?? null); setBusy(false); setJob(null) }
  }
  // the same folder and name, the next limit filled in; the user starts it
  const again = (job: InitJob) => {
    setSource(job.source); setName(job.name); setLimit(String(nextMinutes(limitOf(job)))); setFailed(null); setError(null)
  }

  return createPortal(
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div role="dialog" aria-label="Init LayerFS" style={{ width: 520, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column', gap: 12, padding: 20, borderRadius: 14, background: 'var(--dsh-color-bg, #fff)', color: 'var(--dsh-color-fg, #111)', border: `1px solid ${line}`, fontSize: 13, lineHeight: 1.5, boxShadow: '0 12px 40px rgba(0,0,0,.25)' }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Init LayerFS</div>

        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ color: muted }}>Import files from</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', padding: '6px 8px', borderRadius: 6, border: `1px solid ${line}`, color: source ? undefined : muted }}>{source || 'No folder chosen'}</code>
            {folder !== null && source !== folder && <button style={button} disabled={busy} onClick={() => { setSource(folder); setBrowsing(null) }}>Use the workspace</button>}
            {directories && !browsing && <button style={button} disabled={busy} onClick={() => { void open(source || undefined) }}>Choose folder…</button>}
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
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={source ? `${base(source)} (default)` : 'from the folder (default)'} disabled={busy} style={{ ...button, cursor: 'text', padding: '6px 8px' }} />
        </label>

        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ color: muted }}>Time limit <span style={{ opacity: 0.8 }}>(optional)</span></span>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            {QUICK_MINUTES.map((m) => {
              const on = limit.trim() === String(m)
              return <button key={m} aria-pressed={on} disabled={busy} style={on ? primary : button} onClick={() => setLimit(on ? '' : String(m))}>{m} min</button>
            })}
            <input aria-label="Time limit in minutes" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={`${minutes(limitOf({ timeout: null }))} min (default)`} disabled={busy} style={{ ...button, cursor: 'text', padding: '4px 8px', width: 130 }} />
            {limit.trim() !== '' && <span style={{ color: muted }}>min</span>}
          </div>
        </div>

        <div style={{ color: muted }}>
          {folder !== null
            ? <>New sessions in <code style={{ overflowWrap: 'anywhere' }}>{folder}</code> use the project until they choose another{source !== folder ? '; its first version holds the files of the folder above' : ''}.</>
            : 'Its first version holds the folder\'s files. No workspace uses it by default: a session picks it from its project menu.'}
        </div>
        {job && busy && <InitProgress job={job} />}
        {failed && timedOut(failed)
          ? <InitTimedOut job={failed} onAgain={() => again(failed)} />
          : error && <div style={{ color: 'var(--dsh-color-fg-danger, #d33)' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={button} disabled={busy} onClick={onClose}>Cancel</button>
          <button style={primary} disabled={busy || !!browsing || !source} onClick={() => { void init() }}>{busy ? 'Initializing…' : 'Init'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
