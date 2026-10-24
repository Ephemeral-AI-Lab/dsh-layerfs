// The All projects page: what every project's Sandboxes run on and how full
// they are. Top to bottom:
//   header        the worst warning in words, or none when all is well
//   health strip  Docker, Store calls, free disk on the host and in Docker,
//                 and the last sweep of stopped Sandboxes
//   projects      a card per project with a running Sandbox or a problem
//                 (problems first), each Sandbox with its scratch; the idle
//                 ones as a short list with their Store volume's size
//   leftovers     stopped or ownerless Sandbox containers, and this home's
//                 Store volumes no project uses; volumes of unknown owner
//                 are only counted
// Every figure comes from the Host's runtime read (@layerfs/runtime); the
// page computes nothing about Docker. Its actions are the ones no single
// project owns: start or restart the worker, remove stopped
// leftovers and orphan volumes, each confirmed.
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, imageLabel, type Level, type Overview } from './api.ts'
import { Dot, LEVEL_COLOR, Meter, POLL_MS, span, usePoll } from './runtimeParts.tsx'
import { bytes } from './storage.ts'
import { Ellen } from './maid.tsx'
import { card, T } from './tokens.ts'

// figures: the maid theme's rounded figures inside the page, else monospace
const MONO = 'var(--lfs-num, var(--mono, ui-monospace, monospace))'
const HEADING: CSSProperties = {
  margin: '0 0 6px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: T.caption,
}
const ASK: CSSProperties = {
  display: 'grid',
  gap: 6,
  padding: '8px 10px',
  borderRadius: T.sm,
  background: 'var(--dsw-alias-state-error-bg, rgba(210,69,94,.1))',
  fontSize: 12,
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const running = (calls: number) =>
  calls ? `; ${plural(calls, 'agent call')} ${calls === 1 ? 'is' : 'are'} running and may fail` : ''

export function AllSandboxes({ onOpen }: { onOpen: (project: string) => void }) {
  const [view, setView] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // which confirmation is open: restart, containers, or a volume's name
  const [asking, setAsking] = useState<string | null>(null)
  const read = () =>
    api.overview().then(
      (v) => {
        setView(v)
        setError(null)
      },
      (e: Error) => setError(e.message),
    )
  usePoll(read, POLL_MS, [])
  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await run()
      setAsking(null)
      await read()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const confirm = (text: ReactNode, yes: string, label: string, run: () => Promise<unknown>) => (
    <span role="alertdialog" style={ASK}>
      <span>{text}</span>
      <span style={{ display: 'flex', gap: 6 }}>
        <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void act(label, run)}>
          {yes}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>
          Cancel
        </Button>
      </span>
    </span>
  )

  const worst = view?.reasons[0] ?? null

  return (
    <div className="lfs-bow" style={{ flex: 1, minHeight: 440, display: 'flex', flexDirection: 'column' }}>
      <div
        className="lfs-lace"
        style={{ ...card, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px 8px',
            borderBottom: `1px solid ${T.border}`,
            background: T.well,
            fontSize: 12.5,
            fontWeight: 500,
            flexWrap: 'wrap',
          }}
        >
          {worst && (
            <>
              <Dot level={worst.level} />
              <span title={view!.reasons.map((r) => r.text).join('\n')} style={{ color: LEVEL_COLOR[worst.level] }}>
                {worst.text}
                {view!.reasons.length > 1 ? ` · +${view!.reasons.length - 1} more` : ''}
              </span>
              <span style={{ color: T.caption }}>·</span>
            </>
          )}
          <span>
            {view
              ? `${plural(view.totals.projects, 'project')} · ${plural(view.totals.sandboxes, 'Sandbox', 'Sandboxes')} · ${plural(view.totals.workspaces, 'Workspace')}`
              : 'Reading LayerFS…'}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void read()}>
            Refresh
          </Button>
        </div>
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            display: 'grid',
            gap: 14,
            padding: '12px 14px 16px',
            alignContent: 'start',
            fontSize: 12.5,
          }}
        >
          {(error || busy) && (
            <div role="status" style={{ color: error ? T.danger : T.text2, wordBreak: 'break-word' }}>
              {error ?? busy}
            </div>
          )}

          {view && (
            <Health view={view} asking={asking} setAsking={setAsking} busy={!!busy} act={act} confirm={confirm} />
          )}

          {view && (
            <section>
              <h4 className="lfs-h" style={HEADING}>
                Running · problems first
              </h4>
              {!view.projects.length && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: T.text2 }}>
                  <Ellen pose="sleepy" height={40} />
                  No project runs a Sandbox now.
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
                {view.projects.map((p) => (
                  <div
                    key={p.name}
                    style={{
                      ...card,
                      display: 'grid',
                      alignContent: 'start',
                      overflow: 'hidden',
                      borderLeft:
                        p.level === 'ok' ? card.border : `3px solid ${p.level === 'down' ? T.danger : T.warn}`,
                    }}
                  >
                    <button
                      type="button"
                      className="lfs-card"
                      onClick={() => onOpen(p.name)}
                      title={`Open ${p.name}'s Sandboxes`}
                      style={{
                        textAlign: 'left',
                        cursor: 'pointer',
                        padding: '8px 10px',
                        display: 'grid',
                        gap: 4,
                        color: 'inherit',
                        font: 'inherit',
                        alignContent: 'start',
                        border: 0,
                        background: 'transparent',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontWeight: 600, minWidth: 0 }}>
                        <span style={{ alignSelf: 'center', display: 'flex' }}>
                          <Dot level={p.level} />
                        </span>
                        <span style={{ wordBreak: 'break-all' }}>{p.name}</span>
                        <span style={{ flex: 1 }} />
                        {p.sandboxes.length > 0 && (
                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 11,
                              fontWeight: 400,
                              color: T.caption,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {plural(p.sandboxes.length, 'Sandbox', 'Sandboxes')} · {p.workspaces} WS
                          </span>
                        )}
                      </span>
                      {p.sandboxes.map((s) => (
                        <span
                          key={s.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontFamily: MONO,
                            fontSize: 11,
                            color: T.text2,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span style={{ minWidth: 26 }} title={s.name ?? undefined}>
                            -{s.id}
                          </span>
                          <Meter used={s.used} capacity={s.capacity} />
                          <span>
                            {s.used}/{s.capacity}
                          </span>
                          <span title="Written outside its Workspaces (/tmp, caches): goes when the Sandbox is deleted">
                            scratch {s.scratch === null ? '?' : bytes(s.scratch)}
                          </span>
                          {s.image && (
                            <span title={s.image} style={{ color: T.caption }}>
                              {imageLabel(s)}
                            </span>
                          )}
                          {s.starting && (
                            <span
                              title="Its container just started; its daemon does not answer yet"
                              style={{ color: T.text2 }}
                            >
                              starting…
                            </span>
                          )}
                        </span>
                      ))}
                      {p.note && (
                        <span
                          style={{
                            fontSize: 11.5,
                            color: p.level === 'down' ? T.danger : T.warn,
                            wordBreak: 'break-word',
                          }}
                        >
                          {p.note}
                        </span>
                      )}
                    </button>
                    {p.removable && (
                      <span style={{ padding: '0 10px 8px' }}>
                        {asking === `project:${p.name}` ? (
                          confirm(
                            <>Remove {p.name} from the list? Nothing of it is left to recover; only its entry goes.</>,
                            'Remove',
                            `Removing ${p.name}…`,
                            () => api.remove(p.name),
                          )
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!!busy}
                            onClick={() => setAsking(`project:${p.name}`)}
                          >
                            Remove from list…
                          </Button>
                        )}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {view && view.idle.length > 0 && (
            <section>
              <h4 className="lfs-h" style={HEADING}>
                Idle · start a Sandbox on the next mount
              </h4>
              <div style={{ ...card, display: 'grid' }}>
                {view.idle.map((p, i) => (
                  <button
                    key={p.name}
                    type="button"
                    className="lfs-card"
                    onClick={() => onOpen(p.name)}
                    title={`Open ${p.name}'s Sandboxes`}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      padding: '5px 10px',
                      border: 0,
                      borderTop: i ? `1px solid ${T.border}` : 0,
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ wordBreak: 'break-all' }}>{p.name}</span>
                    <span style={{ flex: 1 }} />
                    <span
                      style={{ fontFamily: MONO, fontSize: 11, color: T.caption, whiteSpace: 'nowrap' }}
                      title="Its Store volume in Docker"
                    >
                      Store {view.volumes === null ? '?' : p.volume === null ? '—' : bytes(p.volume)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {view && (
            <Leftovers view={view} asking={asking} setAsking={setAsking} busy={!!busy} act={act} confirm={confirm} />
          )}
        </div>
      </div>
    </div>
  )
}

interface Parts {
  view: Overview
  asking: string | null
  setAsking: (v: string | null) => void
  busy: boolean
  act: (label: string, run: () => Promise<unknown>) => Promise<void>
  confirm: (text: ReactNode, yes: string, label: string, run: () => Promise<unknown>) => ReactNode
}

/** One thin row: Docker, Store calls, free disk, the last sweep. */
function Health({ view, asking, setAsking, busy, act, confirm }: Parts) {
  const store = view.store,
    up = view.engine.level === 'ok'
  const cell = (label: string, level: Level | null, value: ReactNode, actions?: ReactNode) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', whiteSpace: 'nowrap' }}>
      {level && <Dot level={level} />}
      <span style={{ color: T.text2 }}>{label}</span>
      <span style={{ fontFamily: MONO, fontWeight: 600, color: level && level !== 'ok' ? LEVEL_COLOR[level] : T.text }}>
        {value}
      </span>
      {actions}
    </span>
  )
  // Store calls: the worker (macOS, Windows), else in-process (Linux)
  let storeCell: ReactNode
  if (store) {
    const word =
      store.state !== 'running'
        ? store.state
        : store.answering === false
          ? 'not answering'
          : store.build && store.build !== store.expected
            ? 'worker ready · older build'
            : 'worker ready'
    storeCell = cell(
      'Store calls',
      store.level,
      word,
      up && (
        <>
          {store.state !== 'running' && (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void act(`Starting ${store.name}…`, api.startStore)}
            >
              Start
            </Button>
          )}
          {store.state === 'running' && store.level !== 'ok' && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              title="Stop and start it again: every Store call waits a few seconds"
              onClick={() => setAsking('restart')}
            >
              Restart…
            </Button>
          )}
        </>
      ),
    )
  } else storeCell = cell('Store calls', 'ok', 'in-process')
  const free = (n: number | null) => (n === null ? '?' : `${bytes(n)} free`)
  const sweep = view.sweep
  let swept: ReactNode = null
  if (sweep?.state === 'running') swept = 'sweeping stopped Sandboxes…'
  else if (sweep?.state === 'done') {
    const n = Object.values(sweep.reclaimed).reduce((k, ids) => k + ids.length, 0)
    swept = (
      <span title={sweep.failed.map((f) => `${f.project}: ${f.code} ${f.message}`).join('\n') || undefined}>
        {`last sweep ${span(Date.now() - Date.parse(sweep.at))} ago: ${n ? `deleted ${plural(n, 'stopped Sandbox', 'stopped Sandboxes')}` : 'nothing to delete'}${sweep.failed.length ? `; ${plural(sweep.failed.length, 'project')} failed` : ''}`}
      </span>
    )
  } else if (sweep?.state === 'failed')
    swept = (
      <span
        title={sweep.message}
      >{`last sweep ${span(Date.now() - Date.parse(sweep.at))} ago failed: ${sweep.code}`}</span>
    )
  else swept = 'sweep off'
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', fontSize: 12, rowGap: 2 }}>
        {cell('Docker', view.engine.level, up ? view.engine.version : 'not answering')}
        {storeCell}
        {cell('Host', null, free(view.disk.host))}
        {cell('Docker', view.disk.dockerLevel, free(view.disk.docker))}
        <span style={{ flex: 1 }} />
        <span
          style={{
            padding: '4px 10px',
            fontSize: 11.5,
            color: sweep?.state === 'failed' || (sweep?.state === 'done' && sweep.failed.length) ? T.warn : T.caption,
          }}
        >
          {swept}
        </span>
      </div>
      {store &&
        asking === 'restart' &&
        confirm(
          <>
            Restart {store.name}? Every project's Store calls stop for a few seconds{running(view.calls)}.
          </>,
          'Restart',
          `Restarting ${store.name}…`,
          api.restartStore,
        )}
    </div>
  )
}

/** Stopped or ownerless containers, and Store volumes no project uses. */
function Leftovers({ view, asking, setAsking, busy, act, confirm }: Parts) {
  const stopped = view.leftovers.filter((l) => !l.running)
  const orphans = view.volumes?.orphans ?? [],
    unknown = view.volumes?.unknown ?? { count: 0, size: 0 }
  if (!view.leftovers.length && !orphans.length && !unknown.count) return null
  const row = (i: number, children: ReactNode) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '6px 10px',
        borderTop: i ? `1px solid ${T.border}` : 0,
        flexWrap: 'wrap',
      }}
    >
      {children}
    </div>
  )
  let i = 0
  return (
    <section>
      <h4 className="lfs-h" style={HEADING}>
        Leftovers
      </h4>
      <div style={{ ...card, display: 'grid' }}>
        {view.leftovers.map((l) =>
          row(
            i++,
            <>
              <span style={{ alignSelf: 'center', display: 'flex' }}>
                <Dot level="degraded" />
              </span>
              <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
                <span style={{ fontFamily: MONO }}>{l.name}</span>
                <span style={{ color: T.text2 }}>
                  {' '}
                  · container · {l.status}
                  {l.project ? ` · project ${l.project}` : ''}
                </span>
              </span>
            </>,
          ),
        )}
        {stopped.length > 0 &&
          row(
            i++,
            asking === 'containers' ? (
              <span style={{ flex: 1 }}>
                {confirm(
                  `Remove ${plural(stopped.length, 'stopped container')}? They run nothing; their Store volumes stay.`,
                  'Remove',
                  'Removing leftover containers…',
                  () => api.cleanLeftovers(stopped.map((l) => l.name)),
                )}
              </span>
            ) : (
              <>
                <span style={{ flex: 1, color: T.text2 }}>Running leftovers are left for you to stop.</span>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setAsking('containers')}>
                  Remove stopped…
                </Button>
              </>
            ),
          )}
        {orphans.map((v) =>
          row(
            i++,
            <>
              <span style={{ alignSelf: 'center', display: 'flex' }}>
                <Dot level="degraded" />
              </span>
              <span style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>
                <span style={{ fontFamily: MONO }}>{v.name}</span>
                <span style={{ color: T.text2 }}>
                  {' '}
                  · Store volume · {v.size === null ? '?' : bytes(v.size)}
                  {v.project ? ` · project ${v.project}, no longer here` : ''}
                  {v.containers ? ` · ${plural(v.containers, 'container')} use it` : ''}
                </span>
              </span>
              {asking === v.name ? (
                <span style={{ flexBasis: '100%' }}>
                  {confirm(
                    `Remove the volume ${v.name}${v.size === null ? '' : ` (${bytes(v.size)})`}? Its Store is deleted for good.`,
                    'Remove',
                    `Removing ${v.name}…`,
                    () => api.removeVolumes([v.name]),
                  )}
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !v.removable}
                  title={v.removable ? undefined : 'A container still uses it'}
                  onClick={() => setAsking(v.name)}
                >
                  Remove…
                </Button>
              )}
            </>,
          ),
        )}
        {unknown.count > 0 &&
          row(
            i++,
            <span style={{ color: T.text2 }}>
              {plural(unknown.count, 'other Docker volume')} ({bytes(unknown.size)}) no LayerFS home claims: made before
              volumes were labelled, or by another tool. Remove them by hand if they are unused.
            </span>,
          )}
      </div>
    </section>
  )
}
