/**
 * PostgreSQL's dialogs (docs/specs/store-home-rows.md "Dialogs and picker"):
 *
 *   ConnectDialog         Name, Address, User, Password; Connect is the test:
 *                         the Store is saved only when the host check passes.
 *   EditConnectionDialog  the same form filled in, the name fixed, the
 *                         password left empty to keep it; Save and check
 *                         re-checks the host and the attached machines.
 *   AttachPicker          machines by provider (from a Store), or Stores
 *                         (from a machine page), several at once; one that
 *                         cannot attach is greyed with why and one action.
 *
 * The host never answers a password; it goes to LayerFS on stdin.
 */
import { useState, type ReactNode } from 'react'
import { Checkbox, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { useMachinesMaybe } from '../machines/context.tsx'
import { MachineGlyph } from '../machines/icons.tsx'
import { Field, Notice } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { FormModal, StoreGlyph, TextField } from './parts.tsx'
import { attachFailure, attachMachines, attachStores, isLoopbackUrl, urlHasLogin, type AttachBlock } from './store-rows.ts'
import type { PgAttachResult, StorageView, StoreRow } from './types.ts'
import css from './PgDialogs.module.css'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/

/** Connect a database: a new PostgreSQL Store, checked from the host before it is saved. */
export function ConnectDialog({ api, t, view, onClose, done, onConnected }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, onClose: () => void, done: () => void, onConnected?: ((name: string) => void) | undefined
}): ReactNode {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const taken = new Set((view?.stores ?? []).map((s) => s.name))
  const nameError = !name ? null : !NAME.test(name) ? t('storeNameHint') : taken.has(name) ? t('cdNameTaken', { name }) : null
  const login = urlHasLogin(url)
  const missing = [!name && t('pgName'), !url.trim() && t('pgAddress'), !user.trim() && t('pgUser'), !password && t('pgPasswordValue')].filter(Boolean) as string[]
  const valid = !missing.length && !nameError && !login
  return (
    <FormModal open onClose={onClose} t={t} title={t('connectDatabase')} action={t('pgConnect')} valid={valid}
      hint={missing.length ? t('stillNeeded', { what: missing.join(', ') }) : undefined} busyHint={t('pgConnecting')}
      submit={() => api.call('POST', '/api/stores/postgresql', { name, url: url.trim(), user: user.trim(), passwordValue: password }).then(() => { done(); onConnected?.(name) })}>
      <TextField label={t('pgName')} value={name} onChange={setName} error={nameError} autoFocus mono />
      <AddressField t={t} url={url} onChange={setUrl} login={login} />
      <TextField label={t('pgUser')} value={user} onChange={setUser} mono />
      <PasswordField t={t} value={password} onChange={setPassword} />
    </FormModal>
  )
}

/** The address field: mono, a one-line hint; a login inside it is refused here; a loopback address gets its note. */
function AddressField({ t, url, onChange, login }: { t: StorageT, url: string, onChange: (v: string) => void, login: boolean }): ReactNode {
  return (
    <>
      <TextField label={t('pgAddress')} value={url} onChange={onChange} mono placeholder="postgres://host:5432/database"
        hint={login ? undefined : t('pgAddressHint')} error={login ? t('pgAddressLogin') : null} />
      {!login && isLoopbackUrl(url) ? <p className={css.note}>{t('pgLoopbackNote')}</p> : null}
    </>
  )
}

function PasswordField({ t, value, onChange, placeholder }: { t: StorageT, value: string, onChange: (v: string) => void, placeholder?: string }): ReactNode {
  return (
    <Field label={t('pgPasswordValue')}>
      <Input className={css.mono} value={value} onChange={(e) => onChange(e.target.value)} type="password" placeholder={placeholder}
        aria-label={t('pgPasswordValue')} autoComplete="new-password" spellCheck={false} />
    </Field>
  )
}

/** Edit a PostgreSQL Store's saved connection: only what changed is sent; then the host and its machines are checked again. */
export function EditConnectionDialog({ api, t, view, store, onClose, done }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, store: string, onClose: () => void, done: () => void
}): ReactNode {
  const s = view?.stores.find((x) => x.name === store)
  const urlBefore = s?.postgresql?.url ?? ''
  const userBefore = s?.postgresql?.user ?? ''
  const [url, setUrl] = useState(urlBefore)
  const [user, setUser] = useState(userBefore)
  const [password, setPassword] = useState('')
  if (!s) return null
  const login = urlHasLogin(url)
  const changed = { url: url.trim() !== urlBefore && !!url.trim(), user: user.trim() !== userBefore && !!user.trim(), password: !!password }
  const any = changed.url || changed.user || changed.password
  const machines = (s.attached ?? []).map((a) => (a.machine === 'native' ? t('pgThisComputer') : a.machine))
  const hint = !any ? t('pgEditNothing') : machines.length ? t('pgRecheckMachines', { machines: machines.join(', ') }) : t('pgRecheckHost')
  return (
    <FormModal open onClose={onClose} t={t} title={t('pgEditTitle', { store })} action={t('pgSaveAndCheck')} valid={any && !login && !!url.trim()}
      hint={hint} busyHint={t('pgChecking')}
      submit={() => api.call('POST', `/api/stores/${enc(store)}/connection`, {
        ...(changed.url ? { url: url.trim() } : {}), ...(changed.user ? { user: user.trim() } : {}), ...(changed.password ? { passwordValue: password } : {}),
      }).then(done)}>
      <TextField label={t('pgName')} value={store} onChange={() => {}} disabled mono />
      <AddressField t={t} url={url} onChange={setUrl} login={login} />
      <TextField label={t('pgUser')} value={user} onChange={setUser} mono />
      <PasswordField t={t} value={password} onChange={setPassword} placeholder={s.postgresql?.passwordSaved === false ? undefined : t('pgPasswordKeep')} />
    </FormModal>
  )
}

/** A greyed choice's reason and its one action. */
function Block({ block, t, machine, onStart, onEdit }: { block: AttachBlock, t: StorageT, machine?: string | undefined, onStart?: (() => void) | undefined, onEdit?: (() => void) | undefined }): ReactNode {
  const words = t(block === 'stopped' ? 'pickStopped' : block === 'address' ? 'pickNoAddress' : 'pickNoPlatform')
  const action = block === 'stopped' && onStart ? { label: t('rowStart'), aria: machine ? t('startMachine', { machine }) : undefined, run: onStart } : block === 'address' && onEdit ? { label: t('pgEditConnectionShort'), aria: undefined, run: onEdit } : null
  return (
    <span className={css.block}>
      <span className={css.blockText}>{words}</span>
      {action ? <button type="button" className={css.link} aria-label={action.aria} onClick={action.run}>{action.label}</button> : null}
    </span>
  )
}

/**
 * Attach machines to a Store (`store`), or Stores to a machine (`machine`):
 * a search, the choices (machines grouped by provider), multi-select, and
 * `Attach and check`. Each attach is checked from its machine; a refusal for
 * one is listed under the form and the rest still attach.
 */
export function AttachPicker({ api, t, view, store, machine, onClose, done, onEditConnection }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, store?: string | undefined, machine?: string | undefined
  onClose: () => void, done: () => void, onEditConnection?: ((store: string) => void) | undefined
}): ReactNode {
  const mc = useMachinesMaybe()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  const [failures, setFailures] = useState<{ name: string, store: string, words: string, detail: string, edit: boolean }[]>([])
  if (!view) return null
  const hostOs = view.computer?.os ?? null
  const provider = (platform: string) => mc?.kind(platform) ?? platform
  const s = store ? view.stores.find((x) => x.name === store) : undefined
  const m = machine ? view.machines.find((x) => x.name === machine) ?? { name: machine, platform: machine === 'native' ? 'native' : '' } : undefined
  const toggle = (name: string) => setChosen((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next })
  const start = (name: string) => { void api.call('POST', `/api/machines/${enc(name)}/start`).then(done, () => {}); void mc?.recheck() }
  const edit = (name: string) => { onClose(); onEditConnection?.(name) }
  const run = async () => {
    const pairs: [string, string][] = s ? [[s.name, [...chosen].join('\u0000')]] : [...chosen].map((st) => [st, machine!])
    const failed: { name: string, store: string, words: string, detail: string, edit: boolean }[] = []
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
  const title = s ? t('pickTitleStore', { store: s.name }) : t('pickTitleMachine', { machine: machine === 'native' ? t('pgThisComputer') : machine ?? '' })
  let body: ReactNode
  if (s) {
    const groups = attachMachines(s, view.machines, { hostOs, query, provider })
    body = groups.length ? groups.map((g) => (
      <section key={g.platform} className={css.group} aria-label={provider(g.platform)}>
        <h4 className={css.groupTitle}>{provider(g.platform)}</h4>
        <ul className={css.choices}>
          {g.items.map((it) => (
            <li key={it.name} className={css.choice} data-blocked={it.block ? '' : undefined}>
              <span className={css.mark}><MachineGlyph platform={it.platform} size={14} /></span>
              <Checkbox className={css.check} checked={chosen.has(it.name)} disabled={!!it.block} onChange={() => toggle(it.name)} title={it.name} label={it.name === 'native' ? t('pgThisComputer') : it.name} />
              {it.block ? <Block block={it.block} t={t} machine={it.name} onStart={() => start(it.name)} onEdit={() => edit(s.name)} /> : null}
            </li>
          ))}
        </ul>
      </section>
    )) : <p className={css.empty}>{query ? t('pickNoMatch') : t('pickNoMachines')}</p>
  } else {
    const rows = m ? attachStores(m, view.stores, { hostOs, query }) : []
    body = rows.length ? (
      <ul className={css.choices}>
        {rows.map((it) => (
          <li key={it.name} className={css.choice} data-blocked={it.block ? '' : undefined}>
            <span className={css.mark}><StoreGlyph kind="postgresql" size={14} /></span>
            <Checkbox className={css.check} checked={chosen.has(it.name)} disabled={!!it.block} onChange={() => toggle(it.name)} title={it.name} label={it.name} />
            {it.block ? <Block block={it.block} t={t} machine={machine ?? undefined} onStart={machine ? () => start(machine) : undefined} onEdit={() => edit(it.name)} />
              : <span className={css.choiceMeta} title={it.address ?? undefined}>{it.address}</span>}
          </li>
        ))}
      </ul>
    ) : <p className={css.empty}>{query ? t('pickNoMatch') : t('pickNoStores')}</p>
  }
  return (
    <FormModal open onClose={onClose} t={t} title={title} action={t('pickAttach')} valid={chosen.size > 0} keepOpen
      hint={t('pickSelected', { n: chosen.size })} busyHint={t('pgChecking')} submit={run}>
      <Input className={css.search} icon={<IconSearchOutlineRegular size={14} />} type="search" value={query} placeholder={t('pickSearch')}
        aria-label={t('pickSearch')} onChange={(e) => setQuery(e.target.value)} />
      <div className={css.list}>{body}</div>
      {failures.length ? (
        <Notice tone="danger" role="alert">
          <ul className={css.failures}>
            {failures.map((f) => (
              <li key={f.name} title={f.detail}>
                <span className={css.choiceName}>{f.name === 'native' ? t('pgThisComputer') : f.name}</span> · {f.words}
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
