import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("./bin", import.meta.url));

/** Install the platform's layerfs launcher in the Host's inherited PATH. */
export function shimOnPath(env = process.env, platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  const key = platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH" : "PATH";
  env[key] = env[key] ? `${BIN}${delimiter}${env[key]}` : BIN;
  return () => { env[key] = (env[key] ?? "").split(delimiter).filter((dir) => dir !== BIN).join(delimiter); };
}
