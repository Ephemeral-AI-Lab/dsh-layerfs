/**
 * Shared dsh-layerfs copy. Each area (machines, storage, session) registers
 * its own namespace next to its code; this one holds strings they share.
 */
export const NS = 'layerfs'

const en = {
  connecting: 'Connecting to LayerFS…',
  retry: 'Retry',
  refresh: 'Refresh',
  cancel: 'Cancel',
  close: 'Close',
  loading: 'Loading…',
}

const zh: typeof en = {
  connecting: '正在连接 LayerFS…',
  retry: '重试',
  refresh: '刷新',
  cancel: '取消',
  close: '关闭',
  loading: '加载中…',
}

export const locales = { en, zh }
