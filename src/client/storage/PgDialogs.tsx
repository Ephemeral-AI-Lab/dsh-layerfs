/**
 * PostgreSQL's dialogs (docs/specs/store-home-rows.md "Dialogs and picker"):
 *
 *   ConnectDialog         Name, Address, User, Password; Connect is the test:
 *                         the Store is saved only when the check from this
 *                         computer passes.
 *   EditConnectionDialog  the same form filled in (the Store's name under the
 *                         title), the password left empty to keep it; Save
 *                         and check re-checks from this computer and the
 *                         attached machines.
 *   AttachPicker          machines by provider (from a Store), or Stores
 *                         (from a machine page), several at once; one that
 *                         cannot attach is greyed with why and one action.
 *
 * A refusal is one mapped line in the footer (LayerFS's words as its title),
 * and the field it is about is marked. The host never answers a password; it
 * goes to LayerFS on stdin.
 */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { useMachinesMaybe } from '../machines/context.tsx'
import { MachineGlyph } from '../machines/icons.tsx'
import { Field, Notice } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { FormModal, StoreGlyph, TextField } from './parts.tsx'
import { attachFailure, attachMachines, attachStores, connectFailure, listWords, providerBeside, urlHasLogin, type AttachBlock } from './store-rows.ts'
import { loopbackNote } from './StoreRows.tsx'
import type { PgAttachResult, StorageView, StoreRow } from './types.ts'
import css from './PgDialogs.module.css'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/

/** The field a refused connect is about, and its one line. */
type ConnectError = { field: 'address' | 'password' | 'name' | null, line: string, detail: string }

/** A refused connect as one line: the label LayerFS's words map to (never the raw words, which stay the title). */
export function connectError(error: unknown, t: StorageT, name: string): ConnectError {
  const e = error as { code?: unknown, message?: unknown, fix?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : ''
  const message = typeof e?.message === 'string' ? e.message : String(error ?? '')
  const detail = [message, typeof e?.fix === 'string' ? e.fix : null].filter(Boolean).join('\n')
  const f = connectFailure(code, message)
  return { field: f.field, line: t(f.key, { name }), detail }
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
      <AddressField t={t} url={url} onChange={setUrl} login={login} machines={view?.machines ?? []} refused={failed?.field === 'address'} />
      <TextField label={t('pgUser')} value={user} onChange={setUser} mono />
      <PasswordField t={t} value={password} onChange={setPassword} refused={failed?.field === 'password'} />
    </FormModal>
  )
}

/** The address field: mono, a one-line hint (the local-address note for a loopback address); a login inside it is refused here. */
function AddressField({ t, url, onChange, login, machines, refused }: {
  t: StorageT, url: string, onChange: (v: string) => void, login: boolean, machines: StorageView['machines'], refused: boolean
}): ReactNode {
  const note = loopbackNote(url, machines, t)
  return (
    <TextField label={t('pgAddress')} value={url} onChange={onChange} mono placeholder="postgres://host:5432/database"
      hint={note ?? t('pgAddressHint')} error={login ? t('pgAddressLogin') : null} invalid={refused} />
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

/** Edit a PostgreSQL Store's saved connection: only what changed is sent; then it is checked again from this computer and its machines. */
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
  if (!s) return null
  const login = urlHasLogin(url)
  const changed = { url: url.trim() !== urlBefore && !!url.trim(), user: user.trim() !== userBefore && !!user.trim(), password: !!password }
  const any = changed.url || changed.user || changed.password
  return (
    <FormModal open onClose={onClose} t={t} title={t('pgEditTitle')} description={store} action={t('pgSaveAndCheck')} valid={any && !login && !!url.trim()}
      hint={recheckLine(s, t)} busyHint={t('pgChecking')}
      renderError={(e) => connectError(e, t, store)} onError={(e) => setFailed(e === undefined ? null : connectError(e, t, store))}
      submit={() => api.call('POST', `/api/stores/${enc(store)}/connection`, {
        ...(changed.url ? { url: url.trim() } : {}), ...(changed.user ? { user: user.trim() } : {}), ...(changed.password ? { passwordValue: password } : {}),
      }).then(done)}>
      <AddressField t={t} url={url} onChange={setUrl} login={login} machines={view?.machines ?? []} refused={failed?.field === 'address'} />
      <TextField label={t('pgUser')} value={user} onChange={setUser} mono />
      <PasswordField t={t} value={password} onChange={setPassword} placeholder={s.postgresql?.passwordSaved === false ? undefined : t('pgPasswordKeep')}
        refused={failed?.field === 'password'} />
    </FormModal>
  )
}

/** A greyed choice's reason and its one action. */
function Block({ block, t, machine, onStart, onEdit }: { block: AttachBlock, t: StorageT, machine?: string | undefined, onStart?: (() => void) | undefined, onEdit?: (() => void) | undefined }): ReactNode {
  const words = t(block === 'stopped' ? 'pickStopped' : block === 'address' ? 'pickNoAddress' : 'pickNoPlatform')
  const action = block === 'stopped' && onStart ? { label: t('rowStart'), aria: machine ? t('startMachine', { machine }) : undefined, run: onStart } : block === 'address' && onEdit ? { label: t('pgEditConnectionShort'), aria: undefined, run: onEdit } : null
  return (
    <span className={css.block}>
      <span className={css.blockText} title={words}>{words}</span>
      {action ? <button type="button" className={css.link} aria-label={action.aria} onClick={action.run}>{action.label}</button> : null}
    </span>
  )
}

/** Choices shown before the picker offers a search. */
const SEARCH_FROM = 6

type Failure = { name: string, store: string, words: string, detail: string, edit: boolean }

/**
 * Attach machines to a Store (`store`), or Stores to a machine (`machine`):
 * the choices (machines grouped by provider), a search when there are many,
 * multi-select, and `Attach and check`. Each attach is checked from its
 * machine; a refusal for one is listed under the form and the rest still
 * attach. A stopped machine's picker says so once, above its rows.
 */
export function AttachPicker({ api, t, view, store, machine, onClose, done, onEditConnection }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, store?: string | undefined, machine?: string | undefined
  onClose: () => void, done: () => void, onEditConnection?: ((store: string) => void) | undefined
}): ReactNode {
  const mc = useMachinesMaybe()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  const [failures, setFailures] = useState<Failure[]>([])
  if (!view) return null
  const provider = (platform: string) => mc?.kind(platform) ?? platform
  const s = store ? view.stores.find((x) => x.name === store) : undefined
  const m = machine ? view.machines.find((x) => x.name === machine) ?? { name: machine, platform: '', state: null, supports: null } : undefined
  const toggle = (name: string) => setChosen((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next })
  const start = (name: string) => { void api.call('POST', `/api/machines/${enc(name)}/start`).then(done, () => {}); void mc?.recheck() }
  const edit = (name: string) => { onClose(); onEditConnection?.(name) }
  const run = async () => {
    const pairs: [string, string][] = s ? [[s.name, [...chosen].join('\u0000')]] : [...chosen].map((st) => [st, machine!])
    const failed: Failure[] = []
    for (const [st, machines] of pairs) {
      const answer = await api.call<PgAttachResult>('POST', `/api/stores/${enc(st)}/attach`, { machines: machines.split('\u0000') })
      for (const r of answer.results) {
        if (r.ok) continue
        const f = attachFailure(r.error.code, r.error.message)
        failed.push({ name: s ? r.machine : st, store: st, words: t(f.words), detail: [r.error.message, r.error.fix].filter(Boolean).join('\n'), edit: f.edit })
      }
    }
    done()
    setChosen(new Set(failed.map((f) => f.name)))
    setFailures(failed)
    if (!failed.length) onClose()
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
          {g.items.map((it) => (
            <li key={it.name} className={css.choice} data-blocked={it.block ? '' : undefined}>
              <span className={css.mark}><MachineGlyph platform={it.platform} size={14} /></span>
              <Checkbox className={css.check} checked={chosen.has(it.name)} disabled={!!it.block} onChange={() => toggle(it.name)} title={it.name} label={it.name} />
              {it.block ? <Block block={it.block} t={t} machine={it.name} onStart={() => start(it.name)} onEdit={() => edit(s.name)} /> : <span />}
            </li>
          ))}
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
          return (
            <li key={it.name} className={css.choice} data-blocked={stopped || block ? '' : undefined}>
              <span className={css.mark}><StoreGlyph kind="postgresql" size={14} /></span>
              <Checkbox className={css.check} checked={chosen.has(it.name)} disabled={stopped || !!block} onChange={() => toggle(it.name)} title={it.name} label={it.name} />
              {block ? <Block block={block} t={t} machine={machine ?? undefined} onEdit={() => edit(it.name)} />
                : <span className={css.choiceMeta} title={it.address ?? undefined}>{it.address}</span>}
            </li>
          )
        })}
      </ul>
    ) : <p className={css.empty}>{query ? t('pickNoMatch') : t('pickNoStores')}</p>
  }
  return (
    <FormModal open onClose={onClose} t={t} title={s ? t('pickTitleStore') : t('pickTitleMachine')} description={s ? s.name : machine} action={t('pickAttach')} valid={chosen.size > 0} keepOpen
      hint={t('pickSelected', { n: chosen.size })} busyHint={t('pgChecking')} submit={run}>
      {notice}
      {count >= SEARCH_FROM ? (
        <Input className={css.search} icon={<IconSearchOutlineRegular size={14} />} type="search" value={query} placeholder={t('pickSearch')}
          aria-label={t('pickSearch')} onChange={(e) => setQuery(e.target.value)} />
      ) : null}
      <div className={css.list}>{body}</div>
      {failures.length ? (
        <Notice tone="danger" role="alert">
          <ul className={css.failures}>
            {failures.map((f) => (
              <li key={f.name} title={f.detail}>
                <span className={css.choiceName}>{f.name}</span> · {f.words}
                {f.edit && onEditConnection ? <> · <button type="button" className={css.link} onClick={() => edit(f.store)}>{t('pgEditConnectionShort')}</button></> : null}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </FormModal>
  )
}

/** Which PostgreSQL Store a fix or a machine page means (for callers that hold only its name). */
export const pgStoreOf = (view: StorageView | undefined, name: string): StoreRow | undefined => view?.stores.find((s) => s.name === name && s.kind === 'postgresql')
