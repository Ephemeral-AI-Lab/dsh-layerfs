# Concurrent writers on a macOS sqlite Store are refused, some as `Unknown` or `Failed NotFound`

Draft for the user to file (not filed). Found 2026-11-13 while preparing Quarry v2.

- **Build:** pinned runtime `2.0.0-814768197b73`, commit `ba87a425` (`layerfs_v2_0_0`).
  The tip (`de1d77e130`, 53 commits later) has no change in this area, and its
  `docs/architecture/engine/store/sqlite.md` still says: on macOS "there is no
  cross-process wait and a second writer gets `Busy`".
- **Host:** macOS (Darwin 25.4), sqlite Store on the `native` machine.

## Symptom

Writes from separate CLI processes to one Store are not queued. In a dsh project
session, the agent's first `file write` landed in the same millisecond as the host's
session-archive save (`branch fork dsh.session.<id>` + `file apply`) and was refused:

```
{"code":"Unknown","message":"Service(History(Busy))","detail":{"index":0}}
```

`Unknown` tells the caller the outcome is uncertain, although the write was refused
before any effect (the file was not there afterwards).

## Repro (private home)

```bash
export LAYERFS_HOME=<private 0700 dir> XDG_CACHE_HOME=<cache with the daemon>
layerfs store create pst && layerfs project init pst/p <src>
for b in c1 c2 c3 c4 c5 c6 c7 c8; do layerfs branch fork pst/p $b main; done
for round in 1 2 3; do
  for b in c1 c2 c3 c4 c5 c6 c7 c8; do (echo x | layerfs file write pst/p $b /f$round.txt -m w) & done; wait
done
```

24 writes on 8 **different** Branches: 12 succeeded. Refusals:

| Count | Refusal |
| ---: | --- |
| 5 | `Failed`: `Os { code: 2, kind: NotFound, message: "No such file or directory" }` |
| 4 | `Failed`: `Store open: Store busy before effect` |
| 1 | `Failed`: `Store Commit at Finish: Storage(Busy)` |
| 2 | `Unknown`: `Service(History(Busy))` |

## Expected

Per the owner decision "one writer, short holds … these locks replace `Busy` failures
under the no-retry rule": a second writer waits its turn (as on Linux with the
directory `flock`), or at least every refusal before effect is `Busy`, never
`Unknown` or `Failed NotFound`.

## Why it matters

A multi-agent dsh run has 13 workers plus the host writing one Store: `file` writes,
Workspace Commits, merges, the session archive. With no cross-process wait on macOS,
refusals grow with concurrency, and `Unknown`/`Failed` cost each agent a check before it
can retry.

## Workarounds in dsh-layerfs (not done; user decision)

1. The skill tells agents which refusals are retry-safe (done: SKILL.md "Rules", file.md
   refusals).
2. A dsh-layerfs writer lock per Store, shared by the host's CLI lanes, the managed
   `agent-bin/layerfs` wrapper and the generated SDK module, would queue writes across
   processes on macOS.

## Rerun on a docker Store (2026-11-13 07:24Z, Quarry v2 preflight)

Store `qv2-store` (sqlite) on the app's `docker` machine (worker `lfs-0c9dc9c9-docker`,
pinned runtime `2.0.0-814768197b73`), project `qv2-store/qv2-probe`, writes from separate
host CLI processes (`echo x | layerfs file write … -m w`, all fired at once per round):

| Run | Writes | OK | Refused |
| --- | ---: | ---: | --- |
| issue repro: 8 Branches × 3 rounds | 24 | 23 | 1 × `Failed`: `Os { code: 2, kind: NotFound, … }` |
| 16 Branches × 5 rounds | 80 | 79 | 1 × the same |
| one Branch (lane model), 12 writers × 3 rounds, different files | 36 | 36 | — |

Result: the docker Store queues writers (Linux `flock`). Of 140 concurrent writes, 2 were refused
(1.4%), never `Busy` or `Unknown`, and each refusal was `Failed NotFound` **before effect**: the
file was absent afterwards (`file stat` → `NoSuchPath`), and the Branch's `commit list` had no
Commit for that round. Each write took 0.07–0.13 s.

Residual: on docker, a concurrent `file write` can still be refused as `Failed` with
`Os { code: 2, kind: NotFound }` with nothing written. The message is misleading (`Failed`
promises an uncertain outcome). Kept as watch-list row W1 for Quarry v2 (rate threshold 5%);
the skill tells agents to look (`file stat` / `commit list`) and then retry.
