// What a project's Store holds and what made it, for the LayerFS page: the
// Store totals and what Init recorded (backend.store.project.get_storage), and what each
// recent Commit added (branch.list_commits on every Branch, newest first).
// `main` is a line of Layers, so it lists no Commits. A Commit shared by
// forked Branches is listed once. Bytes are LayerFS's integers; the page
// derives its ratios.

const BRANCHES = 50;
const PER_BRANCH = 20;
const KEEP = 60;

/** @param {{ layerfs: object, backend: object }} client a project's client */
export async function storageOf({ layerfs, backend }) {
  const { init = null, ...store } = await backend.store.project.get_storage();
  const listed = await layerfs.project.list_branches(BRANCHES, 0);
  const branches = listed.items.map((b) => b.name).filter((name) => name !== "main");
  const seen = new Set(), commits = [];
  let partial = listed.hasMore;
  for (const branch of branches) {
    const page = await layerfs.branch.list_commits(branch, PER_BRANCH, 0);
    partial ||= page.hasMore;
    for (const c of page.items) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      commits.push({ id: c.id, time: c.time, message: c.message ?? null, via: c.via, logical: c.logical, newCanonical: c.newCanonical, newStored: c.newStored, newMetadata: c.newMetadata });
    }
  }
  commits.sort((a, b) => b.time - a.time);
  return { store, init, commits: commits.slice(0, KEEP), branches: branches.length, partial: partial || commits.length > KEEP };
}
