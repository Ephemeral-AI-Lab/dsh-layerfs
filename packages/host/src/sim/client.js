// The Host's client of a simulated project: the few calls the Host makes
// (Init, the views' state, Files reads and Sandbox management) sent to the simulator's binding directly. The
// SDK in the Host's process keeps the native binding for live projects.
import { LayerFSError } from "@layerfs/sdk";
import { call, operatorCall, snapshotAll } from "./binding.js";

/** The `{ layerfs, operator }` pair clientFor gives, for project `name` under `home`. */
export function simClient(home, name) {
  const send = async (fn, op, args) => {
    const answer = await fn(op, { ...args, project: name, home });
    if (answer.refused) throw new LayerFSError(answer.refused.code, answer.refused.message, answer.refused.detail);
    return answer.value;
  };
  const layerfs = {
    projectName: name,
    project: {
      init: (path) => send(call, "project.init", { path, name }),
      list_branches: (pageSize = 50, pagePos = 0) => send(call, "project.list_branches", { pageSize, pagePos }),
    },
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
  const operator = {
    inspect: { snapshot: async () => ({ kind: "ok", ...(await snapshotAll(home, name)) }) },
    store: {
      stats: async () => {
        const v = await send(operatorCall, "operator.store.stats", {});
        return { ...v, dedupe: v.dedupe === null ? null : Number(v.dedupe), compression: v.compression === null ? null : Number(v.compression) };
      },
    },
    project: { progress: () => send(operatorCall, "operator.project.progress", {}) },
    process: {
      list: () => send(operatorCall, "operator.process.list", {}),
      cancel: (process) => send(operatorCall, "operator.process.cancel", { process }),
    },
  };
  return { layerfs, operator };
}
