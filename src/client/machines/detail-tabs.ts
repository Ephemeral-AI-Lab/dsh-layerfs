/**
 * The tab shown inside a machine page or a Sandbox page. dsh has no URL
 * routing, so the choice is view state in the app: it starts from the last tab
 * this viewer had open there (localStorage, `storage/tabs.ts`), and a link
 * elsewhere (`go({ kind: 'machine', name, tab: 'log' })`) switches a page that
 * is already open.
 */
import { useCallback, useEffect, useState } from 'react'
import { readDetailTab, watchDetailTab, writeDetailTab, type DetailKind, type DetailTab } from '../storage/tabs.ts'

/**
 * @param offered - the tabs this page has now (a tab whose call the pinned CLI lacks is not among them).
 * @param first - the tab shown when nothing was remembered, or the remembered one is not offered.
 * @returns the tab shown and its setter.
 */
export function useDetailTab<T extends DetailTab>(kind: DetailKind, name: string, offered: readonly T[], first: T): [T, (tab: T) => void] {
  const [wanted, setWanted] = useState<DetailTab | null>(() => readDetailTab(kind, name))
  useEffect(() => {
    setWanted(readDetailTab(kind, name))
    return watchDetailTab(kind, name, setWanted)
  }, [kind, name])
  const set = useCallback((tab: T) => { setWanted(tab); writeDetailTab(kind, name, tab) }, [kind, name])
  const tab = (offered as readonly DetailTab[]).includes(wanted as DetailTab) ? wanted as T : first
  return [tab, set]
}
