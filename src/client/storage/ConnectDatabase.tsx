/**
 * Connect a database: the one dialog a PostgreSQL Store is connected and
 * checked with. A PostgreSQL Store is on no machine and has no Store-wide
 * machine (spec v23): any machine that runs PostgreSQL Sandboxes reaches it,
 * with its own address or the Store's, and each session picks where it runs.
 * Three screens:
 *
 * - pick: every connected PostgreSQL Store under its server, each with the
 *   machines it is connected from and one button (Check from this computer;
 *   on a machine page, Connect: the check from that machine). Each server
 *   ends with "New database on this server" (its host and user filled in,
 *   its login reused) and the list with "New server".
 * - new: the database, its Store name (the database's by default), for a new
 *   server its host, user and password (a pasted connection URL fills them);
 *   a saved login that already serves that server is picked by default
 *   (V23-12). store.connect, then the check from this computer (or the
 *   machine page's machine), which LayerFS records.
 * - check: the path the machine dials (machine, server, Store) and the three
 *   things the check tries from there (store doctor --machine). It answers
 *   once, so the path runs as one until it does; a failure marks the step
 *   LayerFS names (machine-stores.ts `failedStep`), else shows as it came.
 *   Only then, and only for a server not reached, the machine can be given
 *   an address of its own (store connect --machine, which LayerFS checks
 *   from the machine before it saves anything).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { MachineGlyph } from '../machines/icons.tsx'
import { machinesFor } from '../projects/setup/model.ts'
import { Field, MenuSelect, Refusal } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { CHECK_STEPS, checkFailureKind, checkWires, failedStep, missingPrivilege, parsePgUrl, pgUrl, routedServer, serverGroups, serverKey, type CheckStep, type PgServerGroup } from './machine-stores.ts'
import { connectedMachines, loopbackAlias } from './model.ts'
import { refusalLabels, StoreGlyph, TextField } from './parts.tsx'
import { loginInUrlFix, PG_URL_LOGIN, PgPasswordFields, usePgAuths, usePgPassword } from './pg-fields.tsx'
import type { PgAuth, PgCheck, StorageView, StoreRow } from './types.ts'
import css from './MachineStores.module.css'
import scss from './Storage.module.css'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/
const SYNC = ['off', 'local', 'remote_write', 'on', 'remote_apply'] as const

type Screen = { kind: 'pick' } | { kind: 'new', server: PgServerGroup | null } | { kind: 'check', check: Check }

interface Check {
  store: string
  machine: string
  /** `ready`: opened on it, not run yet; the named Check runs it (opening writes nothing: M FAIL 3b). */
  state: 'ready' | 'running' | 'ok' | 'failed'
  /** What the machine answered. */
  result?: PgCheck
  /** A refusal of the call itself, or the check's own error. */
  error?: unknown
  /** This dialog connected the Store just before. */
  connected?: boolean
}

/** The address `machine` dials for `store`: its own connection's, else the Store's with a loopback host renamed for the machine. */
export function dialedServer(s: StoreRow | undefined, machine: string, platform: string | undefined): string {
  const own = s?.ownConnections?.find((c) => c.machine === machine)
  const ownHost = own?.url ? parsePgUrl(own.url)?.host : null
  if (ownHost) return ownHost
  return s ? routedServer(serverKey(s), platform ? loopbackAlias(platform) : null) : ''
}

export function ConnectDatabaseDialog({ api, t, view, machine: fixed, server, check: startCheck, onClose, done, onEditLogin, onRotateLogin }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined
  /** A machine page's dialog: checks run from it, so a Store is connected from it. */
  machine?: string | undefined
  /** Open on a new database on this server (`host:port`). */
  server?: string | undefined
  /** Open on the check of a Store, from `machine` (else this computer): Connect a machine. */
  check?: { store: string, machine?: string | undefined } | undefined
  onClose: () => void, done: () => void
  /** Open Edit connection / Save a login for `store` when a check finds a login, privilege or record problem. */
  onEditLogin?: ((store: string) => void) | undefined
  /** Open Rotate password for saved login `auth` when a check finds a login failure. */
  onRotateLogin?: ((auth: string) => void) | undefined
}): ReactNode {
  const groups = serverGroups(view?.stores ?? [])
  const [screen, setScreen] = useState<Screen>(() => {
    if (startCheck) {
      return { kind: 'check', check: { store: startCheck.store, machine: startCheck.machine ?? fixed ?? 'native', state: 'ready' } }
    }
    if (server) return { kind: 'new', server: groups.find((g) => g.server === server) ?? null }
    return groups.length ? { kind: 'pick' } : { kind: 'new', server: null }
  })
  const [own, setOwn] = useState(false)
  // why the new database's Connect is off (K FAIL 2): the form's reason, shown beside the disabled press
  const [newWhy, setNewWhy] = useState<string | null>(null)
  const [ownUrl, setOwnUrl] = useState('')
  // one call at a time: a newer check wins, an older answer is dropped
  const turn = useRef(0)

  /** The check from `machine` (GET …/check); `via` runs first (a new connection of the machine's own). */
  const check = async (store: string, machine: string, extra: { connected?: boolean } = {}, via?: () => Promise<unknown>) => {
    const mine = ++turn.current
    setScreen({ kind: 'check', check: { store, machine, state: 'running', ...extra } })
    try {
      if (via) { await via(); done() }
      const result = await api.call<PgCheck>('GET', `/api/stores/${enc(store)}/check?machine=${enc(machine)}`)
      if (mine !== turn.current) return
      setScreen({ kind: 'check', check: { store, machine, state: result.ok ? 'ok' : 'failed', result, ...(result.ok ? {} : { error: result.error }), ...extra } })
    } catch (error) {
      if (mine === turn.current) setScreen({ kind: 'check', check: { store, machine, state: 'failed', error, ...extra } })
    }
  }
  // opened on a check: nothing runs until its named Check is pressed (a check runs store doctor and writes observed state)
  if (!view) return null
  const place = (m: string) => (m === 'native' ? t('layerfsHome') : m)
  const running = screen.kind === 'check' && screen.check.state === 'running'
  const title = screen.kind === 'check' ? t('cdCheckTitle', { store: screen.check.store }) : fixed ? t('cdTitle', { machine: place(fixed) }) : t('connectDatabase')
  // a dialog opened on one screen has no list to go back to
  const back = startCheck || running || screen.kind === 'pick' || (screen.kind === 'new' && (server || !groups.length)) ? null : () => { setOwn(false); setScreen({ kind: 'pick' }) }
  return (
    <Modal open onClose={() => { if (!running) onClose() }} title={title} closeLabel={t('close')} className={scss.modal}
      footer={<Footer t={t} screen={screen} back={back} onClose={onClose} place={place} why={newWhy}
        onRun={() => { if (screen.kind === 'check') void check(screen.check.store, screen.check.machine, { connected: screen.check.connected }) }} />}>
      <div className={scss.form}>
        {screen.kind === 'pick' ? (
          <Pick t={t} groups={groups} fixed={fixed} place={place}
            onCheck={(s) => void check(s.name, fixed ?? 'native')}
            onNew={(g) => setScreen({ kind: 'new', server: g })} />
        ) : screen.kind === 'new' ? (
          <NewDatabase api={api} t={t} view={view} server={screen.server} onWhy={setNewWhy}
            onConnected={(store) => { done(); void check(store, fixed ?? 'native', { connected: true }) }} />
        ) : (
          <CheckView t={t} view={view} check={screen.check} place={place} own={own} ownUrl={ownUrl} setOwnUrl={setOwnUrl}
            onFrom={(machine) => { setOwn(false); if (screen.check.state === 'ready') setScreen({ kind: 'check', check: { ...screen.check, machine } }); else void check(screen.check.store, machine, { connected: screen.check.connected }) }}
            onOwn={() => setOwn(true)}
            onEditLogin={onEditLogin}
            onRotateLogin={onRotateLogin}
            onRetryOwn={() => {
              const { store, machine, connected } = screen.check
              // a machine's own address only: the Store's saved login goes with it (store connect --machine)
              void check(store, machine, { connected }, () => api.call('POST', `/api/stores/${enc(store)}/connection`, { machine, url: ownUrl.trim() }))
            }} />
        )}
      </div>
    </Modal>
  )
}

function Footer({ t, screen, back, onClose, onRun, place, why }: { t: StorageT, screen: Screen, back: (() => void) | null, onClose: () => void, onRun: () => void, place: (m: string) => string, why: string | null }): ReactNode {
  const check = screen.kind === 'check' ? screen.check : null
  return (
    <div className={scss.modalFooter}>
      {check?.state === 'running' ? <span className={scss.modalHint} role="status">{t('cdChecking')}</span>
        : screen.kind === 'new' && why ? <span className={scss.modalHint} data-connect-why>{why}</span> : <span />}
      <div className={scss.modalActions}>
        {back ? <Button variant="outline" onClick={back}>{t('cdBack')}</Button> : null}
        {check?.state === 'ready' || screen.kind === 'new' ? <Button variant="outline" onClick={onClose}>{t('cancel')}</Button> : null}
        {check?.state === 'failed' ? <Button variant="outline" onClick={onRun}>{t('ovCheckAgain')}</Button> : null}
        {check?.state === 'ready'
          ? <Button variant="primary" onClick={onRun}>{t('cdCheckFromNamed', { store: check.store, machine: place(check.machine) })}</Button>
          : check?.state === 'ok'
          ? <Button variant="primary" onClick={onClose}>{t('cdDone')}</Button>
          : screen.kind === 'new'
            ? <Button variant="primary" type="submit" form="lfs-cd-new" disabled={!!why} aria-disabled={!!why || undefined} title={why ?? undefined}>{t('connect')}</Button>
            : <Button variant="outline" disabled={check?.state === 'running'} onClick={onClose}>{check ? t('close') : t('cancel')}</Button>}
      </div>
    </div>
  )
}

function Pick({ t, groups, fixed, place, onCheck, onNew }: {
  t: StorageT, groups: PgServerGroup[], fixed: string | undefined, place: (m: string) => string
  onCheck: (s: StoreRow) => void, onNew: (server: PgServerGroup | null) => void
}): ReactNode {
  return (
    <div className={css.servers}>
      {groups.map((g) => (
        <div key={g.server} className={css.server} data-pg-server={g.server}>
          <div className={css.serverHead}>
            <StoreGlyph kind="postgresql" size={14} />
            <span className={`${css.serverName} ${css.mono}`}>{g.server}</span>
            {g.user ? <span>{t('cdUser', { user: g.user })}</span> : null}
          </div>
          {g.stores.map((s) => {
            const from = connectedMachines(s)
            const database = s.postgresql?.database
            return (
              <div key={s.name} className={css.db} data-pg-store={s.name}>
                <StateDot state={s.state === 'broken' ? 'error' : s.state === 'ready' ? 'done' : 'idle'} size={8} />
                <span className={css.dbMain}>
                  <span className={css.dbName}>{s.name}</span>
                  <span className={css.dbSub}>{[database && database !== s.name ? database : null, from.length ? t('pgFrom', { machines: from.map(place).join(', ') }) : null, s.projects.join(', ') || t('msNoProjects')].filter(Boolean).join(' · ')}</span>
                </span>
                {/* each press names its Store (a Check runs store doctor and writes observed.json): R1 F2 */}
                {fixed && !from.includes(fixed)
                  ? <Button size="sm" variant="outline" aria-label={t('cdConnectMachineNamed', { store: s.name })} onClick={() => onCheck(s)}>{t('pgConnectMachineShort')}</Button>
                  : <Button size="sm" variant="ghost" aria-label={t('cdCheckTitle', { store: s.name })} onClick={() => onCheck(s)}>{t('cdCheck')}</Button>}
              </div>
            )
          })}
          <button type="button" className={css.addRow} aria-label={t('cdNewOnServerNamed', { server: g.server })} onClick={() => onNew(g)}>{t('cdNewOnServer')}</button>
        </div>
      ))}
      <button type="button" className={`${css.addRow} ${css.addServer}`} onClick={() => onNew(null)} data-pg-new-server>{t('cdNewServer')}</button>
    </div>
  )
}

/** A URL's options (`?sslmode=…`), as typed; empty when it has none or cannot be read. */
const searchOf = (text: string): string => { try { return new URL(withScheme(text)).search } catch { return '' } }

/** `text` as a URL with its scheme, as `parsePgUrl` reads one typed without it. */
const withScheme = (text: string) => (/^postgres(?:ql)?:\/\//i.test(text.trim()) ? text.trim() : `postgresql://${text.trim()}`)

/** A server as LayerFS compares them: `host:port`, the host in lower case, port 5432 by default. */
const serverOf = (host: string): string => { const h = host.trim().toLowerCase(); return !h ? '' : /:\d+$/.test(h) ? h : `${h}:5432` }

/** The saved login that already serves `server` (one of its Stores is on it), for Connect a database's default (spec v23 V23-12). */
export function serverLogin(view: Pick<StorageView, 'stores'>, auths: readonly PgAuth[], server: string): string | null {
  if (!server) return null
  const on = new Set(view.stores.filter((s) => s.kind === 'postgresql' && s.postgresql?.server === server).map((s) => s.name))
  return auths.find((a) => (a.state ?? 'ready') === 'ready' && a.stores.some((st) => on.has(st)))?.auth ?? null
}

function NewDatabase({ api, t, view, server, onConnected, onWhy }: {
  api: LayerfsApi, t: StorageT, view: StorageView, server: PgServerGroup | null
  /** Why Connect is off now (null: it may be pressed): a login in the URL first, then what is still needed. */
  onWhy: (why: string | null) => void
  onConnected: (store: string) => void
}): ReactNode {
  // a new server is given whole, as one URL; a known server gives its host and user
  const [url, setUrl] = useState('')
  const [typed, setTyped] = useState('')
  const given = server ? null : parsePgUrl(url)
  const host = server ? server.server : given?.host ?? ''
  const user = server ? server.user : given?.user ?? ''
  const database = (server ? typed : given?.database ?? '').trim()
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [sync, setSync] = useState('')
  // a database on a known server takes that server's saved login unless another is given; a pasted URL's user fills the login's
  // reused only from a Store with a saved login (one naming none is broken and has none to give)
  const pw = usePgPassword('entered', '', server?.stores.find((s) => s.postgresql?.auth)?.name ?? null)
  const auths = usePgAuths(api)
  const loginUser = pw.user.trim() || user
  // a new server's URL whose server a saved login already serves: that login, until the person picks another way
  const known = server ? null : serverLogin(view, auths, serverOf(host))
  const chose = useRef(false)
  useEffect(() => { if (known && !chose.current) { pw.setHow('saved'); pw.setAuth(known) } }, [known])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [tried, setTried] = useState(false)
  const storeName = (named ? name : database.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')).trim()
  const taken = view.stores.some((s) => s.name === storeName)
  const dbTaken = server && database ? server.stores.find((s) => s.postgresql?.database === database) : undefined
  // a URL that names no server or no database is said so once Connect was tried, not while it is typed
  const urlShort = !server && !!url.trim() && !(host && database)
  // V23-13: a URL naming a login (a password, user=, passfile=) is refused with words, nothing created (M FAIL 2)
  const loginInUrl = !server && PG_URL_LOGIN.test(withScheme(url))
  const urlError = loginInUrl ? t('cdLoginInUrl') : tried && urlShort ? t('cdUrlInvalid') : null
  // its other options (sslmode, …) go to LayerFS as given, never dropped
  const options = server ? '' : searchOf(url)
  const loginMissing = pw.how === 'entered' ? (!loginUser ? t('pgUser') : !pw.value ? t('pgPasswordValue') : null) : pw.missing ? t('pgPasswordReferenceLabel') : null
  const missing = [server ? !database && t('cdDatabase') : !url.trim() && t('cdUrl'), !storeName && t('cdStoreName'), loginMissing].filter(Boolean) as string[]
  const nameError = storeName && !NAME.test(storeName) ? t('projectNameHint') : taken ? t('nameTaken') : null
  const valid = !missing.length && !urlShort && !nameError && !urlError && !pw.error(t) && !dbTaken
  const why = valid ? null : urlError ?? (urlShort ? t('cdUrlInvalid') : null) ?? nameError ?? pw.error(t) ?? (dbTaken ? t('pgDatabaseTaken', { store: dbTaken.name }) : null) ?? (missing.length ? t('stillNeeded', { what: missing.join(', ') }) : null)
  useEffect(() => { onWhy(why) }, [why])
  useEffect(() => () => onWhy(null), [])
  const submit = async () => {
    setTried(true)
    if (!valid || busy) return
    setBusy(true); setError(undefined)
    try {
      await api.call('POST', '/api/stores/postgresql', {
        // the address has no user: the login (saved now, reused, or named) carries it
        name: storeName, url: `${pgUrl({ user: '', host, database })}${options}`, ...(pw.how === 'entered' ? { user: loginUser, passwordValue: pw.value } : pw.body()), ...(sync ? { synchronousCommit: sync } : {}),
      })
      onConnected(storeName)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form id="lfs-cd-new" className={scss.form} onSubmit={(e) => { e.preventDefault(); void submit() }} aria-busy={busy}>
      {server ? <p className={css.serverGiven}>{t('cdOnServer', { server: server.server, user: server.user || '—' })}</p> : null}
      {server
        ? <TextField label={t('cdDatabase')} value={typed} onChange={setTyped} mono placeholder="orders" autoFocus hint={t('pgDatabaseHint')}
            error={dbTaken ? t('pgDatabaseTaken', { store: dbTaken.name }) : null} />
        : <TextField label={t('cdUrl')} value={url} onChange={setUrl} mono placeholder="postgresql://db.internal:5432/orders" hint={t('cdUrlHint')} error={urlError} autoFocus />}
      {/* LayerFS's own fix for it: save the login, connect the address without it (--auth) */}
      {loginInUrl ? <p className={scss.formNote} data-login-fix><span>{t('cdLoginFix')}</span> <code className={css.mono}>{loginInUrlFix(url, storeName)}</code></p> : null}
      <TextField label={t('cdStoreName')} value={named ? name : storeName} onChange={(v) => { setNamed(true); setName(v) }} mono error={nameError} />
      <PgPasswordFields id="lfs-cd-password" pw={{ ...pw, setHow: (h: Parameters<typeof pw.setHow>[0]) => { chose.current = true; pw.setHow(h) } }} t={t} auths={auths} />
      <details className={scss.storeDetails}>
        <summary className={scss.storeDetailsSummary}>
          <IconChevronRightOutlineRegular size={12} className={scss.storeDetailsChevron} />
          <span>{sync ? t('nsMoreOptionsSet', { value: sync }) : t('nsMoreOptions')}</span>
        </summary>
        <Field label={t('syncCommit')}>
          <MenuSelect value={sync} label={t('syncCommit')} placeholder={t('syncCommitDefault')}
            options={[{ value: '', label: t('syncCommitDefault') }, ...SYNC.map((v) => ({ value: v, label: v }))]} onChange={setSync} />
        </Field>
      </details>
      {busy ? <p className={scss.formNote} role="status">{t('cdConnecting')}</p> : null}
      {missing.length && tried ? <p className={scss.formNote} role="alert">{t('stillNeeded', { what: missing.join(', ') })}</p> : null}
      {error !== undefined ? <Refusal error={error} labels={refusalLabels(t)} /> : null}
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
  )
}

function CheckView({ t, view, check, place, own, ownUrl, setOwnUrl, onFrom, onOwn, onRetryOwn, onEditLogin, onRotateLogin }: {
  t: StorageT, view: StorageView, check: Check, place: (m: string) => string
  own: boolean, ownUrl: string, setOwnUrl: (v: string) => void
  onFrom: (machine: string) => void, onOwn: () => void, onRetryOwn: () => void
  onEditLogin?: ((store: string) => void) | undefined
  onRotateLogin?: ((auth: string) => void) | undefined
}): ReactNode {
  const machine = check.machine
  const from_ = view.machines.find((m) => m.name === machine)
  const platform = from_?.platform
  // a stopped machine answers no check: say so, and offer no address of its own
  const stopped = machine !== 'native' && from_?.state != null && from_.state !== 'ready'
  const s = view.stores.find((x) => x.name === check.store)
  const server = check.result?.host ?? dialedServer(s, machine, platform)
  const failure = check.state === 'failed' ? (check.error as { code?: string, message?: string, fix?: string, step?: string } | undefined) : undefined
  const at = failure ? failedStep(failure.code, failure.message, failure.step) : null
  const kind = failure ? checkFailureKind(failure.code, failure.message, failure.step) : null
  const stepState = (step: CheckStep): 'pending' | 'running' | 'ok' | 'failed' | 'unknown' => {
    if (check.state === 'ready') return 'pending'
    if (check.state === 'running') return 'running'
    if (check.state === 'ok') return 'ok'
    if (!at) return 'unknown'
    const i = CHECK_STEPS.indexOf(step), f = CHECK_STEPS.indexOf(at)
    return i < f ? 'ok' : i === f ? 'failed' : 'pending'
  }
  const [serverWire, storeWire] = checkWires(check.state, at)
  const words: Record<CheckStep, string> = {
    record: t('cdStepRecord'),
    server: t('cdStepServer'),
    login: t('cdStepLogin'),
    store: t('cdStepStore'),
    write: t('cdStepWrite'),
  }
  const priv = kind === 'privilege' ? missingPrivilege(failure?.message) : null
  const guidance = (() => {
    if (check.state !== 'failed' || stopped || !kind) return null
    switch (kind) {
      case 'server': return machine === 'native' ? t('cdFixServerHere') : t('cdFixServer', { machine: place(machine) })
      case 'login': return t('cdFixLogin')
      case 'privilege':
        if (!priv) return t('cdFixPrivilegeGeneric')
        return priv.count && priv.count > 1
          ? t('cdFixPrivilege', { role: priv.role, privilege: priv.privilege, count: priv.count })
          : t('cdFixPrivilegeOne', { role: priv.role, privilege: priv.privilege })
      case 'record': {
        const msg = failure?.message ?? ''
        if (!s?.postgresql?.auth || /no saved login/i.test(msg)) return t('cdFixRecordNoLogin')
        if (/does not hold|\bmissing\b/i.test(msg)) return t('cdFixRecordMissingLogin')
        return t('cdFixRecord')
      }
      case 'store': return t('cdFixStore')
    }
  })()
  const auth = s?.postgresql?.auth ?? null
  const from = machinesFor(view, 'postgresql')
  const ok = check.result?.ok ? check.result : null
  return (
    <>
      <Field label={t('cdFrom')}>
        <MenuSelect value={machine} label={t('cdFrom')} disabled={check.state === 'running'} className={scss.selfStart}
          options={(from.some((m) => m.name === machine) ? from.map((m) => m.name) : [machine, ...from.map((m) => m.name)]).map((m) => ({ value: m, label: place(m) }))} onChange={onFrom} />
      </Field>
      <div className={css.path} aria-hidden="true">
        <span className={css.hop}><span className={css.node}><MachineGlyph platform={platform ?? 'native'} size={18} /></span><span className={css.hopLabel}>{place(machine)}</span></span>
        <span className={css.wire} data-state={serverWire} />
        <span className={css.hop}><span className={css.node}><StoreGlyph kind="postgresql" size={18} /></span><span className={`${css.hopLabel} ${css.mono}`}>{server}</span></span>
        <span className={css.wire} data-state={storeWire} />
        <span className={css.hop}><span className={css.node}><StoreGlyph kind="postgresql" size={18} mono /></span><span className={css.hopLabel}>{check.store}</span></span>
      </div>
      <ul className={css.steps} aria-label={t('cdCheckFrom', { machine: place(machine) })}>
        {CHECK_STEPS.map((step) => {
          const state = stepState(step)
          return (
            <li key={step} className={css.step} data-state={state} data-step={step}>
              <span className={css.stepMark}>{state === 'running' ? <StateDot state="ongoing" size={12} /> : state === 'ok' ? <StateDot state="done" size={9} /> : state === 'failed' ? <StateDot state="error" size={9} /> : <StateDot state="idle" size={9} />}</span>
              {words[step]}
            </li>
          )
        })}
      </ul>
      {ok ? (
        <p className={css.result} role="status">
          {[t('cdReached', { store: check.store, machine: place(machine) }), ok.version ? t('msPgShort', { version: ok.version.split(' ')[0]! }) : null, ok.latencyMs != null ? `${ok.latencyMs} ms` : null].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {check.state === 'failed' ? (
        <div className={css.checkFailure}>
          {check.connected ? <p className={css.checkFailureNote}>{t('cdConnectedNotReached', { store: check.store, machine: place(machine) })}</p> : null}
          {stopped ? <p className={css.checkFailureNote} role="status">{t('cdMachineStopped', { machine: place(machine) })}</p> : null}
          {guidance ? <p className={css.checkFailureNote} data-check-failure={kind ?? undefined}>{guidance}</p> : null}
          <Refusal error={check.error} labels={refusalLabels(t)} />
          {!stopped && kind === 'server' && machine !== 'native' && !own ? (
            <Button variant="outline" size="sm" className={scss.selfStart} onClick={onOwn}>{t('cdOwnAddress', { machine: place(machine) })}</Button>
          ) : null}
          {!stopped && kind === 'server' && machine === 'native' && onEditLogin ? (
            <Button variant="outline" size="sm" className={scss.selfStart} onClick={() => onEditLogin(check.store)}>{t('msEditConnection')}</Button>
          ) : null}
          {!stopped && kind === 'login' && (onEditLogin || (auth && onRotateLogin)) ? (
            <div className={css.checkActions}>
              {onEditLogin ? <Button variant="outline" size="sm" onClick={() => onEditLogin(check.store)}>{t('pgChangeLogin')}</Button> : null}
              {auth && onRotateLogin ? <Button variant="outline" size="sm" onClick={() => onRotateLogin(auth)}>{t('pgRotate')}</Button> : null}
            </div>
          ) : null}
          {!stopped && kind === 'privilege' && onEditLogin ? (
            <Button variant="outline" size="sm" className={scss.selfStart} onClick={() => onEditLogin(check.store)}>{t('pgChangeLogin')}</Button>
          ) : null}
          {!stopped && kind === 'record' && !failure?.fix && onEditLogin ? (
            <Button variant="outline" size="sm" className={scss.selfStart} onClick={() => onEditLogin(check.store)}>{t('pgChangeLogin')}</Button>
          ) : null}
          {!stopped && kind === 'store' && onEditLogin ? (
            <Button variant="outline" size="sm" className={scss.selfStart} onClick={() => onEditLogin(check.store)}>{t('msEditConnection')}</Button>
          ) : null}
          {own ? (
            <>
              <TextField label={t('cdOwnUrl', { machine: place(machine) })} value={ownUrl} onChange={setOwnUrl} mono placeholder="postgresql://10.0.0.12:5432/orders" hint={t('pgUrlHint')}
                error={PG_URL_LOGIN.test(ownUrl.trim()) ? t('pgPasswordInUrl') : null} autoFocus />
              <Button variant="primary" size="sm" className={scss.selfStart} disabled={!ownUrl.trim() || PG_URL_LOGIN.test(ownUrl.trim())}
                onClick={onRetryOwn}>{t('cdSaveAndCheck')}</Button>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
