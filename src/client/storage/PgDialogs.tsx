/**
 * PostgreSQL's dialogs (docs/specs/store-home-rows.md "Dialogs and picker"):
 *
 *   ConnectDialog         Name, Address, User, Password; Connect is the test:
 *                         the Store is saved only when the check from this
 *                         computer passes.
 *   EditConnectionDialog  the same form filled in (the Store's name under the
 *                         title), the password left empty to keep it. Test
 *                         tries the connection as it would be saved from this
 *                         computer and every attached machine, saving
 *                         nothing; Save and check is refused while an
 *                         attached machine would lose the Store.
 *   AttachPicker          machines by provider (from a Store), or Stores
 *                         (from a machine page), several at once. Each row
 *                         has its own Test, run from that machine only when
 *                         pressed; a failure names the connection step it
 *                         stopped at. Reach is never predicted from the
 *                         address: a machine is greyed only when it is
 *                         stopped or cannot run PostgreSQL Sandboxes.
 *
 * A refusal is one mapped line in the footer (LayerFS's words as its title),
 * and the field it is about is marked. The host never answers a password; it
 * goes to LayerFS on stdin.
 */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, IconRefreshOutlineRegular, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { useMachinesMaybe } from '../machines/context.tsx'
import { MachineGlyph } from '../machines/icons.tsx'
import { Field, Notice } from '../ui/index.tsx'
import { StatusDot } from '../ui/StatusDot.tsx'
import type { StorageT } from './locale.ts'
import { FormModal, StoreGlyph, TextField } from './parts.tsx'
import { attachFailure, attachMachines, attachStores, connectFailure, listWords, providerBeside, STEP_LABEL, TEST_STEPS, urlHasLogin, type AttachBlock, type TestStep } from './store-rows.ts'
import type { PgAttachResult, PgConnectionTest, PgReachError, PgReachTest, StorageView, StoreRow } from './types.ts'
import css from './PgDialogs.module.css'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/

/** The field a refused connect is about, and its one line. */
type ConnectError = { field: 'address' | 'password' | 'name' | null, line: string, detail: string }

/** A refused connect as one line: the label its connection step maps to (never LayerFS's words, which stay the title). */
export function connectError(error: unknown, t: StorageT, name: string): ConnectError {
  const e = error as { code?: unknown, message?: unknown, fix?: unknown, detail?: any } | null
  const code = typeof e?.code === 'string' ? e.code : ''
  const message = typeof e?.message === 'string' ? e.message : String(error ?? '')
  const detail = [message, typeof e?.fix === 'string' ? e.fix : null].filter(Boolean).join('\n')
  const step = typeof e?.detail?.step === 'string' ? e.detail.step : null
  // a changed connection an attached machine would lose names those machines
  const lost: string[] = Array.isArray(e?.detail?.machines) ? e.detail.machines.filter((m: any) => m?.ok === false && typeof m.machine === 'string').map((m: any) => m.machine) : []
  const f = connectFailure(code, step)
  return { field: f.field, line: t(f.key, { name, machines: listWords(lost) }), detail }
}

/** Connect a database: a new PostgreSQL Store, checked from this computer before it is saved. */
export function ConnectDialog({ api, t, view, onClose, done, onConnected }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, onClose: () => void, done: () => void, onConnected?: ((name: string) => void) | undefined
}): ReactNode {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [failed, setFailed] = useState<ConnectError | null>(null)
  const taken = new Set((view?.stores ?? []).map((s) => s.name))
  const nameError = !name ? null : !NAME.test(name) ? t('storeNameHint') : taken.has(name) ? t('cdNameTaken', { name }) : null
  const login = urlHasLogin(url)
  const valid = !!name && !!url.trim() && !!user.trim() && !!password && !nameError && !login
  return (
    <FormModal open onClose={onClose} t={t} title={t('connectDatabase')} action={t('pgConnect')} valid={valid} busyHint={t('pgConnecting')}
      renderError={(e) => connectError(e, t, name)} onError={(e) => setFailed(e === undefined ? null : connectError(e, t, name))}
      submit={() => api.call('POST', '/api/stores/postgresql', { name, url: url.trim(), user: user.trim(), passwordValue: password }).then(() => { done(); onConnected?.(name) })}>
      <TextField label={t('pgName')} value={name} onChange={setName} error={nameError} invalid={failed?.field === 'name'} autoFocus mono />
      <AddressField t={t} url={url} onChange={setUrl} login={login} refused={failed?.field === 'address'} />
      <TextField label={t('pgUser')} value={user} onChange={setUser} mono />
      <PasswordField t={t} value={password} onChange={setPassword} refused={failed?.field === 'password'} />
    </FormModal>
  )
}

/** The address field: mono, a one-line hint; a login inside it is refused here. */
function AddressField({ t, url, onChange, login, refused }: { t: StorageT, url: string, onChange: (v: string) => void, login: boolean, refused: boolean }): ReactNode {
  return (
    <TextField label={t('pgAddress')} value={url} onChange={onChange} mono placeholder="postgres://host:5432/database"
      hint={t('pgAddressHint')} error={login ? t('pgAddressLogin') : null} invalid={refused} />
  )
}

function PasswordField({ t, value, onChange, placeholder, refused }: { t: StorageT, value: string, onChange: (v: string) => void, placeholder?: string | undefined, refused: boolean }): ReactNode {
  return (
    <Field label={t('pgPasswordValue')} invalid={refused}>
      <Input className={css.mono} value={value} onChange={(e) => onChange(e.target.value)} type="password" placeholder={placeholder}
        aria-label={t('pgPasswordValue')} aria-invalid={refused || undefined} autoComplete="new-password" spellCheck={false} />
    </Field>
  )
}

/** The machines a check runs from after this computer, as the hint says them. */
function recheckLine(s: StoreRow, t: StorageT): string {
  const machines = (s.attached ?? []).map((a) => a.machine)
  return machines.length ? t('pgRecheckMachines', { machines: listWords(machines) }) : t('pgRecheckHost')
}

/** A refused reach as words and the step it stopped at. */
function failureWords(error: PgReachError, t: StorageT): { step: TestStep | null, line: string } {
  const f = attachFailure(error)
  return { step: f.step, line: f.step ? t('pickFailedAt', { step: t(STEP_LABEL[f.step]) }) : t(f.words) }
}

/** The steps a test went through: passed up to the one it stopped at, that one failed, the rest not reached; LayerFS's words under them. */
function StepTrail({ step, message, t }: { step: TestStep, message: string, t: StorageT }): ReactNode {
  const at = TEST_STEPS.indexOf(step)
  return (
    <div className={css.steps}>
      <ol className={css.stepList}>
        {TEST_STEPS.map((s, i) => <li key={s} className={css.step} data-state={i < at ? 'passed' : i === at ? 'failed' : 'unreached'}>{t(STEP_LABEL[s])}</li>)}
      </ol>
      <p className={css.stepWhy}>{message}</p>
    </div>
  )
}

/** One test's result: testing, reachable with its time, or failed at a step (which opens the steps). */
function ReachResult({ result, busy, t, open, onToggle }: { result: PgReachTest | undefined, busy: boolean, t: StorageT, open: boolean, onToggle: () => void }): ReactNode {
  if (busy) return <span className={css.reach}><StatusDot state="ongoing" size={10} />{t('pickTesting')}</span>
  if (!result) return <span className={css.reachMuted}>{t('pickNotTested')}</span>
  if (result.ok) return <span className={css.reach}><StatusDot state="done" size={8} />{t('pickReachable', { ms: result.latencyMs ?? 0 })}</span>
  if (result.ok === null) return <span className={css.reachMuted} title={t('pgTestNotChecked')}>{t('stNotChecked')}</span>
  const f = failureWords(result.error ?? { code: 'Failed', message: '', step: null }, t)
  return (
    <span className={css.reach}>
      <StatusDot state="error" size={8} />
      {f.step ? (
        <button type="button" className={css.failedLink} aria-expanded={open} title={t('pickShowSteps')} onClick={onToggle}>{f.line}</button>
      ) : <span className={css.failedText} title={result.error?.message}>{f.line}</span>}
    </span>
  )
}

/** A picker row's trailing part: its result and its Test (or Test again) button. */
function TestCell({ name, result, busy, t, open, onToggle, onTest }: {
  name: string, result: PgReachTest | undefined, busy: boolean, t: StorageT, open: boolean, onToggle: () => void, onTest: () => void
}): ReactNode {
  return (
    <span className={css.test}>
      <ReachResult result={result} busy={busy} t={t} open={open} onToggle={onToggle} />
      {busy ? null : result ? (
        <Button variant="ghost" size="sm" className={css.again} aria-label={t('pickTestAgain', { name })} title={t('pickTestAgain', { name })}
          icon={<IconRefreshOutlineRegular size={13} />} onClick={onTest} />
      ) : <Button variant="outline" size="sm" onClick={onTest}>{t('pickTest')}</Button>}
    </span>
  )
}

/** What was typed, as one key: a test answers only for the values it ran with. */
const keyOf = (url: string, user: string, password: string) => JSON.stringify([url.trim(), user.trim(), password])

/** Edit a PostgreSQL Store's saved connection: only what changed is sent; Test tries it first, from this computer and every attached machine. */
export function EditConnectionDialog({ api, t, view, store, onClose, done }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, store: string, onClose: () => void, done: () => void
}): ReactNode {
  const s = view?.stores.find((x) => x.name === store)
  const urlBefore = s?.postgresql?.url ?? ''
  const userBefore = s?.postgresql?.user ?? ''
  const [url, setUrl] = useState(urlBefore)
  const [user, setUser] = useState(userBefore)
  const [password, setPassword] = useState('')
  const [failed, setFailed] = useState<ConnectError | null>(null)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ key: string, answer: PgConnectionTest } | { key: string, error: ConnectError } | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  if (!s) return null
  const login = urlHasLogin(url)
  const changed = { url: url.trim() !== urlBefore && !!url.trim(), user: user.trim() !== userBefore && !!user.trim(), password: !!password }
  const any = changed.url || changed.user || changed.password
  const body = { ...(changed.url ? { url: url.trim() } : {}), ...(changed.user ? { user: user.trim() } : {}), ...(changed.password ? { passwordValue: password } : {}) }
  const key = keyOf(url, user, password)
  const current = test?.key === key ? test : null
  const answer = current && 'answer' in current ? current.answer : null
  const lost = answer ? answer.machines.filter((m) => m.ok === false).map((m) => m.machine) : []
  const hereFailed = answer?.here.ok === false
  const runTest = () => {
    setTesting(true)
    setOpen(new Set())
    api.call<PgConnectionTest>('POST', `/api/stores/${enc(store)}/connection-test`, body)
      .then((a) => setTest({ key, answer: a }), (e) => setTest({ key, error: connectError(e, t, store) }))
      .finally(() => setTesting(false))
  }
  const toggle = (side: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(side)) next.delete(side); else next.add(side); return next })
  const rows: { side: string, label: string, result: PgReachTest | undefined }[] = [
    { side: '', label: t('pgTestHere'), result: answer?.here },
    ...(s.attached ?? []).map((a) => ({ side: a.machine, label: a.machine, result: answer?.machines.find((m) => m.machine === a.machine) })),
  ]
  const hint = lost.length ? t('pgTestLoses', { machines: listWords(lost) }) : test && !current ? t('pgTestStale') : recheckLine(s, t)
  return (
    <FormModal open onClose={onClose} t={t} title={t('pgEditTitle')} description={store} action={t('pgSaveAndCheck')} valid={any && !login && !!url.trim() && !testing && !lost.length && !hereFailed}
      hint={hint} busyHint={t('pgChecking')}
      renderError={(e) => connectError(e, t, store)} onError={(e) => setFailed(e === undefined ? null : connectError(e, t, store))}
      submit={() => api.call('POST', `/api/stores/${enc(store)}/connection`, body).then(done)}>
      <AddressField t={t} url={url} onChange={setUrl} login={login} refused={failed?.field === 'address'} />
      <TextField label={t('pgUser')} value={user} onChange={setUser} mono />
      <PasswordField t={t} value={password} onChange={setPassword} placeholder={s.postgresql?.passwordSaved === false ? undefined : t('pgPasswordKeep')}
        refused={failed?.field === 'password'} />
      <section className={css.testBox} aria-label={t('pgTestTitle')}>
        <div className={css.testHead}>
          <span className={css.testTitle}>{t('pgTestTitle')}</span>
          <Button variant="outline" size="sm" disabled={testing || login || !url.trim()} aria-busy={testing}
            icon={testing ? <StatusDot state="ongoing" size={12} /> : <IconRefreshOutlineRegular size={13} />} onClick={runTest}>{t('pgTest')}</Button>
        </div>
        {current && 'error' in current ? <p className={css.testError} role="alert" title={current.error.detail}>{current.error.line}</p> : (
          <ul className={css.testRows}>
            {rows.map((r) => {
              const step = r.result?.ok === false && r.result.error ? attachFailure(r.result.error).step : null
              return (
                <li key={r.side || 'here'} className={css.testRow}>
                  <div className={css.testLine}>
                    <span className={css.choiceName}>{r.label}</span>
                    <ReachResult result={current ? r.result : undefined} busy={testing} t={t} open={open.has(r.side)} onToggle={() => toggle(r.side)} />
                  </div>
                  {step && open.has(r.side) ? <StepTrail step={step} message={r.result?.error?.message ?? ''} t={t} /> : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </FormModal>
  )
}

/** A greyed choice's reason and its one action. */
function Block({ block, t, machine, onStart }: { block: AttachBlock, t: StorageT, machine?: string | undefined, onStart?: (() => void) | undefined }): ReactNode {
  const words = t(block === 'stopped' ? 'pickStopped' : 'pickNoPlatform')
  return (
    <span className={css.block}>
      <span className={css.blockText} title={words}>{words}</span>
      {block === 'stopped' && onStart ? <button type="button" className={css.link} aria-label={machine ? t('startMachine', { machine }) : undefined} onClick={onStart}>{t('rowStart')}</button> : null}
    </span>
  )
}

/** Choices shown before the picker offers a search. */
const SEARCH_FROM = 6

/**
 * Attach machines to a Store (`store`), or Stores to a machine (`machine`):
 * the choices (machines grouped by provider), a search when there are many,
 * multi-select, a Test on each row, and `Attach and check`. Each attach is
 * checked from its machine again; a refusal shows on its row as a test
 * result, stays selected, and the rest still attach. A stopped machine's
 * picker says so once, above its rows.
 */
export function AttachPicker({ api, t, view, store, machine, onClose, done }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, store?: string | undefined, machine?: string | undefined
  onClose: () => void, done: () => void
}): ReactNode {
  const mc = useMachinesMaybe()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  // results by row name (a machine from a Store, a Store from a machine)
  const [results, setResults] = useState<ReadonlyMap<string, PgReachTest>>(() => new Map())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  if (!view) return null
  const provider = (platform: string) => mc?.kind(platform) ?? platform
  const s = store ? view.stores.find((x) => x.name === store) : undefined
  const m = machine ? view.machines.find((x) => x.name === machine) ?? { name: machine, platform: '', state: null, supports: null } : undefined
  const flip = (set: ReadonlySet<string>, name: string) => { const next = new Set(set); if (next.has(name)) next.delete(name); else next.add(name); return next }
  const toggle = (name: string) => setChosen((prev) => flip(prev, name))
  const start = (name: string) => { void api.call('POST', `/api/machines/${enc(name)}/start`).then(done, () => {}); void mc?.recheck() }
  const record = (name: string, result: PgReachTest) => setResults((prev) => new Map(prev).set(name, result))
  // a row names a machine (from a Store) or a Store (from a machine): the pair tested
  const pairOf = (row: string): [string, string] => (s ? [s.name, row] : [row, machine!])
  const testRow = (row: string) => {
    const [st, mach] = pairOf(row)
    setBusy((prev) => new Set(prev).add(row))
    setOpen((prev) => { const next = new Set(prev); next.delete(row); return next })
    api.call<PgReachTest>('POST', `/api/stores/${enc(st)}/attach-test`, { machine: mach })
      .then((r) => record(row, r), (e: any) => record(row, { ok: false, latencyMs: null, version: null, error: { code: String(e?.code ?? 'Failed'), message: String(e?.message ?? e), step: null } }))
      .finally(() => setBusy((prev) => { const next = new Set(prev); next.delete(row); return next }))
  }
  const run = async () => {
    const pairs: [string, string][] = s ? [[s.name, [...chosen].join('\u0000')]] : [...chosen].map((st) => [st, machine!])
    const failed: string[] = []
    for (const [st, machines] of pairs) {
      const answer = await api.call<PgAttachResult>('POST', `/api/stores/${enc(st)}/attach`, { machines: machines.split('\u0000') })
      for (const r of answer.results) {
        if (r.ok) continue
        const row = s ? r.machine : st
        failed.push(row)
        record(row, { ok: false, latencyMs: null, version: null, error: r.error })
      }
    }
    done()
    setChosen(new Set(failed))
    if (!failed.length) onClose()
  }
  const cell = (row: string) => (
    <TestCell name={row} result={results.get(row)} busy={busy.has(row)} t={t} open={open.has(row)} onToggle={() => setOpen((prev) => flip(prev, row))} onTest={() => testRow(row)} />
  )
  const trail = (row: string) => {
    const r = results.get(row)
    const step = r && !r.ok && r.error ? attachFailure(r.error).step : null
    return step && open.has(row) ? <li key={`${row}:steps`} className={css.choiceSteps}><StepTrail step={step} message={r?.error?.message ?? ''} t={t} /></li> : null
  }
  let body: ReactNode
  let count = 0
  let notice: ReactNode = null
  if (s) {
    count = attachMachines(s, view.machines, { provider }).reduce((n, g) => n + g.items.length, 0)
    const groups = attachMachines(s, view.machines, { query, provider })
    body = groups.length ? groups.map((g) => (
      <section key={g.platform} className={css.group} aria-label={provider(g.platform)}>
        {/* a provider heading that only repeats its one machine's name says nothing */}
        {g.items.length === 1 && !providerBeside(g.items[0]!.name, provider(g.platform)) ? null : <h4 className={css.groupTitle}>{provider(g.platform)}</h4>}
        <ul className={css.choices}>
          {g.items.map((it) => [
            <li key={it.name} className={css.choice} data-blocked={it.block ? '' : undefined}>
              <span className={css.mark}><MachineGlyph platform={it.platform} size={14} /></span>
              <Checkbox className={css.check} checked={chosen.has(it.name)} disabled={!!it.block || busy.has(it.name)} onChange={() => toggle(it.name)} title={it.name} label={it.name} />
              {it.block ? <Block block={it.block} t={t} machine={it.name} onStart={() => start(it.name)} /> : cell(it.name)}
            </li>,
            trail(it.name),
          ])}
        </ul>
      </section>
    )) : <p className={css.empty}>{query ? t('pickNoMatch') : t('pickNoMachines')}</p>
  } else {
    const stopped = m?.state === 'stopped'
    count = m ? attachStores(m, view.stores).length : 0
    const rows = m ? attachStores(m, view.stores, { query }) : []
    if (stopped && machine && count) {
      notice = (
        <Notice tone="warning">
          <span className={css.stoppedNotice}>
            <span>{t('pickMachineStopped', { machine })}</span>
            <Button variant="outline" size="sm" aria-label={t('startMachine', { machine })} onClick={() => start(machine)}>{t('rowStart')}</Button>
          </span>
        </Notice>
      )
    }
    body = rows.length ? (
      <ul className={css.choices}>
        {rows.map((it) => {
          // a stopped machine says so once, above the list: its rows are off with no reason of their own
          const block = stopped ? null : it.block
          return [
            <li key={it.name} className={css.choice} data-blocked={stopped || block ? '' : undefined}>
              <span className={css.mark}><StoreGlyph kind="postgresql" size={14} /></span>
              <Checkbox className={css.check} checked={chosen.has(it.name)} disabled={stopped || !!block || busy.has(it.name)} onChange={() => toggle(it.name)} title={`${it.name} · ${it.address ?? ''}`} label={it.name} />
              {block ? <Block block={block} t={t} machine={machine ?? undefined} /> : stopped ? <span /> : cell(it.name)}
            </li>,
            trail(it.name),
          ]
        })}
      </ul>
    ) : <p className={css.empty}>{query ? t('pickNoMatch') : t('pickNoStores')}</p>
  }
  return (
    <FormModal open onClose={onClose} t={t} title={s ? t('pickTitleStore') : t('pickTitleMachine')} description={s ? s.name : machine} action={t('pickAttach')} valid={chosen.size > 0 && !busy.size} keepOpen
      hint={chosen.size ? t('pickSelected', { n: chosen.size }) : t('pickTestHint')} busyHint={t('pgChecking')} submit={run}>
      {notice}
      {count >= SEARCH_FROM ? (
        <Input className={css.search} icon={<IconSearchOutlineRegular size={14} />} type="search" value={query} placeholder={t('pickSearch')}
          aria-label={t('pickSearch')} onChange={(e) => setQuery(e.target.value)} />
      ) : null}
      <div className={css.list}>{body}</div>
    </FormModal>
  )
}

/** Which PostgreSQL Store a fix or a machine page means (for callers that hold only its name). */
export const pgStoreOf = (view: StorageView | undefined, name: string): StoreRow | undefined => view?.stores.find((s) => s.name === name && s.kind === 'postgresql')
