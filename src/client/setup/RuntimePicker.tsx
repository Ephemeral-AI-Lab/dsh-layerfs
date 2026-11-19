/**
 * The runtime picker (docs/specs/layerfs-setup.md §4.2), shared by the setup
 * modal and Settings' Change…: the runtimes installed in the LayerFS folder
 * (`runtime.installed`), each with its version, commit and what is wrong with
 * it, and Use; Other build… reveals path fields (CLI, daemon, Linux bundle,
 * machine image cache) saved through `runtime.save`. The host refuses pieces
 * from different builds (`MixedBuild`) unless development allows it.
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { Field } from '../ui/index.tsx'
import type { SetupModalT } from './locale.ts'
import { useInstalled, type InstalledRuntime } from './store.ts'
import css from './setup.module.css'
import { dateOnly } from '../ui/locale-sync.ts'

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
const messageOf = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e)

/** What is wrong with an installed runtime, in words; none: one build. */
export function problems(r: InstalledRuntime, t: SetupModalT): string[] {
  if (r.error) return [t('rowBroken', { message: r.error })]
  const out: string[] = []
  const b = r.pieces.bundle, d = r.pieces.daemon
  if (b?.verdict === 'other') out.push(t('rowBundleOther'))
  else if (!b || b.verdict === 'missing') out.push(t('rowBundleMissing'))
  if (d?.verdict === 'other') out.push(t('rowDaemonOther'))
  else if (d && d.verdict === 'missing') out.push(t('rowDaemonMissing'))
  return out
}

/** Whether a runtime may be used as it is (no piece from another build). */
export const oneBuild = (r: InstalledRuntime): boolean => !r.error && r.pieces.bundle?.verdict !== 'other' && r.pieces.daemon?.verdict !== 'other'

export function RuntimePicker({ api, t, other, onOther, onDone, cancellable, current }: {
  api: LayerfsApi, t: SetupModalT
  /** The path fields are shown. */
  other: boolean
  onOther: () => void
  /** After a save, or Cancel. */
  onDone: () => void
  cancellable: boolean
  /** The pin to prefill Other build… with. */
  current?: { cli: string | null, daemon: string | null, bundle: string | null, cacheHome?: string | null, cacheHomeSource?: string | null, source?: string } | undefined
}): ReactNode {
  const read = useInstalled(api)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const save = async (key: string, pin: Record<string, unknown>) => {
    setBusy(key); setError(null)
    try { await api.op('runtime.save', pin); read.check(); onDone() } catch (e) { setError(e) } finally { setBusy(null) }
  }
  const runtimes = read.data?.runtimes ?? []
  return (
    <div className={css.picker} data-runtime-picker="">
      {!read.data && !read.error ? <p className={css.note}>{t('pickerReading')}</p> : null}
      {read.error && !read.data ? <p className={css.errorText} role="alert">{messageOf(read.error)}</p> : null}
      {read.data && runtimes.length === 0 ? <p className={css.note}>{t('pickerEmpty')}</p> : null}
      {runtimes.length ? (
        <ul className={css.runtimes}>
          {runtimes.map((r) => {
            const wrong = problems(r, t)
            const blocking = !oneBuild(r)
            return (
              <li key={r.id} className={clsx(css.runtime, r.active && css.runtimeActive)} data-runtime={r.id}>
                <span className={css.lineText}>
                  <span className={css.lineTitle}>{r.version ?? r.id}<span className={css.commit}>{r.commit ? r.commit.slice(0, 8) : '—'}</span>{r.dirty ? <span className={css.commit}>{t('dirtyTree')}</span> : null}</span>
                  <span className={css.lineSub} data-blocked={blocking || undefined}>{[...wrong, dateOnly(r.at)].join(' · ')}</span>
                </span>
                <span className={css.lineActions}>
                  {r.active
                    ? <span className={css.tag}>{t('inUse')}</span>
                    : <Button variant="outline" size="sm" disabled={!!busy || !!r.error} onClick={() => void save(r.id, { cli: r.cli, daemon: r.daemon, runtime: r.id })}>{busy === r.id ? t('using') : t('use')}</Button>}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {other ? <OtherBuild t={t} current={current} busy={busy === 'other'} onSave={(pin) => void save('other', pin)} /> : null}
      {error != null ? <p className={css.errorText} role="alert">{messageOf(error)}</p> : null}
      <div className={css.pickerFoot}>
        {other ? null : <Button variant="ghost" size="sm" onClick={onOther}>{t('otherBuild')}</Button>}
        {current?.source === 'settings' ? <Button variant="ghost" size="sm" disabled={!!busy} title={t('resetTitle')} onClick={() => void save('reset', { cli: null, daemon: null })}>{t('reset')}</Button> : null}
        <span className={css.spacer} />
        {cancellable ? <Button variant="ghost" size="sm" disabled={!!busy} onClick={onDone}>{t('hideChange')}</Button> : null}
      </div>
    </div>
  )
}

function OtherBuild({ t, current, busy, onSave }: { t: SetupModalT, current: Parameters<typeof RuntimePicker>[0]['current'], busy: boolean, onSave: (pin: Record<string, unknown>) => void }): ReactNode {
  const [cli, setCli] = useState(current?.cli ?? '')
  const [daemon, setDaemon] = useState(current?.daemon ?? '')
  const [bundle, setBundle] = useState(current?.bundle ?? '')
  const [cache, setCache] = useState(current?.cacheHomeSource === 'settings' ? current?.cacheHome ?? '' : '')
  const bad = (v: string) => v.trim() !== '' && !isAbsolute(v.trim())
  const invalid = bad(cli) || bad(daemon) || bad(bundle) || bad(cache)
  const submit = () => { if (cli.trim() && !invalid) onSave({ cli: cli.trim(), daemon: daemon.trim() || null, bundle: bundle.trim() || null, cacheHome: cache.trim() || null }) }
  return (
    <form className={css.other} onSubmit={(e) => { e.preventDefault(); submit() }} aria-label={t('otherTitle')}>
      <span className={css.lineTitle}>{t('otherTitle')}</span>
      <Field label={t('fieldCli')} error={bad(cli) ? t('errAbsolute') : null}>
        <Input value={cli} onChange={(e) => setCli(e.target.value)} placeholder="/path/to/layerfs" spellCheck={false} disabled={busy} />
      </Field>
      <Field label={t('fieldDaemon')} error={bad(daemon) ? t('errAbsolute') : null}>
        <Input value={daemon} onChange={(e) => setDaemon(e.target.value)} placeholder="/path/to/layerfs-daemon" spellCheck={false} disabled={busy} />
      </Field>
      <Field label={t('fieldBundle')} error={bad(bundle) ? t('errAbsolute') : null}>
        <Input value={bundle} onChange={(e) => setBundle(e.target.value)} placeholder="/path/to/bundle/2.0.0/linux-aarch64" spellCheck={false} disabled={busy} />
      </Field>
      <Field label={t('fieldImages')} error={bad(cache) ? t('errAbsolute') : null}>
        <Input value={cache} onChange={(e) => setCache(e.target.value)} placeholder={current?.cacheHome ?? '/path/to/cache'} spellCheck={false} disabled={busy} />
      </Field>
      <div className={css.pickerFoot}>
        <span className={css.spacer} />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !cli.trim() || invalid}>{busy ? t('saving') : t('save')}</Button>
      </div>
    </form>
  )
}
