// The Host's client of a simulated project: the few calls the Host makes
// (the views' state, Files reads, storage and Sandbox management) sent to the
// simulator's binding directly, in the shape clientFor gives for a live
// project: { layerfs, backend, state, close }. The Host process's
// @layerfs/agent keeps the real binding for live projects: a process has one
// binding, so a simulated project cannot have an agent client beside them.
import { LayerFSError } from "@layerfs/agent";
import { backendCall, call, snapshotAll } from "./binding.js";

/** The `{ layerfs, backend, state, close }` client of project `name` under `home`. */
export function simClient(home, name) {
  const send = async (fn, op, args) => {
    const answer = await fn(op, { ...args, project: name, home });
    if (answer.refused) throw new LayerFSError(answer.refused.code, answer.refused.message, answer.refused.detail);
    return answer.value;
  };
  const layerfs = {
    projectName: name,
    project: { list_branches: (pageSize = 50, pagePos = 0) => send(call, "project.list_branches", { pageSize, pagePos }) },
    branch: {
      list_commits: (branch, pageSize = 50, pagePos = 0) => send(call, "branch.list_commits", { branch, pageSize, pagePos }),
      diff_commits: (from, to, pageSize = 50, pagePos = 0) => send(call, "branch.diff_commits", { from, to, pageSize, pagePos }),
    },
    fs: {
      list: (ref, path = "/", pageSize = 50, pagePos = 0) => send(call, "fs.list", { branch: ref, path, pageSize, pagePos }),
      read: (ref, path, startLine = 1, endLine) => send(call, "fs.read", { branch: ref, path, startLine, endLine }),
      stat: (ref, path) => send(call, "fs.stat", { branch: ref, path }),
      blame: (ref, path, fromLine = 1) => send(call, "fs.blame", { branch: ref, path, fromLine }),
      diff_files: (leftRef, leftPath, rightRef, rightPath) => send(call, "fs.diff_files", { branch: leftRef, left: { commit: leftRef, path: leftPath }, right: { commit: rightRef, path: rightPath } }),
    },
    workspace: { unmount: (ws, discard = false) => send(call, "workspace.unmount", { sandbox: ws.sandbox, path: ws.path, discard }) },
  };
  const get_history = (since) => send(backendCall, "backend.store.project.get_history", since === undefined ? {} : { since });
  const backend = {
    store: {
      project: {
        get_history,
        get_storage: async () => {
          const v = await send(backendCall, "backend.store.project.get_storage", {});
          return { ...v, dedupe: v.dedupe === null ? null : Number(v.dedupe), compression: v.compression === null ? null : Number(v.compression) };
        },
        get_comparable: (ref) => comparable(get_history, ref),
      },
    },
    daemon: {
      process: {
        list: () => send(backendCall, "backend.daemon.process.list", {}),
        cancel: (process) => send(backendCall, "backend.daemon.process.cancel", { process }),
      },
    },
  };
  return { layerfs, backend, state: async () => ({ kind: "ok", ...(await snapshotAll(home, name)) }), close: async () => {} };
}

/** Imports `source` as the simulated project `name` under `home` (the binding's project.init). */
export async function initSim(home, name, source) {
  const answer = await call("project.init", { project: name, home, name, path: source });
  if (answer.refused) throw new LayerFSError(answer.refused.code, answer.refused.message, answer.refused.detail);
  return answer.value;
}

/** backend.store.project.get_comparable's answer on the simulator: a Commit
 * is itself; a Layer is the listed Commit with its root, else the Commit it
 * was published from when that is not listed (not exact); NotComparable
 * otherwise (Init's Layer, or a publish that merged). */
async function comparable(get_history, ref) {
  const history = await get_history(), commits = history.commits ?? [];
  const commit = commits.find((c) => c.id === ref);
  if (commit) return { commit: commit.id, root: commit.root, exact: true };
  const layer = (history.layers ?? []).find((l) => l.id === ref);
  const same = layer && commits.find((c) => c.root === layer.root);
  if (same) return { commit: same.id, root: layer.root, exact: true };
  if (layer?.sourceCommit && !commits.some((c) => c.id === layer.sourceCommit)) return { commit: layer.sourceCommit, root: layer.root, exact: false };
  throw new LayerFSError("NotComparable", "LayerFS compares Commits, and this Layer has no Commit with the same files (Init's Layer, or a publish that merged)", { ref });
}
