# Two homes: DSH_HOME and LAYERFS_HOME

Status: implementation specification. §2–§6 are built in dsh-layerfs; §7 lists
what LayerFS itself has to adopt, and §8 the decisions still open.

## 1. The rule

DSH uses LayerFS; it does not contain it. There are two homes, each owned by
one side:

- **`LAYERFS_HOME`** is LayerFS's. It holds everything any LayerFS client needs:
  the records (machines, Stores, buckets), the LayerFS programs, and the secrets
  the records reference. Any client (dsh-layerfs, Connect, the bare CLI) can use
  it, and removing a DSH install never breaks it.
- **`DSH_HOME`** is DSH's. dsh-layerfs keeps only what belongs to this DSH
  install under `$DSH_HOME/layerfs`.

dsh-layerfs changes LayerFS records only through the CLI; it may read them
(the bucket list, §5). The only files it writes into the LayerFS home itself
are in `runtime/`, `secret/`, `job/`, `stat/` and `preset/` (§3–§5), folders whose layout
this spec fixes and LayerFS should adopt (§7). None is named after a client:
any client of the home (dsh-layerfs, Connect, the CLI) uses the same folders.

## 2. Layout

```text
LAYERFS_HOME  (default ~/.layerfs)       LayerFS's
  layerfs.json  layerfs.lock             identity and lock (LayerFS)
  machine/  store/  backup/  trace/  log/   records (LayerFS); trace/calls.jsonl is LayerFS's
                                         own call log (#659), read only through `layerfs logs`
  runtime/<version>-<sha12>/             the LayerFS programs (§3)
    bin/layerfs
    bin/layerfs-daemon                   macOS native machine
    bundle/<platform>/                   Linux bundle: bundle.json, workers, Sandbox image
  secret/                                (0700) files that file: references name (§4)
    bucket-<name>.key
    pg-<store>--<random>.pw  pg-<store>--<machine>--<random>.pw
  job/                                   (0700) storage jobs about this home (§5)
    storage-jobs.json                    push, pull, move, backup and restore jobs
    doctor-jobs.json                     home check reports
  stat/                                  (0700) storage statistics about this home (§5)
    storage-observations/                Store statistics journals
    project-storage/                     per-project storage ledgers (Stats tab)
  preset/                                (0700) Presets state for this home (§5)
    demo-fixtures.json                   ownership manifest: what the preset built here
    demo-steps.ndjson  demo-preset-jobs.json  environment-reset.json  demo-sources/

DSH_HOME                                 DSH's
  sessions/                              normal DSH sessions (stock)
  layerfs/                               dsh-layerfs, this DSH install only
    runtime.json                         the pinned CLI, daemon and bundle (paths into the home's runtime/), and the machine image cache
    sessions.json                        session bindings and placements
    trace/                               (0700) the call log stand-in, while the pinned CLI has no
      calls.jsonl  calls.1.jsonl  calls.lock   `logs` family (docs/specs/layerfs-logs.md §3): LayerFS
                                         #659 lines (0600) for calls made through DSH, rotated at 16 MiB
      outputs/<sha256>.json              (0700/0600) what each call made through DSH printed, in both
                                         modes (docs/specs/layerfs-logs.md §6a): 64 KiB per stream,
                                         at most 2000 files / 64 MiB, cleared by the Logs page's Reset
    agent-bin/layerfs  agent-bin/layerfs.mjs   the managed CLI agent shells run (tags calls, writes stand-in lines)
    project-sessions/projects/<id>/sessions/<sid>/   project conversation logs (§6)
    scratch/  projects/  project-sources/
```

The LayerFS home's folders are owner-only (0700): LayerFS's `doctor` reports
anything else as an error. When dsh-layerfs is the first to create the home
(installing a runtime or saving a key before LayerFS ran), it creates it 0700.
LayerFS adopts a home that already holds `runtime/` and `secret/`, and its
`doctor` does not report them (checked against the 2.0 CLI).

## 3. The runtime lives in the LayerFS home

The runtime is the LayerFS CLI, the daemon behind the macOS `native` machine,
and the Linux bundle the docker and VM machines start workers from.

- **One folder per CLI build:** `runtime/<version>-<first 12 hex of the CLI's
  sha256>/`. Hosts sharing a home can pin different builds; a dirty rebuild of
  the same commit gets its own folder.
- **Install on Change.** Machines → LayerFS runtime → Change (`runtime.save`)
  checks the CLI with discovery, copies the CLI, daemon and bundle into that
  folder (cloned on APFS, through a temporary sibling then renamed), and pins the
  copies in `runtime.json`. Paths already inside the folder are kept as they are.
- **A folder is filled once.** A later install into the same folder must bring
  the same daemon bytes and the same `bundle.json`; a different one is refused
  `InvalidInput` and nothing is replaced, since a running machine may use the
  files. A daemon or bundle not given keeps the folder's.
- **Choosing a runtime.** The pin is, in order: config `cli`/`daemon`/`bundle`,
  then `runtime.json`, then `DSH_LAYERFS_CLI`/`DSH_LAYERFS_DAEMON`, then the
  newest runtime installed in the home (source `home`). So a fresh DSH install
  pointed at an existing home just works.
- **Prepared machine images** are not part of the runtime: LayerFS reads them
  from `$XDG_CACHE_HOME/layerfs/machine-images` when a Lima or Apple Container
  machine is created. The cache home is config `cacheHome`, then `runtime.json`,
  then `DSH_LAYERFS_CACHE_HOME`, else the CLI inherits the host's
  `XDG_CACHE_HOME`; it is passed as `XDG_CACHE_HOME` to every CLI call. It is
  never copied into the home: `XDG_CACHE_HOME` is a per-user cache shared by
  every home (the default Linux bundle, the prepared images, and the Docker
  image locks that keep homes sharing one Docker Engine from importing at the
  same time), so it is not data about one home. A pin should name a stable
  cache (the default `~/.cache`), never a build worktree. `scripts/dev.mjs`
  leaves it unset (it reads nothing from LayerFS Connect):
  a cache without the default bundle makes unpinned Docker and VM machines
  refuse to start.
- **The native machine** records the daemon path the pin names. With installed
  runtimes that path is inside the home.
- Dev servers and tests pin through the environment and do not install.

## 4. Secrets live in the LayerFS home

Keys and passwords typed into the panel are written to owner-only files in the
secrets folder, and LayerFS is given only their `file:` references:

- Folder: config `secrets`, else `DSH_LAYERFS_SECRETS`, else **`<home>/secret`**
  (created 0700; files 0600).
- `bucket-<name>.key` holds `access_key=…` and `secret_key=…`. A bucket records
  the file it was connected with, so Replace keys and Disconnect use that file
  even after the folder setting changes.
- PostgreSQL passwords keep their names (`pg-<store>--<random>.pw`, a new file
  per write). A machine's password counts as "saved by this host" only when it
  is a file in the secrets folder.
- `env:` references and `file:` references to files kept elsewhere still work;
  dsh-layerfs never copies those.
- Secret values never go into URLs, `buckets.json`, the views, logs or LayerFS
  records.

Consequence: a copy of the home carries its secrets. Copying, sharing or backing
up a home is now a sensitive act (§7).

## 5. Storage state lives in the LayerFS home

Everything the Storage page shows about a home comes from that home, so a
second client, or a fresh DSH install, pointed at it sees the same thing, and
switching homes never carries one home's state into another:

- **Buckets** are read from LayerFS's own records, `<home>/backup/<name>/record.json`
  (read only). LayerFS 2.0 has no call that lists connected buckets without
  contacting each one (`backup list` reads every bucket), so the records are the
  list. A bucket another client connected shows up too. Its key is `saved` when
  the record's `file:` reference names a file in the secrets folder, else a
  reference shown as is. There is no `buckets.json`.
- **Jobs and statistics** are in client-neutral folders: `<home>/job/` (job
  tables, home check reports) and `<home>/stat/` (Store statistics, project
  ledgers), 0700, created with the home owner-only if it does not exist yet.
  They are named for what they hold, never for a client, so any service using
  the home reads and writes the same files.
- **Presets state** is in `<home>/preset/`: the ownership manifest names the
  home it built in, so it lives in that home. An earlier build kept it in
  `$DSH_HOME/layerfs/presets/homes/<digest of the home's path>/`; on first start
  that folder is moved into the home and the absolute state path it recorded
  (the manifest's `state`, source paths in the step journal) is rewritten. The
  older flat `$DSH_HOME/layerfs/presets/` files are not consulted. Build and
  Reset act only through LayerFS calls, so `preset/` survives a Reset.
- An earlier build used `<home>/dsh-layerfs/`. On startup its files are moved
  into `job/` and `stat/` (a file already there wins) and the empty folder is
  removed.
- Limit: the job tables are rewritten whole by the host that owns the job, so
  two DSH servers using one home at the same time can drop each other's job
  history (never Stores, projects or backups). One server per home is the
  supported setup.
- Files left under `$DSH_HOME/layerfs` by earlier versions (`buckets.json`,
  `storage-jobs.json`, `doctor-jobs.json`, `storage-observations/`,
  `project-storage/`) belonged to whichever home was in use then; they are no
  longer read.

## 6. dsh-layerfs state under DSH_HOME

- `root` (default `$DSH_HOME/layerfs`) holds the plugin's state for this install:
  the runtime pin, session bindings, scratch and legacy anchors.
- Project conversation logs default to `<root>/project-sessions`
  (`projectSessionHome`, or `DSH_LAYERFS_SESSION_HOME`). They are DSH-format logs
  and belong with DSH. They are not the only copy: each project session is
  mirrored into the LayerFS session store and imported again on a local miss.
- The previous default, `~/.layerfs/dsh`, would now sit inside the LayerFS home
  and is no longer used. Logs already there are not moved automatically; point
  `DSH_LAYERFS_SESSION_HOME` at it, or move it, to keep them.

## 7. What LayerFS has to adopt

dsh-layerfs cannot change LayerFS; these are changes to LayerFS's home design
(`layerfs/core/docs/proposals/host-platform-connections.md` §7.8 and §9):

1. Reserve `runtime/<version>-<sha>/`, `secret/`, `job/`, `stat/` and `preset/` in the home
   layout, with these file formats as the shared contract between clients.
2. Preferably, a call that lists the connected buckets from the home's records
   without contacting them, so clients need not read `backup/*/record.json`.
3. Replace the guarantee "No secret is written to the home" with: secrets may
   live in `<home>/secret/` (0700, files 0600); reset, doctor and copying a home
   treat that folder deliberately.
4. Preferably, a CLI call that installs a runtime into the home, and machine
   records that name a runtime folder instead of an absolute daemon path. That
   also settles O16 (where the Linux bundle comes from). When it exists,
   dsh-layerfs calls it instead of copying files itself.

## 8. Open decisions

- **Presets and the real home.** Build clears and rebuilds the home it runs on.
  Presets now run on the one LayerFS home; on a home with real work that is
  destructive. Either Presets get their own home (sessions and the Storage pages
  would then have to switch homes with them), or Build stays on the one home and
  its confirmation keeps naming that scope. Decided so far: preset state lives
  in the home it describes, `<home>/preset/` (§5, `src/host/presets/state-dir.ts`).
  Moving a server to another home leaves the old home's preset resources
  running until a Reset runs against that home.
- **Moving an existing home.** Not done automatically. A server that used the
  old default `$DSH_HOME/layerfs/home` keeps it by setting `DSH_LAYERFS_HOME` to
  that path; otherwise it starts on `~/.layerfs`. Whether a LayerFS home can be
  moved (its records hold absolute paths, such as the daemon's) is LayerFS's to
  answer.
- **Sharing with Connect.** Connect keeps its own home
  (`~/.layerfs-connect/home-2`). Pointing it at `~/.layerfs` needs matching CLI
  builds per host (which §3 allows) and one agreed native daemon.
