/**
 * Center's "Needs attention": what `layerfs doctor` finds in the home, listed
 * when the Overview's doctor need is opened (the bar's Health button opens
 * the full Health page). Report-only: each finding names its entity
 * and the call that fixes it, in LayerFS's words; nothing runs for you.
 */
import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import type { Query } from '../files/use-query.ts'
import { Card, Refusal } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { refusalLabels } from './parts.tsx'
import type { DoctorReport } from './types.ts'
import css from './Storage.module.css'

export function DoctorFindings({ read, t, now }: { read: Query<DoctorReport>, t: StorageT, now: number }): ReactNode {
  if (read.error !== undefined && !read.data) return <Refusal error={read.error} labels={refusalLabels(t)} />
  const report = read.data
  const findings = report?.findings ?? []
  if (!report || !findings.length) return null
  const errors = findings.filter((f) => f.severity === 'error').length
  return (
    <Card className={css.findings} aria-label={t('needsAttention')}>
      <p className={css.findingsHead}>
        <span className={css.findingsTitle}>{t('needsAttention')}</span>
        <span>{t('doctorSummary', { n: findings.length, errors, ago: ago(report.at, now, t as Translate) })}</span>
      </p>
      <ul className={css.rows}>
        {findings.map((f, i) => (
          <li key={`${f.entity?.kind}:${f.entity?.name}:${i}`} className={css.finding}>
            <span className={css.findingTop}>
              <Tag tone={f.severity === 'error' ? 'danger' : 'warning'}>{f.severity === 'error' ? t('severityError') : t('severityWarning')}</Tag>
              {f.entity ? <span className={css.findingEntity}>{f.entity.kind} <strong>{f.entity.name}</strong></span> : null}
            </span>
            <span className={css.findingMessage}>{f.message}</span>
            {f.fix ? <code className={css.findingFix}>{t('fix', { fix: f.fix })}</code> : null}
          </li>
        ))}
      </ul>
    </Card>
  )
}
