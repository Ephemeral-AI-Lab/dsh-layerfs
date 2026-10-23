// The scripted model's decision for one request, derived from the
// conversation alone: which agent this is (root, or a child known by the
// prompt its parent gave it), how far its steps got, and what it says next.
// Nothing is kept between requests, so a reload, a restart or a second
// viewer changes nothing.
//
// Walking the agent's assistant messages against its steps gives the
// position. A message with a tool call is one call step: an error result
// stops the scenario, otherwise the next step follows. dsh's bash tool does
// not mark a command that exits non-zero, is killed or times out as an error;
// its result ends with a marker line instead ("[exit code: 1]"). A bash
// call's exit must be its step's `exit`, and its trace lines (read from the
// Host through `traceOf`) must show its step's `expect`; the first mismatch
// stops the scenario. Nothing is retried. A text-only message is the reply
// step when one is due and the agent has been woken since its last reply, and
// otherwise what the agent said while it waited to be woken.
//
// The placeholders a step's text holds ({{sandbox}}, {{ws}}, {{commit:<ref>}};
// scenario.js) are filled from the same walk: the last Sandbox number the
// agent saw, the last Workspace it saw, the Commit ids its `commits` steps printed, and the ids the
// messages it received carry where their senders' text names a ref.
import { callCodes, inOrder } from "./expect.js";
import { PLACEHOLDER } from "./scenario.js";

/** A child's id in the subagent tool's result, and in its settled notice; a background job's id. */
const STARTED = /started subagent ([0-9a-f-]{8,})/;
const SETTLED = /subagent ([0-9a-f-]{8,}) (finished|failed before|was stopped before|ran out of room before|declined the task|ended abnormally)/;
const JOB = /background job ([A-Za-z0-9_.:-]+)/;

/** The markers dsh's bash tool appends to a command that did not exit 0. */
const EXIT = /\n\[exit code: ([0-9]+)\]$/;
const CUT = /\n\[killed by signal: [^\]\n]+\]$|\[timed out after [0-9]+ms\]/;
/** A Sandbox number in a result or message. */
const SANDBOX = /"sandbox"\s*:\s*"([^"]+)"/g;
/** A Workspace in a result or message, as `workspace mount` prints it. */
const WS = /"ws"\s*:\s*"([^"]+)"/g;

const textOf = (message) => (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const settledId = (message) => message.role === "user" ? (message.source?.kind === "subagent-settled" ? message.source.senderSessionId : message.source?.childId) ?? textOf(message).match(SETTLED)?.[1] : undefined;

/** Which of the scenario's agents a conversation belongs to. */
export function agentOf(scenario, messages) {
  const first = messages.find((m) => m.role === "user");
  const text = first ? textOf(first) : "";
  for (const [agent, prompt] of scenario.prompts) if (text.includes(prompt)) return agent;
  return "root";
}

/**
 * The next reply for `agent` in `scenario`, from its `messages`:
 *   { kind: "calls", calls: [{ name, args }], say, step }   answer with this tool call
 *   { kind: "text", text }               answer with text, which ends the turn
 *   { kind: "error", message }           the scenario cannot go on
 * Each also carries `done` (this agent's steps finished once it is sent),
 * `of` (its steps), `phase` (the latest `phase` at or before its step) and
 * `children` (the ids of the subagents this agent started so far).
 * @param {{ traceOf?: (callId: string) => object[] | null, checked?: Set<string> }} [live]
 *   `traceOf` gives a bash call's finished trace lines (null without a Host);
 *   `checked` holds the calls whose `expect` already held, so each is read once
 */
export function nextReply(scenario, agent, messages, { traceOf = null, checked = null } = {}) {
  const steps = scenario.agents[agent];
  let index = 0;
  const children = new Map(), contact = new Map(), jobs = new Map();
  const reply = placed(steps, () => index, () => [...children.values()]);
  const results = new Map(), settled = [];
  // what the agent has seen: the last Sandbox number, and Commit ids by ref
  let sandbox = null, ws = null;
  const commits = new Map();
  messages.forEach((m, k) => {
    if (m.role === "tool") results.set(String(m.toolCallId), { text: textOf(m), isError: m.isError === true });
    const id = settledId(m);
    if (id) {
      const summary = m.source?.summary ?? textOf(m).split("\n")[0];
      settled.push({ id: String(id), k, failure: summary.match(SETTLED)?.[2] !== "finished" ? summary : null });
    }
    if (m.role === "assistant") return;
    const text = textOf(m);
    for (const found of text.matchAll(SANDBOX)) sandbox = found[1];
    for (const found of text.matchAll(WS)) ws = found[1];
    if (m.role === "user") {
      for (const { pattern, refs } of scenario.templates ?? []) {
        const found = text.match(pattern);
        if (found) refs.forEach((ref, i) => commits.set(ref, found[i + 1]));
      }
    }
  });

  let replyAt = -1;
  // the children of `until` that have not settled since the agent last
  // contacted them, counting the messages before `before`
  const unsettled = (until, before) => until.filter((child) => {
    const id = children.get(child), since = contact.get(child) ?? -1;
    return !id || !settled.some((s) => s.id === id && s.k > since && s.k < before);
  });
  // a wait whose children all settled already is not said: saying it would end
  // the turn, and no notice would come to wake the agent again
  const skipWait = (before) => {
    const step = steps[index];
    if (step?.kind === "reply" && step.until.length && !unsettled(step.until, before).length) { index++; return true; }
    return false;
  };
  // after a reply the agent is woken by the children of its `until` settling,
  // or else by a message; a text it says before that is a wait, not its next reply
  const woken = (before) => {
    const previous = steps[index - 1];
    if (previous?.kind !== "reply") return true;
    if (previous.until.length) return !unsettled(previous.until, before).length;
    return messages.slice(replyAt + 1, before).some((m) => m.role === "user" && !settledId(m));
  };
  for (const [k, m] of messages.entries()) {
    if (m.role !== "assistant") continue;
    const calls = (m.content ?? []).filter((b) => b.type === "tool-call");
    if (calls.length) skipWait(k);
    if (!calls.length) {
      if (steps[index]?.kind === "reply" && woken(k)) { index++; replyAt = k; }
      continue;
    }
    const step = steps[index];
    if (step?.kind !== "call") return reply({ kind: "error", message: `the conversation has a ${calls[0].name} call where ${step ? `${step.at} is a reply` : `${agent} has no steps left`}` });
    if (calls.length !== 1 || calls[0].name !== step.call.name) {
      return reply({ kind: "error", message: `${step.at} calls ${step.call.name}, but the conversation has ${calls.map((c) => c.name).join(", ")}` });
    }
    const result = results.get(String(calls[0].id));
    if (!result) return reply({ kind: "error", message: `${step.at}: the ${step.call.name} call has no result yet` });
    if (step.call.child) {
      const id = result.text.match(STARTED)?.[1];
      if (id) children.set(step.call.child, id);
      contact.set(step.call.child, k);
    }
    for (const ref of Object.values(step.call.refs ?? {})) if (ref.agent) contact.set(ref.agent, k);
    if (step.call.job) {
      const id = result.text.match(JOB)?.[1];
      if (id) jobs.set(step.call.job, id);
    }
    const failure = result.isError ? `${step.at} failed` : step.call.name === "bash" ? checkBash(step, String(calls[0].id), result.text, { traceOf, checked }) : null;
    if (failure) return reply({ kind: "error", message: `${failure}, so ${agent} stops here: ${result.text.slice(-400)}` });
    if (step.commits) {
      const printed = commitsIn(result.text);
      if (printed.length !== step.commits.length) return reply({ kind: "error", message: `${step.at} names ${step.commits.length} Commit(s) (${step.commits.join(", ")}) and its call printed ${printed.length}, so ${agent} stops here` });
      step.commits.forEach((ref, i) => commits.set(ref, printed[i]));
    }
    index++;
  }

  const failedChild = settled.find((s) => s.failure && [...children.values()].includes(s.id));
  if (failedChild) return reply({ kind: "error", message: failedChild.failure });
  skipWait(messages.length);
  const step = steps[index];
  if (!step) return reply({ kind: "text", text: "Done." });
  // the first step of a later turn waits until the agent is woken
  const previous = steps[index - 1];
  if (previous?.kind === "reply") {
    if (previous.until.length) {
      const waiting = unsettled(previous.until, messages.length);
      if (waiting.length) return reply({ kind: "text", text: `Still waiting for ${waiting.join(" and ")}.` });
    } else if (!woken(messages.length)) {
      return reply({ kind: "text", text: "Waiting for a message." });
    }
  }
  // the step's placeholders, from what the agent has seen
  const missing = [];
  const fill = (text) => text.replace(PLACEHOLDER, (all, what, ref) => {
    const value = what === "sandbox" ? sandbox : what === "ws" ? ws : commits.get(ref);
    if (value == null) missing.push(all);
    return value ?? all;
  });
  if (step.kind === "reply") {
    const text = fill(step.text);
    if (missing.length) return reply({ kind: "error", message: `${step.at}: ${agent} has seen no value for ${missing.join(", ")}` });
    return reply({ kind: "text", text }, 1);
  }

  const args = { ...step.call.args };
  for (const [key, ref] of Object.entries(step.call.refs ?? {})) {
    const id = ref.agent ? children.get(ref.agent) : jobs.get(ref.job);
    if (!id) return reply({ kind: "error", message: `${step.at}: no id for @${ref.agent ?? ref.job} in the results so far` });
    args[key] = id;
  }
  if (step.call.name === "bash") args.command = fill(args.command);
  if (step.call.name === "send_message") args.message = fill(String(args.message));
  if (missing.length) return reply({ kind: "error", message: `${step.at}: ${agent} has seen no value for ${missing.join(", ")}` });
  return reply({ kind: "calls", calls: [{ name: step.call.name, args }], say: step.say, step: step.at });
}

/**
 * Why a finished bash call does not match its step, or null when it does: a
 * killed or timed-out command, trace lines without the step's `expect`, or an
 * exit other than the step's. A background call is checked after the run.
 */
function checkBash(step, callId, text, { traceOf, checked }) {
  if (step.call.args.run_in_background) return null;
  if (CUT.test(text)) return `${step.at} was killed or timed out`;
  if (step.expect && !checked?.has(callId)) {
    const lines = traceOf?.(callId);
    if (!lines) return `${step.at} has expect, and no LayerFS Host gives its trace lines`;
    const codes = callCodes(lines);
    if (!inOrder(codes, step.expect)) return `${step.at} (${step.call.args.description}) expected ${step.expect.join(", ")}; its LayerFS calls show ${codes.length ? codes.join(", ") : "nothing"}`;
    checked?.add(callId);
  }
  const code = Number(text.match(EXIT)?.[1] ?? 0);
  if (code !== step.exit) return `${step.at} exited ${code}, and the step expects ${step.exit}`;
  return null;
}

/**
 * The Commit ids a call printed, in order: the `head` of its JSON lines whose
 * kind is Committed or Merged (the new Commit's id; `commit` is its record).
 */
export function commitsIn(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.includes("\"head\"")) continue;
    let value;
    try { value = JSON.parse(t); } catch { continue; }
    if ((value?.kind === "Committed" || value?.kind === "Merged") && typeof value.head === "string") out.push(value.head);
  }
  return out;
}

/** Adds the agent's position to a reply; `sent` counts the step the reply finishes. */
function placed(steps, index, started) {
  return (value, sent = 0) => {
    const done = Math.min(index() + sent, steps.length);
    let phase = null;
    for (let i = Math.min(index(), steps.length - 1); i >= 0 && !phase; i--) phase = steps[i].phase ?? null;
    return { ...value, done, of: steps.length, phase, children: started() };
  };
}

/** Names of the tools the request offers, including ones added by tool updates. */
export function offeredTools(options) {
  const names = new Set((options.tools ?? []).map((t) => t.name));
  for (const t of options.toolHistory?.tools ?? []) names.add(t.name);
  for (const u of options.toolHistory?.updates ?? []) for (const t of u.additions ?? []) names.add(t.name);
  return names;
}
