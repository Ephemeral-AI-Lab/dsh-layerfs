// How far each scenario's latest run on each backend got, from the replies
// the adapter sends. The client records a run's root Session with the
// scenario and backend it plays (routes.js, POST …/session) before sending
// its first message; that root's first request starts the run, and its
// subagents add their own steps. One run per scenario and backend is kept:
//   { sessionId, state: running | passed | failed, done, of, phase, error, started, ended }
// A run fails on a scenario error or when one of its requests is aborted;
// it passes when the root agent sends its last step. `done` and `of` sum
// every agent's finished and total steps. The runs are written whole to
// <stateDir>/runs.json when one starts or ends, so they outlive a dsh web
// restart; a run still running at a restart reads as failed (interrupted).
// A run has LIMIT_MS (15 minutes, owner 2026-10-23) from its start: past it,
// the run fails as `timedOut` at its next read or request, the adapter answers
// no further step, and the client cancels its root Session once.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BACKENDS = ["mocked", "real"];
export const LIMIT_MS = 15 * 60 * 1000;

export class Progress {
  /**
   * @param {Map<string, object>} scenarios compiled scenarios by model id
   * @param {string | null} stateDir where runs.json is kept; null keeps nothing on disk
   */
  constructor(scenarios, stateDir = null, now = Date.now) {
    this.now = now;
    this.scenarios = scenarios;
    this.file = stateDir ? join(stateDir, "runs.json") : null;
    this.stateDir = stateDir;
    const saved = this.read();
    /** root Session id -> { scenario, backend } */
    this.sessions = new Map(Object.entries(saved.sessions ?? {}));
    /** subagent Session id -> its run's root Session id; learned from the replies, kept in memory */
    this.children = new Map();
    /** "<scenario>:<backend>" -> run, with each agent's counts in `agents` */
    this.runs = new Map();
    for (const [key, run] of Object.entries(saved.runs ?? {})) {
      this.runs.set(key, run.state === "running" ? { ...run, state: "failed", error: "interrupted: dsh web restarted", ended: run.ended ?? run.started } : run);
    }
  }

  read() {
    if (!this.file) return {};
    try { return JSON.parse(readFileSync(this.file, "utf8")); } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  write() {
    if (!this.file) return;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ sessions: Object.fromEntries(this.sessions), runs: Object.fromEntries(this.runs) }, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** Fails `run` when it outlived LIMIT_MS; true when it did (now or before). */
  expire(run) {
    if (run?.state === "running" && this.now() - run.started > LIMIT_MS) {
      Object.assign(run, { state: "failed", error: `over the ${LIMIT_MS / 60000}-minute limit`, timedOut: true, ended: run.started + LIMIT_MS });
      this.write();
    }
    return run?.timedOut === true;
  }

  /** The client made `sessionId` the root of a new run of `scenario` on `backend`. */
  register(scenario, backend, sessionId) {
    if (!this.scenarios.has(scenario)) throw Object.assign(new Error(`no scenario named ${scenario}`), { status: 404 });
    if (!BACKENDS.includes(backend)) throw Object.assign(new Error(`backend is one of ${BACKENDS.join(", ")}`), { status: 400 });
    this.sessions.set(sessionId, { scenario, backend });
    const steps = Object.entries(this.scenarios.get(scenario).agents);
    this.runs.set(`${scenario}:${backend}`, {
      sessionId, state: "running", agents: Object.fromEntries(steps.map(([name, list]) => [name, { done: 0, of: list.length }])),
      phase: null, error: null, timedOut: false, started: this.now(), ended: null,
    });
    this.write();
  }

  /** The root Session of `sessionId`: itself, or the root of the run that started it as a subagent. */
  rootOf(sessionId) {
    return this.children.get(sessionId) ?? sessionId;
  }

  /** The run the root Session `rootId` plays, or null. */
  runOf(rootId) {
    const at = this.sessions.get(rootId);
    if (!at) return null;
    const run = this.runs.get(`${at.scenario}:${at.backend}`);
    return run?.sessionId === rootId ? run : null;
  }

  /**
   * Records the reply about to be sent to `agent` of `scenario`, asked for by
   * Session `sessionId` (a run's root, or one of its subagents).
   * @param {string} scenario model id
   * @param {string} agent the scenario's agent name
   * @param {{ kind: string, done: number, of: number, phase: string | null, children: string[], message?: string }} reply from nextReply
   * @param {string | undefined} sessionId the requesting agent's Session
   */
  report(scenario, agent, reply, sessionId) {
    const rootId = this.rootOf(sessionId), run = this.runOf(rootId);
    if (!run || run.state !== "running" || this.sessions.get(rootId).scenario !== scenario) return;
    // the subagents this agent started belong to the same run
    for (const child of reply.children ?? []) this.children.set(child, rootId);
    run.agents[agent] = { done: reply.done, of: reply.of };
    if (agent === "root" && reply.phase) run.phase = reply.phase;
    if (reply.kind === "error") { Object.assign(run, { state: "failed", error: `${agent}: ${reply.message}`, ended: this.now() }); this.write(); }
    else if (agent === "root" && reply.done === reply.of) { Object.assign(run, { state: "passed", ended: this.now() }); this.write(); }
  }

  /** The user stopped the run (Stop on the Run bar or the Scenarios tab): it fails, and its agents get no further step. */
  halt(sessionId) {
    const run = this.runOf(this.rootOf(sessionId));
    if (!run) throw Object.assign(new Error("this Session is no run's root"), { status: 404 });
    if (run.state === "running") {
      Object.assign(run, { state: "failed", error: "stopped", ended: this.now() });
      this.write();
    }
    return run;
  }

  /**
   * Why a request of `sessionId` gets no step, or null when it may go on: its
   * run was stopped or failed, ran out of time, or a newer run of the same
   * scenario and backend replaced it. Sessions of no run go on.
   */
  refusal(sessionId) {
    const root = this.rootOf(sessionId);
    if (!this.sessions.has(root)) return null;
    const run = this.runOf(root);
    if (!run) return "a newer run of this scenario replaced this one";
    if (this.expire(run)) return `the run is over its ${LIMIT_MS / 60000}-minute limit`;
    return run.state === "failed" ? `the run ended: ${run.error}` : null;
  }

  /** A request of the run was aborted (the user stopped the agents): the run fails. */
  stop(sessionId, agent) {
    const run = this.runOf(this.rootOf(sessionId));
    if (run?.state === "running") {
      Object.assign(run, { state: "failed", error: `stopped while ${agent} worked`, ended: this.now() });
      this.write();
    }
  }

  /** The latest run of `scenario` on `backend` with its summed counts, or null before any run. */
  get(scenario, backend) {
    const run = this.runs.get(`${scenario}:${backend}`);
    if (!run) return null;
    this.expire(run);
    const agents = Object.values(run.agents);
    const { agents: _, ...rest } = run;
    return { ...rest, done: agents.reduce((n, a) => n + a.done, 0), of: agents.reduce((n, a) => n + a.of, 0) };
  }

  /** What a root Session plays, or null: the Run bar shows only on these. */
  sessionOf(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }
}
