// The unmount journal: one JSON line per normal unmount that took LayerFS's
// abort path, under the state folder (`<stateDir>/unmounts.jsonl`), so its
// outcome outlives the temporary trace files and the Host. This is the
// Interface Adapter behind the use case's port
// (packages/model/src/unmount-count.js); the Entities value it stores is
// packages/model/src/unmount.js. Append-only; a torn last line is skipped
// when read, as the trace-line journal (collector.js) does.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class UnmountJournal {
  /** @param {string} stateDir the Host's state folder (config.js: stateDir) */
  constructor(stateDir) {
    this.file = join(stateDir, "unmounts.jsonl");
  }

  /** Appends one record; a failed write is thrown to the caller that records it. */
  append(record) {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  /** The records of one project, oldest first; other projects' and a torn last line are skipped. */
  records(project) {
    if (!existsSync(this.file)) return [];
    const out = [];
    for (const raw of readFileSync(this.file, "utf8").split("\n")) {
      if (!raw) continue;
      let record;
      try { record = JSON.parse(raw); } catch { continue; } // a torn last line
      if (record && record.project === project) out.push(record);
    }
    return out;
  }
}
