// The All projects page: what every project's Sandboxes run on and how full
// they are. Docker, the Store container (macOS) and free disk on top, then a
// card per project (problems first) that opens its Sandboxes tab, then
// leftover containers no project owns. Its actions are the ones no single
// project owns: start a stopped Store container, remove stopped leftovers.
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, imageLabel, type Overview } from './api.ts'
import { Dot, Meter, POLL_MS, usePoll } from './runtimeParts.tsx'
import { bytes } from './storage.ts'
import { card, T } from './tokens.ts'

const MONO = 'var(--mono, ui-monospace, monospace)'

export function AllSandboxes({ onOpen }: { onOpen: (project: string) => void }) {
  const [view, setView] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const read = () => api.overview().then((v) => { setView(v); setError(null) }, (e: Error) => setError(e.message))
  usePoll(read, POLL_MS, [])
  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label); setError(null)
    try { await run(); setAsking(false); setRestarting(false); await read() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  const tile = (title: string, level: Overview['level'] | null, body: React.ReactNode, extra?: React.ReactNode, actions?: React.ReactNode) => (
    <div style={{ ...card, padding: '8px 10px', display: 'grid', gap: 2, minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: T.text2, whiteSpace: 'nowrap' }}>{level && <Dot level={level} />}{title}{actions && <><span style={{ flex: 1 }} /><span style={{ display: 'flex', gap: 4 }}>{actions}</span></>}</span>
      <span style={{ fontFamily: MONO, fontSize: 12.5, wordBreak: 'break-word' }}>{body}</span>
      {extra}
    </div>
  )
  const store = view?.store
  const stopped = view?.leftovers.filter((l) => !l.running) ?? []

  return (
    <div style={{ ...card, flex: 1, minHeight: 440, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: `1px solid ${T.border}`, background: T.well, fontFamily: MONO, fontSize: 12 }}>
        {view && <Dot level={view.level} />}
        <span>{view ? `${view.totals.projects} project${view.totals.projects === 1 ? '' : 's'} · ${view.totals.sandboxes} Sandbox${view.totals.sandboxes === 1 ? '' : 'es'} · ${view.totals.workspaces} Workspace${view.totals.workspaces === 1 ? '' : 's'}` : 'Reading LayerFS…'}</span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void read()}>Refresh</Button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', display: 'grid', gap: 14, padding: '12px 14px 16px', alignContent: 'start', fontSize: 12.5 }}>
        {(error || busy) && <div role="status" style={{ color: error ? T.danger : T.text2, wordBreak: 'break-word' }}>{error ?? busy}</div>}
        {view && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
            {tile('Docker', view.engine.level, view.engine.level === 'ok' ? `running · ${view.engine.version}` : 'not answering')}
            {store && tile('layerfs-store', store.level,
              store.state === 'running' ? `${store.answering ? 'ready' : 'not answering'}${store.build && store.build !== store.expected ? ' · older build' : ''}` : store.state,
              restarting
                ? <span role="alertdialog" style={{ display: 'grid', gap: 6, marginTop: 4, padding: '6px 8px', borderRadius: T.sm, background: 'var(--dsw-alias-state-error-bg, rgba(210,69,94,.1))', fontSize: 12 }}>
                  <span>Restart layerfs-store? Every project's Store calls stop for a few seconds{view.calls ? `; ${view.calls} agent call${view.calls === 1 ? ' is' : 's are'} running and may fail` : ''}.</span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void act('Restarting layerfs-store…', api.restartStore)}>Restart</Button>
                    <Button variant="ghost" size="sm" onClick={() => setRestarting(false)}>Cancel</Button>
                  </span>
                </span>
                : null,
              view.engine.level === 'ok' && <>
                <Button variant={store.state === 'running' ? 'ghost' : 'primary'} size="sm" disabled={!!busy || store.state === 'running'}
                  title={store.state === 'running' ? 'It is running' : 'Start the Store container'} onClick={() => void act('Starting layerfs-store…', api.startStore)}>Start</Button>
                <Button variant={store.level === 'ok' ? 'ghost' : 'outline'} size="sm" disabled={!!busy || store.state !== 'running'}
                  title={store.state === 'running' ? 'Stop and start it again: every Store call waits a few seconds' : 'It is not running; start it'} onClick={() => setRestarting(true)}>Restart…</Button>
              </>)}
            {tile('Disk free', null, [view.disk.vm !== null ? `Docker ${bytes(view.disk.vm)}` : null, view.disk.host !== null ? `local ${bytes(view.disk.host)}` : null].filter(Boolean).join(' · ') || 'not read')}
          </div>
        )}
        {view && (
          <section>
            <h4 style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: T.caption }}>Projects · problems first</h4>
            {!view.projects.length && <div style={{ color: T.text2 }}>No projects yet.</div>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
              {view.projects.map((p) => (
                <button key={p.name} type="button" className="lfs-card" onClick={() => onOpen(p.name)} title={`Open ${p.name}'s Sandboxes`}
                  style={{ ...card, textAlign: 'left', cursor: 'pointer', padding: '8px 10px', display: 'grid', gap: 4, color: 'inherit', font: 'inherit',
                    borderLeft: p.level === 'ok' ? card.border : `3px solid ${p.level === 'down' ? T.danger : T.warn}` }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, minWidth: 0 }}>
                    <Dot level={p.level} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 400, color: T.caption, whiteSpace: 'nowrap' }}>
                      {p.sandboxes.length ? `${p.sandboxes.length} Sandbox${p.sandboxes.length === 1 ? '' : 'es'} · ${p.workspaces} WS` : 'no Sandbox'}{p.simulated ? ' · sim' : ''}
                    </span>
                  </span>
                  {p.sandboxes.map((s) => (
                    <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: T.text2 }}>
                      <span style={{ minWidth: 26 }}>-{s.id}</span><Meter used={s.used} capacity={s.capacity} /><span>{s.used}/{s.capacity}</span>
                      {s.image && <span title={s.image} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{imageLabel(s)}</span>}
                    </span>
                  ))}
                  {!p.sandboxes.length && <span style={{ fontSize: 11.5, color: T.caption }}>Idle · starts one on the next mount</span>}
                  {p.note && <span style={{ fontSize: 11.5, color: p.level === 'down' ? T.danger : T.warn, wordBreak: 'break-word' }}>{p.note}</span>}
                </button>
              ))}
            </div>
          </section>
        )}
        {view && view.leftovers.length > 0 && (
          <section>
            <h4 style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: T.caption }}>Leftovers</h4>
            <div style={{ ...card, display: 'grid' }}>
              {view.leftovers.map((l, i) => (
                <div key={l.name} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 10px', borderTop: i ? `1px solid ${T.border}` : 0 }}>
                  <span style={{ alignSelf: 'center', display: 'flex' }}><Dot level="degraded" /></span>
                  <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
                    <span style={{ fontFamily: MONO }}>{l.name}</span>
                    <span style={{ color: T.text2 }}> · {l.status}{l.project ? ` · project ${l.project}` : ''}</span>
                  </span>
                </div>
              ))}
              {stopped.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 10px', borderTop: `1px solid ${T.border}` }}>
                  {asking
                    ? <>
                      <span style={{ flex: 1 }}>Remove {stopped.length} stopped container{stopped.length === 1 ? '' : 's'}? They run nothing; their Store volumes stay.</span>
                      <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void act('Removing leftovers…', () => api.cleanLeftovers(stopped.map((l) => l.name)))}>Remove</Button>
                      <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>Cancel</Button>
                    </>
                    : <><span style={{ flex: 1, color: T.text2 }}>Running leftovers are left for you to stop.</span><Button variant="outline" size="sm" disabled={!!busy} onClick={() => setAsking(true)}>Clean up…</Button></>}
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
