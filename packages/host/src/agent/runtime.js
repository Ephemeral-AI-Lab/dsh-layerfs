// Public @layerfs/runtime exports in the agent process, after DSH environment mapping.
// Importing starts nothing; runtime/instance creation and terminal close stay explicit.
import "./env.js";
export * from "@layerfs/runtime";
