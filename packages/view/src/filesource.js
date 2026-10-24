// The Files pane's reads on demand, for an engine whose trees are not in
// memory (a dsh project): a folder's pages, a file's windows, the paths two
// saved ids differ in and one file's diff, each one request (the Host's Files
// reads). Answers come back synchronously when kept: `undefined` value means
// loading, and `onchange` runs when it arrives. Saved ids never change, so an
// answer is kept until KEEP newer ones push it out. A refusal is kept too and
// shown: it is not asked again by itself.

const KEEP = 1000;

/**
 * @param {(kind: string, query: object) => Promise<object>} fetch one Host read
 * @param {() => void} onchange
 */
export function createFilesSource(fetch, onchange) {
  const kept = new Map(),
    wanted = new Map();
  const keyOf = (kind, q) => `${kind}\n${JSON.stringify(q)}`;
  /** { value, error } of one read, started on first use */
  function one(kind, q) {
    const key = keyOf(kind, q);
    let e = kept.get(key);
    if (e) {
      kept.delete(key);
      kept.set(key, e);
      return e;
    }
    e = { value: undefined, error: null };
    kept.set(key, e);
    fetch(kind, q)
      .then(
        (value) => {
          e.value = value;
        },
        (error) => {
          e.error = error;
        },
      )
      .then(() => onchange());
    while (kept.size > KEEP) kept.delete(kept.keys().next().value);
    return e;
  }
  /** The pages asked for so far, joined: { items, more, loading, error } */
  function paged(kind, q) {
    const pages = wanted.get(keyOf(kind, q)) ?? 1,
      items = [];
    let position = 0;
    for (let n = 0; n < pages; n++) {
      const e = one(kind, { ...q, position });
      if (e.error) return { items, more: false, loading: false, error: e.error };
      if (!e.value) return { items, more: false, loading: true, error: null };
      items.push(...e.value.items);
      if (e.value.next == null) return { items, more: false, loading: false, error: null };
      position = e.value.next;
    }
    return { items, more: true, loading: false, error: null };
  }
  const ask = (kind, q) => {
    const key = keyOf(kind, q);
    wanted.set(key, (wanted.get(key) ?? 1) + 1);
  };
  return {
    /** A folder's entries: [{ name, path, type }] in the SDK's order. */
    list: (ref, dir) => paged("list", { ref, dir }),
    moreList: (ref, dir) => ask("list", { ref, dir }),
    /** One window from `line`: { text, startLine, nextLine, size, lineTruncated } or { binary, size }. */
    read: (ref, path, line) => one("read", { ref, path, line }),
    /** Which Commit wrote each line from `line`: { lines: [{ n, text, commit, message }], versions, nextLine }. */
    blame: (ref, path, line) => one("blame", { ref, path, line }),
    /** The paths that differ: [{ path, kind, type }]. */
    changes: (from, to) => paged("changes", { from, to }),
    moreChanges: (from, to) => ask("changes", { from, to }),
    /** One file's line diff: { kind, hunks, hunksOmitted }. */
    diff: (from, to, path) => one("diff", { from, to, path }),
  };
}
