/**
 * Keeper runtime config. In the cloud the operator key + transports must come
 * from a secret env var, never a file baked into the image — so DEMO_CONFIG_JSON
 * (the full config JSON, same shape as .demo-config.json) takes precedence over
 * the DEMO_CONFIG file path used locally.
 */
import fs from "node:fs";

export interface KeeperConfig {
  operator: number[];                 // ed25519 secret key bytes
  transports?: Record<string, string>; // tickerId -> delivery feed pubkey
  day?: number;
  quoteMint?: string;
}

export function loadKeeperConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const inline = env.DEMO_CONFIG_JSON;
  if (inline !== undefined) return JSON.parse(inline) as KeeperConfig;
  const file = env.DEMO_CONFIG ?? ".demo-config.json";
  return JSON.parse(fs.readFileSync(file, "utf8")) as KeeperConfig;
}
