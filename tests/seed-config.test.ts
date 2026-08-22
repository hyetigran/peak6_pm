/**
 * Unit test for the seed environment resolver (#24). Pure — no validator.
 * Run directly: pnpm exec tsx --test tests/seed-config.test.ts
 *
 * Contract: localnet keeps the demo placeholders (self-made mint, zero delays,
 * harness feed); devnet requires the real identities and enforces the strict
 * on-chain settlement-delay floors that a strict build (#23) applies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSeedConfig, NORMAL_DELAY_FLOOR, OVERRIDE_DELAY_FLOOR,
  assertStrictSchedule, MINT_TO_TRADE_SECS, MIN_ADD_STRIKE_LEAD_SECS, MAX_SESSION_SECS } from "../scripts/seed-config.js";

const CIRCLE_DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEVNET_ENV: Record<string, string> = {
  DEMO_MODE: "devnet",
  QUOTE_MINT: CIRCLE_DEVNET_USDC,
  OPENBOOK_EXECUTABLE_SHA256: "a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8",
  OPENBOOK_UPGRADE_AUTHORITY: "Cax5s8CjmHiCNVLLnc3D5Aht5Uv2Fk37gfsMoccddPTn",
  METADATA_URI: "https://meridian.markets/meta/{ticker}-{strike}.json",
  ORACLE_PROGRAM_ID: "Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4", // pyth-adapter
};

test("localnet: self-made mint, zero delays, harness feed, 32-byte placeholder sha", () => {
  const c = resolveSeedConfig({});
  assert.equal(c.mode, "localnet");
  assert.equal(c.quoteMint, null); // seed creates a mint
  assert.equal(c.normalDelaySecs, 0);
  assert.equal(c.overrideDelaySecs, 0);
  assert.equal(c.oracleProgram, null); // harness mock feed
  assert.equal(c.openbookExecutableSha256.length, 32);
});

test("localnet: METADATA_URI override is respected", () => {
  assert.equal(resolveSeedConfig({ METADATA_URI: "https://x/y.json" }).metadataUri, "https://x/y.json");
});

test("devnet: resolves the real identities; delays default to the strict floors", () => {
  const c = resolveSeedConfig(DEVNET_ENV);
  assert.equal(c.mode, "devnet");
  assert.equal(c.quoteMint, DEVNET_ENV.QUOTE_MINT);
  assert.equal(c.normalDelaySecs, NORMAL_DELAY_FLOOR);
  assert.equal(c.overrideDelaySecs, OVERRIDE_DELAY_FLOOR);
  assert.equal(c.oracleProgram, DEVNET_ENV.ORACLE_PROGRAM_ID);
  assert.equal(c.openbookUpgradeAuthority, DEVNET_ENV.OPENBOOK_UPGRADE_AUTHORITY);
  assert.equal(c.openbookExecutableSha256.toString("hex"), DEVNET_ENV.OPENBOOK_EXECUTABLE_SHA256);
});

test("devnet: each required identity throws when missing", () => {
  for (const k of ["OPENBOOK_EXECUTABLE_SHA256", "OPENBOOK_UPGRADE_AUTHORITY", "METADATA_URI", "ORACLE_PROGRAM_ID"]) {
    const env = { ...DEVNET_ENV };
    delete env[k];
    assert.throws(() => resolveSeedConfig(env), new RegExp(k), `missing ${k} should throw naming it`);
  }
});

test("devnet: QUOTE_MINT defaults to Circle devnet USDC (unset or empty), override respected", () => {
  const noMint = { ...DEVNET_ENV };
  delete noMint.QUOTE_MINT;
  assert.equal(resolveSeedConfig(noMint).quoteMint, CIRCLE_DEVNET_USDC);
  assert.equal(resolveSeedConfig({ ...DEVNET_ENV, QUOTE_MINT: "" }).quoteMint, CIRCLE_DEVNET_USDC);
  assert.equal(resolveSeedConfig({ ...DEVNET_ENV, QUOTE_MINT: "9nZ2u5FakeMintForTest1111111111111111111111" }).quoteMint, "9nZ2u5FakeMintForTest1111111111111111111111");
});

test("devnet: delays below the strict floor are rejected", () => {
  assert.throws(() => resolveSeedConfig({ ...DEVNET_ENV, NORMAL_DELAY_SECS: String(NORMAL_DELAY_FLOOR - 1) }), /NORMAL_DELAY_SECS/);
  assert.throws(() => resolveSeedConfig({ ...DEVNET_ENV, OVERRIDE_DELAY_SECS: String(OVERRIDE_DELAY_FLOOR - 1) }), /OVERRIDE_DELAY_SECS/);
});

test("devnet: delays at or above the floor are accepted", () => {
  const c = resolveSeedConfig({ ...DEVNET_ENV, NORMAL_DELAY_SECS: "1800", OVERRIDE_DELAY_SECS: "7200" });
  assert.equal(c.normalDelaySecs, 1800);
  assert.equal(c.overrideDelaySecs, 7200);
});

test("devnet: OPENBOOK_EXECUTABLE_SHA256 must be 32 bytes of hex", () => {
  assert.throws(() => resolveSeedConfig({ ...DEVNET_ENV, OPENBOOK_EXECUTABLE_SHA256: "abcd" }), /SHA256|32/);
});

const NOW = 1_700_000_000;
const okSched = { mintOpen: NOW - 30 - MINT_TO_TRADE_SECS, tradeOpen: NOW - 30, close: NOW + 6 * 3600, now: NOW };

test("assertStrictSchedule: the seed's normal 6h window passes the strict floors", () => {
  assert.doesNotThrow(() => assertStrictSchedule(okSched));
});

test("assertStrictSchedule: a sub-floor DEMO_SETTLE close (now+90) fails closed with a clear message", () => {
  assert.throws(() => assertStrictSchedule({ ...okSched, close: NOW + 90 }), /add-strike lead|sub-floor|DEMO_SETTLE/i);
});

test("assertStrictSchedule: close exactly at the lead boundary passes; one second inside fails", () => {
  assert.doesNotThrow(() => assertStrictSchedule({ ...okSched, close: NOW + MIN_ADD_STRIKE_LEAD_SECS }));
  assert.throws(() => assertStrictSchedule({ ...okSched, close: NOW + MIN_ADD_STRIKE_LEAD_SECS - 1 }));
});

test("assertStrictSchedule: a mint->trade gap other than 1800 fails (ADR-0033)", () => {
  assert.throws(() => assertStrictSchedule({ ...okSched, mintOpen: NOW - 30 - 1000 }), /1800/);
});

test("assertStrictSchedule: a session longer than MAX_SESSION_SECS fails", () => {
  assert.throws(() => assertStrictSchedule({ ...okSched, close: okSched.tradeOpen + MAX_SESSION_SECS + 1 }), /MAX_SESSION_SECS|session/i);
});

test("assertStrictSchedule: out-of-order schedule fails", () => {
  assert.throws(() => assertStrictSchedule({ mintOpen: NOW, tradeOpen: NOW - 10, close: NOW + 3600, now: NOW }), /mint_open < trade_open/);
});
