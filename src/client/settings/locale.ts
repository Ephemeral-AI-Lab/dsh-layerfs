/** The LayerFS Settings page's copy. The runtime card's words come from the Machines namespace. */
export const NS = 'layerfsSettings'

const en = {
  panel: 'Settings',
  title: 'LayerFS settings',
  runtime: 'Runtime',
}

const zh: typeof en = {
  panel: '设置',
  title: 'LayerFS 设置',
  runtime: '运行时',
}

export const locales = { en, zh }
export type SettingsT = (key: keyof typeof en, params?: Record<string, string | number>) => string
