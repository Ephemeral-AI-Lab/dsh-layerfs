import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const CLIENT_DIR = join(ROOT, 'src', 'client')
const TONES_FILE = join(CLIENT_DIR, 'ui', 'tones.module.css')
const STATUS_DOT_FILE = join(CLIENT_DIR, 'ui', 'StatusDot.tsx')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function stripCssCommentsPreserveLines(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

function iterCssBlocks(css) {
  const clean = stripCssCommentsPreserveLines(css)
  const blocks = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(clean)) !== null) {
    blocks.push({ selector: m[1].trim(), body: m[2].trim() })
  }
  return blocks
}

function parseHex(hex) {
  const raw = hex.replace(/^#/, '')
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw.slice(0, 6)
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ]
}

function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n))
}

function isChromaticRgb(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b) > 0.1
}

function isChromaticHex(hex) {
  const [r, g, b] = parseHex(hex)
  return isChromaticRgb(r, g, b)
}

function parseAngleDeg(token) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(token.trim())
  if (!m) return null
  const val = Number(m[1])
  switch ((m[2] ?? 'deg').toLowerCase()) {
    case 'deg': return val
    case 'rad': return (val * 180) / Math.PI
    case 'grad': return val * 0.9
    case 'turn': return val * 360
    default: return null
  }
}

function parseChannel(token, maxVal = 1) {
  const s = token.trim()
  if (s === 'none') return 0
  if (s.endsWith('%')) {
    const v = Number(s.slice(0, -1))
    return Number.isFinite(v) ? clamp01(v / 100) : null
  }
  const v = Number(s)
  return Number.isFinite(v) ? clamp01(v / maxVal) : null
}

function isChromaticColorFn(fnName, rawArgs) {
  const name = fnName.toLowerCase()
  const baseArgs = rawArgs.split('/')[0].trim()
  if (!baseArgs || /\b(?:var|calc|env|from)\b/i.test(baseArgs)) return false
  const parts = baseArgs.includes(',')
    ? baseArgs.split(',').map((s) => s.trim()).filter(Boolean)
    : baseArgs.split(/\s+/).filter(Boolean)

  if (name === 'rgb' || name === 'rgba') {
    if (parts.length < 3) return false
    const rgb = parts.slice(0, 3).map((p) => parseChannel(p, 255))
    if (rgb.some((v) => v === null)) return false
    return isChromaticRgb(rgb[0], rgb[1], rgb[2])
  }

  if (name === 'hsl' || name === 'hsla') {
    if (parts.length < 3) return false
    if (parseAngleDeg(parts[0]) === null) return false
    const s = parseChannel(parts[1], 100)
    const l = parseChannel(parts[2], 100)
    if (s === null || l === null) return false
    return (1 - Math.abs(2 * l - 1)) * s > 0.1
  }

  if (name === 'hwb') {
    if (parts.length < 3) return false
    if (parseAngleDeg(parts[0]) === null) return false
    const w = parseChannel(parts[1], 100)
    const b = parseChannel(parts[2], 100)
    if (w === null || b === null) return false
    return w + b < 1 && 1 - w - b > 0.1
  }

  if (name === 'oklch' || name === 'lch') {
    if (parts.length < 3) return false
    const cRaw = parts[1].trim()
    const c = cRaw === 'none' ? 0 : cRaw.endsWith('%') ? Number(cRaw.slice(0, -1)) * (name === 'oklch' ? 0.004 : 1.5) : Number(cRaw)
    return Number.isFinite(c) && c > (name === 'oklch' ? 0.03 : 10)
  }

  if (name === 'oklab' || name === 'lab') {
    if (parts.length < 3) return false
    const scale = name === 'oklab' ? 0.4 : 125
    const parseAxis = (tok) => {
      const s = tok.trim()
      if (s === 'none') return 0
      return s.endsWith('%') ? Number(s.slice(0, -1)) * (scale / 100) : Number(s)
    }
    const a = parseAxis(parts[1])
    const b = parseAxis(parts[2])
    return Number.isFinite(a) && Number.isFinite(b) && Math.hypot(a, b) > (name === 'oklab' ? 0.03 : 10)
  }

  if (name === 'color') {
    if (parts.length < 4) return false
    if (!/^(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020)$/i.test(parts[0])) return false
    const rgb = parts.slice(1, 4).map((p) => parseChannel(p, 1))
    if (rgb.some((v) => v === null)) return false
    return isChromaticRgb(rgb[0], rgb[1], rgb[2])
  }

  return false
}

const COLOR_FN_RE = /\b(rgb|rgba|hsl|hsla|hwb|oklch|lch|oklab|lab|color)\s*\(((?:\([^()]*\)|[^()])*)\)/gi
const CHROMATIC_NAMED_COLOR_RE = /\b(?:red|green|blue|orange|yellow|amber|crimson|tomato|lime|coral|salmon|gold|pink|purple|violet|indigo|cyan|teal|magenta|maroon|olive|navy|aqua|fuchsia|darkred|firebrick|indianred|orangered|darkorange|forestgreen|limegreen|seagreen|mediumseagreen|yellowgreen|chartreuse|dodgerblue|royalblue|steelblue)\b/i

const NON_STATUS_CHROMATIC_ALLOWLIST = new Set([
  'src/client/doctor/DoctorPage.module.css',
  'src/client/machines/icons.tsx',
  'src/client/overview/glyph.tsx',
  'src/client/storage/HomeOverview.module.css',
  'src/client/views/marks.tsx',
])

const NON_STATUS_VAR_ALLOWLIST = /^--(doc-(run|link|tip-run)|ov-(accent|ink-\w+)|lfs-(light|dark))$/

test('lint: every circular (50%/100%) or pill (999px/radius-full) border-radius in src/client declares corner-shape: round', () => {
  const files = walk(CLIENT_DIR).filter((f) => /\.(css|ts|tsx)$/.test(f))
  const missing = []

  for (const file of files) {
    const rel = relative(ROOT, file)
    const text = readFileSync(file, 'utf8')
    if (file.endsWith('.css')) {
      for (const { selector, body } of iterCssBlocks(text)) {
        if (/border-radius\s*:\s*[^;]*(?:50%|100%|999+px|radius-full)/.test(body)) {
          if (!/corner-shape\s*:\s*round\b/.test(body)) {
            missing.push(`${rel} [${selector}]`)
          }
        }
      }
    } else {
      for (const m of text.matchAll(/borderRadius\s*:\s*['"]?(?:50%|100%|999+px)['"]?/g)) {
        const slice = text.slice(Math.max(0, m.index - 120), m.index + 160)
        if (!/cornerShape\s*:\s*['"]round['"]/.test(slice)) {
          missing.push(`${rel}: inline ${m[0]}`)
        }
      }
    }
  }

  assert.deepEqual(missing, [], `circular/pill border-radius missing corner-shape: round:\n${missing.join('\n')}`)
})

test('lint: src/client uses --lf-tone-* for status colors (no DSH state tokens, no hardcoded status colors, no StateDot outside StatusDot.tsx)', () => {
  const files = walk(CLIENT_DIR).filter((f) => /\.(css|ts|tsx)$/.test(f))
  const violations = []

  for (const file of files) {
    const rel = relative(ROOT, file)
    const text = readFileSync(file, 'utf8')

    if (file !== TONES_FILE) {
      const source = file.endsWith('.css') ? stripCssCommentsPreserveLines(text) : text
      const lines = source.split('\n')
      const rawLines = text.split('\n')
      lines.forEach((line, idx) => {
        const trimmed = rawLines[idx].trim()
        if (!file.endsWith('.css') && (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))) return
        if (/--dsw-alias-state-(?:success|warn|error)/.test(line)) {
          violations.push(`${rel}:${idx + 1}: direct DSH status token: ${trimmed}`)
        }
        if (/dsh-layerfs:(?:halo|palette)|data-lf-(?:halo|palette)/.test(line)) {
          violations.push(`${rel}:${idx + 1}: leftover prototype toggle: ${trimmed}`)
        }
        if (/(?:color|background|border|fill|stroke)\s*:\s*['"]?\b(?:red|green|orange|yellow|amber|crimson|tomato|lime)\b/i.test(line)) {
          violations.push(`${rel}:${idx + 1}: named status color: ${trimmed}`)
        }
        if (/--(?:doc-(?:ok|bad|warn|tip-ok|tip-bad|tip-warn)|ov-(?:success|warning|danger))\s*:[^;]*#[0-9a-f]{3,8}\b/i.test(line)) {
          violations.push(`${rel}:${idx + 1}: hardcoded status custom property: ${trimmed}`)
        }
        if (file.endsWith('.css')) {
          const varDecl = /^\s*(--[a-zA-Z0-9-]+)\s*:/.exec(line)
          const allowlistedVar = NON_STATUS_CHROMATIC_ALLOWLIST.has(rel) && varDecl && NON_STATUS_VAR_ALLOWLIST.test(varDecl[1])
          if (!allowlistedVar) {
            for (const hm of line.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
              if (!isChromaticHex(hm[0])) continue
              violations.push(`${rel}:${idx + 1}: hardcoded chromatic hex ${hm[0]}: ${trimmed}`)
            }
            for (const cm of line.matchAll(COLOR_FN_RE)) {
              if (isChromaticColorFn(cm[1], cm[2])) {
                violations.push(`${rel}:${idx + 1}: hardcoded chromatic ${cm[0]}: ${trimmed}`)
              }
            }
            for (const dm of line.matchAll(/(?:^|[{;])\s*(?:[a-z][a-z0-9-]*|--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi)) {
              const val = dm[1].replace(/var\([^()]*\)/g, '').replace(/['"][^'"]*['"]/g, '')
              const nm = CHROMATIC_NAMED_COLOR_RE.exec(val)
              if (nm) {
                violations.push(`${rel}:${idx + 1}: named chromatic color ${nm[0]}: ${trimmed}`)
              }
            }
          }
          if (/(?:^|[;{]\s*)(?:background|background-color)\s*:\s*color-mix\([^;]*var\(--lf-tone-(?:success|warning|danger|info|neutral)-[^)]+\)[^;]*transparent/.test(line)) {
            violations.push(`${rel}:${idx + 1}: ad-hoc color-mix background tint (use --lf-tone-*-bg): ${trimmed}`)
          }
        } else if (!NON_STATUS_CHROMATIC_ALLOWLIST.has(rel)) {
          for (const hm of line.matchAll(/['"`](#[0-9a-fA-F]{3,8})['"`]/g)) {
            if (isChromaticHex(hm[1])) {
              violations.push(`${rel}:${idx + 1}: hardcoded chromatic hex ${hm[1]}: ${trimmed}`)
            }
          }
          for (const sm of line.matchAll(/(['"`])([^\n]*?)\1/g)) {
            for (const cm of sm[2].matchAll(COLOR_FN_RE)) {
              if (isChromaticColorFn(cm[1], cm[2])) {
                violations.push(`${rel}:${idx + 1}: hardcoded chromatic ${cm[0]}: ${trimmed}`)
              }
            }
          }
        }
      })
    }

    if (file !== STATUS_DOT_FILE && /\.(ts|tsx)$/.test(file)) {
      const lines = text.split('\n')
      lines.forEach((line, idx) => {
        if (/import[^;]*\bStateDot\b|<StateDot\b/.test(line)) {
          violations.push(`${rel}:${idx + 1}: use StatusDot instead of DSH StateDot: ${line.trim()}`)
        }
      })
    }
  }

  assert.deepEqual(violations, [], `status color lint violations (${violations.length}):\n${violations.slice(0, 25).join('\n')}${violations.length > 25 ? `\n... +${violations.length - 25} more` : ''}`)
})

test('tokens: Palette A Calm defines complete light/dark token sets and meets WCAG AA contrast', () => {
  assert.ok(existsSync(TONES_FILE), 'src/client/ui/tones.module.css must exist')
  const css = readFileSync(TONES_FILE, 'utf8')
  const blocks = iterCssBlocks(css)
  const lightBlock = blocks.find((b) => b.selector === ':global(body)')
  const darkBlock = blocks.find((b) => b.selector === ':global(body[data-ds-dark-theme])')
  assert.ok(lightBlock, 'tones.module.css must define :global(body) light tokens')
  assert.ok(darkBlock, 'tones.module.css must define :global(body[data-ds-dark-theme]) dark tokens')
  assert.ok(!blocks.some((b) => /:global\(html\s+body\)/.test(b.selector)), 'must not globally remap DSH tokens on html body')
  assert.ok(blocks.some((b) => b.selector === '.lfTone'), 'tones.module.css must provide scoped .lfTone remap class')

  const parseVars = (body) => {
    const vars = {}
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      vars[m[1]] = m[2].trim()
    }
    return vars
  }

  const light = parseVars(lightBlock.body)
  const dark = parseVars(darkBlock.body)
  assert.equal(light['--lf-glow-room'], '10px')
  assert.equal(light['--lf-glow-core'], '45%')
  assert.equal(light['--lf-glow-edge'], '24%')
  assert.equal(dark['--lf-glow-core'], '55%')
  assert.equal(dark['--lf-glow-edge'], '34%')

  const tones = ['success', 'warning', 'danger', 'info', 'neutral']
  const suffixes = ['fg', 'dot', 'bg', 'border', 'solid', 'solid-hover', 'on-solid', 'dot-inverse', 'halo', 'halo-tight']

  for (const [mode, vars, pageBg, cardBg] of [
    ['light', light, '#ffffff', '#ffffff'],
    ['dark', dark, '#151517', '#232324'],
  ]) {
    for (const tone of tones) {
      for (const s of suffixes) {
        const key = `--lf-tone-${tone}-${s}`
        assert.ok(vars[key], `${mode} missing ${key}`)
      }
      const fg = vars[`--lf-tone-${tone}-fg`]
      const dot = vars[`--lf-tone-${tone}-dot`]
      const bg = vars[`--lf-tone-${tone}-bg`]
      const solid = vars[`--lf-tone-${tone}-solid`]
      const onSolid = vars[`--lf-tone-${tone}-on-solid`]

      assert.ok(contrast(fg, pageBg) >= 4.5, `${mode} ${tone} fg vs page (${contrast(fg, pageBg).toFixed(2)}) < 4.5`)
      assert.ok(contrast(fg, cardBg) >= 4.5, `${mode} ${tone} fg vs card (${contrast(fg, cardBg).toFixed(2)}) < 4.5`)
      assert.ok(contrast(fg, bg) >= 4.5, `${mode} ${tone} fg vs bg (${contrast(fg, bg).toFixed(2)}) < 4.5`)
      assert.ok(contrast(dot, pageBg) >= 3.0, `${mode} ${tone} dot vs page (${contrast(dot, pageBg).toFixed(2)}) < 3.0`)
      assert.ok(contrast(onSolid, solid) >= 4.5, `${mode} ${tone} on-solid vs solid (${contrast(onSolid, solid).toFixed(2)}) < 4.5`)

      if (tone === 'neutral' || tone === 'info') {
        assert.equal(vars[`--lf-tone-${tone}-halo`], 'none', `${mode} ${tone} halo must be none`)
        assert.equal(vars[`--lf-tone-${tone}-halo-tight`], 'none', `${mode} ${tone} tight halo must be none`)
      } else {
        assert.match(vars[`--lf-tone-${tone}-halo`], /^0 0 3px 0\.5px .*0 0 8px 1\.5px /, `${mode} ${tone} halo must match third-draft soft glow`)
        assert.match(vars[`--lf-tone-${tone}-halo-tight`], /^0 0 2px 0\.5px .*0 0 5px 0\.5px /, `${mode} ${tone} tight halo must match third-draft compact glow`)
      }
    }
  }
})
