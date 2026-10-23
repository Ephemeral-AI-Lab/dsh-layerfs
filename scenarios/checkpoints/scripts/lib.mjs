// The checkpoints demo (#352): a small history replay in four ranges. In each
// range two agents write on lanes of their own; the lead merges the lanes,
// publishes and verifies main, and the range ends at a checkpoint.
const { LayerFS, isRefusal } = await import(process.env.DSH_LAYERFS_SDK);
const lf = await LayerFS.open(process.env.DSH_LAYERFS_PROJECT);
const show = (what, value) => console.log(`${what} → ${value.kind}`);
// One attempt: LayerFS queues concurrent writers itself, so a call is never retried here.
const settle = (call) => call();
const lane = (range, agent) => `r${range}-${agent}`;
/** Closes the client; every run command ends with it. */
export const done = () => lf.close();

/** An agent's work in a range: fork its lane from main, make the lane's folder and write two files with fs. */
export async function work(agent, range) {
  const branch = lane(range, agent), folder = `/${branch}`;
  show(`fork ${branch}`, await settle(() => lf.branch.fork(branch)));
  // each lane writes a folder of its own, so the lanes merge cleanly
  show(`mkdir ${folder}`, await settle(() => lf.fs.mkdir(branch, folder, `r${range} ${agent} folder`)));
  for (let i = 1; i <= 2; i++) {
    const path = `${folder}/change-${i}.ts`;
    show(`write ${path}`, await settle(() => lf.fs.write(branch, path, `// range ${range}, ${agent}, change ${i}\nexport const r${range}${agent}${i} = ${range * 10 + i};\n`, `r${range} ${agent} change ${i}`)));
  }
}

/** The lead's consolidation: merge the two lanes into the range's Branch and publish it. */
export async function consolidate(range) {
  show(`merge lanes into r${range}`, await settle(() => lf.branch.merge(lane(range, "a01"), lane(range, "a02"), `r${range}`, `range ${range}`)));
  show(`publish r${range}`, await settle(() => lf.branch.publish(`r${range}`)));
}

/** The checkpoint check: main holds every file the ranges so far wrote. */
export async function verify(range) {
  let found = 0;
  for (let r = 1; r <= range; r++) for (const agent of ["a01", "a02"]) found += (await lf.fs.list("main", `/${lane(r, agent)}`)).items.length;
  const want = range * 4;
  console.log(`checkpoint r${range}: main has ${found} of ${want} files the ranges wrote`);
  if (found !== want) { console.log("checkpoint failed"); process.exitCode = 1; }
}

/**
 * What a run that starts after checkpoint `range` restores first. Here it
 * rebuilds ranges 1..range at once, standing in for #352's Store snapshot
 * restore, which brings the project back in one step without replaying them.
 */
export async function restore(range) {
  for (let r = 1; r <= range; r++) {
    for (const agent of ["a01", "a02"]) await work(agent, r);
    await consolidate(r);
  }
  console.log(`restored: main as it was at the end of range ${range}`);
}
