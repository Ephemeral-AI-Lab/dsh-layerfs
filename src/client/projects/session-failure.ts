/**
 * Localized PostgreSQL & Store failure descriptions for session lists, project
 * rows, and ProjectDialog (issues #199 / #203). Every Store-side failure points
 * to the Store page (`store:<name>`), never the non-existent "Storage page".
 */
import { classifyPgFailure, missingPrivilege, type PgFailureKind, type SessionFailure, type SessionFailureCode } from '../../shared/pg-failure.ts'
import type { StoreRow } from '../storage/types.ts'

export const SESSION_FAILURE_EN = {
  sfOpenStore: 'Open Store',
  sfShortNoLogin: 'No login',
  sfShortOutdated: 'Outdated record',
  sfShortWrongLogin: 'Wrong login',
  sfShortPrivilege: 'Missing privilege',
  sfShortUnreachable: 'Server unreachable',
  sfShortDaemonDns: 'Address not resolved',
  sfShortStoreMismatch: 'Wrong database',
  sfShortBroken: 'Store broken',
  sfShortRemoved: 'Store removed',
  sfShortBusy: 'Store busy',
  sfShortMachine: 'Machine blocked',
  sfPgNoLogin: 'Store {store} has no saved login. Save or pick a login on its Store page.',
  sfPgOutdated: 'Store {store}’s record is outdated. Check or reconnect it on its Store page.',
  sfPgWrongLogin: 'PostgreSQL rejected the login for Store {store}. Rotate the password or change the login on its Store page.',
  sfPgPrivilege: 'The PostgreSQL user for Store {store} lacks {privilege}. Grant it or switch to a login with access on its Store page.',
  sfPgPrivilegeGeneric: 'The PostgreSQL user for Store {store} lacks required database privileges. Grant access or change the login on its Store page.',
  sfPgUnreachable: 'Cannot reach the PostgreSQL server for Store {store}. Check the server and connection on its Store page.',
  sfPgDaemonDns: 'The LayerFS daemon could not resolve the PostgreSQL host for Store {store}. Check the server address on its Store page (on Linux, prefer 127.0.0.1 over localhost).',
  sfPgStoreMismatch: 'The PostgreSQL database does not match Store {store}. Check its connection on the Store page.',
  sfStoreRemoved: 'Store {store} was removed from this LayerFS home.',
  sfStoreMissingFile: 'The file of Store {store} is missing. Check it on its Store page.',
  sfStoreBroken: 'Store {store} is broken. Check and repair it on its Store page.',
  sfStoreBusy: 'Store {store} is busy with another operation. Try again once it finishes.',
  sfStoreUnresolved: 'LayerFS cannot verify Store {store} right now. Check it on its Store page.',
  sfMachineBlocked: 'Machine {machine} is not available right now. Check it on the Machines page.',
}

export const SESSION_FAILURE_ZH: typeof SESSION_FAILURE_EN = {
  sfOpenStore: '打开 Store',
  sfShortNoLogin: '缺少登录',
  sfShortOutdated: '记录已过时',
  sfShortWrongLogin: '登录错误',
  sfShortPrivilege: '缺少权限',
  sfShortUnreachable: '连不上服务器',
  sfShortDaemonDns: '地址无法解析',
  sfShortStoreMismatch: '数据库不匹配',
  sfShortBroken: 'Store 损坏',
  sfShortRemoved: 'Store 已移除',
  sfShortBusy: 'Store 忙碌',
  sfShortMachine: '机器不可用',
  sfPgNoLogin: 'Store {store} 没有已保存的登录。请到 Store 页面保存或选择登录。',
  sfPgOutdated: 'Store {store} 的记录已过时。请到 Store 页面检查或重新连接。',
  sfPgWrongLogin: 'PostgreSQL 拒绝了 Store {store} 的登录。请到 Store 页面更换密码或切换登录。',
  sfPgPrivilege: 'Store {store} 的 PostgreSQL 用户缺少 {privilege} 权限。请授予权限或到 Store 页面切换登录。',
  sfPgPrivilegeGeneric: 'Store {store} 的 PostgreSQL 用户缺少所需数据库权限。请授予权限或到 Store 页面切换登录。',
  sfPgUnreachable: '无法连接到 Store {store} 的 PostgreSQL 服务器。请到 Store 页面检查服务器和连接。',
  sfPgDaemonDns: 'LayerFS 守护进程无法解析 Store {store} 的主机名。请到 Store 页面检查地址（Linux 上建议使用 127.0.0.1 而非 localhost）。',
  sfPgStoreMismatch: '连接的 PostgreSQL 数据库与 Store {store} 不匹配。请到 Store 页面检查连接。',
  sfStoreRemoved: 'Store {store} 已从当前 LayerFS 主目录中移除。',
  sfStoreMissingFile: 'Store {store} 的文件丢失。请到 Store 页面检查。',
  sfStoreBroken: 'Store {store} 已损坏。请到 Store 页面检查并修复。',
  sfStoreBusy: 'Store {store} 正忙于其他操作，请稍后重试。',
  sfStoreUnresolved: 'LayerFS 目前无法验证 Store {store}。请到 Store 页面检查。',
  sfMachineBlocked: '机器 {machine} 当前不可用。请到“机器”页面检查。',
}

export type SessionFailureKey = keyof typeof SESSION_FAILURE_EN
export type SessionFailureT = (key: SessionFailureKey, params?: Record<string, string | number>) => string

export interface LocalizedFailure {
  code: SessionFailureCode
  short: string
  message: string
  store?: string
  openStore: boolean
  openMachines: boolean
}

function codeFromPgKind(kind: PgFailureKind | null, raw: string): SessionFailureCode | null {
  switch (kind) {
    case 'record': return /outdated/i.test(raw) ? 'pg_outdated' : 'pg_no_login'
    case 'login': return 'pg_wrong_login'
    case 'privilege': return 'pg_privilege'
    case 'server': return 'pg_unreachable'
    case 'daemon_dns': return 'pg_daemon_dns'
    case 'store': return 'pg_store_mismatch'
    default: return null
  }
}

/** Infer a structured failure from a StoreRow when it is unavailable or all checked PostgreSQL reaches failed. */
export function pgStoreFailure(store: StoreRow | undefined): SessionFailure | null {
  if (!store || store.kind !== 'postgresql') return null
  if (store.state === 'broken') {
    if (store.reason === 'missing' || !store.postgresql?.auth || /names no saved login|no saved login named/i.test(store.message ?? '')) {
      return { code: 'pg_no_login', store: store.name, reason: store.reason ?? undefined, detail: store.message ?? undefined }
    }
    if (store.reason === 'outdated') return { code: 'pg_outdated', store: store.name, reason: 'outdated', detail: store.message ?? undefined }
    const kind = classifyPgFailure(undefined, store.message ?? undefined)
    const code = codeFromPgKind(kind, store.message ?? '') ?? 'store_broken'
    return { code, store: store.name, reason: store.reason ?? undefined, detail: store.message ?? undefined }
  }
  if (store.state === 'blocked') {
    const machine = store.blockedBy?.machine
    if (machine) return { code: 'machine_blocked', store: store.name, machine, reason: store.blockedBy?.reason, detail: store.message ?? undefined }
    return { code: 'store_unresolved', store: store.name, detail: store.message ?? undefined }
  }
  if (store.state === 'busy') return { code: 'store_busy', store: store.name, detail: store.message ?? undefined }
  if (store.state !== 'ready') return { code: 'store_unresolved', store: store.name, detail: store.message ?? undefined }
  const rows = store.connectedFrom ?? []
  const first = !rows.some((c) => c.reached === 'ok') ? rows.find((c) => c.reached === 'failed') : undefined
  if (first) {
    const err = first.reach?.error ?? undefined
    const kind = classifyPgFailure(undefined, err)
    const code = codeFromPgKind(kind, err ?? '') ?? 'pg_unreachable'
    return { code, store: store.name, detail: err }
  }
  return null
}

/** Infer a SessionFailure from a raw/legacy error string when structured `failure` is absent. */
export function inferSessionFailure(raw: string | null | undefined, store?: string | null, storeRow?: StoreRow): SessionFailure | null {
  const text = (raw ?? '').trim()
  const allowPg = !storeRow || storeRow.kind === 'postgresql'
  if (text) {
    if (allowPg) {
      const kind = classifyPgFailure(undefined, text)
      const code = codeFromPgKind(kind, text)
      if (code) return { code, store: store ?? storeRow?.name ?? undefined, detail: text }
    }
    if (/was removed from this LayerFS home/i.test(text)) return { code: 'store_removed', store: store ?? undefined, detail: text }
    if (/file of Store\s+.+\s+is missing/i.test(text)) {
      if (storeRow?.kind === 'postgresql') return { code: 'pg_no_login', store: store ?? storeRow.name, detail: text }
      return { code: 'store_missing_file', store: store ?? undefined, detail: text }
    }
    if (/is busy/i.test(text)) return { code: 'store_busy', store: store ?? undefined, detail: text }
  }
  if (storeRow && (!text || /file of Store|no saved login|names no saved login|outdated|PostgreSQL|SQLSTATE|lacks\s+|Storage page|Store page/i.test(text))) {
    return pgStoreFailure(storeRow)
  }
  return null
}

/** Format a structured (or inferred) session/Store failure in the active UI locale. */
export function formatSessionFailure(
  failure: SessionFailure | null | undefined,
  rawError: string | null | undefined,
  t: SessionFailureT,
  fallbackStore?: string,
  storeRow?: StoreRow,
): LocalizedFailure | null {
  const f = failure ?? inferSessionFailure(rawError, fallbackStore, storeRow)
  if (!f) return null
  const store = f.store || fallbackStore || storeRow?.name || '?'
  const machine = f.machine || '?'
  switch (f.code) {
    case 'pg_no_login':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortNoLogin'), message: t('sfPgNoLogin', { store }) }
    case 'pg_outdated':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortOutdated'), message: t('sfPgOutdated', { store }) }
    case 'pg_wrong_login':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortWrongLogin'), message: t('sfPgWrongLogin', { store }) }
    case 'pg_privilege': {
      const priv = missingPrivilege(f.detail ?? rawError ?? undefined)
      return {
        code: f.code, store, openStore: true, openMachines: false,
        short: t('sfShortPrivilege'),
        message: priv ? t('sfPgPrivilege', { store, privilege: priv.privilege }) : t('sfPgPrivilegeGeneric', { store }),
      }
    }
    case 'pg_unreachable':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortUnreachable'), message: t('sfPgUnreachable', { store }) }
    case 'pg_daemon_dns':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortDaemonDns'), message: t('sfPgDaemonDns', { store }) }
    case 'pg_store_mismatch':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortStoreMismatch'), message: t('sfPgStoreMismatch', { store }) }
    case 'store_removed':
      return { code: f.code, store, openStore: false, openMachines: false, short: t('sfShortRemoved'), message: t('sfStoreRemoved', { store }) }
    case 'store_missing_file':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortBroken'), message: t('sfStoreMissingFile', { store }) }
    case 'store_broken':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortBroken'), message: t('sfStoreBroken', { store }) }
    case 'store_busy':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortBusy'), message: t('sfStoreBusy', { store }) }
    case 'store_unresolved':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortBroken'), message: t('sfStoreUnresolved', { store }) }
    case 'machine_blocked':
      return { code: f.code, store, openStore: false, openMachines: true, short: t('sfShortMachine'), message: t('sfMachineBlocked', { machine }) }
    case 'store_unknown':
      return { code: f.code, store, openStore: true, openMachines: false, short: t('sfShortBroken'), message: t('sfStoreBroken', { store }) }
  }
}
