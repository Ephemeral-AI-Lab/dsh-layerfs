/**
 * Connect a database: the one dialog a PostgreSQL Store is connected and
 * checked with. Three screens: pick, new, check.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../ui/StatusDot.tsx'
import { enc, type LayerfsApi } from '../api.ts'
import { MachineGlyph } from '../machines/icons.tsx'
import { machinesFor } from '../projects/setup/model.ts'
import { Field, MenuSelect, Refusal } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { CHECK_STEPS, checkFailureKind, checkWires, failedStep, missingPrivilege, parsePgUrl, pgUrl, routedServer, serverGroups, serverKey, type CheckStep, type PgServerGroup } from './machine-stores.ts'
import { connectedMachines, loopbackAlias, pgServerLogin } from './model.ts'
import { refusalLabels, StoreGlyph, TextField } from './parts.tsx'
import { formatHostPort, hasPgUrlLogin, isLinuxLocalhostUrl, PgLocalhostNotice, PgLoginInUrlFix, PgPasswordFields, replaceLocalhostWithIpv4, usePgAuths, usePgPassword, withPgScheme } from './pg-fields.tsx'
import type { PgAuth, PgCheck, StorageView, StoreRow } from './types.ts'
import css from './MachineStores.module.css'
import scss from './Storage.module.css'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/
const SYNC = ['off', 'local', 'remote_write', 'on', 'remote_apply'] as const

type Screen = { kind: 'pick' } | { kind: 'new', server: PgServerGroup | null } | { kind: 'check', check: Check }

interface Check {
  store: string
  machine: string
  state: 'ready' | 'running' | 'ok' | 'failed'
  result?: PgCheck
  error?: unknown
  connected?: boolean
}

type HostOs = 'macos' | 'linux' | 'windows' | 'other' | undefined

/** The address `machine` dials for `store`: its own connection's, else the Store's with a loopback host renamed for the machine when the platform rewrites it. */
export function dialedServer(s: StoreRow | undefined, machine: string, platform: string | undefined, hostOs?: HostOs): string {
  const alias = platform ? loopbackAlias(platform, hostOs) : null
  const own = s?.ownConnections?.find((c) => c.machine === machine)
  const ownHost = own?.url ? parsePgUrl(own.url)?.host : null
  if (ownHost) return routedServer(ownHost, alias)
  return s ? routedServer(serverKey(s), alias) : ''
}

export function ConnectDatabaseDialog({ api, t, view, machine: fixed, server, check: startCheck, onClose, done, onEditLogin, onRotateLogin }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined
  machine?: string | undefined
  server?: string | undefined
  check?: { store: string, machine?: string | undefined } | undefined
  onClose: () => void, done: () => void
  onEditLogin?: ((store: string) => void) | undefined
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
  const [newWhy, setNewWhy] = useState<string | null>(null)
  const [ownUrl, setOwnUrl] = useState('')
  const turn = useRef(0)

  const check = async (store: string, machine: string, extra: { connected?: boolean } = {}, via?: () => Promise<unknown>) => {
    const mine = ++turn.current
    setScreen({ kind: 'check', check: { store, machine, state: 'running', ...extra } })
    try {
      if (via) { await via(); done() }
      const result = await api.call<PgCheck>('GET', `/api/stores/${enc(store)}/check?machine=${enc(machine)}`)
      if (mine !== turn.current) return
      done()
      setScreen({ kind: 'check', check: { store, machine, state: result.ok ? 'ok' : 'failed', result, ...(result.ok ? {} : { error: result.error }), ...extra } })
    } catch (error) {
      if (mine === turn.current) setScreen({ kind: 'check', check: { store, machine, state: 'failed', error, ...extra } })
    }
  }
  if (!view) return null
  const place = (m: string) => (m === 'native' ? t('layerfsHome') : m)
  const running = screen.kind === 'check' && screen.check.state === 'running'
  const title = screen.kind === 'check' ? t('cdCheckTitle', { store: screen.check.store }) : fixed ? t('cdTitle', { machine: place(fixed) }) : t('connectDatabase')
  const back = startCheck || running || screen.kind === 'pick' || (screen.kind === 'new' && (server || !groups.length)) ? null : () => { setOwn(false); setOwnUrl(''); setScreen({ kind: 'pick' }) }
  return (
    <Modal open onClose={() => { if (!running) onClose() }} title={title} closeLabel={t('close')} className={scss.modal}
      footer={<Footer t={t} screen={screen} back={back} onClose={onClose} place={place} why={newWhy}
        onRun={() => { if (screen.kind === 'check') void check(screen.check.store, screen.check.machine, { connected: screen.check.connected }) }} />}>
      <div className={scss.form}>
        {screen.kind === 'pick' ? (
          <Pick t={t} groups={groups} auths={view.auths ?? []} fixed={fixed} place={place}
            onCheck={(s) => void check(s.name, fixed ?? 'native')}
            onNew={(g) => setScreen({ kind: 'new', server: g })} />
        ) : screen.kind === 'new' ? (
          <NewDatabase api={api} t={t} view={view} server={screen.server} onWhy={setNewWhy}
            onConnected={(store) => { done(); void check(store, fixed ?? 'native', { connected: true }) }} />
        ) : (
          <CheckView t={t} view={view} check={screen.check} place={place} own={own} ownUrl={ownUrl} setOwnUrl={setOwnUrl}
            onFrom={(machine) => { setOwn(false); setOwnUrl(''); if (screen.check.state === 'ready') setScreen({ kind: 'check', check: { ...screen.check, machine } }); else void check(screen.check.store, machine, { connected: screen.check.connected }) }}
            onOwn={(prefill) => { if (prefill !== undefined) setOwnUrl(prefill); setOwn(true) }}
            onCancelOwn={() => { setOwn(false); setOwnUrl('') }}
            onEditLogin={onEditLogin}
            onRotateLogin={onRotateLogin}
            onRetryOwn={() => {
              const { store, machine, connected } = screen.check
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

/** Whether a Store's dot in Pick should read failed: broken record, or its last reach (on `fixed` when set, else any side) failed. */
function pickDotState(s: StoreRow, fixed: string | undefined): 'error' | 'done' | 'idle' {
  if (s.state === 'broken') return 'error'
  const rows = s.connectedFrom ?? []
  const relevant = fixed ? rows.filter((c) => (c.machine ?? 'native') === fixed) : rows
  if (relevant.some((c) => c.reached === 'failed')) return 'error'
  return s.state === 'ready' ? 'done' : 'idle'
}

function Pick({ t, groups, auths, fixed, place, onCheck, onNew }: {
  t: StorageT, groups: PgServerGroup[], auths: readonly PgAuth[], fixed: string | undefined, place: (m: string) => string
  onCheck: (s: StoreRow) => void, onNew: (server: PgServerGroup | null) => void
}): ReactNode {
  const userOf = (auth: string) => auths.find((a) => a.auth === auth)?.user ?? null
  return (
    <div className={css.servers}>
      {groups.map((g) => {
        const singleAuth = g.auths.length === 1 ? g.auths[0]! : null
        const singleUser = singleAuth ? userOf(singleAuth) : null
        const headLogin = singleAuth ? (singleUser ? `${singleAuth} (${singleUser})` : singleAuth) : null
        const mixedAuths = g.auths.length > 1
        return (
          <div key={g.server} className={css.server} data-pg-server={g.server}>
            <div className={css.serverHead}>
              <StoreGlyph kind="postgresql" size={14} />
              <span className={`${css.serverName} ${css.mono}`}>{g.server}</span>
              {headLogin ? <span>{t('cdUser', { user: headLogin })}</span> : null}
            </div>
            {g.stores.map((s) => {
              const from = connectedMachines(s)
              const database = s.postgresql?.database
              const authTag = mixedAuths && s.postgresql?.auth ? t('cdUser', { user: s.postgresql.auth }) : null
              return (
                <div key={s.name} className={css.db} data-pg-store={s.name}>
                  <StatusDot state={pickDotState(s, fixed)} size={8} />
                  <span className={css.dbMain}>
                    <span className={css.dbName}>{s.name}</span>
                    <span className={css.dbSub}>{[database && database !== s.name ? database : null, authTag, from.length ? t('pgFrom', { machines: from.map(place).join(', ') }) : null, s.projects.join(', ') || t('msNoProjects')].filter(Boolean).join(' · ')}</span>
                  </span>
                  {fixed && !from.includes(fixed)
                    ? <Button size="sm" variant="outline" aria-label={t('cdConnectMachineNamed', { store: s.name })} onClick={() => onCheck(s)}>{t('pgConnectMachineShort')}</Button>
                    : <Button size="sm" variant="ghost" aria-label={t('cdCheckTitle', { store: s.name })} onClick={() => onCheck(s)}>{t('cdCheck')}</Button>}
                </div>
              )
            })}
            <button type="button" className={css.addRow} aria-label={t('cdNewOnServerNamed', { server: g.server })} onClick={() => onNew(g)}>{t('cdNewOnServer')}</button>
          </div>
        )
      })}
      <button type="button" className={`${css.addRow} ${css.addServer}`} onClick={() => onNew(null)} data-pg-new-server>{t('cdNewServer')}</button>
    </div>
  )
}

const searchOf = (text: string): string => { try { return new URL(withPgScheme(text)).search } catch { return '' } }
const serverOf = (host: string): string => { const h = host.trim().toLowerCase(); return !h ? '' : /:\d+$/.test(h) ? h : `${h}:5432` }

/** The saved login that already serves `server` (preferring one whose Stores have not failed reach), for Connect a database's default (spec v23 V23-12). */
export function serverLogin(view: Pick<StorageView, 'stores'>, auths: readonly PgAuth[], server: string): string | null {
  if (!server) return null
  const on = view.stores.filter((s) => s.kind === 'postgresql' && s.postgresql?.server === server)
  const onNames = new Set(on.map((s) => s.name))
  const candidates = auths.filter((a) => (a.state ?? 'ready') === 'ready' && a.stores.some((st) => onNames.has(st)))
  const healthy = candidates.find((a) => on.some((s) => s.postgresql?.auth === a.auth && !(s.connectedFrom ?? []).some((c) => c.reached === 'failed')))
  return (healthy ?? candidates[0])?.auth ?? null
}

function freeLoginName(base: string, taken: ReadonlySet<string>): string {
  const MAX_NAME = 63
  const cleaned = base.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, MAX_NAME).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
  const root = cleaned || 'pg-login'
  if (!taken.has(root)) return root
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const maxPrefix = MAX_NAME - suffix.length
    const prefix = maxPrefix > 0 ? root.slice(0, maxPrefix).replace(/[^a-z0-9]+$/, '') : ''
    const candidate = prefix ? `${prefix}${suffix}` : String(i)
    if (!taken.has(candidate)) return candidate
  }
}

function NewDatabase({ api, t, view, server, onConnected, onWhy }: {
  api: LayerfsApi, t: StorageT, view: StorageView, server: PgServerGroup | null
  onWhy: (why: string | null) => void
  onConnected: (store: string) => void
}): ReactNode {
  const [url, setUrl] = useState('')
  const [typed, setTyped] = useState('')
  const given = server ? null : parsePgUrl(url)
  const host = server ? server.server : given?.host ?? ''
  const database = (server ? typed : given?.database ?? '').trim()
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [sync, setSync] = useState('')
  const sameStore = server?.stores.find((s) => s.postgresql?.auth && !(s.connectedFrom ?? []).some((c) => c.reached === 'failed')) ?? server?.stores.find((s) => s.postgresql?.auth)
  const pw = usePgPassword('entered', '', sameStore?.name ?? null)
  const auths = usePgAuths(api)
  const takenAuths = new Set(auths.map((a) => a.auth))
  const known = server ? null : serverLogin(view, auths, serverOf(host))
  const chose = useRef(false)
  const autoAuth = useRef<string | null>(null)
  useEffect(() => {
    if (chose.current) return
    if (known) {
      pw.setHow('saved')
      pw.setAuth(known)
      autoAuth.current = known
    } else if (autoAuth.current !== null) {
      pw.setHow('entered')
      pw.setAuth('')
      autoAuth.current = null
    }
  }, [known])
  const [typedAuthName, setTypedAuthName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [tried, setTried] = useState(false)
  const storeName = (named ? name : database.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')).trim()
  const taken = view.stores.some((s) => s.name === storeName)
  const dbTaken = server && database ? server.stores.find((s) => s.postgresql?.database === database) : undefined
  const urlShort = !server && !!url.trim() && !(host && database)
  const loginInUrl = !server && hasPgUrlLogin(url)
  const linuxLocalhost = !server && !loginInUrl && isLinuxLocalhostUrl(url, view.computer?.os)
  const urlError = loginInUrl ? t('cdLoginInUrl') : tried && urlShort ? t('cdUrlInvalid') : null
  const options = server ? '' : searchOf(url)
  const defaultAuthBase = pgServerLogin(serverOf(host)) ?? storeName
  const needExplicitAuthName = pw.how === 'entered' && !!defaultAuthBase && takenAuths.has(defaultAuthBase)
  const authName = (typedAuthName ?? (needExplicitAuthName ? freeLoginName(defaultAuthBase, takenAuths) : '')).trim()
  const authNameError = needExplicitAuthName && authName
    ? (takenAuths.has(authName) ? t('pgLoginNameTaken', { auth: authName }) : NAME.test(authName) ? null : t('storeNameHint'))
    : null
  const loginMissing = pw.how === 'entered' ? (!pw.user.trim() ? t('pgUser') : !pw.value ? t('pgPasswordValue') : needExplicitAuthName && !authName ? t('pgLoginName') : null) : pw.missing ? t('pgPasswordReferenceLabel') : null
  const missing = [server ? !database && t('cdDatabase') : !url.trim() && t('cdUrl'), !storeName && t('cdStoreName'), loginMissing].filter(Boolean) as string[]
  const nameError = storeName && !NAME.test(storeName) ? t('projectNameHint') : taken ? t('nameTaken') : null
  const valid = !missing.length && !urlShort && !nameError && !urlError && !authNameError && !pw.error(t) && !dbTaken
  const why = valid ? null : loginInUrl ? t('cdLoginInUrlShort') : (urlShort ? t('cdUrlInvalid') : null) ?? nameError ?? authNameError ?? pw.error(t) ?? (dbTaken ? t('pgDatabaseTaken', { store: dbTaken.name }) : null) ?? (missing.length ? t('stillNeeded', { what: missing.join(', ') }) : null)
  useEffect(() => { onWhy(why) }, [why])
  useEffect(() => () => onWhy(null), [])
  const submit = async () => {
    setTried(true)
    if (!valid || busy) return
    setBusy(true); setError(undefined)
    try {
      await api.call('POST', '/api/stores/postgresql', {
        name: storeName, url: `${pgUrl({ user: '', host, database })}${options}`, ...pw.body(needExplicitAuthName ? authName : undefined), ...(sync ? { synchronousCommit: sync } : {}),
      })
      onConnected(storeName)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const serverLoginLabel = server ? (server.auths.length === 1 ? server.auths[0]! : sameStore?.postgresql?.auth ?? '—') : ''
  return (
    <form id="lfs-cd-new" className={scss.form} onSubmit={(e) => { e.preventDefault(); void submit() }} aria-busy={busy}>
      {server ? <p className={css.serverGiven}>{t('cdOnServer', { server: server.server, user: serverLoginLabel })}</p> : null}
      {server
        ? <TextField label={t('cdDatabase')} value={typed} onChange={setTyped} mono placeholder="orders" autoFocus hint={t('pgDatabaseHint')}
            error={dbTaken ? t('pgDatabaseTaken', { store: dbTaken.name }) : null} />
        : <TextField label={t('cdUrl')} value={url} onChange={setUrl} mono placeholder="postgresql://db.internal:5432/orders" hint={t('cdUrlHint')} error={urlError} autoFocus />}
      {loginInUrl ? <PgLoginInUrlFix url={url} store={storeName} label={t('cdLoginFix')} copyLabel={t('cdCopyFix')} copiedLabel={t('ovCopied')} /> : null}
      {linuxLocalhost ? <PgLocalhostNotice message={t('pgLocalhostWarn')} actionLabel={t('pgLocalhostUseIpv4')} onReplace={() => setUrl(replaceLocalhostWithIpv4(url))} /> : null}
      <TextField label={t('cdStoreName')} value={named ? name : storeName} onChange={(v) => { setNamed(true); setName(v) }} mono error={nameError} />
      <PgPasswordFields id="lfs-cd-password" pw={{
        ...pw,
        setHow: (h: Parameters<typeof pw.setHow>[0]) => { chose.current = true; pw.setHow(h) },
        setAuth: (a: Parameters<typeof pw.setAuth>[0]) => { chose.current = true; pw.setAuth(a) },
        setUser: (u: Parameters<typeof pw.setUser>[0]) => { chose.current = true; pw.setUser(u) },
        setValue: (v: Parameters<typeof pw.setValue>[0]) => { chose.current = true; pw.setValue(v) },
      }} t={t} auths={auths} />
      {needExplicitAuthName ? <TextField label={t('pgLoginName')} value={typedAuthName ?? authName} onChange={setTypedAuthName} mono hint={t('pgLoginNameHint')} error={authNameError} /> : null}
      <details className={scss.storeDetails}>
        <summary className={scss.storeDetailsSummary}>
          <IconChevronRightOutlineRegular size={12} className={scss.storeDetailsChevron} />
          <span>{sync ? t('nsMoreOptionsSet', { value: sync }) : t('nsMoreOptions')}</span>
        </summary>
        <Field label={t('syncCommit')}>
          <MenuSelect value={sync} label={t('syncCommit')} placeholder={t('syncCommitDefault')}
            options={SYNC.map((v) => ({ value: v, label: v === 'local' ? t('syncCommitLocalDefault') : v }))} onChange={setSync} />
        </Field>
      </details>
      {busy ? <p className={scss.formNote} role="status">{t('cdConnecting')}</p> : null}
      {missing.length && tried ? <p className={scss.formNote} role="alert">{t('stillNeeded', { what: missing.join(', ') })}</p> : null}
      {error !== undefined ? <Refusal error={error} labels={refusalLabels(t)} /> : null}
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
  )
}

function CheckView({ t, view, check, place, own, ownUrl, setOwnUrl, onFrom, onOwn, onCancelOwn, onRetryOwn, onEditLogin, onRotateLogin }: {
  t: StorageT, view: StorageView, check: Check, place: (m: string) => string
  own: boolean, ownUrl: string, setOwnUrl: (v: string) => void
  onFrom: (machine: string) => void, onOwn: (prefill?: string) => void, onCancelOwn: () => void, onRetryOwn: () => void
  onEditLogin?: ((store: string) => void) | undefined
  onRotateLogin?: ((auth: string) => void) | undefined
}): ReactNode {
  const machine = check.machine
  const from_ = view.machines.find((m) => m.name === machine)
  const platform = from_?.platform
  const hostOs = view.computer?.os
  const stopped = machine !== 'native' && from_?.state != null && from_.state !== 'ready'
  const s = view.stores.find((x) => x.name === check.store)
  const hasOwn = !!s?.ownConnections?.some((c) => c.machine === machine)
  const dialed = dialedServer(s, machine, platform, hostOs)
  const dialedPort = parsePgUrl(dialed)?.host.match(/:(\d+)$/)?.[1]
  const server = check.result?.host
    ? formatHostPort(check.result.host, check.result.port ?? (dialedPort ? Number(dialedPort) : null))
    : dialed
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
  const activeUrl = s?.ownConnections?.find((c) => c.machine === machine)?.url ?? s?.postgresql?.url ?? ''
  const showLinuxLocalhostCheckWarn = !!ok && (platform === 'docker' || machine === 'native') && isLinuxLocalhostUrl(activeUrl, hostOs)
  const ownLoginInUrl = hasPgUrlLogin(ownUrl)
  const ownLinuxLocalhost = !ownLoginInUrl && isLinuxLocalhostUrl(ownUrl, hostOs)
  return (
    <>
      <Field label={t('cdFrom')}>
        <MenuSelect value={machine} label={t('cdFrom')} disabled={check.state === 'running'} className={scss.selfStart}
          options={(from.some((m) => m.name === machine) ? from.map((m) => m.name) : [machine, ...from.map((m) => m.name)]).map((m) => ({ value: m, label: place(m) }))} onChange={onFrom} />
      </Field>
      <div className={css.path} aria-hidden="true">
        <span className={css.hop}><span className={css.node}><MachineGlyph platform={platform ?? 'native'} size={18} /></span><span className={css.hopLabel}>{place(machine)}</span></span>
        <span className={css.wire} data-state={serverWire} />
        <span className={css.hop}>
          <span className={css.node}><StoreGlyph kind="postgresql" size={18} /></span>
          <span className={`${css.hopLabel} ${css.mono}`}>{server}</span>
          {hasOwn ? <span className={css.hopSub}>{t('pgOwnAddressShort')}</span> : null}
        </span>
        <span className={css.wire} data-state={storeWire} />
        <span className={css.hop}><span className={css.node}><StoreGlyph kind="postgresql" size={18} mono /></span><span className={css.hopLabel}>{check.store}</span></span>
      </div>
      <ul className={css.steps} aria-label={t('cdCheckFrom', { machine: place(machine) })}>
        {CHECK_STEPS.map((step) => {
          const state = stepState(step)
          return (
            <li key={step} className={css.step} data-state={state} data-step={step}>
              <span className={css.stepMark}>{state === 'running' ? <StatusDot state="ongoing" size={12} /> : state === 'ok' ? <StatusDot state="done" size={9} /> : state === 'failed' ? <StatusDot state="error" size={9} /> : <StatusDot state="idle" size={9} />}</span>
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
      {showLinuxLocalhostCheckWarn && !own ? (
        <PgLocalhostNotice message={t('pgLocalhostCheckWarn')}
          actionLabel={machine === 'native' ? t('msEditConnection') : t('pgLocalhostUseIpv4On', { machine: place(machine) })}
          onReplace={() => {
            if (machine === 'native' && onEditLogin) onEditLogin(check.store)
            else onOwn(replaceLocalhostWithIpv4(activeUrl))
          }} />
      ) : null}
      {own && ok ? (
        <div className={css.ownForm}>
          <TextField label={t('cdOwnUrl', { machine: place(machine) })} value={ownUrl} onChange={setOwnUrl} mono placeholder="postgresql://127.0.0.1:5432/orders" hint={t('pgUrlHint')}
            error={ownLoginInUrl ? t('cdLoginInUrlOwn') : null} autoFocus />
          {ownLoginInUrl ? <PgLoginInUrlFix url={ownUrl} store={check.store} machine={machine} label={t('cdLoginFix')} copyLabel={t('cdCopyFix')} copiedLabel={t('ovCopied')} /> : null}
          {ownLinuxLocalhost ? <PgLocalhostNotice message={t('pgLocalhostWarn')} actionLabel={t('pgLocalhostUseIpv4')} onReplace={() => setOwnUrl(replaceLocalhostWithIpv4(ownUrl))} /> : null}
          <div className={css.checkActions}>
            <Button variant="primary" size="sm" disabled={!ownUrl.trim() || ownLoginInUrl} onClick={onRetryOwn}>{t('cdSaveAndCheck')}</Button>
            <Button variant="ghost" size="sm" onClick={onCancelOwn}>{t('cancel')}</Button>
          </div>
        </div>
      ) : null}
      {check.state === 'failed' ? (
        <div className={css.checkFailure}>
          {check.connected ? <p className={css.checkFailureNote}>{t('cdConnectedNotReached', { store: check.store, machine: place(machine) })}</p> : null}
          {stopped ? <p className={css.checkFailureNote} role="status">{t('cdMachineStopped', { machine: place(machine) })}</p> : null}
          {guidance ? <p className={css.checkFailureNote} data-check-failure={kind ?? undefined}>{guidance}</p> : null}
          <Refusal error={check.error} labels={refusalLabels(t)} />
          {!stopped && kind === 'server' && machine !== 'native' && !own ? (
            <Button variant="outline" size="sm" className={scss.selfStart} onClick={() => onOwn()}>{t('cdOwnAddress', { machine: place(machine) })}</Button>
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
                error={ownLoginInUrl ? t('cdLoginInUrlOwn') : null} autoFocus />
              {ownLoginInUrl ? <PgLoginInUrlFix url={ownUrl} store={check.store} machine={machine} label={t('cdLoginFix')} copyLabel={t('cdCopyFix')} copiedLabel={t('ovCopied')} /> : null}
              {ownLinuxLocalhost ? <PgLocalhostNotice message={t('pgLocalhostWarn')} actionLabel={t('pgLocalhostUseIpv4')} onReplace={() => setOwnUrl(replaceLocalhostWithIpv4(ownUrl))} /> : null}
              <div className={css.checkActions}>
                <Button variant="primary" size="sm" disabled={!ownUrl.trim() || ownLoginInUrl} onClick={onRetryOwn}>{t('cdSaveAndCheck')}</Button>
                <Button variant="ghost" size="sm" onClick={onCancelOwn}>{t('cancel')}</Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
