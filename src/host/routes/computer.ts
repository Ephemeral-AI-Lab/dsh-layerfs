/**
 * The computer this host runs on, as the Machines page names it: the native
 * machine is this computer, so its name, mark and notes follow its OS. `os`
 * is LayerFS's own word for the host when it gave one (machine.platforms
 * `host`), else Node's; `name` is the OS release in words (macOS 15.4,
 * Ubuntu 24.04.1 LTS, Windows 11 Pro), read once.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { arch, platform, release, version } from 'node:os'

export type HostOs = 'macos' | 'linux' | 'windows' | 'other'

export interface Computer {
  os: HostOs
  /** The OS release in words, or null when unreadable. */
  name: string | null
  arch: string
}

/** Node's platform in LayerFS's words. */
export function osOf(value: string | null | undefined): HostOs {
  if (value === 'macos' || value === 'darwin') return 'macos'
  if (value === 'linux') return 'linux'
  if (value === 'windows' || value === 'win32') return 'windows'
  return 'other'
}

/** `PRETTY_NAME` of an os-release file's text, or null. */
export function prettyName(text: string): string | null {
  const line = text.split('\n').find((l) => l.startsWith('PRETTY_NAME='))
  const value = line?.slice('PRETTY_NAME='.length).trim().replace(/^"(.*)"$/, '$1')
  return value || null
}

function releaseName(os: HostOs): string | null {
  try {
    if (os === 'macos') {
      const v = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 }).trim()
      return v ? `macOS ${v}` : 'macOS'
    }
    if (os === 'linux') {
      for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
        try { const name = prettyName(readFileSync(file, 'utf8')); if (name) return name } catch {}
      }
      return `Linux ${release()}`
    }
    if (os === 'windows') return version() || 'Windows'
  } catch {}
  return null
}

let known: Computer | null = null

/** This computer; `lfsHost` (machine.platforms `host`) wins over Node's platform. */
export function computer(lfsHost?: string | null): Computer {
  const os = lfsHost ? osOf(lfsHost) : osOf(platform())
  if (!known || known.os !== os) known = { os, name: releaseName(os), arch: arch() }
  return known
}
