/** A Branch selector: main under Published, the others under Branches, each with its saved head. */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconBranchOutlineRegular, IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { shortId } from './format.ts'
import { branchLabel } from './labels.ts'
import type { Translate } from './types.ts'
import css from './Files.module.css'

export interface BranchPickerProps {
  branches: readonly { name: string, head: string | null }[]
  value: string
  onChange: (branch: string) => void
  t: Translate
  className?: string
}

export function BranchPicker({ branches, value, onChange, t, className }: BranchPickerProps): ReactNode {
  const [open, setOpen] = useState(false)
  const main = branches.find((b) => b.name === 'main')
  const others = branches.filter((b) => b.name !== 'main')
  const row = (b: { name: string, head: string | null }): MenuEntry => ({
    id: b.name,
    label: <span className={css.branchItem} title={b.name}><span className={css.branchItemName}>{branchLabel(b.name, t)}</span><span className={css.branchItemHead}>{shortId(b.head)}</span></span>,
  })
  const items: MenuEntry[] = [
    ...(main ? [{ type: 'label' as const, id: 'published', text: t('files_published') }, row(main)] : []),
    ...(others.length ? [{ type: 'label' as const, id: 'others', text: t('files_branches') }, ...others.map(row)] : []),
  ]
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={items}
      selectedId={value}
      onSelect={(id) => { setOpen(false); onChange(id) }}
      portal
      minWidthFromAnchor
      className={className}
      anchor={(
        <Button variant="outline" size="sm" className={clsx(css.branchButton)} aria-label={t('files_branch')} aria-haspopup="menu" aria-expanded={open}
          icon={<IconBranchOutlineRegular size={14} />} onClick={() => setOpen((v) => !v)}>
          <span className={css.branchButtonName} title={value}>{branchLabel(value, t)}</span>
          <IconChevronDownOutlineRegular size={12} className={css.branchChevron} />
        </Button>
      )}
    />
  )
}
