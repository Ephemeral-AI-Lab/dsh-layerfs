// Init jobs: POST /layerfs/init checks the request, starts the Init and
// answers with its job at once; the page reads the job until it ends.
//   step      scan | volume | import | done | failed
//   scanned   running counts while the source is counted
//   totals    { entries, files, bytes } once counted
//   imported  LayerFS's counts while it imports: { step: scan | files | tree |
//             publish | seal, entries, files, bytes } (see the SDK operator's
//             project.progress); the totals above make them a fraction
//   project   the new project (done); error { code, message } (failed)
// A job is kept for KEEP_MS after it ends, then dropped.
import { randomUUID } from "node:crypto";

const KEEP_MS = 5 * 60_000;

export class InitJobs {
  /** @param {(prepared: object, report: (fields: object) => void) => Promise<object>} start runs one prepared Init */
  constructor(start) {
    this.start = start;
    /** job id -> job */
    this.jobs = new Map();
  }

  /** Names of Inits still running; a new Init does not take them. */
  pending() {
    return new Set([...this.jobs.values()].filter((job) => !job.ended).map((job) => job.name));
  }

  /** Starts a prepared Init; answers its job. */
  begin(prepared) {
    const job = { id: randomUUID(), name: prepared.project.name, source: prepared.project.source, folder: prepared.folder, started: Date.now(), step: "scan", scanned: null, totals: null, imported: null, project: null, error: null, ended: null };
    this.jobs.set(job.id, job);
    const end = (fields) => {
      Object.assign(job, fields, { ended: Date.now() });
      setTimeout(() => this.jobs.delete(job.id), KEEP_MS).unref?.();
    };
    this.start(prepared, (fields) => { if (!job.ended) Object.assign(job, fields) }).then(
      (project) => end({ step: "done", project }),
      (error) => end({ step: "failed", error: { code: error.code || "failed", message: error.message } }),
    );
    return { ...job };
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }
}
