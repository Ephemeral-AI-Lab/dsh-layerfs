// The "layerfs-mock" provider: the LayerFS scripted model, one model per
// scenario ("LayerFS scripted model · <title>"), picked like any other model.
// Its answers are the scenario's steps; dsh's own agent loop and tools run
// every call. A subagent starts on its parent's model, so children get the
// same scenario and answer as the agent their prompt names. Replies come at
// once: there is no typing effect and no pause. Each bash call's trace lines
// come from the LayerFS Host's layerfsTraces service, for the live expect
// check (plan.js).
import { randomUUID } from "node:crypto";
import { agentOf, nextReply, offeredTools } from "./plan.js";
import { windowsCall } from "./windows-shell.js";

export const PROVIDER = "layerfs-mock";
export const LABEL = "LayerFS scripted model";

/**
 * @param {typeof import("@deepseek-ai/dsh-llm").LlmAdapter} Base dsh's adapter class
 * @param {Map<string, object>} scenarios compiled scenarios by model id
 * @param {import("./progress.js").Progress} [progress] where each reply's position is reported
 * @param {() => { callLines(sessionId: string, callId: string): object[] } | undefined} [traces] the Host's layerfsTraces service, while it runs
 */
export function createAdapter(Base, scenarios, progress, traces = () => undefined, scripts = null) {
  /** Session id -> the bash calls whose expect already held. */
  const checked = new Map();
  class LayerFsScriptedAdapter extends Base {
    providerInfo(provider) {
      return { id: provider, name: LABEL };
    }

    listModels(provider) {
      return Promise.resolve([...scenarios.values()].map((s) => model(provider, s)));
    }

    resolveModel(provider, id) {
      const scenario = scenarios.get(id);
      return Promise.resolve(
        scenario
          ? model(provider, scenario)
          : { provider, id, name: `${LABEL} · ${id} (no such scenario)`, inputModalities: ["text"] },
      );
    }

    async *stream(options) {
      const { signal } = options;
      let scenario, agent;
      try {
        scenario = scenarios.get(options.model);
        if (!scenario)
          return yield failure(
            `no scenario named ${options.model}; scenarios: ${[...scenarios.keys()].join(", ") || "none"}`,
            "MOCK_NO_SCENARIO",
          );
        const offered = offeredTools(options);
        // dsh's own requests without tools (a session title): the scenario's title
        if (!offered.size) return yield* text(scenario.title);
        agent = agentOf(scenario, options.messages ?? []);
        const ended = progress?.refusal(options.sessionId);
        if (ended)
          return yield failure(
            `${LABEL} (${scenario.name}, ${agent}): ${ended}`,
            ended.includes("limit") ? "MOCK_TIME_LIMIT" : "MOCK_RUN_ENDED",
          );
        const service = traces(),
          sessionId = String(options.sessionId);
        if (!checked.has(sessionId)) checked.set(sessionId, new Set());
        const live = {
          traceOf: service ? (callId) => service.callLines(sessionId, callId) : null,
          checked: checked.get(sessionId),
        };
        const reply = nextReply(scenario, agent, options.messages ?? [], live);
        progress?.report(scenario.name, agent, reply, options.sessionId);
        if (reply.kind === "error")
          return yield failure(`${LABEL} (${scenario.name}, ${agent}): ${reply.message}`, "MOCK_SCENARIO_STOPPED");
        const childFailure = progress?.refusal(options.sessionId);
        if (childFailure)
          return yield failure(`${LABEL} (${scenario.name}, ${agent}): ${childFailure}`, "MOCK_RUN_ENDED");
        if (reply.kind === "text") return yield* text(reply.text);
        const missing = reply.calls.map((c) => c.name).filter((n) => !offered.has(n));
        if (missing.length) {
          const message = `${reply.step} calls ${missing.join(", ")}, which this agent's preset does not offer`;
          progress?.fail(options.sessionId, agent, message);
          return yield failure(`${LABEL} (${scenario.name}, ${agent}): ${message}`, "MOCK_TOOL_NOT_OFFERED");
        }
        let index = 0;
        if (reply.say) yield* block(index++, reply.say);
        for (const original of reply.calls) {
          const call = scripts ? windowsCall(original, scripts) : original;
          yield { type: "block-start", index, blockType: "tool-call" };
          yield {
            type: "block-end",
            index,
            block: {
              type: "tool-call",
              id: `lfsmock_${randomUUID()}`,
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          };
          index++;
        }
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } catch (error) {
        if (signal?.aborted) {
          if (scenario && agent) progress?.stop(options.sessionId, agent);
          return yield {
            type: "finish",
            reason: { kind: "aborted", failure: { message: "scripted request aborted", code: "ABORTED" } },
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        progress?.fail(options.sessionId, agent ?? "root", message);
        yield failure(message, "MOCK_FAILED");
      }
    }
  }
  return new LayerFsScriptedAdapter();
}

const model = (provider, scenario) => ({
  provider,
  id: scenario.name,
  name: `${LABEL} · ${scenario.title}`,
  description: `Scripted, not a language model. ${scenario.blurb}`.trim(),
  inputModalities: ["text"],
});

const failure = (message, code) => ({ type: "finish", reason: { kind: "error", failure: { message, code } } });

function* text(value) {
  yield* block(0, value);
  yield { type: "finish", reason: { kind: "stop" } };
}

/** One text block, sent whole. */
function* block(index, value) {
  yield { type: "block-start", index, blockType: "text" };
  yield { type: "text-delta", index, text: value };
  yield { type: "block-end", index, block: { type: "text", text: value } };
}
