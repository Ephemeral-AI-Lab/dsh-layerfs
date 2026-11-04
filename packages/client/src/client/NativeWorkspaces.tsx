// Original host-runtime native owners. No fake Sandboxes, auto-create or retries.
import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type NativeAction, type NativeSnapshot } from './api.ts'
import { card, T } from './tokens.ts'

export function NativeWorkspaces({ name, snapshot, reload }: { name: string, snapshot?: NativeSnapshot, reload: () => void }) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ error: boolean, text: string } | null>(null)
  const [branch, setBranch] = useState('')
  const [message, setMessage] = useState('')
  const [discard, setDiscard] = useState<{ instance: string, path: string } | null>(null)
  const [confirm, setConfirm] = useState('')
  const [file, setFile] = useState('/note.txt')
  const [editor, setEditor] = useState<{ instance: string, path: string, file: string, text: string, revision: string | null } | null>(null)
  const act = async (input: NativeAction) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setFeedback(null)
    try {
      const value = await api.nativeAction(name, input)
      if (input.action === "readText") setEditor({ instance: input.instance!, path: input.path!, file: input.file!, text: value.text, revision: value.revision })
      if (input.action === "writeText") setEditor(current => current ? { ...current, revision: value.revision } : null)
      setFeedback({ error: false, text: input.action + ': ' + (value.kind ?? 'acknowledged') + (value.head ? ' · ' + value.head : '') })
      setDiscard(null); setConfirm('')
    } catch (e) {
      const error = e as Error & { code?: string }
      setFeedback({ error: true, text: (error.code ?? 'Failed') + ': ' + error.message + '. No automatic retry; refresh to inspect the original owner.' })
    } finally { pending.current = false; setBusy(false); reload() }
  }
  const field = { color: T.text, background: T.card, border: '1px solid ' + T.border, borderRadius: T.sm, padding: '5px 8px', minWidth: 140 }
  return <section aria-label="Native Workspace owners" style={{ display: 'grid', gap: 12 }}>
    <p style={{ margin: 0, color: T.text2 }}>Only this running host's original native instances are shown. Reading starts nothing. This is not machine-wide discovery.</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <Button variant="primary" size="sm" disabled={busy || !snapshot?.configured} onClick={() => void act({ action: 'create' })}>Create native instance</Button>
      {!snapshot?.configured && <span style={{ color: T.warn }}>Configure nativeWorkspace product paths and private workRoot on the host first.</span>}
    </div>
    <label style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>Existing Branch
      <input aria-label="Native Branch" style={field} value={branch} onChange={e => setBranch(e.target.value)} placeholder="Branch name (not main)" disabled={busy} />
    </label>
    <label style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>Commit message
      <input aria-label="Native Commit message" style={{ ...field, flex: 1 }} value={message} onChange={e => setMessage(e.target.value)} disabled={busy} />
    </label>
    {feedback && <div role={feedback.error ? 'alert' : 'status'} style={{ color: feedback.error ? T.danger : T.ok, overflowWrap: 'anywhere' }}>{feedback.text}</div>}
    {busy && <div role="status">Original native operation in progress…</div>}
    {snapshot && snapshot.instances.length === 0 && <div>No native instance is owned by this host runtime. Create one explicitly before mounting.</div>}
    {snapshot?.instances.map(i => <section key={i.id} aria-label={'Native instance ' + i.id} style={{ ...card, padding: 10, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <strong style={{ overflowWrap: 'anywhere' }}>{i.nativeId ?? i.id}</strong><span>{i.state}{i.busy ? ' · operation pending' : ''}</span>
        <span>owned sessions: {i.sessions ?? 'unknown'}</span>
        <Button variant="outline" size="sm" disabled={busy || i.busy || i.state !== 'running' || !branch.trim() || branch === 'main'} onClick={() => void act({ action: 'mount', instance: i.id, branch })}>Mount Branch</Button>
        <Button variant="outline" size="sm" disabled={busy || i.busy || i.state !== 'running' || i.sessions !== 0} onClick={() => void act({ action: 'close', instance: i.id })}>Close instance</Button>
      </div>
      {i.error && <div role="status" style={{ color: T.warn }}>{i.error.code}: {i.error.message}</div>}
      {!i.workspacesKnown && <div style={{ color: T.warn }}>Workspace snapshot unavailable or operation in progress; empty rows are not evidence of no mounts.</div>}
      {i.workspaces.map(w => <div key={w.path} style={{ borderTop: '1px solid ' + T.border, paddingTop: 8, display: 'grid', gap: 6 }}>
        <code style={{ overflowWrap: 'anywhere' }}>{w.path}</code>
        <div>{w.branch} · {w.activity} · dirty inodes {w.dirty.inodes}, entries {w.dirty.entries}{w.headMovedSinceMount ? ' · Branch head moved' : ''}</div>
        <label style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>Workspace text path
          <input aria-label="Native text path" style={field} value={file} onChange={e => setFile(e.target.value)} disabled={busy} />
          <Button variant="outline" size="sm" disabled={busy || i.busy || i.state !== "running"} onClick={() => void act({ action: "readText", instance: i.id, path: w.path, file })}>Load text window</Button>
        </label>
        {editor?.instance === i.id && editor.path === w.path && <div style={{ display: "grid", gap: 6 }}>
          <label>Editing {editor.file} · UTF-8 window up to 16 KiB; Save does not Commit.
            <textarea aria-label="Native text content" style={{ ...field, width: "100%", minHeight: 140, boxSizing: "border-box", display: "block" }} value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })} disabled={busy} />
          </label>
          <Button variant="outline" size="sm" disabled={busy || i.busy} onClick={() => void act({ action: "writeText", instance: i.id, path: w.path, file: editor.file, text: editor.text, revision: editor.revision })}>Save to Workspace</Button>
        </div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button variant="primary" size="sm" disabled={busy || i.busy || i.state !== 'running'} onClick={() => void act({ action: 'commit', instance: i.id, path: w.path, message })}>Commit Workspace</Button>
          <Button variant="outline" size="sm" disabled={busy || i.busy || i.state !== 'running'} onClick={() => void act({ action: 'unmount', instance: i.id, path: w.path })}>Unmount cleanly</Button>
          <Button variant="ghost" size="sm" disabled={busy || i.busy || i.state !== 'running'} onClick={() => { setDiscard({ instance: i.id, path: w.path }); setConfirm('') }}>Discard and unmount…</Button>
        </div>
        {discard?.path === w.path && discard.instance === i.id && <div role="alertdialog" aria-label="Confirm native discard" style={{ display: 'grid', gap: 6 }}>
          <span>Discard uncommitted changes? This cannot be undone. Type the exact Workspace path.</span>
          <input aria-label="Confirm native Workspace path" style={field} value={confirm} onChange={e => setConfirm(e.target.value)} />
          <div><Button variant="outline" size="sm" disabled={busy || confirm !== w.path} onClick={() => void act({ action: 'unmount', instance: i.id, path: w.path, discard: true, confirm })}>Confirm discard</Button>
          <Button variant="ghost" size="sm" onClick={() => setDiscard(null)}>Cancel</Button></div>
        </div>}
      </div>)}
    </section>)}
  </section>
}
