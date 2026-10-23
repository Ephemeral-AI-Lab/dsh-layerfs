// node replay-commit.mjs <branch> <message>...: prints the id of the Branch's
// own Commit (newest first, along first parents, up to the node it was forked
// from) whose message is the first of `message...` it holds; with none of
// them, the node the Branch was forked from. A recorded Commit ref
// "branch#i" of a replayed run (scenarios/shared/replay.sh) lists the
// recorded messages of Commit i and of every one before it, newest first, so a
// Commit this replay does not make names the one before it.
const [branch, ...messages] = process.argv.slice(2);
if (!branch || !messages.length) { console.error("usage: replay-commit.mjs <branch> <message>..."); process.exit(2); }
const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK);
const lf = await LayerFS.open(process.env.DSH_LAYERFS_PROJECT);

/** Every item of a paged call. */
async function all(call) {
  const items = [];
  for (let pos = 0; ;) {
    const page = await call(pos);
    items.push(...page.items);
    if (!page.hasMore) return items;
    pos = page.nextPagePos;
  }
}

/** The ref to print, or null when there is none. */
async function resolve() {
  const b = (await all((pos) => lf.project.list_branches(1000, pos))).find((x) => x.name === branch);
  if (!b) { console.error(`✕ there is no Branch ${branch}`); return null; }
  const listed = await all((pos) => lf.branch.list_commits(branch, 1000, pos));
  const cut = listed.findIndex((c) => c.id === b.forkedFrom);
  const own = cut < 0 ? listed : listed.slice(0, cut);
  for (const [k, message] of messages.entries()) {
    const c = own.find((x) => x.message === message);
    if (!c) continue;
    if (k) console.error(`(${branch}'s recorded Commit "${messages[0]}" is not made by this replay: the one ${k} before it)`);
    return c.id;
  }
  if (!b.forkedFrom) { console.error(`✕ ${branch} has none of the recorded Commits, and no fork point`); return null; }
  console.error(`(${branch} has none of the recorded Commits up to "${messages[0]}" in this replay: its fork point)`);
  return b.forkedFrom;
}

try {
  const ref = await resolve();
  if (ref) console.log(ref);
  else process.exitCode = 1;
} finally {
  await lf.close();
}
