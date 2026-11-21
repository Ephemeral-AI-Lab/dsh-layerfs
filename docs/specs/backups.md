# Backups: buckets, files and Stores

Status: implementation specification for the Storage page's backups. The
LayerFS facts come from the LayerFS 2.0 backup family
(`layerfs/docs/architecture/api/sdk/backup/`, `docs/general/backups-minio-r2.md`).

## 1. What LayerFS has

```text
 bucket  (r2:// or MinIO http(s)://, a bucket and a prefix; recorded by name in <home>/backup/<name>/record.json)
   file  <prefix>/<file>/store.sqlite   one whole SQLite Store: every project, branch, commit and file
 Store   record field backups.<bucket> = { file, heads, last: { op, at, bytes, sha256 } }
```

- **A link is one Store's pointer to one file in one bucket.** It is written
  only by moving bytes: `backup create` (Store → file) or `backup restore`
  (file → Store). There is no call that links without a transfer, and
  `backup disconnect` drops every link to the bucket (objects stay).
- **One link per bucket per Store.** A Store can be linked to one file in
  each connected bucket, so the same Store can have copies in R2 and MinIO.
- **A file can be linked by several Stores of one home.** Restoring a file
  under a new name makes a second Store carrying the same binding and a link
  to the same file; `backup list` then shows the file once per linked Store.
- **Writes are guarded, not locked.** `create` refuses `Conflict` when the
  object is not the copy this Store's link last moved, and `Exists` when
  another home wrote it. `restore` over an existing Store needs that Store's
  binding. Two homes writing one file at the same moment are not serialized
  (last writer wins); LayerFS's advice is one file per home.
- **Contents are read only by restoring.** No call reads a backup's projects
  without downloading it. A listing gives the file's size, time, heads and,
  per linked Store, a state (`current`, `store_changed`, `bucket_changed`,
  `both_changed`, `unknown`, `unlinked`, `missing`).
- A PostgreSQL Store is never backed up here (PostgreSQL's own tools).

## 2. Cardinality

| Relation | LayerFS allows | The panel treats it as |
| --- | --- | --- |
| Store → buckets | many (one link per bucket) | normal: back a Store up to R2 and MinIO |
| Store → files in one bucket | one | normal: Back up now rewrites the linked file |
| file → Stores of this home | many (same binding, after a restore under a new name) | allowed, shown, not offered as a goal |
| file → homes | many readers; one writer at a time by convention | not managed: one file per home |

**Recommendation: one file ↔ one Store per bucket, and one Store ↔ many
buckets.** A file is one Store's history. Linking a file to several Stores
makes them race for it: after either one backs up, every other linked Store
is `bucket_changed`, and its next backup is refused `Conflict`. Many files
merged into one Store does not exist: a restore replaces a Store's file
whole. So the panel:

- never offers "link a file to a Store" as a separate action: links come from
  Back up (Store → file, the file named after the Store unless one is chosen)
  and Restore (as a new Store, or over the Store whose binding it carries);
- shows every linked Store when LayerFS reports several, each with its own
  state, so a shared file is visible and its conflicts explainable;
- on a Store, lists one row per bucket (its links), so a second copy goes to a
  second bucket, not to a second file in the same bucket.

## 3. The Storage page

- **Home › Stores › SQLite › Buckets (`BucketCards`).** The SQLite board's
  second view (with a provider switch when several providers are connected):
  one card per bucket with its provider mark (Cloudflare R2, MinIO, other),
  file count, size, list time, up to five file rows (linked Stores first, then
  unlinked files with Restore…), and Open bucket. Opening a bucket opens
  `bucket:<bucket>`; opening a file from the Bucket page opens
  `backup:<bucket>/<file>`.
- **Store cards, Store page and Backups dialogs.** Each SQLite Store card
  shows a muted **No backup** button when unlinked, or its provider marks,
  backup count and worst-state dot (which opens the **Backups of *store***
  dialog with its provider-grouped copies and health bar). A Store's
  **Overview** shows **Last backup** and Health's **Backups** row; its
  **Backups** tab lists one destination card per linked bucket with state pill,
  last saved, size, provider, **Back up now** and **Restore…**.
- **Bucket page (`bucket:<bucket>`).** Its facts and actions (**Test
  connection**, **List** / **List again**, ⋯ **Disconnect**), status line
  (with **Connect again…** when the key was refused), then its files grouped
  into *Bound to a Store in this home* and *Not in this home*, with linked
  Store, state chip, size, written, and **Back up now** / **Restore…**.
- **File page (`backup:<bucket>/<file>`).** The object path, provider, bucket,
  size and time; *Inside*: a whole SQLite Store, and its projects when a linked
  Store's copy is still its own (`current`: the same projects; `store_changed`:
  the Store's projects now, the backup may hold fewer or older ones);
  `bucket_changed` says the file was rewritten elsewhere; an unlinked file says
  LayerFS reads it only by restoring, with Restore as a new Store. Then the
  linked Stores, each with its state, its last backup or restore, and Back up
  now / Restore.
- **Tones (optional backups).** Backups are optional: no backup,
  `store_changed`, `bucket_changed`, `unlinked`, `unknown` and unlisted copies
  are neutral (muted text or grey dots, never amber warnings, and never counted
  or sorted un-backed-up first). `current` is green; only real failures
  (`missing` and `both_changed`) are red.

## 4. What LayerFS could add

- A call that reads a backup's metadata and project list without a full
  download (the object metadata already records heads, binding and the home
  that wrote it), so an unlinked file's contents can be shown.
- The writer (`layerfs-exported-from`: home id and machine) in `backup list`,
  so the panel can say who wrote an unlinked file.
