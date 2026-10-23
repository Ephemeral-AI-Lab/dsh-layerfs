// Demo stories for the simulation engine (terminal.js Engine).
// term: "history" | "fs" (the active tab's Branch) | a Sandbox terminal alias.
// branch: switch to that Branch's tab first (fs steps and ui "open").
// ui:   "open" (new Sandbox terminal), "split" (new Workspace in the same
//       Sandbox as `from`), "stop" (stop the running process of `term`).
// expect: the outcome code of the step's last SDK call.
(function (global) {
  "use strict";
  const TOUR = [
    { term: "history", lines: ["fork feature-home"], expect: "Forked",
      note: "Fork a Branch from main. A Branch opens as its own tab." },
    { term: "fs", lines: ['edit app/page.tsx "Hello world" "Welcome to LayerFS"'], expect: "Committed",
      note: "The fs terminal writes straight to the Store: each write is a Commit. No mount, no Sandbox." },
    { term: "fs", lines: ["mkdir app/about", "write app/about/page.tsx <<EOF", "export default function Page() {", "  return <main><h1>We're building with LayerFS</h1></main>;", "}", "EOF"], expect: "Committed",
      note: "mkdir and a heredoc write add a new page: two more Commits." },
    { ui: "open", as: "sb1", expect: "Mounted",
      note: "A Sandbox terminal mounts a new Workspace from the Branch head (C3)." },
    { term: "sb1", lines: ["npm ci"], expect: "exit:0",
      note: "Plain shell commands. Each one is sandbox.exec on this Workspace." },
    { term: "sb1", lines: ["npm run build"], expect: "exit:1",
      note: "The build fails lint on the unescaped apostrophe." },
    { term: "sb1", lines: ['sed -i "s/We\'re/We\\&apos;re/" app/about/page.tsx'], expect: "exit:0",
      note: "Fix it inside the Workspace." },
    { term: "sb1", lines: ["npm run build"], expect: "exit:0",
      note: "The build passes." },
    { term: "sb1", lines: ["npm run start &"], expect: "running",
      note: "A trailing & starts a background process." },
    { term: "sb1", lines: ["unmount"], expect: "Busy",
      note: "Unmount is refused while the process runs." },
    { ui: "stop", term: "sb1", expect: "Stopped",
      note: "Stop the process (process.cancel)." },
    { term: "sb1", lines: ["commit"], expect: "Committed",
      note: "Commit saves the Workspace, build output included, as C4. The Workspace now sits on C4." },
    { term: "fs", lines: ['write CHANGELOG.md "- about page"'], expect: "Committed",
      note: "fs still writes while the Branch is mounted. The head moves to C5, so the Workspace on C4 is now stale." },
    { term: "sb1", lines: ['echo "PORT=3000" > .env.example'], expect: "exit:0",
      note: "The stale Workspace keeps working on its own base: it cannot see CHANGELOG.md." },
    { term: "sb1", lines: ["commit"], expect: "Committed",
      note: "Commit merges the stale Workspace with the head: no file changed on both sides, so C6 sits on C5 and keeps the changelog." },
    { ui: "split", from: "sb1", as: "sb2", expect: "Mounted",
      note: "Split: a second Workspace in the same Sandbox, mounted from the current head." },
    { term: "sb2", lines: ['echo "Built with LayerFS" >> README.md'], expect: "exit:0",
      note: "Each Workspace has its own overlay." },
    { term: "sb2", lines: ["commit"], expect: "Committed",
      note: "Another CLI committing also moves the head: now the first Workspace is stale." },
    { term: "sb1", lines: ["unmount"], expect: "Unmounted",
      note: "Nothing uncommitted, so the stale Workspace unmounts cleanly and its terminal closes." },
    { term: "sb2", lines: ["unmount"], expect: "Unmounted",
      note: "The Branch has no mounts left." },
    { term: "history", lines: ["fork header from C4"], expect: "Forked",
      note: "Fork a second Branch from a feature-home Commit: header starts at C4, before the changelog." },
    { term: "fs", lines: ['write app/header.tsx "export const Header = () => <header/>;"'], expect: "Committed",
      note: "Work on header directly through fs." },
    { term: "history", lines: ["publish feature-home"], expect: "Added",
      note: "Publish adds the Branch head to main as a new Layer." },
    { term: "history", lines: ["publish header"], expect: "Added",
      note: "Publish overwrites: main now has exactly header's files, so feature-home's changes leave main (L1 stays in history). Merge first to keep both." },
  ];

  // Commit, commit conflict, merge, merge conflict.
  const DEL = (keep) => `sed -i '/${keep}\\|^<<<<<<<\\|^=======\\|^>>>>>>>/d' app/page.tsx`;
  const MERGE = [
    { term: "history", lines: ["fork feature"], expect: "Forked",
      note: "Fork feature from main." },
    { ui: "open", as: "sb1", expect: "Mounted",
      note: "Mount a Workspace on feature." },
    { term: "sb1", lines: ['sed -i "s/Hello world/Hello from the Workspace/" app/page.tsx'], expect: "exit:0",
      note: "The Workspace edits the page." },
    { term: "fs", lines: ['edit README.md "# Website" "# Website (feature)"'], expect: "Committed",
      note: "Meanwhile fs commits C1 on feature. The Workspace is now stale." },
    { term: "sb1", lines: ["commit"], expect: "Committed",
      note: "Commit: a stale Workspace merges with the head first. Different files changed, so the merge is clean and C2 sits on C1." },
    { term: "fs", lines: ['edit app/page.tsx "Hello from the Workspace" "Hello from fs"'], expect: "Committed",
      note: "fs changes the same line: C3." },
    { term: "sb1", lines: ['sed -i "s/Hello from the Workspace/Hello, Workspace/" app/page.tsx'], expect: "exit:0",
      note: "The Workspace changes that line too, differently." },
    { term: "sb1", lines: ["commit"], expect: "Conflict",
      note: "Commit conflict: rejected, nothing committed, so a script stops here. The merge is written into the Workspace, which now sits on C3." },
    { term: "sb1", lines: ["cat app/page.tsx"], expect: "exit:0",
      note: "The conflicting line carries both versions between markers." },
    { term: "sb1", lines: ["commit"], expect: "Conflict",
      note: "Commit is refused while a marker block remains." },
    { term: "sb1", lines: [DEL("Hello from fs")], expect: "exit:0",
      note: "Fix it: keep the Workspace's line, drop fs's line and the markers." },
    { term: "sb1", lines: ["commit"], expect: "Committed",
      note: "A normal Commit on the head C3." },
    { term: "sb1", lines: ["unmount"], expect: "Unmounted",
      note: "Nothing uncommitted, so unmount closes the terminal." },
    { term: "history", lines: ["fork header"], expect: "Forked",
      note: "A second Branch from main." },
    { term: "fs", lines: ['write app/header.tsx "export const Header = () => <header/>;"'], expect: "Committed",
      note: "header adds a component." },
    { term: "history", lines: ["merge feature header as release"], expect: "Merged",
      note: "Merge: a + b = c. feature and header stay as they are; release is a new Branch whose first Commit holds both." },
    { term: "fs", branch: "header", lines: ['edit app/page.tsx "Hello world" "Hello from header"'], expect: "Committed",
      note: "header changes the page line that feature also changed." },
    { term: "history", lines: ["merge release header as release-2"], expect: "Conflict",
      note: "Merge conflict: refused with the conflicting line from each side; nothing is created. The merge base is header's C5, through release's merge link." },
    { term: "fs", branch: "header", lines: ['edit app/page.tsx "Hello from header" "Hello, Workspace"'], expect: "Committed",
      note: "Make the sides agree: header takes release's title." },
    { term: "history", lines: ["merge release header as release-2"], expect: "Merged",
      note: "Now the merge is clean." },
    { term: "history", lines: ["publish release-2"], expect: "Added",
      note: "Publish: main now has feature's and header's work." },
  ];

  // The two conflict kinds and how each is resolved.
  const CONFLICTS = [
    { term: "history", lines: ["fork feature"], expect: "Forked",
      note: "Conflict 1: a Workspace against its Branch head. Fork feature." },
    { ui: "open", as: "sb1", expect: "Mounted",
      note: "Mount a Workspace on feature's head." },
    { term: "sb1", lines: ['sed -i "s/Hello world/Hello from the Workspace/" app/page.tsx'], expect: "exit:0",
      note: "The Workspace changes the page title." },
    { term: "fs", lines: ['edit app/page.tsx "Hello world" "Hello from fs"'], expect: "Committed",
      note: "fs commits a different title on feature. The head moves, so the Workspace is stale." },
    { term: "sb1", lines: ["commit"], expect: "Conflict",
      note: "Both changed the same line: commit is rejected and nothing is committed. The merge is written into the Workspace, which now sits on the head." },
    { term: "sb1", lines: ["cat app/page.tsx"], expect: "exit:0",
      note: "The conflict is plain file content: both titles between markers." },
    { term: "sb1", lines: [DEL("Hello from fs")], expect: "exit:0",
      note: "Resolve: keep the Workspace's title, delete fs's title and the markers." },
    { term: "sb1", lines: ["commit"], expect: "Committed",
      note: "No markers left: a normal Commit on the head." },
    { term: "sb1", lines: ["unmount"], expect: "Unmounted",
      note: "Done with this Workspace." },
    { term: "history", lines: ["fork header"], expect: "Forked",
      note: "Conflict 2: Branch against Branch. Fork header from main." },
    { term: "fs", lines: ['edit app/page.tsx "Hello world" "Hello from header"'], expect: "Committed",
      note: "header changes the same title." },
    { term: "history", lines: ["merge feature header as release"], expect: "Conflict",
      note: "Both changed the same line: merge is refused, lists the conflict with each side's line, and creates nothing. feature and header are unchanged." },
    { term: "fs", lines: ['edit app/page.tsx "Hello from header" "Hello from the Workspace"'], expect: "Committed",
      note: "Resolve: make the two Branches agree. Here header takes feature's title." },
    { term: "history", lines: ["merge feature header as release"], expect: "Merged",
      note: "Same line on both sides now: the merge is clean and release holds both Branches' work." },
    { term: "history", lines: ["publish release"], expect: "Added",
      note: "Publish release to main." },
  ];

  // Five agents, two feature Branches, a Workspace per Bash tool call.
  // agent: one tool call per line: mount a Workspace in the Branch's shared
  //        Sandbox (a window opens), run, commit, unmount (it closes).
  // burst: calls that run at the same time, [agent, line, { think, run }?];
  //        they overlap and commit in the order they finish (see schedule).
  // milestone, pct, caption: a progress card between Branch segments.
  // on: run the call on another Branch than the agent's own.
  // jump: [who, "agent:<name>" | "tab:<branch>", bubble?] mascot hop before the step.
  // beat: a step worth a caption and a pause; the rest run quickly.
  const ROSTER = {
    lead: { name: "Lead", initial: "L", color: "#d97757", crown: true },
    ava: { name: "Ava", initial: "A", color: "#2f80ed", branch: "checkout" },
    ben: { name: "Ben", initial: "B", color: "#27ae60", branch: "checkout" },
    cy: { name: "Cy", initial: "C", color: "#e0a321", branch: "checkout" },
    dee: { name: "Dee", initial: "D", color: "#e5484d", branch: "search" },
    eli: { name: "Eli", initial: "E", color: "#0fa3a3", branch: "search" },
  };
  const echo = (text, path) => `echo "${text.replace(/"/g, '\\"')}" > ${path}`;
  const navSed = (href, label) => `sed -i "s#<body>{children}</body>#<body><a href=\\"${href}\\">${label}</a>{children}</body>#" app/layout.tsx`;
  const CART = '<a href=\\"/cart\\">Cart</a>', FIND = '<a href=\\"/search\\">Search</a>';
  // When a step's tool calls happen, in demo ms at 1×. Each call thinks (its
  // mascot at the bench), mounts a Workspace (a window opens), types, runs,
  // then commits and unmounts. A burst's calls start together and overlap, so
  // they mount, finish and commit in time order, not list order; one agent's
  // lines run in turn. A call's options { think, run } steer that order.
  const RUN = [[/npm ci/, 2600], [/npm run build/, 2000], [/npm test/, 1300], [/&\s*$/, 700], [/^(cat|ls|curl)/, 450]];
  const runMs = (line) => (RUN.find(([re]) => re.test(line)) || [0, 650])[1];
  const typeMs = (line) => Math.min(1100, 260 + line.length * 6);
  const thinkMs = (who, line) => { let h = 7; for (const c of who + line) h = (h * 31 + c.charCodeAt(0)) % 9973; return 450 + (h % 900); };
  const PHASE = { done: 0, stop: 0, think: 1, mount: 2, exec: 3 };
  function schedule(step) {
    const calls = step.burst || step.lines.map((line) => [step.agent, line]), ev = [];
    let t = 0;
    calls.forEach(([who, line, o = {}], k) => {
      const start = step.burst ? 0 : t, think = o.think ?? thinkMs(who, line);
      ev.push({ t: start, phase: "think", who, line, k });
      if (line.trim() === "stop") { ev.push({ t: start + think, phase: "stop", who, line, k }); t = start + think; return; }
      const mount = start + think, exec = mount + typeMs(line), done = exec + (o.run ?? runMs(line));
      ev.push({ t: mount, phase: "mount", who, line, k, type: exec - mount }, { t: exec, phase: "exec", who, line, k }, { t: done, phase: "done", who, line, k });
      t = done + 200;
    });
    return ev.sort((a, b) => a.t - b.t || PHASE[a.phase] - PHASE[b.phase]);
  }
  // A short caption card between the alternating Branch segments.
  const ms = (branch, pct, caption) => ({ milestone: branch, pct, caption, note: `${branch} ${pct}%: ${caption}`, expect: "ok" });
  const AGENTS = [
    // ---------------------------------------------------------------- Kickoff
    { act: "Kickoff", beat: true, term: "history", lines: ["fork checkout"], expect: "Forked",
      note: "The Lead forks two feature Branches from main. A fork is metadata only: nothing is copied." },
    { term: "history", lines: ["fork search"], expect: "Forked" },
    { beat: true, branch: "checkout", term: "fs", lines: ['write .lww "%include .gitignore"'], expect: "Committed", jump: ["lead", "tab:checkout"],
      note: "The Lead adds .lww: whatever .gitignore names (node_modules, .next) is last-writer-wins instead of a conflict." },
    { branch: "search", term: "fs", lines: ['write .lww "%include .gitignore"'], expect: "Committed", jump: ["lead", "tab:search"] },
    { beat: true, ui: "agents", branch: "checkout", agents: ["ava", "ben", "cy"], expect: "ok",
      note: "Ava, Ben and Cy take checkout. They own no window: every Bash tool call mounts its own Workspace, and its window closes on unmount." },
    { beat: true, ui: "agents", branch: "search", agents: ["dee", "eli"], expect: "ok",
      note: "Dee and Eli take search. One shared Sandbox per Branch, one Store." },
    // ---------------------------------------------------------------- checkout 25%
    { act: "checkout 25%", beat: true, branch: "checkout", agent: "ava", lines: ["npm ci"], expect: "Committed",
      note: "Ava installs dependencies. node_modules is ordinary Workspace state, so it is committed like any file." },
    { beat: true, agent: "ben", lines: ["ls node_modules"], expect: "UpToDate", jump: ["ava", "agent:ben", "node_modules ✓"],
      note: "Ben's next call mounts the new head and node_modules is already there: no restore, no reinstall." },
    { beat: true, expect: "Committed",
      burst: [["ben", "mkdir -p app/cart && " + echo("export default function Cart() { return <main><h1>Cart</h1></main>; }", "app/cart/page.tsx"), { think: 400 }],
        ["cy", "mkdir -p app/api && " + echo("export async function GET() { return Response.json({ items: [] }); }", "app/api/route.ts"), { think: 900 }]],
      note: "Ben and Cy work at the same time from the same head. Ben commits first, so Cy's Workspace is stale: its commit merges with Ben's and lands on top." },
    ms("checkout", 25, "Installed once; cart page and API written side by side."),
    // ---------------------------------------------------------------- search 25%
    { act: "search 25%", beat: true, branch: "search", agent: "dee", lines: ["npm ci"], expect: "Committed",
      note: "On search, Dee installs. Same Store, its own Sandbox." },
    { agent: "eli", lines: ["ls node_modules"], expect: "UpToDate", jump: ["dee", "agent:eli", "node_modules ✓"] },
    { expect: "Committed",
      burst: [["dee", "mkdir -p app/search && echo 'import { index } from \"@/lib/index\"; export default function Search() { return <main><h1>Search</h1></main>; }' > app/search/page.tsx"],
        ["eli", "mkdir -p lib && " + echo("export const index = new Map();", "lib/index.ts")]] },
    ms("search", 25, "Installed; search page and its index started together."),
    // ---------------------------------------------------------------- checkout 50%
    { act: "checkout 50%", beat: true, branch: "checkout", expect: "UpToDate",
      burst: [["ava", "npm test", { think: 300, run: 2400 }], ["ben", "mkdir -p lib && " + echo("export const total = (items) => items.length;", "lib/cart.ts")],
        ["cy", 'sed -i "s/items: \\[\\]/items: await load()/" app/api/route.ts']],
      note: "Three calls at once. Ben's and Cy's quick edits commit while Ava's tests are still running; Ava's run changed nothing, so it is up to date." },
    { agent: "cy", lines: ["cat app/api/route.ts"], expect: "UpToDate" },
    { beat: true, burst: [["ava", "npm run build"], ["cy", "npm run build"]], expect: "Committed",
      note: "Ava and Cy build at the same time and both write .next/. It is in .lww, so the newer write wins and the result reports it: no conflict on build output." },
    { agent: "ben", lines: ["npm test"], expect: "UpToDate" },
    ms("checkout", 50, "Cart logic in; two builds at once, .lww kept the newer output."),
    // ---------------------------------------------------------------- search 50%
    { act: "search 50%", beat: true, branch: "search", expect: "UpToDate",
      burst: [["eli", echo("export const tokenize = (s) => s.toLowerCase().split(' ');", "lib/tokenize.ts")], ["dee", "npm test"]],
      note: "Eli adds a tokenizer while Dee's tests run in a Workspace of its own." },
    { agent: "dee", lines: ["npm run build"], expect: "Committed" },
    { beat: true, agent: "dee", lines: ["npm run dev &"], expect: "running",
      note: "Dee starts a dev server. Its window stays open while the server runs; Dee's next calls open windows of their own." },
    ms("search", 50, "Tokenizer and build in; Dee's dev server keeps running."),
    // ---------------------------------------------------------------- checkout 75%
    { act: "checkout 75%", beat: true, branch: "checkout", expect: "Conflict",
      burst: [["ben", 'sed -i "s/next build/next build --lint/" package.json', { think: 400 }], ["cy", 'sed -i "s/next build/next build --profile/" package.json', { think: 900 }]],
      note: "Ben and Cy change the same line of package.json. Ben commits first. Cy's commit is rejected and nothing is saved, so a script would stop here. The merge, with markers, is written into Cy's Workspace." },
    { beat: true, agent: "cy", lines: ["cat package.json"], expect: "Conflict",
      note: "Cy's next call runs in the kept Workspace, so the markers are right there. Commit stays refused while they remain." },
    { beat: true, agent: "cy", lines: ["sed -i '/--lint\\|^<<<<<<<\\|^=======\\|^>>>>>>>/d' package.json"], expect: "Committed",
      note: "Cy keeps its line and deletes Ben's line and the markers. Now it is a normal Commit on the head." },
    { agent: "ben", lines: ["cat package.json"], expect: "UpToDate" },
    ms("checkout", 75, "One conflict with history, fixed in Cy's kept Workspace."),
    // ---------------------------------------------------------------- search 75%
    { act: "search 75%", beat: true, branch: "search", expect: "Committed",
      burst: [["eli", echo("export const rank = (hits) => hits.sort();", "lib/rank.ts")], ["dee", 'sed -i "s/<h1>Search</<h1>Search the shop</" app/search/page.tsx']],
      note: "The server ran the whole time. Eli and Dee keep committing; the server's Workspace falls behind the head and keeps serving." },
    { beat: true, agent: "dee", lines: ["curl -s http://localhost:3000/search"], expect: "UpToDate",
      note: "curl from a fresh per-call Workspace reaches the server: both run in search's Sandbox, so they share localhost." },
    { beat: true, term: "history", lines: ["fork search-try from search"], expect: "Forked", jump: ["eli", "tab:search-try", "try it"],
      note: "Eli wants to try a risky refactor, so it forks search-try from search's head. Metadata only." },
    { beat: true, branch: "search-try", agent: "eli", on: "search-try", lines: ["rm -r lib && npm test"], expect: "Committed",
      note: "On search-try, Eli deletes lib/ and the tests fail. The call still commits, but only to search-try." },
    { beat: true, branch: "search", agent: "eli", lines: ["npm test"], expect: "UpToDate",
      note: "Eli drops the experiment. search never saw it: the same tests pass there." },
    ms("search", 75, "Ranking in; a risky refactor tried and dropped on search-try."),
    // ---------------------------------------------------------------- checkout 100%
    { act: "checkout 100%", beat: true, branch: "checkout", expect: "Committed",
      burst: [["ava", echo("export const currency = 'EUR';", "lib/currency.ts")], ["ben", 'sed -i "s/<h1>Cart</<h1>Your cart</" app/cart/page.tsx'],
        ["cy", echo("export const tax = 0.2;", "lib/tax.ts")]],
      note: "Three calls at once on checkout. Different files, so every stale commit merges cleanly." },
    { burst: [["cy", 'sed -i "s/0.2/0.21/" lib/tax.ts'], ["ava", echo("# Checkout", "CHECKOUT.md")]], expect: "Committed" },
    { beat: true, burst: [["ben", navSed("/cart", "Cart")], ["ava", "npm run build"]], expect: "Committed",
      note: "Ben adds a Cart link to the shared layout while Ava rebuilds." },
    { burst: [["cy", "npm test"], ["ben", "npm test"], ["ava", "npm test"]], expect: "UpToDate" },
    ms("checkout", 100, "Checkout done: cart, API, tax and a Cart link in the layout."),
    // ---------------------------------------------------------------- search 100%
    { act: "search 100%", beat: true, branch: "search", expect: "Committed",
      burst: [["eli", "sed -i \"s/new Map()/new Map([['cart', 1]])/\" lib/index.ts"], ["dee", echo("export const debounce = 300;", "lib/debounce.ts")]],
      note: "Last stretch on search: two more calls side by side." },
    { burst: [["eli", echo("export const stem = (w) => w.replace(/s$/, '');", "lib/stem.ts")], ["dee", "npm test"]], expect: "UpToDate" },
    { beat: true, burst: [["dee", navSed("/search", "Search")], ["eli", "npm run build"]], expect: "Committed",
      note: "Dee adds a Search link to the same line of the same layout. The two Branches will meet there." },
    { beat: true, agent: "dee", lines: ["stop"], expect: "Unmounted",
      note: "Dee stops the server. Its Workspace unmounts and only its uncommitted dev cache is discarded." },
    ms("search", 100, "Search done: index, ranking, stemming and a Search link on the same layout line."),
    // ---------------------------------------------------------------- Integrate
    { act: "Integrate", beat: true, term: "history", lines: ["merge checkout search as release"], expect: "Conflict",
      note: "The Lead merges the features. Refused: both added a nav link on the same line of app/layout.tsx. Nothing is created and the error shows both lines." },
    { beat: true, branch: "checkout", term: "fs", lines: [`edit app/layout.tsx "${CART}" "${CART}${FIND}"`], expect: "Committed", jump: ["lead", "tab:checkout"],
      note: "To resolve, the Lead makes the two sides agree: the combined nav on checkout…" },
    { branch: "search", term: "fs", lines: [`edit app/layout.tsx "${FIND}" "${CART}${FIND}"`], expect: "Committed", jump: ["lead", "tab:search"],
      note: "…and the same line on search." },
    { beat: true, term: "history", lines: ["merge checkout search as release"], expect: "Merged",
      note: "Clean now: release = checkout + search, both unchanged. .lww decided the build output." },
    { ui: "agents", branch: "release", agents: ["lead"], expect: "ok" },
    { beat: true, agent: "lead", lines: ["npm run build && npm test"], expect: "Committed",
      note: "One per-call Workspace on release: the merged tree builds and its tests pass." },
    { beat: true, term: "history", lines: ["publish release"], expect: "Added", jump: ["lead", "tab:main"],
      note: "Publish: main now has both features." },
    { beat: true, branch: "main", term: "fs", lines: ["blame package.json"], expect: "ok",
      note: "Every call was a Commit. Blame on main credits each line to the Commit and agent that wrote it; hover any node in History for the call." },
  ];

  const STORIES = { agents: { title: "5 agents", steps: AGENTS, roster: ROSTER, speed: 2 }, tour: { title: "Tour", steps: TOUR }, conflicts: { title: "Conflicts", steps: CONFLICTS }, merge: { title: "Commit & merge", steps: MERGE } };
  Object.defineProperty(STORIES, "schedule", { value: schedule });
  if (typeof module !== "undefined" && module.exports) module.exports = STORIES;
  else global.LAYERFS_DEMO = STORIES;
})(this);
