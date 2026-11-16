/**
 * Connect a database to a machine (the Stores tab's PostgreSQL side). One
 * dialog, three screens:
 *
 * - pick: every connected PostgreSQL Store, grouped by server (host and
 *   user). One already on the machine says so; another has Attach, or why it
 *   cannot be attached here. Each server ends with "New database on this
 *   server" (its host and user filled in) and the list with "New server".
 * - new: the database, its Store name (the database's by default), and for a
 *   new server its host, user and password; a pasted connection URL fills
 *   them. store.connect, then store.attach to this machine (store.connect
 *   attaches the LayerFS Home itself).
 * - check: the path the machine dials (machine, server, Store) and the three
 *   things store.attach checks from there. The call answers once, so the path
 *   runs as one until it does; a refusal marks the step LayerFS names
 *   (machine-stores.ts `failedStep`), else shows as it came. A server not
 *   reached offers the machine its own address, a new attempt the person
 *   starts. A database connected whose attach failed says so: it stays
 *   connected on the LayerFS Home.
 */
import { useState, type ReactNode } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { MachineGlyph } from '../machines/icons.tsx'
import { Refusal, refusalOf } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { CHECK_STEPS, failedStep, parsePgUrl, pgServers, pgUrl, routedServer, type CheckStep, type PgServerGroup } from './machine-stores.ts'
import { loopbackAlias } from './model.ts'
import { refusalLabels, StoreGlyph, TextField } from './parts.tsx'
import { PG_URL_PASSWORD, PgPasswordFields, usePgPassword } from './pg-fields.tsx'
import type { StorageView } from './types.ts'
import css from './MachineStores.module.css'
import scss from './Storage.module.css'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/

type Screen = { kind: 'pick' } | { kind: 'new', server: PgServerGroup | null } | { kind: 'check', check: Check }

interface Check {
  store: string
  /** The address the machine dials, as shown on the path. */
  server: string
  state: 'running' | 'ok' | 'failed'
  error?: unknown
  /** A new database: connected, then its attach failed. */
  connected?: boolean
}

export function ConnectDatabaseDialog({ api, t, view, machine, onClose, done }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, machine: string, onClose: () => void, done: () => void
}): ReactNode {
  const [screen, setScreen] = useState<Screen>({ kind: 'pick' })
  const [own, setOwn] = useState(false)
  const [ownUrl, setOwnUrl] = useState('')
  const ownPw = usePgPassword()
  if (!view) return null
  const place = machine === 'native' ? t('layerfsHome') : machine
  const platform = view.machines.find((m) => m.name === machine)?.platform
  const alias = platform ? loopbackAlias(platform) : null
  const groups = pgServers(view, machine, t)
  const running = screen.kind === 'check' && screen.check.state === 'running'

  /** store.attach from the machine, with its own connection when one is given. */
  const attach = async (store: string, server: string, extra: { connected?: boolean } = {}, ownBody: Record<string, string> = {}) => {
    setScreen({ kind: 'check', check: { store, server, state: 'running', ...extra } })
    try {
      await api.call('POST', `/api/stores/${enc(store)}/attach`, { machine, ...ownBody })
      setScreen({ kind: 'check', check: { store, server, state: 'ok', ...extra } })
    } catch (error) {
      setScreen({ kind: 'check', check: { store, server, state: 'failed', error, ...extra } })
    } finally {
      done()
    }
  }

  const title = t('cdTitle', { machine: place })
  const back = screen.kind === 'pick' || running ? null : () => { setOwn(false); setScreen({ kind: 'pick' }) }
  return (
    <Modal open onClose={() => { if (!running) onClose() }} title={title} closeLabel={t('close')} className={scss.modal}
      footer={<Footer t={t} screen={screen} back={back} onClose={onClose} />}>
      <div className={scss.form}>
        {screen.kind === 'pick' ? (
          <Pick t={t} groups={groups} place={place} alias={alias}
            onAttach={(store, server) => void attach(store, server)}
            onNew={(server) => setScreen({ kind: 'new', server })} />
        ) : screen.kind === 'new' ? (
          <NewDatabase api={api} t={t} view={view} machine={machine} server={screen.server} alias={alias}
            onConnected={(store, server) => {
              done()
              if (machine === 'native') setScreen({ kind: 'check', check: { store, server, state: 'ok' } })
              else void attach(store, server, { connected: true })
            }} />
        ) : (
          <CheckView t={t} check={screen.check} machine={machine} place={place} platform={platform}
            own={own} ownUrl={ownUrl} setOwnUrl={setOwnUrl} ownPw={ownPw}
            onOwn={() => setOwn(true)}
            onRetryOwn={() => {
              const target = parsePgUrl(ownUrl)
              void attach(screen.check.store, target?.host ?? ownUrl, { connected: screen.check.connected }, {
                ...(ownUrl.trim() ? { url: ownUrl.trim() } : {}), ...(ownPw.missing ? {} : ownPw.body()),
              })
            }} />
        )}
      </div>
    </Modal>
  )
}

function Footer({ t, screen, back, onClose }: { t: StorageT, screen: Screen, back: (() => void) | null, onClose: () => void }): ReactNode {
  const check = screen.kind === 'check' ? screen.check : null
  return (
    <div className={scss.modalFooter}>
      {check?.state === 'running' ? <span className={scss.modalHint} role="status">{t('cdChecking')}</span> : <span />}
      <div className={scss.modalActions}>
        {back ? <Button variant="outline" onClick={back}>{t('cdBack')}</Button> : null}
        {check?.state === 'ok'
          ? <Button variant="primary" onClick={onClose}>{t('cdDone')}</Button>
          : screen.kind === 'new'
            ? <Button variant="primary" type="submit" form="lfs-cd-new">{t('cdConnectAttach')}</Button>
            : <Button variant="outline" disabled={check?.state === 'running'} onClick={onClose}>{check ? t('close') : t('cancel')}</Button>}
      </div>
    </div>
  )
}

function Pick({ t, groups, place, alias, onAttach, onNew }: {
  t: StorageT, groups: PgServerGroup[], place: string, alias: string | null
  onAttach: (store: string, server: string) => void, onNew: (server: PgServerGroup | null) => void
}): ReactNode {
  return (
    <div className={css.servers}>
      {groups.length === 0 ? <p className={css.serverGiven}>{t('cdNoneYet')}</p> : null}
      {groups.map((g) => (
        <div key={`${g.user}@${g.server}`} className={css.server} data-pg-server={g.server}>
          <div className={css.serverHead}>
            <StoreGlyph kind="postgresql" size={14} />
            <span className={`${css.serverName} ${css.mono}`}>{g.server}</span>
            {g.user ? <span>{t('cdUser', { user: g.user })}</span> : null}
          </div>
          {g.stores.map(({ store, database, here, why }) => (
            <div key={store.name} className={css.db} data-pg-store={store.name}>
              <StateDot state={here ? 'done' : 'idle'} size={8} />
              <span className={css.dbMain}>
                <span className={css.dbName}>{store.name}</span>
                <span className={css.dbSub}>{[database !== store.name ? database : null, store.projects.join(', ') || t('msNoProjects')].filter(Boolean).join(' · ')}</span>
              </span>
              {here ? <span className={css.muted}>{t('cdOnMachine', { machine: place })}</span>
                : why ? <span className={css.muted} title={why}>{why}</span>
                  : <Button size="sm" variant="outline" onClick={() => onAttach(store.name, routedServer(g.server, alias))}>{t('cdAttach')}</Button>}
            </div>
          ))}
          <button type="button" className={css.addRow} onClick={() => onNew(g)}>{t('cdNewOnServer')}</button>
        </div>
      ))}
      <button type="button" className={`${css.addRow} ${css.addServer}`} onClick={() => onNew(null)} data-pg-new-server>{t('cdNewServer')}</button>
    </div>
  )
}

function NewDatabase({ api, t, view, machine, server, alias, onConnected }: {
  api: LayerfsApi, t: StorageT, view: StorageView, machine: string, server: PgServerGroup | null, alias: string | null
  onConnected: (store: string, server: string) => void
}): ReactNode {
  const [url, setUrl] = useState('')
  const [host, setHost] = useState(server?.server ?? '')
  const [user, setUser] = useState(server?.user ?? '')
  const [database, setDatabase] = useState('')
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const pw = usePgPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [tried, setTried] = useState(false)
  const fill = (text: string) => {
    setUrl(text)
    const parts = parsePgUrl(text)
    if (!parts || !/^postgres(?:ql)?:\/\//i.test(text.trim())) return
    setHost(parts.host); setUser(parts.user); setDatabase(parts.database)
    if (!named) setName(parts.database.toLowerCase().replace(/[^a-z0-9_.-]/g, '-'))
  }
  const storeName = (named ? name : name || database.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')).trim()
  const taken = view.stores.some((s) => s.name === storeName)
  const urlError = PG_URL_PASSWORD.test(url.trim()) ? t('pgPasswordInUrl') : null
  const missing = [!database.trim() && t('cdDatabase'), !host.trim() && t('cdHost'), !storeName && t('cdStoreName'), pw.missing && (pw.how === 'entered' ? t('pgPasswordValue') : t('pgPasswordReferenceLabel'))].filter(Boolean) as string[]
  const nameError = storeName && !NAME.test(storeName) ? t('projectNameHint') : taken ? t('nameTaken') : null
  const valid = !missing.length && !nameError && !urlError && !pw.error(t)
  const submit = async () => {
    setTried(true)
    if (!valid || busy) return
    setBusy(true); setError(undefined)
    try {
      await api.call('POST', '/api/stores/postgresql', { name: storeName, url: pgUrl({ user: user.trim(), host: host.trim(), database: database.trim() }), ...pw.body() })
      onConnected(storeName, routedServer(host.trim(), alias))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form id="lfs-cd-new" className={scss.form} onSubmit={(e) => { e.preventDefault(); void submit() }} aria-busy={busy}>
      <p className={css.serverGiven}>{server ? t('cdOnServer', { server: server.server, user: server.user || '—' }) : t('cdNewServerBody')}</p>
      {server ? null : <TextField label={t('cdUrl')} value={url} onChange={fill} mono placeholder="postgresql://app@db.internal:5432/orders" hint={t('cdUrlHint')} error={urlError} autoFocus />}
      <TextField label={t('cdDatabase')} value={database} onChange={setDatabase} mono placeholder="orders" autoFocus={!!server} />
      <TextField label={t('cdStoreName')} value={named ? name : storeName} onChange={(v) => { setNamed(true); setName(v) }} mono hint={t('cdStoreNameHint')} error={nameError} />
      {server ? null : (
        <div className={scss.inline}>
          <span className={scss.grow}><TextField label={t('cdHost')} value={host} onChange={setHost} mono placeholder="db.internal:5432" /></span>
          <span className={scss.grow}><TextField label={t('cdUserLabel')} value={user} onChange={setUser} mono placeholder="app" /></span>
        </div>
      )}
      <PgPasswordFields id="lfs-cd-password" pw={pw} t={t} />
      {machine !== 'native' ? <p className={scss.formNote}>{t('cdThenAttach', { machine })}</p> : null}
      {busy ? <p className={scss.formNote} role="status">{t('cdConnecting')}</p> : null}
      {missing.length && tried ? <p className={scss.formNote} role="alert">{t('stillNeeded', { what: missing.join(', ') })}</p> : null}
      {error !== undefined ? <Refusal error={error} labels={refusalLabels(t)} /> : null}
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
  )
}

function CheckView({ t, check, machine, place, platform, own, ownUrl, setOwnUrl, ownPw, onOwn, onRetryOwn }: {
  t: StorageT, check: Check, machine: string, place: string, platform: string | undefined
  own: boolean, ownUrl: string, setOwnUrl: (v: string) => void, ownPw: ReturnType<typeof usePgPassword>
  onOwn: () => void, onRetryOwn: () => void
}): ReactNode {
  const refusal = check.error !== undefined ? refusalOf(check.error) : null
  const at = refusal ? failedStep(refusal.code, refusal.message) : null
  const stepState = (step: CheckStep): 'pending' | 'running' | 'ok' | 'failed' | 'unknown' => {
    if (check.state === 'running') return 'running'
    if (check.state === 'ok') return 'ok'
    if (!at) return 'unknown'
    const i = CHECK_STEPS.indexOf(step), f = CHECK_STEPS.indexOf(at)
    return i < f ? 'ok' : i === f ? 'failed' : 'pending'
  }
  const wire = (after: CheckStep): string => {
    const s = stepState(after)
    return s === 'unknown' ? 'failed' : s
  }
  const words: Record<CheckStep, string> = { server: t('cdStepServer'), store: t('cdStepStore'), write: t('cdStepWrite') }
  return (
    <>
      <div className={css.path} aria-hidden="true">
        <span className={css.hop}><span className={css.node}><MachineGlyph platform={platform ?? 'native'} size={18} /></span><span className={css.hopLabel}>{place}</span></span>
        <span className={css.wire} data-state={wire('server')} />
        <span className={css.hop}><span className={css.node}><StoreGlyph kind="postgresql" size={18} /></span><span className={`${css.hopLabel} ${css.mono}`}>{check.server}</span></span>
        <span className={css.wire} data-state={check.state === 'failed' && at === 'server' ? 'pending' : wire('store')} />
        <span className={css.hop}><span className={css.node}><StoreGlyph kind="postgresql" size={18} mono /></span><span className={css.hopLabel}>{check.store}</span></span>
      </div>
      <ul className={css.steps} aria-label={t('cdCheckFrom', { machine: place })}>
        {CHECK_STEPS.map((step) => {
          const s = stepState(step)
          return (
            <li key={step} className={css.step} data-state={s} data-step={step}>
              <span className={css.stepMark}>{s === 'running' ? <StateDot state="ongoing" size={12} /> : s === 'ok' ? <StateDot state="done" size={9} /> : s === 'failed' ? <StateDot state="error" size={9} /> : <StateDot state="idle" size={9} />}</span>
              {words[step]}
            </li>
          )
        })}
      </ul>
      {check.state === 'ok' ? <p className={css.result} role="status">{machine === 'native' ? t('cdConnectedHome', { store: check.store }) : t('cdAttached', { store: check.store, machine: place })}</p> : null}
      {check.state === 'failed' ? (
        <>
          {check.connected ? <p className={scss.formNote}>{t('cdConnectedNotAttached', { store: check.store, machine: place })}</p> : null}
          <Refusal error={check.error} labels={refusalLabels(t)} />
          {at === 'server' && machine !== 'native' && !own ? (
            <Button variant="outline" size="sm" className={scss.selfStart} onClick={onOwn}>{t('cdOwnAddress', { machine: place })}</Button>
          ) : null}
          {own ? (
            <>
              <TextField label={t('cdOwnUrl', { machine: place })} value={ownUrl} onChange={setOwnUrl} mono placeholder="postgresql://app@10.0.0.12:5432/orders" hint={t('pgUrlHint')}
                error={PG_URL_PASSWORD.test(ownUrl.trim()) ? t('pgPasswordInUrl') : null} autoFocus />
              <PgPasswordFields id="lfs-cd-own-password" pw={ownPw} t={t} />
              <Button variant="primary" size="sm" className={scss.selfStart} disabled={(!ownUrl.trim() && ownPw.missing) || PG_URL_PASSWORD.test(ownUrl.trim()) || !!ownPw.error(t)}
                onClick={onRetryOwn}>{t('attachAndCheck')}</Button>
            </>
          ) : null}
        </>
      ) : null}
    </>
  )
}
