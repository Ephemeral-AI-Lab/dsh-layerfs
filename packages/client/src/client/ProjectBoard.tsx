// A project like an editor: the shared view in project mode draws Files'
// tree at the picked point in a sidebar, and File, History (the chat's
// History panel, view/history.js) and Storage (the chat's storage panel) as
// tabs, from the project's LayerFS state and its Store's figures, which it
// reads here, and Sandboxes (SandboxesTab, in an element the view keeps).
// Under it the status bar: the project's facts, when the page gives them, its
// Sandboxes, which open their tab, and the Store's size, which opens Storage.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import FM from '../../../../sim/simulation_engine/files.js'
import M from '../../../../sim/simulation_engine/model.js'
import { createFilesSource, createView, injectStyle } from '../../../view/src/index.js'
import { api, type ProjectRuntime, type ProjectState, type Storage } from './api.ts'
import { CASTS, MAID_AVATARS } from './avatars.ts'
import { projectModel, type FilesSource } from './replay.ts'
import { Dot, POLL_MS, usePoll } from './runtimeParts.tsx'
import { SandboxesTab } from './SandboxesTab.tsx'
import { bytes, saved, storeOf, times } from './storage.ts'
import { followTheme } from './theme.ts'
import { card, T } from './tokens.ts'

/**
 * `tab`: the tab to open with (the All projects page opens Sandboxes).
 * `storage`: the Store's figures, which the page reads alongside History (null while it reads).
 */
export function ProjectBoard({ name, state, storage, storageError, status, tab }: { name: string, state: ProjectState, storage: Storage | null, storageError: string | null, status?: ReactNode, tab?: 'sandboxes' }) {
  const host = useRef<HTMLDivElement>(null)
  const board = useRef<any>(null)
  const files = useRef<FilesSource | null>(null)
  const store = useRef<any>(null)
  // the Sandboxes tab's element: the view shows it as the tab's page and keeps it across draws
  const sbxEl = useRef<HTMLDivElement>(null as unknown as HTMLDivElement)
  if (!sbxEl.current) { sbxEl.current = document.createElement('div'); sbxEl.current.className = 'lfs-own'; sbxEl.current.style.height = '100%' }
  const runtimeRef = useRef<ProjectRuntime | null>(null)
  const [runtime, setRuntime] = useState<ProjectRuntime | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const readRuntime = () => api.projectRuntime(name).then((r) => { setRuntime(r); setRuntimeError(null) }, (e: Error) => setRuntimeError(e.message))
  usePoll(readRuntime, POLL_MS, [name])
  useEffect(() => { setRuntime(null); setRuntimeError(null) }, [name])

  useEffect(() => {
    injectStyle(document)
    const root = host.current!
    let soon: ReturnType<typeof setTimeout> | undefined
    board.current = createView(root, { avatars: MAID_AVATARS, casts: CASTS, files: FM, lineDiff: M.lineDiff, live: false, lead: 'main', project: true })
    board.current.rerender = () => { clearTimeout(soon); soon = setTimeout(() => board.current?.W && board.current.render(), 40) }
    if (tab) board.current.ide = tab
    const unfollow = followTheme(root)
    files.current = createFilesSource((kind, query) => api.projectFiles(name, kind, query), () => board.current?.rerender?.())
    return () => { clearTimeout(soon); unfollow(); board.current.dispose(); board.current = null }
  }, [name])

  useEffect(() => {
    const b = board.current
    if (!b) return
    const W = projectModel(state, files.current!, () => b.rerender())
    W.engine.storage = () => store.current
    W.engine.sandboxes = () => ({ el: sbxEl.current, level: runtimeRef.current?.level ?? 'ok' })
    for (const agent of ['main', ...new Set(Object.values(state.authors))]) b.avatar(agent)
    b.W = W
    b.render()
  }, [name, state])

  useEffect(() => {
    store.current = storage ? storeOf(storage, state) : null
    board.current?.rerender?.()
  }, [storage, state])

  useEffect(() => { runtimeRef.current = runtime; board.current?.rerender?.() }, [runtime])

  const gain = storage ? saved(storage) : null
  const sbx = runtime?.sandboxes ?? [], wsCount = sbx.reduce((n, x) => n + x.workspaces.length, 0)
  return (
    <div style={{ flex: 1, minHeight: 560, display: 'flex', flexDirection: 'column', borderRadius: T.md, overflow: 'hidden', border: card.border, boxShadow: card.boxShadow }}>
      <div ref={host} style={{ position: 'relative', flex: 1, minHeight: 0 }} />
      <footer style={{ flex: 'none', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 16px', minWidth: 0, padding: '4px 12px', borderTop: `1px solid ${T.border}`, background: T.well, fontSize: 12 }}>
        {status}
        <span style={{ flex: 1 }} />
        <button type="button" className="lfs-chip" onClick={() => { if (board.current) board.current.ide = 'sandboxes' }}
          title={runtime ? 'Sandboxes running for this project and their Workspaces. Click for Sandboxes.' : runtimeError ?? 'Reading Sandboxes…'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: '0 -6px', padding: '0 6px', border: 0, borderRadius: T.sm, color: 'inherit', font: 'inherit', whiteSpace: 'nowrap' }}>
          {runtime
            ? <><Dot level={runtime.level} /><span style={{ fontWeight: 500 }}>{sbx.length}</span><span style={{ color: T.text2 }}>Sandbox{sbx.length === 1 ? '' : 'es'} · {wsCount} WS</span></>
            : <span style={{ color: T.caption }}>{runtimeError ? 'Sandboxes not read' : 'reading Sandboxes…'}</span>}
        </button>
        <button type="button" className="lfs-chip" disabled={!storage} onClick={() => { if (board.current) board.current.ide = 'storage' }}
          title={storage ? `The Store's database is ${bytes(storage.store.file)}; every saved version as plain files would be ${bytes(storage.store.logical)}. Click for Storage.` : storageError ?? 'Reading the Store…'}
          style={{ display: 'inline-flex', gap: 4, margin: '0 -6px', padding: '0 6px', border: 0, borderRadius: T.sm, color: 'inherit', font: 'inherit', whiteSpace: 'nowrap' }}>
          {storage
            ? <><span style={{ fontWeight: 500 }}>{bytes(storage.store.file)}</span><span style={{ color: T.text2 }}>on disk{gain ? ` · ${times(gain)} smaller than raw` : ''}</span></>
            : <span style={{ color: T.caption }}>{storageError ? 'storage not read' : 'reading storage…'}</span>}
        </button>
      </footer>
      {createPortal(<SandboxesTab name={name} runtime={runtime} error={runtimeError} reload={readRuntime} />, sbxEl.current)}
    </div>
  )
}
