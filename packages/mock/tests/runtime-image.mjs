// Shipped workloads inherit the configured deployment image, including on WSL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadScenarios, compileScenario } from "../src/scenario.js";
const folder = fileURLToPath(new URL("../../../scenarios/", import.meta.url));
const scenarios = loadScenarios(folder);
for (const name of ["shop", "depot", "crew"]) {
  const scenario = scenarios.get(name);
  assert.equal(scenario.image, null, name + ": no machine-local image ID");
  const commands = Object.values(scenario.agents).flat().filter(s => s.call?.name === "bash").map(s => s.call.args.command);
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.equal(command.includes("--image"), false, name);
    assert.equal(command.includes("sandbox.create({ image:"), false, name);
  }
  assert.ok(commands.some(c => c.includes(name === "depot" ? "sandbox.create()" : "layerfs sandbox create |")), name);
}
// Custom scenarios can still intentionally choose an explicit image.
const raw = JSON.parse(readFileSync(new URL("../../../scenarios/shop/scenario.json", import.meta.url)));
const image = "sha256:" + "a".repeat(64);
raw.image = image;
const step = raw.agents.root.find(s => s.bash?.command.includes("layerfs sandbox create"));
step.bash.command = step.bash.command.replace("layerfs sandbox create", "layerfs sandbox create --image {{image}}");
const custom = compileScenario(raw, {name: "shop", folder: folder + "/shop"});
assert.ok(custom.agents.root.some(s => s.call?.args.command?.includes("--image " + image)));
console.log("Shipped scenarios inherit deployment image; explicit custom images preserved: PASS");
