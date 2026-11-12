/** Copy of the session row mark (namespace `layerfsSession`). */
export const NS = 'layerfsSession'

const en = {
  inProject: 'LayerFS · {project}',
}

const zh: typeof en = {
  inProject: 'LayerFS · {project}',
}

export const locales = { en, zh }
export type SessionKey = keyof typeof en
