#!/Users/yifanxu/.nvm/versions/node/v24.21.0/bin/node
// STAND-IN, not LayerFS: a pinned-CLI wrapper that ANSWERS `sandbox files` and
// `machine files` for a CLI that does not have the calls yet
// (layerfs-project#178 steps 3 to 5), so the dsh-layerfs Files views can be
// built and checked before the real calls exist. A run against it shows that
// the UI follows the SPEC as read here; it is never a pass on a real machine.
// Runs against a real build do not use it.
//
// It answers what #178 "Design > Calls", "Machine files", "Sandbox files" and
// "API summary" describe:
//   layerfs sandbox files <sandbox> [<path>] [--depth N] [--cursor ..] [--limit ..] [--offset ..] [--length ..]
//   layerfs machine files <machine> [<path>] [...]
//   no path  -> the roots: { kind: "folder", entries: [{ path, depth: 1, kind, size, mode, mtime, role, … }], next: null, has_more: false }
//   a folder -> { kind: "folder", entries: [{ path, depth, kind, size, mode, mtime, target?, workspace?, fs? }], next, has_more, reason? }
//               a flat list in tree order: names in byte order, a folder before its entries (to --depth, default 1, at most 32);
//               at most --limit entries (default 500, at most 1000); `next` is the last entry's path and --cursor
//               continues after it; `reason` is "limit" for a full page, "deadline" for one cut short by time
//   a file   -> { kind: "file", size, offset, content, binary, next }: --length bytes from --offset (default 256 KiB,
//               at most 1 MiB), cut back to a whole UTF-8 character; `next` is the offset after it, null at the end;
//               `binary` is true when the file's first 256 KiB hold a NUL (its content is then empty)
// Entry kinds: file, folder, symlink (with `target`, never followed), mount (with `fs`; a Workspace's with
// `workspace`), restricted, system, unreadable, other (a FIFO, socket or device).
// Refusals: a stopped machine, or a path outside a stopped Sandbox's home, `Unavailable`; a path that is not
// absolute and normal (`..`, `//`), outside the target's confines, through or at an entry that is not a folder or
// a regular file (restricted, system, mount, unreadable, symlink, other) `InvalidInput`; a path that is not
// there `NotFound` (this stand-in's choice: the spec names no code for it); a bad option `InvalidInput`.
//
// Aligned with the merged build's answers for `sandbox files` (the lead's
// monitoring-179-API-SHAPES.md, 2026-11-16): `mode` is the permission bits,
// `mtime` ms since 1970, `size` only for regular files, `next` of a folder
// page the last entry's path whenever the page has entries (also when
// `has_more` is false), `next` of a file the next byte offset, depth 1 to 32,
// a missing path `NotFound`. Still this stand-in's reading of the spec, with
// no real answer to compare yet: everything about `machine files` (its
// `system` and `unreadable` kinds, a root's free space as `free`), and a
// Sandbox's `/` root (role `root`; still offered by a stopped Sandbox).
//
// What a target (a machine or a Sandbox) holds is a folder tree on disk plus
// a small declaration, in <LFS_INSPECT_DIR>/files.json, read on every call:
//   { "calls": ["sandbox.files", "machine.files"],      the calls listed in help and answered (default both)
//     "machine": { "<name>" | "*": Target }, "sandbox": { "<name>" | "*": Target } }
//   Target = {
//     "state": "stopped",                     default running
//     "root": "/real/dir",                    the folder on disk that is the target's `/`
//     "binds": [{ "at": "/abs", "from": "/real/dir" }],    paths under `at` are read from `from` instead (longest first)
//     "roots": [{ "role", "path", "free"?, "kind"?, "workspace"?, "fs"? }],   the roots answer, in this order; one whose path
//                                             is not there is left out, unless it declares its kind (a Workspace mount: never stat'ed)
//     "whole": "machine" | "root",            `/` is offered after the roots, with this role
//     "confine": ["/abs", …],                 a path outside all of them is InvalidInput (a native machine, a host-process Sandbox)
//     "home": "/abs",                         a Sandbox's home: readable while it is stopped
//     "o_r_outside": "/layerfs",              outside this folder an entry without o+r is `unreadable`
//     "overlay": { "/abs/path": { "kind", "fs"?, "workspace"?, "target"?, "size"? } },   kinds the disk cannot show; an entry
//                                             that is not on disk is added to its folder's listing
//     "restricted_names": ["control.json", …],    names that are `restricted` wherever they are (default: the spec's list)
//     "deadline": { "/abs/folder": <n> },     every page of that folder ends after n entries with reason "deadline"
//     "run_folders": ["/abs/folder", …],      folders that hold Sandbox run folders: in each run folder, `config` and `overlay`
//                                             are restricted and every entry of `workspaces` is a mount (`run_folders_fs`,
//                                             default "nfs") that is listed by name and never stat'ed
//     "records": "/real/<home>/sandbox/<name>" }   a Sandbox on this disk, from its LayerFS records: its run folder
//                                             (record.json `daemon.directory`) is read at its own path; its roots are one
//                                             `workspace` mount per Workspace record (path, id; fs from the record's route),
//                                             `home` (<run folder>/tmp) and `log` (<run folder>/daemon.log); without `whole`
//                                             only paths under its home are read (a host-process Sandbox)
// and <LFS_INSPECT_DIR>/control.json (shared with cli-inspect-logs.mjs) holds
// delays and refusals, keyed `files-<machine|sandbox>:<name>` (every read of
// the target), `…:<name>:<path>` (one path; the roots' path is empty) or
// `files-<machine|sandbox>:*`:
//   { "delay_ms": { "files-machine:docker:/etc": 60000 }, "refuse": { "files-sandbox:sb": { "code": "Busy", "message": "…" } } }
// Each call it answers adds `<epoch ms> <argv JSON>` to spawns.log. Everything
// else passes through to $LFS_REAL_CLI (cli-standin-lib.mjs: the chain).
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync } from 'node:fs'
import { join, posix } from 'node:path'
import { answer, args, call, dir, emit, family, flags, json, logSpawn, need, nextEnv, pass, positionals, real, refuse, sleep } from './cli-standin-lib.mjs'
import { spawnSync } from 'node:child_process'

need('cli-inspect-files')

const WINDOW = 256 * 1024, MAX_LENGTH = 1024 * 1024, DEFAULT_LIMIT = 500, MAX_LIMIT = 1000
const RESTRICTED = ['control.json', 'worker.json', 'store.sqlite', 'store.sqlite-wal', 'store.sqlite-shm', 'store.sqlite-journal', 'layerfs.lock', 'lock', 'serve.lock', 'start.lock']
const config = json('files.json')
const answered = new Set(Array.isArray(config.calls) ? config.calls : ['sandbox.files', 'machine.files'])
const key = `${family}.${call}`

if (family === 'help' && args.includes('--json') && args.length === 2) {
  const r = spawnSync(real, args, { encoding: 'utf8', maxBuffer: 1 << 28, env: nextEnv() })
  let out = r.stdout
  try {
    const help = JSON.parse(out)
    const has = (f, c) => (help.calls ?? []).some((x) => x.family === f && x.call === c)
    const options = ['depth', 'limit', 'offset', 'length'].map((name) => ({ name, kind: 'int', optional: true }))
    options.splice(1, 0, { name: 'cursor', kind: 'text', optional: true })
    const added = []
    for (const kind of ['sandbox', 'machine']) {
      if (answered.has(`${kind}.files`) && !has(kind, 'files')) added.push({ family: kind, call: 'files', args: [{ name: kind, kind: 'name', optional: false }, { name: 'path', kind: 'text', optional: true }], options, help: `STAND-IN: a ${kind === 'sandbox' ? 'Sandbox' : 'machine'}'s files: its roots, a folder page or a file window` })
    }
    out = JSON.stringify({ ...help, calls: [...(help.calls ?? []), ...added] })
  } catch { /* not JSON: pass through */ }
  emit(1, out ?? '')
  emit(2, r.stderr ?? '')
  process.exit(r.status ?? 1)
}

if (!((family === 'sandbox' || family === 'machine') && call === 'files' && answered.has(key))) pass()
else await files()

async function files() {
  logSpawn()
  const kind = family, name = positionals[0], path = positionals[1]
  const what = kind === 'sandbox' ? 'Sandbox' : 'machine'
  if (!name || positionals.length > 2) { process.stderr.write(`usage: layerfs ${kind} files <${kind}> [<path>] [--depth N] [--cursor ..] [--limit ..] [--offset ..] [--length ..]\n`); process.exit(2) }

  const control = json('control.json')
  const keys = [`files-${kind}:${name}:${path ?? ''}`, `files-${kind}:${name}`, `files-${kind}:*`]
  const delay = keys.map((k) => Number(control.delay_ms?.[k])).find((ms) => Number.isFinite(ms) && ms > 0) ?? 0
  if (delay) await sleep(delay)
  const refusal = keys.map((k) => control.refuse?.[k]).find(Boolean)
  if (refusal) refuse(String(refusal.code), String(refusal.message ?? refusal.code))

  const target = config[kind]?.[name] ?? config[kind]?.['*']
  if (!target) refuse(kind === 'sandbox' ? 'NoSuchSandbox' : 'NoSuchMachine', `no ${what} named ${name}`)
  const invalid = (message) => refuse('InvalidInput', `${kind}.files: ${message}`)
  const whole = (flag, min, max, fallback) => {
    if (flags[flag] === undefined) return fallback
    const n = Number(flags[flag])
    if (!Number.isSafeInteger(n) || n < min || n > max) invalid(`\`${flag}\` is ${min} to ${max}`)
    return n
  }
  const depth = whole('depth', 1, 32, 1), limit = whole('limit', 1, MAX_LIMIT, DEFAULT_LIMIT)
  const offset = whole('offset', 0, Number.MAX_SAFE_INTEGER, 0), length = whole('length', 1, MAX_LENGTH, WINDOW)
  const stopped = target.state === 'stopped'
  if (stopped && kind === 'machine') refuse('Unavailable', `machine ${name} is stopped`)

  const under = (p, base) => p === base || base === '/' || p.startsWith(`${base}/`)
  // a Sandbox declared by its LayerFS records on this disk: what the real call reads on the record side
  if (target.records) {
    try {
      const record = JSON.parse(readFileSync(join(target.records, 'record.json'), 'utf8'))
      const run = record.daemon.directory
      let records = []
      try { records = readdirSync(join(target.records, 'workspace')).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(target.records, 'workspace', n), 'utf8'))) } catch { /* none mounted */ }
      const fs = record.route === 'nfs' ? 'nfs' : 'fuse.layerfs'
      target.home ??= `${run}/tmp`
      target.binds = [...(target.binds ?? []), { at: run, from: run }]
      target.run_folders = [...(target.run_folders ?? []), posix.dirname(run)]
      target.run_folders_fs ??= fs
      target.roots = [
        ...records.sort((a, b) => a.namespace - b.namespace).map((w) => ({ role: 'workspace', path: w.path, kind: 'mount', workspace: w.id, fs })),
        { role: 'home', path: target.home }, { role: 'log', path: `${run}/daemon.log` },
        ...(target.roots ?? []),
      ]
      target.overlay = { ...Object.fromEntries(records.map((w) => [w.path, { kind: 'mount', workspace: w.id, fs }])), ...(target.overlay ?? {}) }
      if (!target.whole) target.confine ??= [target.home]
    } catch (error) { refuse('NoSuchSandbox', `no Sandbox named ${name} (${error?.message ?? error})`) }
  }

  const overlay = target.overlay ?? {}
  const runFolders = Array.isArray(target.run_folders) ? target.run_folders : []
  /** What a run folder makes of `p`: its `config` and `overlay` are restricted, an entry of its `workspaces` a mount. */
  const inRun = (p) => {
    for (const holder of runFolders) {
      if (!under(p, holder) || p === holder) continue
      const parts = p.slice(holder.length + 1).split('/')
      if (parts.length === 2 && (parts[1] === 'config' || parts[1] === 'overlay')) return 'restricted'
      if (parts.length === 3 && parts[1] === 'workspaces') return 'mount'
    }
    return null
  }
  const restricted = new Set(Array.isArray(target.restricted_names) ? target.restricted_names : RESTRICTED)
  const binds = [...(target.binds ?? [])].sort((a, b) => b.at.length - a.at.length)
  /** Where a path of the target is on this disk. */
  const onDisk = (p) => {
    const bind = binds.find((b) => under(p, b.at))
    if (bind) return join(bind.from, p.slice(bind.at.length))
    if (!target.root) return null
    return join(target.root, p)
  }
  const stat = (p) => { const real = onDisk(p); if (!real) return null; try { return lstatSync(real) } catch { return null } }
  /** One entry as the answer carries it; null when it is neither on disk nor declared. */
  const entry = (p, level) => {
    const declared = overlay[p]
    // a Workspace mount is reported from the records, never stat'ed: a stopped daemon cannot hang the listing
    if (inRun(p) === 'mount') return { path: p, depth: level, kind: 'mount', size: null, mode: null, mtime: null, fs: declared?.fs ?? target.run_folders_fs ?? 'nfs', ...(declared?.workspace ? { workspace: declared.workspace } : {}) }
    const st = stat(p)
    if (!declared && !st) return null
    let kindOf = declared?.kind
    if (!kindOf) {
      kindOf = st.isDirectory() ? 'folder' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other'
      if (restricted.has(posix.basename(p)) || inRun(p) === 'restricted') kindOf = 'restricted'
      else if (target.o_r_outside && !under(p, target.o_r_outside) && kindOf !== 'symlink' && (st.mode & 0o004) === 0) kindOf = 'unreadable'
    }
    // as the merged build answers (monitoring-179-API-SHAPES.md): the permission bits, ms since 1970, a size for regular files only
    const out = { path: p, depth: level, kind: kindOf, size: declared?.size ?? (st && st.isFile() ? st.size : null), mode: st ? st.mode & 0o7777 : null, mtime: st ? Math.floor(st.mtimeMs) : null }
    if (kindOf === 'symlink') { out.target = declared?.target; if (!out.target) { try { out.target = readlinkSync(onDisk(p)) } catch { /* shown without one */ } } }
    if (declared?.workspace) out.workspace = declared.workspace
    if (declared?.fs) out.fs = declared.fs
    return out
  }

  // ------------------------------------------------------------ the roots
  if (path === undefined) {
    if (flags.cursor !== undefined || flags.offset !== undefined || flags.length !== undefined) invalid('the roots take no cursor, offset or length')
    const entries = []
    for (const root of target.roots ?? []) {
      let e
      if (root.kind) e = { path: root.path, depth: 1, kind: root.kind, size: null, mode: null, mtime: null }
      else e = entry(root.path, 1)
      if (!e) continue
      e.role = root.role
      if (root.workspace) e.workspace = root.workspace
      if (root.fs) e.fs = root.fs
      if (typeof root.free === 'number') e.free = root.free
      entries.push(e)
    }
    if (target.whole) entries.push({ path: '/', depth: 1, kind: 'folder', size: null, mode: null, mtime: null, role: target.whole })
    answer({ kind: 'folder', entries, next: null, has_more: false })
  }

  // ------------------------------------------------------------ a path
  if (!path.startsWith('/')) invalid('a path is absolute')
  if (path !== '/' && (path.endsWith('/') || path.split('/').slice(1).some((part) => part === '' || part === '.' || part === '..'))) invalid(`${path} leaves the folder it names (\`..\`, \`.\` or an empty part)`)
  if (stopped && !(target.home && under(path, target.home))) refuse('Unavailable', `Sandbox ${name} is stopped: only its home can be read`)
  if (Array.isArray(target.confine) && !target.confine.some((base) => under(path, base))) invalid(kind === 'machine' ? `${path} is outside the LayerFS folders of machine ${name}` : `${path} is outside the home of Sandbox ${name}`)

  // the base the read starts from (a root, or `/`): opened whatever it is; every part after it must be a folder
  const bases = ['/', ...(target.roots ?? []).filter((r) => !r.kind).map((r) => r.path), ...(target.home ? [target.home] : []), ...binds.map((b) => b.at)].filter((b) => under(path, b)).sort((a, b) => b.length - a.length)
  const base = bases[0]
  const parts = path === base ? [] : path.slice(base === '/' ? 1 : base.length + 1).split('/')
  let at = base
  for (let i = 0; i < parts.length; i++) {
    at = at === '/' ? `/${parts[i]}` : `${at}/${parts[i]}`
    const e = entry(at, 1)
    if (!e) refuse('NotFound', `${kind}.files: no such file or folder: ${path}`)
    const last = i === parts.length - 1
    if (!last && e.kind !== 'folder') invalid(`${at} is ${e.kind}: it is not entered`)
    if (last && e.kind !== 'folder' && e.kind !== 'file') invalid(`${path} is ${e.kind}: it is not read`)
  }
  const st = stat(path)
  if (!st) refuse('NotFound', `${kind}.files: no such file or folder: ${path}`)

  // ------------------------------------------------------------ a file window
  if (st.isFile()) {
    if (flags.cursor !== undefined) invalid(`${path} is a file: it takes an offset, not a cursor`)
    const fd = openSync(onDisk(path), 'r')
    try {
      const head = Buffer.alloc(Math.min(st.size, WINDOW))
      readSync(fd, head, 0, head.length, 0)
      const binary = head.includes(0)
      let buffer = Buffer.alloc(Math.max(0, Math.min(length, st.size - offset)))
      readSync(fd, buffer, 0, buffer.length, offset)
      // not inside a UTF-8 character: the cut goes back to its first byte
      let end = buffer.length
      if (!binary && offset + end < st.size) {
        let back = 0
        while (back < 3 && end - back > 0 && (buffer[end - back - 1] & 0xc0) === 0x80) back++
        if (end - back > 0 && (buffer[end - back - 1] & 0xc0) === 0xc0) end -= back + 1
      }
      buffer = buffer.subarray(0, end)
      const next = offset + end < st.size && end > 0 ? offset + end : null
      answer({ kind: 'file', size: st.size, offset, content: binary ? '' : buffer.toString('utf8'), binary, next })
    } finally { closeSync(fd) }
  }
  if (!st.isDirectory()) invalid(`${path} is not a regular file or a folder`)

  // ------------------------------------------------------------ a folder page
  if (flags.offset !== undefined || flags.length !== undefined) invalid(`${path} is a folder: it takes a cursor, not an offset or length`)
  const bytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
  /** The names of a folder in byte order: what is on disk and what is declared there. */
  const names = (folder) => {
    const all = new Set()
    try { for (const n of readdirSync(onDisk(folder))) all.add(n) } catch { /* unreadable on this disk: only what is declared */ }
    const prefix = folder === '/' ? '/' : `${folder}/`
    for (const p of Object.keys(overlay)) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && p.length > prefix.length) all.add(p.slice(prefix.length))
    return [...all].sort(bytes)
  }
  /** Tree order: by parts, each in byte order; a folder before what is in it. */
  const order = (a, b) => {
    const x = a.split('/'), y = b.split('/')
    for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = bytes(x[i], y[i]); if (c) return c }
    return x.length - y.length
  }
  const cursor = typeof flags.cursor === 'string' ? flags.cursor : null
  if (cursor !== null && !under(cursor, path)) invalid('that cursor is not of this folder')
  const budget = Number(target.deadline?.[path]) > 0 ? Number(target.deadline[path]) : Infinity
  const page = []
  let more = false, reason
  const walk = (folder, level) => {
    for (const n of names(folder)) {
      const p = folder === '/' ? `/${n}` : `${folder}/${n}`
      // nothing at or under this entry is after the cursor
      if (cursor !== null && order(p, cursor) <= 0 && !under(cursor, p)) continue
      const after = cursor === null || order(p, cursor) > 0
      let e = null
      if (after) {
        if (page.length >= limit) { more = true; reason = 'limit'; return false }
        if (page.length >= budget) { more = true; reason = 'deadline'; return false }
        e = entry(p, level)
        if (!e) continue
        page.push(e)
      }
      if (level < depth && (e ?? entry(p, level))?.kind === 'folder' && walk(p, level + 1) === false) return false
    }
    return true
  }
  walk(path, 1)
  // `next` is the last entry's path whenever the page has entries, also on the last page; null for an empty first page
  answer({ kind: 'folder', entries: page, next: page.at(-1)?.path ?? (more ? cursor : null), has_more: more, ...(more ? { reason } : {}) })
}
