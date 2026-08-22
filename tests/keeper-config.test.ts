/**
 * Keeper runtime config loading (deploy). Prefer DEMO_CONFIG_JSON (a cloud
 * secret) over the local .demo-config.json file, so no operator key ships in
 * the image. Pure. Run: pnpm exec tsx --test tests/keeper-config.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKeeperConfig } from "../services/keeper/src/config.js";

const sample = { operator: [1, 2, 3], transports: { "7": "Feed7" }, day: 20260825, quoteMint: "USDC" };

test("DEMO_CONFIG_JSON env takes precedence over the file", () => {
  const cfg = loadKeeperConfig({ DEMO_CONFIG_JSON: JSON.stringify(sample) });
  assert.deepEqual(cfg.transports, { "7": "Feed7" });
  assert.equal(cfg.day, 20260825);
});

test("falls back to the DEMO_CONFIG file when no env JSON", () => {
  const f = path.join(os.tmpdir(), `mrd-cfg-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(sample));
  try {
    const cfg = loadKeeperConfig({ DEMO_CONFIG: f });
    assert.deepEqual(cfg.operator, [1, 2, 3]);
  } finally { fs.unlinkSync(f); }
});

test("a malformed DEMO_CONFIG_JSON fails loudly (not silently onto the file)", () => {
  assert.throws(() => loadKeeperConfig({ DEMO_CONFIG_JSON: "{not json" }), /JSON|Unexpected|token/i);
});

test("a missing config file fails loudly (ENOENT), not a silent empty config", () => {
  assert.throws(() => loadKeeperConfig({ DEMO_CONFIG: "/nonexistent/mrd-does-not-exist.json" }), /ENOENT|no such file/i);
});
