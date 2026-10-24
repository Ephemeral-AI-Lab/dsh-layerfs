// The Files pane's reads of saved ids, one SDK call each: a folder page
// (fs.list), a window of a file (fs.read), which Commit wrote each line of a
// window (fs.blame), the paths that changed between two Commits
// (branch.diff_commits) and one file's line diff (fs.diff_files).
// Nothing walks a whole tree: the pane asks only for what is on screen, so a
// read costs the same in a small project and a huge one. Arguments are
// checked here; the SDK's refusals (NoSuchPath, NotDirectory, …) pass through.

/** A page of a folder or of changed paths: the SDK's largest. */
export const PAGE = 1000;

const SAVED = /^[0-9a-f]{64,68}$/;
const bad = (message) => Object.assign(new Error(message), { code: "invalid-input", status: 400 });
const id = (q, name) => {
  const value = q.get(name);
  if (!SAVED.test(value ?? "")) throw bad(`${name} must be a saved Commit or Layer id`);
  return value;
};
const path = (q, name, fallback) => {
  const value = q.get(name) ?? fallback;
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.split("/").includes(".."))
    throw bad(`${name} must be an absolute path`);
  return value;
};
const count = (q, name, min) => {
  const raw = q.get(name),
    value = raw == null ? min : Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw bad(`${name} must be a whole number from ${min}`);
  return value;
};
const refuse = (code, message) => Object.assign(new Error(message), { code, status: 409 });

/** Saved id -> { commit, root, check }: the Commit with the same files
 * (backend.store.project.get_comparable, which keeps what it learns per
 * client). One that is not exact is the Commit a Layer was published from,
 * whose root the diff answer must then show equal (`check`). It refuses
 * NotComparable for a Layer with no such Commit. */
const unlike = () =>
  refuse(
    "NotComparable",
    "LayerFS compares Commits, and this Layer has no Commit with the same files (Init's Layer, or a publish that merged)",
  );
async function asCommit(client, ref) {
  let found;
  try {
    found = await client.backend.store.project.get_comparable(ref);
  } catch (error) {
    if (error?.code === "NotComparable") throw unlike();
    throw error;
  }
  return { commit: found.commit, root: found.root, check: !found.exact };
}

const next = (page, position) => (page.hasMore ? (page.nextPagePos ?? position + page.items.length) : null);

/** kind -> { args(query): checked arguments, run(client, args): the answer } */
export const READS = {
  /** One page of a folder, in the SDK's (byte) order. */
  list: {
    args: (q) => ({ ref: id(q, "ref"), dir: path(q, "dir", "/"), position: count(q, "position", 0) }),
    async run({ layerfs }, a) {
      const page = await layerfs.fs.list(a.ref, a.dir, PAGE, a.position);
      return { items: page.items.map(({ name, path, type }) => ({ name, path, type })), next: next(page, a.position) };
    },
  },
  /** One window of a text file from `line` (at most 2000 lines or 48 KiB); a binary file answers its size. */
  read: {
    args: (q) => ({ ref: id(q, "ref"), path: path(q, "path"), line: count(q, "line", 1) }),
    async run({ layerfs }, a) {
      try {
        const w = await layerfs.fs.read(a.ref, a.path, a.line);
        return {
          text: w.text,
          startLine: w.startLine ?? a.line,
          nextLine: w.nextLine ?? null,
          lineTruncated: !!w.lineTruncated,
          size: w.size ?? null,
        };
      } catch (error) {
        if (error?.code !== "Binary") throw error;
        const stat = await layerfs.fs.stat(a.ref, a.path);
        return { binary: true, size: stat.size ?? null };
      }
    },
  },
  /** Which Commit last changed each line, from `line`: { lines, versions, nextLine }. */
  blame: {
    args: (q) => ({ ref: id(q, "ref"), path: path(q, "path"), line: count(q, "line", 1) }),
    async run({ layerfs }, a) {
      const b = await layerfs.fs.blame(a.ref, a.path, a.line);
      return {
        lines: b.lines.map(({ n, text, lineTruncated, commit, message }) => ({
          n,
          text,
          lineTruncated: !!lineTruncated,
          commit,
          message: message ?? "",
        })),
        versions: b.versions ?? null,
        nextLine: b.nextLine ?? null,
      };
    },
  },
  /** One page of the paths that differ from `from` to `to`, without line hunks.
   * diff_commits takes Commits, so a Layer is compared as its same-tree Commit. */
  changes: {
    args: (q) => ({ from: id(q, "from"), to: id(q, "to"), position: count(q, "position", 0) }),
    async run(client, a) {
      const from = await asCommit(client, a.from),
        to = await asCommit(client, a.to);
      if (from.root === to.root) return { items: [], next: null };
      const page = await client.layerfs.branch.diff_commits(from.commit, to.commit, PAGE, a.position, { hunks: false });
      if ((from.check && page.from?.root !== from.root) || (to.check && page.to?.root !== to.root)) throw unlike();
      return { items: page.items.map(({ path, kind, type }) => ({ path, kind, type })), next: next(page, a.position) };
    },
  },
  /** One file's line diff from `from` to `to`. */
  diff: {
    args: (q) => ({ from: id(q, "from"), to: id(q, "to"), path: path(q, "path") }),
    async run({ layerfs }, a) {
      const d = await layerfs.fs.diff_files(a.from, a.path, a.to, a.path);
      return { kind: d.kind, hunks: d.hunks ?? [], hunksOmitted: !!d.hunksOmitted };
    },
  },
};
