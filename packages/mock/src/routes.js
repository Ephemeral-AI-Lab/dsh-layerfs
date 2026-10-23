// The /layerfs-mock route on the Host's web server, behind ctx.connection's
// checks like /layerfs. It exists only while the plugin is on, so the client
// shows the Scenarios tab and the Run bar only then (a 404 hides them):
//   GET  /layerfs-mock                      the Scenarios workspace folder, the
//                                           preset, provider and first message,
//                                           and each scenario with its backends,
//                                           fixture and latest run on each backend
//   GET  /layerfs-mock/session/<sessionId>  what that root Session plays, with
//                                           its run: { scenario, backend, run }
//   POST /layerfs-mock/session/<sessionId>/stop   stops that root Session's
//                                           run: it fails, and its agents get
//                                           no further step
//   POST /layerfs-mock/<id>/session {backend, sessionId}   a new run's root
//                                           Session, recorded before its first
//                                           message (progress.js)
import { BACKENDS } from "./progress.js";

const PREFIX = "/layerfs-mock";
const MAX_BODY = 4 * 1024;

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY) throw Object.assign(new Error("request body too large"), { status: 413 });
  }
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error("request body is not JSON"), { status: 400 }); }
}

/**
 * Registers the route; its disposer runs with the plugin fiber.
 * @param {object} ctx plugin context with webServer and connection
 * @param {{ scenarios: Map<string, object>, progress: import("./progress.js").Progress, workspace: string, preset: string, provider: string, prompt: string }} options
 */
export function registerRoutes(ctx, { scenarios, progress, workspace, preset, provider, prompt }) {
  const view = (id, s) => ({
    id, title: s.title, blurb: s.blurb || null, agents: Object.keys(s.agents), layerfs: s.layerfs, fixture: s.fixture,
    runs: Object.fromEntries(BACKENDS.map((b) => [b, progress.get(id, b)])),
  });
  const handler = async (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return; }
    const url = new URL(String(req.url), "http://localhost"), parts = url.pathname.slice(PREFIX.length).split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (req.method === "GET" && parts.length === 0) {
        return send(res, 200, { workspace, preset, provider, prompt, scenarios: [...scenarios].map(([id, s]) => view(id, s)) });
      }
      if (req.method === "GET" && parts[0] === "session" && parts.length === 2) {
        const at = progress.sessionOf(parts[1]);
        if (!at) return send(res, 404, { code: "not-found", message: "this Session plays no scenario" });
        return send(res, 200, { ...at, run: progress.get(at.scenario, at.backend) });
      }
      if (req.method === "POST" && parts[0] === "session" && parts[2] === "stop" && parts.length === 3) {
        const run = progress.halt(parts[1]);
        return send(res, 200, { state: run.state, error: run.error });
      }
      const id = parts[0] ?? "", scenario = scenarios.get(id);
      if (!scenario) return send(res, 404, { code: "not-found", message: `no scenario named ${id}` });
      if (req.method === "POST" && parts[1] === "session" && parts.length === 2) {
        const body = await readJson(req);
        if (typeof body.sessionId !== "string" || !body.sessionId) return send(res, 400, { code: "invalid-session", message: "sessionId is required" });
        if (!scenario.layerfs.includes(body.backend)) return send(res, 400, { code: "invalid-backend", message: `${id} runs on ${scenario.layerfs.join(" and ")} LayerFS` });
        progress.register(id, body.backend, body.sessionId);
        return send(res, 200, view(id, scenario));
      }
      return send(res, 404, { code: "not-found", message: `no route ${req.method} ${url.pathname}` });
    } catch (error) {
      return send(res, error.status || 500, { code: error.code || "failed", message: error.message });
    }
  };
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: PREFIX, handler }), `layerfs-mock: ${PREFIX}`);
}
