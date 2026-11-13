# Merge rules: `/.lww`

Part of the `dsh-layerfs` skill.

## Treat it as your `.gitignore`

In the normal case `/.lww` is one line:

```
%include .gitignore
```

That makes every `.gitignore` pattern a merge rule. Dependencies, build output, caches
and logs then take the newer version whole instead of conflicting line by line, which
is what you want for files a tool regenerates.

`._*` and `.DS_Store` belong in `.gitignore` too: copy folders from macOS with
`COPYFILE_DISABLE=1 tar`, and check with `find . -name '._*'` before a publish.

**Add more lines only for a file Git tracks that a tool still produces** and that keeps
conflicting: JavaScript lockfiles (`package-lock.json`, `yarn.lock`,
`pnpm-lock.yaml`) and checked-in generated code (`src/generated/`). Never `Cargo.lock`
([Cargo](cargo.md)).

**Never add source files.** Last-writer-wins silently drops the other side's change; a
source conflict should surface so you read both sides and resolve it.

If the project has no `.gitignore` yet, create one first, with the usual entries for its
stack (`node_modules/`, `dist/`, `build/`, `coverage/`, `.cache/`, `*.log` for Node). Do
this in the project's first step, before any parallel work. LayerFS still saves those
files: `/.lww` changes only how they merge, never whether they are saved.

Check it, and set it up with a `file` write when it is missing:

```bash
layerfs file read "$P" "$B" /.lww --text 2>/dev/null || printf '%%include .gitignore\n' | layerfs file write "$P" "$B" /.lww -m "merge rules: generated files by /.gitignore"
```

## Where it applies

LayerFS merges in exactly two places, and `/.lww` applies to both:

| Merge | When it happens | Which `/.lww` is read | "ours" / "theirs" |
| --- | --- | --- | --- |
| **Commit merge** | `workspace commit` (and the session's checkpoint) when the Branch moved since the mount | The one on the Branch's current head | ours = the Workspace, theirs = the head |
| **Branch merge** | `branch merge <project> <name> <a> <b>` | The one on `a` | ours = `a`, theirs = `b` |

Nothing else merges, so nothing else reads it: `file` writes are refused `HeadMoved`
if the Branch moved during the call, and `branch publish` replaces `main`'s view. A
path only one side changed takes that side's change, with or without a rule. A change
to `/.lww` takes effect once it is committed on the Branch the merge reads.

## How a path is decided

For each path both sides changed differently:

1. The **last** matching line decides. A matching `!` line means "no rule".
2. With a rule, the side with the **newer modification time** is kept whole; on a tie,
   ours. A side that deleted the path counts with its nearest surviving parent folder's
   time, so a newer deletion can win.
3. Without a rule, the usual merge runs: text files merge line by line, and overlapping
   changes become marker blocks and a `Conflict` ([conflicts](conflicts.md)).

Every rule decision is reported in the result's `lww` list, on success and inside a
`Conflict`'s `detail`: `{ path, kept: "ours" | "theirs", deleted, rule }`.

## Syntax

The same as `.gitignore`, plus `%include`:

| Pattern | Meaning |
| --- | --- |
| `# text` | A comment |
| `node_modules/` | A name at any depth; a folder match covers everything below it |
| `/dist` or `config/local.json` | Contains a `/`: anchored at the project root |
| `*.log` | `*` matches within one name; `?` matches one character |
| `logs/**/*.txt` | `**` spans folders |
| `!keep.log` | A later matching `!` line means "no rule" for that path |
| `%include .gitignore` | Reads another file in place, by its path from the project root; a missing file is skipped (at most 16 files) |

Only the root `/.lww` is read. A `.gitignore` in a subfolder counts only if you
`%include` it.
