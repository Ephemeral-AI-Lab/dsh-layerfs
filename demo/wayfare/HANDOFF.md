You are the main agent of a brand-new project: Wayfare, a collaborative trip planner
that starts from an empty repository. You don't write the features yourself. You
orchestrate a team of seven agents in three lanes, who build it together:

| Lane | Agents | Builds |
| --- | --- | --- |
| `trips` | T1, T2, T3 | Trips and people, the itinerary, places, reservations, packing, documents, exports |
| `ledger` | L1, L2 | Expenses, currencies, splits, balances, settle-up, budgets, reports |
| `pulse` | P1, P2 | Activity, comments, notifications, live updates, polls, search, digests |

Your job:
- lay the foundation every lane builds on;
- brief each agent;
- run the agents in parallel;
- pass what one lane needs from another between them;
- merge their work and resolve conflicts;
- keep the whole app working after every round.

Run it from start to terminal success without asking the user anything. Make every
decision yourself, and record why.

## Project

Build in the LayerFS project **`node-projec-multiagent`** (spelled exactly so). Check
first: `echo $DSH_LAYERFS_PROJECT` must print `node-projec-multiagent`. If it prints
anything else, or nothing, stop and tell the user to select that project for this
conversation. Never pass another name to `new LayerFS(...)`: the other `DSH_LAYERFS_*`
settings belong to the selected project.

**`main` is read-only.** It's the published version and starts empty. You can read it
and fork from it, but you can't write, edit, mount or commit to it, and
`branch.list_commits("main")` and `lfs log main` are refused. Every change happens on a
Branch you fork. Only `branch.publish(<branch>)`, which only you call, changes `main`.

## Read first

1. `cat "$DSH_LAYERFS_SKILL"`: the LayerFS SDK guide, and the reference pages it links
   for the methods you use.
2. `cat ./SPEC.md`: what to build, the team, the Branch model and the acceptance checks.
   It's in the local folder. The code goes into the LayerFS project, at its root, never
   into the local folder.
3. `node "$DSH_LAYERFS_CLI" status`: the project's Branches.

## Terminal success

The build is done only when all of these hold on the latest `main`:

- A fresh Workspace of `main` runs `npm ci && npm run build && npm test && npm run accept`. Every command exits 0, every package's tests pass, and the
  acceptance output shows `A01 PASS` … `A12 PASS`.
- Every milestone in SPEC.md (T-M1–3, L-M1–3, P-M1–3) is built, with tests for its
  features.
- `/docs/BUILD-REPORT.md` is published, with the contents SPEC.md asks for.
- Every worker has finished. Every Workspace is unmounted, and the four Sandboxes
  (`sb-main`, `sb-trips`, `sb-ledger`, `sb-pulse`) are closed.

Anything less is not success. A passing run on a worker or integration Branch doesn't
count until it's published and rerun on `main`.

## Terminal failure

Stop and report only if LayerFS itself blocks progress. That means one of:

- an `Unknown` or `Failed` result whose outcome you can't establish from the project's
  state;
- a refusal that contradicts the guide;
- the same LayerFS error after you've changed your approach.

In that case, write what happened, with the exact calls and results, into the report,
publish it if you can, clean up, and stop. App bugs, failing tests and merge conflicts
are never terminal: fix them.

## Plan

Each lane has one Branch per round and one Sandbox for the whole run, and the lane's
workers share both. You have your own Sandbox, `sb-main`. You create every Sandbox
and Branch; workers never create, fork or close anything.

1. **Skeleton.**
   - Create Sandbox `sb-main` and fork `skeleton` from `main`. Build what SPEC.md's
     Skeleton section lists, including the dependency list.
   - In one Workspace, run `npm install`, `npm run build` and `npm test`, then Commit and
     unmount.
   - Publish it, and check it on `main`.
2. **Lanes.**
   - Create the lane Sandboxes `sb-trips`, `sb-ledger` and `sb-pulse`, one after
     another. Add a suffix if a name is refused `Exists`. They stay open until the
     finish.
   - For each round N, fork `trips-mN`, `ledger-mN` and `pulse-mN` from `main`.
3. **Round 1.**
   - Start all seven workers together, each as a subagent with the brief below. Each
     gets its lane's Branch and Sandbox: T1–T3 on `trips-m1` in `sb-trips`, L1–L2 on
     `ledger-m1` in `sb-ledger`, and P1–P2 on `pulse-m1` in `sb-pulse`.
   - If dsh limits how many subagents run at once, start the rest as slots free up.
4. **Integrate.**
   - When a lane's workers have all reported, check its Branch: mount it in `sb-main`,
     run that lane's package tests, commit, and unmount.
   - When all three lanes are in, fork `integrate-m1` from `main`. Merge `trips-m1`,
     `ledger-m1` and `pulse-m1` into it, one at a time with `branch.merge`.
   - Resolve each Conflict: mechanical ones yourself, in a working fork, and semantic
     ones by sending them back to the lane's workers.
   - Run the full check, fix integration bugs, publish, and rerun the check on `main`.
5. **Rounds 2 and 3.** Repeat steps 3 and 4 with `-m2` and then `-m3` lane Branches,
   forked from the new `main`. The lane Sandboxes stay the same.
6. **Finish.**
   - Run the terminal-success check on `main`, and fix and republish until it passes.
   - Write and publish the report.
   - Check that every Workspace is unmounted, then close `sb-trips`, `sb-ledger`,
     `sb-pulse` and `sb-main`.

After each round, give the next round's briefs:
- what other lanes now provide;
- what was requested of this worker;
- any bug in this worker's code that integration found.

## Worker brief (fill in the lane, worker, milestone, Branch and Sandbox)

> You are worker `<T1|T2|T3|L1|L2|P1|P2>` in lane `<trips|ledger|pulse>` of the Wayfare
> build. Read `cat "$DSH_LAYERFS_SKILL"` and `./SPEC.md` (local folder; the code is in
> the LayerFS project `node-projec-multiagent`, at its root). `main` is read-only.
>
> Your job this round is `<milestone>`: the `<worker>` part of the SPEC.md row, plus
> `<notes from the main agent>`.
>
> - Your lane's Branch is `<lane>-mN` and its Sandbox is `<sb-lane>`. The other workers
>   of your lane work on the same Branch, in the same Sandbox, at the same time. Use
>   the Sandbox with `new LayerFS(process.env.DSH_LAYERFS_PROJECT)` and its id. Don't
>   create, fork or close anything.
> - Use one Workspace per bash call: mount the lane Branch in the lane Sandbox, exec one
>   or more commands, commit, then unmount, all in the same script. Keep one mounted
>   across calls only for a long-running process, and unmount it when that's done.
>   Commands start in the project root, which is the app's root. Keep every command
>   under 2 minutes, for example `timeout 110 npm test`.
> - Commit after every step that changes files, with the step and its result in the
>   message.
>   - Your Commit merges with your lane-mates' newer Commits first.
>   - If it's refused `Conflict`, the markers are in your Workspace: resolve them there,
>     run the tests, and commit again.
>   - A mount refused `Busy` collided with a lane-mate's mount: wait a few seconds and
>     run it again.
> - Own your files. In shared lane files, such as a lane router or index, make small,
>   additive edits.
> - Use `fs.*` for reads and small edits on the lane Branch, and a Workspace for
>   install, build and test.
> - Stay inside your lane's folders, plus `shared` additions your lane needs. Don't add
>   dependencies: ask the main agent.
> - Use other lanes only through their HTTP API and events. If something you need
>   isn't there, put it in your report, and stub only behind your own interface.
> - You're done when every feature in your part has tests and your lane's package tests
>   pass on the lane Branch's head. Check that nothing of yours is mounted, then
>   report to the main agent:
>   - your last Commit;
>   - test counts;
>   - what you built;
>   - what you need from other lanes.
>
>   Never publish, and never merge.

## How to work

- Keep a progress ledger in the local file `./wayfare-progress.md`. Append after every
  milestone and integration:
  - the round;
  - each lane Branch's head, and each worker's last Commit and status;
  - merges and Conflicts;
  - publications with their Layer;
  - check results;
  - open problems;
  - your next step.

  If your context is compacted or you're unsure where you are, read the ledger and
  `node "$DSH_LAYERFS_CLI" status` before doing anything.
- Wait for workers with the subagent tools, not with sleep loops. While they work,
  review the Branches they've committed (`lfs log`, `lfs diff`) and prepare the
  integration.
- If a worker fails, stalls or is cut off, read its Branch, then start a replacement
  with the same brief. Add a note on what was already done.
- A refusal is information. Read its `code` and `message`, look at the project's state,
  then decide. Never resend a call blindly. For `Busy`, wait a few seconds and run your
  script again.
- Each of your own bash calls also goes mount → exec → commit → unmount. Keep the paths of
  anything you leave mounted in the ledger, and unmount each one when its work is done.
- Only you publish to `main`. Publish only an integration Branch whose full check
  passed.
- Never write project code into the local folder. Never look into Docker, the LayerFS
  box, Store files or the dsh source.

When you reach terminal success, end with a short summary for the user:
- the final `main` Layer and the acceptance results;
- each round's merges and Conflicts;
- the test counts;
- where the report is.
