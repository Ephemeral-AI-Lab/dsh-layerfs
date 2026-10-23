// A project's Sandboxes tab: each running Sandbox (layerfs-<project>-<n>) with
// how full it is, and each Workspace in it with its Branch, the agent that
// mounted it, how long it has sat, its uncommitted changes and background
// processes. LayerFS starts and closes Sandboxes by itself (#373); the actions
// here end one Workspace or process. One that would cut off an agent's call
// running in that Workspace is disabled; one that loses work asks first.
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, imageLabel, type ProjectRuntime, type RuntimeWorkspace } from './api.ts'
import { Dot, Meter, span, wsName } from './runtimeParts.tsx'
import { card, T } from './tokens.ts'

type Ask = { kind: 'discard' | 'stop', sandbox: string, path: string, process?: string, command?: string } | null

export function SandboxesTab({ name, runtime, error, reload }: { name: string, runtime: ProjectRuntime | null, error: string | null, reload: () => void }) {
  const [ask, setAsk] = useState<Ask>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const act = async (label: string, body: Parameters<typeof api.runtimeAction>[1]) => {
    setBusy(label); setFailed(null)
    try { await api.runtimeAction(name, body); setAsk(null); reload() } catch (e) { setFailed((e as Error).message) } finally { setBusy(null) }
  }
  const sandboxes = runtime?.sandboxes ?? []
  const workspaces = sandboxes.reduce((n, s) => n + s.workspaces.length, 0)

  return (
    <div style={{ height: '100%', overflow: 'auto', background: T.card, color: T.text, fontSize: 12.5, lineHeight: '18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: `1px solid ${T.border}`, fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 12 }}>
        {runtime && <Dot level={runtime.level} />}
        <span>{runtime ? `${sandboxes.length} Sandbox${sandboxes.length === 1 ? '' : 'es'} · ${workspaces} Workspace${workspaces === 1 ? '' : 's'} · up to ${sandboxes[0]?.capacity ?? 16} each` : error ? 'Sandboxes not read' : 'Reading Sandboxes…'}</span>
        {runtime?.simulated && <span style={{ color: T.caption }}>· simulated</span>}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={reload} disabled={!!busy}>Refresh</Button>
      </div>
      <div style={{ display: 'grid', gap: 10, padding: '12px 14px 16px', alignContent: 'start' }}>
        {(error || failed) && <div role="status" style={{ color: T.danger, wordBreak: 'break-word' }}>{failed ?? error}</div>}
        {busy && <div role="status" style={{ color: T.text2 }}>{busy}</div>}
        {runtime?.pending && <div role="status" style={{ color: T.text2 }}>Still reading the Sandboxes' Workspaces; shown meanwhile from Docker and the agents' calls, without changes, Branches or processes.</div>}
        {runtime && !sandboxes.length && (
          <div style={{ color: T.text2 }}>No Sandbox runs. LayerFS starts one when an agent mounts a Workspace and closes it once it sits idle; reading this page starts none.</div>
        )}
        {sandboxes.map((sb) => (
          <section key={sb.id} style={{ ...card, overflow: 'hidden' }} aria-label={sb.name ?? `Sandbox ${sb.id}`}>
            <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: T.well }}>
              <Dot level={sb.level} />
              <b style={{ fontWeight: 600, fontFamily: 'var(--mono, ui-monospace, monospace)' }}>{sb.name ?? `Sandbox ${sb.id}`}</b>
              <span style={{ color: T.text2 }}>{sb.workspaces.length ? 'running' : 'idle · closes by itself'}</span>
              {sb.image && <span title={sb.image} style={{ color: T.text2, fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 11 }}>image {imageLabel(sb)}</span>}
              <span style={{ flex: 1 }} />
              <span style={{ color: T.text2 }}>{sb.workspaces.length}/{sb.capacity}</span>
              <Meter used={sb.workspaces.length} capacity={sb.capacity} />
            </header>
            {sb.workspaces.map((w) => (
              <WorkspaceRow key={w.path} w={w} disabled={!!busy || !!runtime?.pending}
                onUnmount={() => act(`Unmounting ${wsName(w.path)}…`, { action: 'unmount', sandbox: sb.id, path: w.path })}
                onDiscard={() => setAsk({ kind: 'discard', sandbox: sb.id, path: w.path })}
                onStop={(p) => setAsk({ kind: 'stop', sandbox: sb.id, path: w.path, process: p.id, command: p.command })}
                ask={ask && ask.sandbox === sb.id && ask.path === w.path ? ask : null}
                onConfirm={() => ask && (ask.kind === 'discard'
                  ? act(`Discarding ${wsName(w.path)}…`, { action: 'discard', sandbox: sb.id, path: w.path, confirm: w.path })
                  : act('Stopping the process…', { action: 'stop', process: ask.process }))}
                onCancel={() => setAsk(null)} />
            ))}
          </section>
        ))}
        {runtime?.gone.map((g) => (
          <div key={g.id} style={{ ...card, display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', color: T.text2 }}>
            <Dot level="degraded" /> {g.name ?? `Sandbox ${g.id}`}: its container is gone; LayerFS closes it on the next read.
          </div>
        ))}
      </div>
    </div>
  )
}

function WorkspaceRow({ w, disabled, ask, onUnmount, onDiscard, onStop, onConfirm, onCancel }: {
  w: RuntimeWorkspace, disabled: boolean, ask: Ask,
  onUnmount: () => void, onDiscard: () => void, onStop: (p: RuntimeWorkspace['processes'][number]) => void, onConfirm: () => void, onCancel: () => void
}) {
  const why = w.busy ? `An agent's call is running in ${wsName(w.path)}; wait for it to end` : undefined
  const chip = (text: string, color: string) => <span style={{ padding: '0 6px', borderRadius: 4, border: `1px solid ${T.border}`, color, whiteSpace: 'nowrap' }}>{text}</span>
  return (
    <div style={{ borderTop: `1px solid ${T.border}`, padding: '6px 10px', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Dot level={w.busy ? 'ok' : w.level} title={w.busy ? 'in use' : undefined} />
        <b style={{ fontWeight: 500, minWidth: 44 }}>{wsName(w.path)}</b>
        <span style={{ fontFamily: 'var(--mono, ui-monospace, monospace)' }}>{w.branch ?? '—'}</span>
        {w.agent && <span style={{ color: T.text2 }}>· {w.agent}</span>}
        <span style={{ color: T.text2 }}>· {w.busy ? 'in use now' : w.idleMs !== null ? `idle ${span(w.idleMs)}` : (w.activity ?? '').toLowerCase() || 'mounted'}</span>
        {w.uncommitted ? chip(`${w.uncommitted} uncommitted`, w.level === 'ok' ? T.text2 : T.warn) : chip('clean', T.ok)}
        {w.stale && chip('Branch moved since mount', T.text2)}
        <span style={{ flex: 1 }} />
        {w.uncommitted
          ? <Button variant="outline" size="sm" disabled={disabled || w.busy} title={why ?? 'Drop its uncommitted changes and unmount it'} onClick={onDiscard}>Discard…</Button>
          : <Button variant="outline" size="sm" disabled={disabled || w.busy} title={why ?? 'Unmount it: nothing is uncommitted'} onClick={onUnmount}>Unmount</Button>}
      </div>
      {w.processes.map((p) => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16, color: T.text2 }}>
          <span style={{ fontFamily: 'var(--mono, ui-monospace, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.command}</span>
          <span>· {p.status}</span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onStop(p)}>Stop…</Button>
        </div>
      ))}
      {ask && (
        <div role="alertdialog" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 8px', borderRadius: T.sm, background: 'var(--dsw-alias-state-error-bg, rgba(210,69,94,.1))' }}>
          <span style={{ flex: 1, minWidth: 200 }}>
            {ask.kind === 'discard'
              ? <>Drop {w.uncommitted} uncommitted change{w.uncommitted === 1 ? '' : 's'} in {wsName(w.path)} ({w.branch}{w.agent ? `, ${w.agent}` : ''}) and unmount it? This can't be undone.</>
              : <>Stop <code>{ask.command}</code> in {wsName(w.path)}{w.agent ? `, started by ${w.agent}` : ''}?</>}
          </span>
          <Button variant="primary" size="sm" disabled={disabled} onClick={onConfirm}>{ask.kind === 'discard' ? 'Discard' : 'Stop'}</Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      )}
    </div>
  )
}
