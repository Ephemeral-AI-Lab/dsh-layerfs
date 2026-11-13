/**
 * The `dsh-layerfs` skill (`skills/dsh-layerfs/` in this package): how a project
 * session uses LayerFS as its filesystem through `$DSH_LAYERFS_CLI` and
 * `$DSH_LAYERFS_SDK`. A skill provider row mounted inside the `layerfs` preset
 * (cordis.patch.yml), so it lands in that preset's skill layer: project sessions
 * and their subagents see it in the `skill` catalog, normal sessions don't.
 * Bundled to `lib/skills.js` (`dsh-layerfs/skills`).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-layerfs-skills'
export const inject = ['skills']

/** The skills this package ships, by folder under `skills/`. */
export const SKILLS = ['dsh-layerfs'] as const

/** Precedence of packaged skills (`BUNDLED_SKILL_RANK` in dsh-skill). */
const BUNDLED_RANK = 600

/** The package's `skills/` folder: beside `lib/` when bundled, two levels up from `src/host/` in tests. */
export function skillRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from)
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'skills', SKILLS[0], 'SKILL.md'))) return join(dir, 'skills')
    dir = dirname(dir)
  }
  throw new Error('dsh-layerfs: the skills folder is missing from the package')
}

/** `{ description, content }` of a SKILL.md: YAML frontmatter `description`, then the body. */
export function parseSkill(raw: string, path: string): { description: string, content: string } {
  const head = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!head) throw new Error(`dsh-layerfs: ${path} has no frontmatter`)
  const line = head[1].split(/\r?\n/).find((l) => l.startsWith('description:'))
  const description = line?.slice('description:'.length).trim().replace(/^(['"])(.*)\1$/, '$2')
  if (!description) throw new Error(`dsh-layerfs: ${path} has no description`)
  return { description, content: raw.slice(head[0].length).trim() }
}

export function apply(ctx: Context, config: { root?: string } = {}): void {
  const root = config.root ?? skillRoot()
  const candidates = SKILLS.map((skill) => {
    const directory = join(root, skill), path = join(directory, 'SKILL.md')
    return {
      name: skill,
      description: parseSkill(readFileSync(path, 'utf8'), path).description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-layerfs',
      source: 'bundled',
      rank: BUNDLED_RANK,
      path,
      resourceBase: { kind: 'directory' as const, path: directory.split('\\').join('/') },
      locator: path,
    }
  })
  const skills = (ctx as any).skills
  skills.registerProvider(() => ({
    name: 'dsh-layerfs',
    list: () => Promise.resolve(candidates),
    async get(candidate: any, options: { signal?: AbortSignal }) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options?.signal })
      return { ...summary, content: parseSkill(raw, locator as string).content }
    },
  }))
}
