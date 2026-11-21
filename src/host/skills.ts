/**
 * The `dsh-layerfs` skill (`skills/dsh-layerfs/` in this package): how a project
 * session uses LayerFS as its filesystem through `$DSH_LAYERFS_CLI` and
 * `$DSH_LAYERFS_SDK`. A skill provider row mounted inside the `layerfs` preset
 * (cordis.patch.yml), so it lands in that preset's skill layer: project sessions
 * and their subagents see it in the `skill` catalog, normal sessions don't.
 * Bundled to `lib/skills.js` (`dsh-layerfs/skills`).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillInvocationPolicy, SkillLookupOptions } from '@deepseek-ai/dsh-skill'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-layerfs-skills'
export const inject = ['skills']

/** The skills this package ships, by folder under `skills/`. */
export const SKILLS = ['dsh-layerfs'] as const

/** Precedence of packaged skills (`BUNDLED_SKILL_RANK` in dsh-skill). */
const BUNDLED_RANK = 600

/** Same public kebab-case grammar as `@deepseek-ai/dsh-skill` (`isSkillName`). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface ParsedSkill {
  name?: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  metadata?: Readonly<Record<string, unknown>>
  content: string
}

/** The package's `skills/` folder: beside `lib/` when bundled, two levels up from `src/host/` in tests. */
export function skillRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from)
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'skills', SKILLS[0], 'SKILL.md'))) return join(dir, 'skills')
    dir = dirname(dir)
  }
  throw new Error('dsh-layerfs: the skills folder is missing from the package')
}

function indentOf(line: string): number {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length === 0 || trimmed.startsWith('#')
}

function stripInlineComment(text: string): string {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text.trimEnd()
}

function parseScalarAtom(text: string): unknown {
  if (text === 'true' || text === 'True' || text === 'TRUE') return true
  if (text === 'false' || text === 'False' || text === 'FALSE') return false
  if (text === 'null' || text === 'Null' || text === 'NULL' || text === '~') return null
  return text
}

function foldLines(parts: string[]): string {
  let out = ''
  let blankRun = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '') {
      blankRun++
      continue
    }
    if (out.length > 0) {
      out += blankRun > 0 ? '\n'.repeat(blankRun) : ' '
    }
    blankRun = 0
    out += part
  }
  return out
}

function parseSingleQuoted(lines: string[], startIdx: number, rest: string, path: string, key: string): { value: string, nextIdx: number } {
  let out = ''
  let i = startIdx
  let pos = 1 // skip opening '
  let line = rest
  let pendingNewlines = 0
  let started = false

  for (;;) {
    while (pos < line.length) {
      const ch = line[pos]
      if (ch === "'") {
        if (line[pos + 1] === "'") {
          if (pendingNewlines > 0 && started) out += pendingNewlines === 1 ? ' ' : '\n'.repeat(pendingNewlines - 1)
          pendingNewlines = 0
          started = true
          out += "'"
          pos += 2
          continue
        }
        const trailing = line.slice(pos + 1).trim()
        if (trailing.length > 0 && !trailing.startsWith('#')) {
          throw new Error(`dsh-layerfs: ${path} has unexpected trailing characters after single-quoted "${key}"`)
        }
        return { value: out, nextIdx: i + 1 }
      }
      if (pendingNewlines > 0 && started) {
        out += pendingNewlines === 1 ? ' ' : '\n'.repeat(pendingNewlines - 1)
      }
      pendingNewlines = 0
      started = true
      out += ch
      pos++
    }
    i++
    if (i >= lines.length) {
      throw new Error(`dsh-layerfs: ${path} has unclosed single-quoted string for "${key}"`)
    }
    // Trim trailing horizontal whitespace before folded newline when continuing across lines
    out = out.replace(/[ \t]+$/, '')
    pendingNewlines++
    line = lines[i].replace(/^[ \t]+/, '')
    pos = 0
  }
}

function parseDoubleQuoted(lines: string[], startIdx: number, rest: string, path: string, key: string): { value: string, nextIdx: number } {
  let out = ''
  let i = startIdx
  let pos = 1 // skip opening "
  let line = rest
  let pendingNewlines = 0
  let started = false
  let escapedBreak = false

  const flushBreak = () => {
    if (pendingNewlines > 0 && started && !escapedBreak) {
      out += pendingNewlines === 1 ? ' ' : '\n'.repeat(pendingNewlines - 1)
    }
    pendingNewlines = 0
    escapedBreak = false
  }

  for (;;) {
    while (pos < line.length) {
      const ch = line[pos]
      if (ch === '"') {
        const trailing = line.slice(pos + 1).trim()
        if (trailing.length > 0 && !trailing.startsWith('#')) {
          throw new Error(`dsh-layerfs: ${path} has unexpected trailing characters after double-quoted "${key}"`)
        }
        return { value: out, nextIdx: i + 1 }
      }
      if (ch === '\\') {
        flushBreak()
        started = true
        pos++
        if (pos >= line.length) {
          // Escaped newline continuation
          escapedBreak = true
          break
        }
        const esc = line[pos]
        pos++
        switch (esc) {
          case '"': out += '"'; break
          case '\\': out += '\\'; break
          case '/': out += '/'; break
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case '0': out += '\0'; break
          case ' ': out += ' '; break
          case 'x': {
            const hex = line.slice(pos, pos + 2)
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error(`dsh-layerfs: ${path} has invalid \\x escape in "${key}"`)
            out += String.fromCodePoint(parseInt(hex, 16))
            pos += 2
            break
          }
          case 'u': {
            const hex = line.slice(pos, pos + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`dsh-layerfs: ${path} has invalid \\u escape in "${key}"`)
            out += String.fromCodePoint(parseInt(hex, 16))
            pos += 4
            break
          }
          case 'U': {
            const hex = line.slice(pos, pos + 8)
            if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new Error(`dsh-layerfs: ${path} has invalid \\U escape in "${key}"`)
            out += String.fromCodePoint(parseInt(hex, 16))
            pos += 8
            break
          }
          default:
            throw new Error(`dsh-layerfs: ${path} has invalid escape "\\${esc}" in "${key}"`)
        }
        continue
      }
      flushBreak()
      started = true
      out += ch
      pos++
    }
    i++
    if (i >= lines.length) {
      throw new Error(`dsh-layerfs: ${path} has unclosed double-quoted string for "${key}"`)
    }
    if (!escapedBreak) {
      out = out.replace(/[ \t]+$/, '')
      pendingNewlines++
    }
    line = lines[i].replace(/^[ \t]+/, '')
    pos = 0
  }
}

function parseBlockScalar(lines: string[], startIdx: number, parentIndent: number, header: RegExpExecArray, path: string, key: string): { value: string, nextIdx: number } {
  const style = header[1] as '|' | '>'
  const chomp = (header[2] ?? header[5] ?? 'clip') as 'clip' | '-' | '+'
  const explicit = header[3] ?? header[4]
  let blockIndent = explicit ? parentIndent + Number(explicit) : -1

  let i = startIdx + 1
  let maxLeadingBlankSpaces = 0
  if (blockIndent < 0) {
    let scan = i
    while (scan < lines.length) {
      const l = lines[scan]
      if (l.trim() === '') {
        maxLeadingBlankSpaces = Math.max(maxLeadingBlankSpaces, indentOf(l))
        scan++
        continue
      }
      const ind = indentOf(l)
      if (ind > parentIndent) blockIndent = ind
      break
    }
    if (blockIndent >= 0 && maxLeadingBlankSpaces > blockIndent) {
      throw new Error(`dsh-layerfs: ${path} has over-indented blank line in block scalar "${key}"`)
    }
  }

  const rawLines: string[] = []
  while (i < lines.length) {
    const l = lines[i]
    if (l.trim() === '') {
      if (blockIndent >= 0 && l.length > blockIndent) {
        rawLines.push(l.slice(blockIndent))
      } else {
        rawLines.push('')
      }
      i++
      continue
    }
    const ind = indentOf(l)
    if (blockIndent < 0 || ind < blockIndent) break
    rawLines.push(l.slice(blockIndent))
    i++
  }

  let lastNonEmpty = -1
  for (let j = rawLines.length - 1; j >= 0; j--) {
    if (rawLines[j] !== '') {
      lastNonEmpty = j
      break
    }
  }

  if (lastNonEmpty < 0) {
    const value = chomp === '+' ? '\n'.repeat(rawLines.length) : ''
    return { value, nextIdx: i }
  }

  const contentLines = rawLines.slice(0, lastNonEmpty + 1)
  const trailingBlanks = rawLines.length - 1 - lastNonEmpty

  let body: string
  if (style === '|') {
    body = contentLines.join('\n')
  } else {
    // YAML folded scalar ('>'): fold consecutive non-indented non-empty lines with a space,
    // preserve newlines for blank lines and more-indented lines.
    const out: string[] = []
    let prevKind: 'none' | 'folded' | 'indented' | 'blank' = 'none'
    let blankCount = 0
    for (const l of contentLines) {
      if (l === '') {
        blankCount++
        prevKind = 'blank'
        continue
      }
      const isIndented = /^[ \t]/.test(l)
      if (isIndented) {
        if (prevKind === 'blank') out.push('\n'.repeat(blankCount + 1))
        else if (prevKind !== 'none') out.push('\n')
        out.push(l)
        blankCount = 0
        prevKind = 'indented'
      } else {
        if (prevKind === 'blank') out.push('\n'.repeat(blankCount))
        else if (prevKind === 'indented') out.push('\n')
        else if (prevKind === 'folded') out.push(' ')
        out.push(l)
        blankCount = 0
        prevKind = 'folded'
      }
    }
    body = out.join('')
  }

  if (chomp === '-') return { value: body, nextIdx: i }
  if (chomp === '+') return { value: body + '\n'.repeat(1 + trailingBlanks), nextIdx: i }
  return { value: body + '\n', nextIdx: i }
}

function parsePlainContinuation(lines: string[], startIdx: number, firstLineValue: string, baseIndent: number): { value: unknown, nextIdx: number } {
  const parts: string[] = []
  if (firstLineValue.length > 0) parts.push(firstLineValue)
  let i = startIdx + 1
  let pendingBlanks = 0

  while (i < lines.length) {
    const l = lines[i]
    if (l.trim() === '') {
      pendingBlanks++
      i++
      continue
    }
    if (l.trimStart().startsWith('#')) {
      break
    }
    const ind = indentOf(l)
    if (ind <= baseIndent) break
    const trimmed = stripInlineComment(l.trim())
    if (trimmed.length === 0) break
    for (let b = 0; b < pendingBlanks; b++) parts.push('')
    pendingBlanks = 0
    parts.push(trimmed)
    i++
  }

  if (parts.length === 0) return { value: undefined, nextIdx: i }
  if (parts.length === 1 && firstLineValue.length > 0) {
    return { value: parseScalarAtom(parts[0]), nextIdx: i }
  }
  return { value: foldLines(parts), nextIdx: i }
}

function parseMappingKey(line: string): { key: string, rest: string } | null {
  const trimmed = line.trimStart()
  if (!trimmed || trimmed.startsWith('#')) return null
  let key: string
  let afterKey: string
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const q = trimmed[0]
    let end = 1
    while (end < trimmed.length) {
      if (q === '"' && trimmed[end] === '\\') { end += 2; continue }
      if (q === "'" && trimmed[end] === "'" && trimmed[end + 1] === "'") { end += 2; continue }
      if (trimmed[end] === q) break
      end++
    }
    if (end >= trimmed.length) return null
    key = trimmed.slice(1, end)
    afterKey = trimmed.slice(end + 1)
    if (!afterKey.startsWith(':')) return null
  } else {
    const m = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(trimmed)
    if (!m) return null
    key = m[1]
    afterKey = ':' + m[2]
  }
  const restRaw = afterKey.slice(1)
  if (restRaw.length > 0 && restRaw[0] !== ' ' && restRaw[0] !== '\t') return null
  return { key, rest: restRaw.trimStart() }
}

function parseMapping(lines: string[], startIdx: number, minIndent: number, path: string): { map: Record<string, unknown>, nextIdx: number } {
  const map: Record<string, unknown> = {}
  let i = startIdx
  let expectedIndent = -1

  while (i < lines.length) {
    const line = lines[i]
    if (isBlankOrComment(line)) {
      i++
      continue
    }
    const ind = indentOf(line)
    if (ind < minIndent) break
    if (expectedIndent < 0) {
      if (minIndent === 0 && ind !== 0) {
        throw new Error(`dsh-layerfs: ${path} has unexpected indentation at frontmatter line ${i + 1}`)
      }
      expectedIndent = ind
    } else if (ind < expectedIndent) {
      break
    } else if (ind > expectedIndent) {
      throw new Error(`dsh-layerfs: ${path} has unexpected indentation at frontmatter line ${i + 1}`)
    }

    const entry = parseMappingKey(line)
    if (!entry) {
      throw new Error(`dsh-layerfs: ${path} has invalid YAML mapping entry at frontmatter line ${i + 1}`)
    }
    const { key, rest } = entry

    const blockMatch = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?\s*(?:#.*)?$/.exec(rest)
    if (blockMatch) {
      const parsed = parseBlockScalar(lines, i, expectedIndent, blockMatch, path, key)
      map[key] = parsed.value
      i = parsed.nextIdx
      continue
    }

    if (rest.startsWith("'")) {
      const parsed = parseSingleQuoted(lines, i, rest, path, key)
      map[key] = parsed.value
      i = parsed.nextIdx
      continue
    }

    if (rest.startsWith('"')) {
      const parsed = parseDoubleQuoted(lines, i, rest, path, key)
      map[key] = parsed.value
      i = parsed.nextIdx
      continue
    }

    const plainRest = stripInlineComment(rest)
    if (plainRest.length === 0) {
      // Look ahead for nested mapping or indented multi-line plain scalar
      let peek = i + 1
      while (peek < lines.length && isBlankOrComment(lines[peek])) peek++
      if (peek < lines.length && indentOf(lines[peek]) > expectedIndent) {
        if (parseMappingKey(lines[peek])) {
          const nested = parseMapping(lines, peek, expectedIndent + 1, path)
          map[key] = nested.map
          i = nested.nextIdx
          continue
        }
        const parsed = parsePlainContinuation(lines, i, '', expectedIndent)
        map[key] = parsed.value
        i = parsed.nextIdx
        continue
      }
      map[key] = undefined
      i++
      continue
    }

    const parsed = parsePlainContinuation(lines, i, plainRest, expectedIndent)
    map[key] = parsed.value
    i = parsed.nextIdx
  }

  return { map, nextIdx: i }
}

function parseFrontmatterData(yamlText: string, path: string): Record<string, unknown> {
  const normalized = yamlText.replace(/\r\n/g, '\n')
  const trimmedTrailing = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  const lines = trimmedTrailing.length === 0 ? [] : trimmedTrailing.split('\n')
  if (lines.length === 0 || lines.every(isBlankOrComment)) {
    throw new Error(`dsh-layerfs: ${path} has empty frontmatter`)
  }
  const { map } = parseMapping(lines, 0, 0, path)
  return map
}

function parseFrontmatterBoolean(data: Record<string, unknown>, key: string, path: string): boolean | undefined {
  if (!Object.hasOwn(data, key) || data[key] === undefined) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === '1' || value === 1) return true
  if (value === '0' || value === 0) return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`dsh-layerfs: ${path} frontmatter field "${key}" must be a boolean`)
}

function parseInvocationPolicy(data: Record<string, unknown>, path: string): SkillInvocationPolicy {
  const legacy: Array<[string, string]> = [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ]
  for (const [oldKey, canonical] of legacy) {
    if (Object.hasOwn(data, oldKey)) {
      throw new Error(`dsh-layerfs: ${path} frontmatter field "${oldKey}" is unsupported; use "${canonical}"`)
    }
  }
  const disableModelInvocation = parseFrontmatterBoolean(data, 'disable-model-invocation', path)
  const userInvocable = parseFrontmatterBoolean(data, 'user-invocable', path)
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/** Parse a SKILL.md document: YAML frontmatter (`description`, optional `name`, `whenToUse`, invocation policy, `metadata`) and markdown body. */
export function parseSkill(raw: string, path: string): ParsedSkill {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  const firstNewline = text.indexOf('\n')
  if (firstNewline < 0) throw new Error(`dsh-layerfs: ${path} has no frontmatter`)
  if (text.slice(0, firstNewline).replace(/\r$/, '') !== '---') {
    throw new Error(`dsh-layerfs: ${path} has no frontmatter`)
  }

  const start = firstNewline + 1
  let lineStart = start
  let closingStart = -1
  let bodyStart = -1
  while (lineStart <= text.length) {
    const nextNewline = text.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? text.length : nextNewline
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closingStart = lineStart
      bodyStart = nextNewline < 0 ? text.length : nextNewline + 1
      break
    }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }

  if (closingStart < 0) throw new Error(`dsh-layerfs: ${path} has unclosed frontmatter`)

  const data = parseFrontmatterData(text.slice(start, closingStart), path)

  let skillName: string | undefined
  if (Object.hasOwn(data, 'name') && data.name !== undefined) {
    if (typeof data.name !== 'string' || !SKILL_NAME.test(data.name)) {
      throw new Error(`dsh-layerfs: ${path} has invalid skill name "${String(data.name)}"`)
    }
    skillName = data.name
  }

  const description = data.description
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(`dsh-layerfs: ${path} has no description`)
  }

  const whenToUse = typeof data.whenToUse === 'string' && data.whenToUse.trim().length > 0 ? data.whenToUse : undefined
  const invocation = parseInvocationPolicy(data, path)
  const metadata = typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)
    ? data.metadata as Readonly<Record<string, unknown>>
    : undefined

  return {
    ...(skillName !== undefined ? { name: skillName } : {}),
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    invocation,
    ...(metadata !== undefined ? { metadata } : {}),
    content: text.slice(bodyStart).trim(),
  }
}

/** Resolve and validate a bundled skill folder into a {@link SkillCandidate}. */
export function resolveSkill(skill: string, root: string = skillRoot()): SkillCandidate {
  const directory = join(root, skill)
  const path = join(directory, 'SKILL.md')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`dsh-layerfs: failed to read skill "${skill}" at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const parsed = parseSkill(raw, path)
  const resolvedDir = (existsSync(directory) ? realpathSync(directory) : resolve(directory)).split('\\').join('/')
  const resolvedPath = existsSync(path) ? realpathSync(path) : resolve(path)
  return {
    name: parsed.name ?? skill,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    invocation: parsed.invocation,
    provider: 'dsh-layerfs',
    source: 'bundled',
    rank: BUNDLED_RANK,
    path: resolvedPath,
    resourceBase: { kind: 'directory' as const, path: resolvedDir },
    locator: resolvedPath,
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
  }
}

export function apply(ctx: Context, config: { root?: string } = {}): void {
  const logger = (ctx as { logger?: { warn?: (msg: string) => void } }).logger
  const root = config.root ?? skillRoot()
  const candidates = SKILLS.map((skill) => {
    try {
      return resolveSkill(skill, root)
    } catch (error) {
      logger?.warn?.(`dsh-layerfs: failed to load skill "${skill}": ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  })

  ctx.skills.registerProvider(() => ({
    name: 'dsh-layerfs',
    list: () => Promise.resolve(candidates),
    async get(candidate: SkillCandidate, options: SkillLookupOptions) {
      options?.signal?.throwIfAborted?.()
      const { rank: _rank, locator, ...summary } = candidate
      const path = locator as string
      let raw: string
      try {
        raw = await readFile(path, { encoding: 'utf8', signal: options?.signal })
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
          logger?.warn?.(`dsh-layerfs: skill file missing at ${path}`)
          return undefined
        }
        throw error
      }
      const parsed = parseSkill(raw, path)
      return {
        ...summary,
        name: parsed.name ?? summary.name,
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: parsed.invocation,
        ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
        content: parsed.content,
      }
    },
  }))
}
