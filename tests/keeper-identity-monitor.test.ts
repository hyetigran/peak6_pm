/**
 * Identity-drift monitor (#25): decode the pinned OpenBook identity from Config
 * and the pinned oracle identity from FeedVersion (at the on-chain offsets), and
 * the checkIdentities runner that compares each target's live identity to its
 * pin and routes drift/upgrade to the alerter. Pure — reads/alerts injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { pinnedOpenbookFromConfig, pinnedOracleFromFeedVersion } from "../services/keeper/src/identity-monitor.js";
import { checkIdentities } from "../services/keeper/src/identity-monitor.js";
import type { ExecutableIdentity } from "../services/keeper/src/identity.js";
import type { AlertEvent } from "../services/keeper/src/alerter.js";

const pk = (b: number) => new PublicKey(Buffer.alloc(32, b)).toBase58();
const shaHex = (b: number) => Buffer.alloc(32, b).toString("hex");

// Build a Config blob with the OpenBook identity at the real offsets.
function configBlob(): Buffer {
  const b = Buffer.alloc(600);
  new PublicKey(pk(1)).toBuffer().copy(b, 333); // openbook_program_id (verified on-chain offset)
  new PublicKey(pk(2)).toBuffer().copy(b, 365); // openbook_programdata
  b.writeBigUInt64LE(282042596n, 397);          // deployment slot
  Buffer.alloc(32, 0xaa).copy(b, 405);          // executable sha256
  new PublicKey(pk(3)).toBuffer().copy(b, 437); // upgrade authority
  return b;
}
function feedVersionBlob(): Buffer {
  const b = Buffer.alloc(400);
  new PublicKey(pk(4)).toBuffer().copy(b, 79);  // oracle_program_id
  new PublicKey(pk(5)).toBuffer().copy(b, 111); // oracle_programdata
  b.writeBigUInt64LE(500n, 143);                // deployment slot
  Buffer.alloc(32, 0xbb).copy(b, 151);          // executable sha256
  Buffer.alloc(32, 0).copy(b, 183);             // upgrade authority = all-zero == None
  return b;
}

// Offsets verified against a live localnet Config account (openbook_program_id @333).
test("pinnedOpenbookFromConfig decodes the identity at the Config offsets", () => {
  const id = pinnedOpenbookFromConfig(configBlob());
  assert.equal(id.programId, pk(1));
  assert.equal(id.programdata, pk(2));
  assert.equal(id.deploymentSlot, 282042596n);
  assert.equal(id.executableSha256, "aa".repeat(32));
  assert.equal(id.upgradeAuthority, pk(3));
});

test("pinnedOracleFromFeedVersion decodes the identity; all-zero authority == None", () => {
  const id = pinnedOracleFromFeedVersion(feedVersionBlob());
  assert.equal(id.programId, pk(4));
  assert.equal(id.deploymentSlot, 500n);
  assert.equal(id.executableSha256, "bb".repeat(32));
  assert.equal(id.upgradeAuthority, null);
});

const pin: ExecutableIdentity = { programId: pk(1), programdata: pk(2), deploymentSlot: 100n, executableSha256: shaHex(1), upgradeAuthority: pk(3) };

test("checkIdentities: no drift -> no alert, no upgrade", async () => {
  const alerts: AlertEvent[] = []; const upgrades: string[] = [];
  const r = await checkIdentities({
    targets: [{ name: "OpenBook", pinned: pin, readLive: async () => ({ ...pin }) }],
    alert: async (e) => { alerts.push(e); }, onUpgrade: (n) => upgrades.push(n),
  });
  assert.equal(alerts.length, 0);
  assert.equal(r.find((x) => x.name === "OpenBook")!.status, "ok");
});

test("checkIdentities: drift -> critical alert", async () => {
  const alerts: AlertEvent[] = [];
  await checkIdentities({
    targets: [{ name: "OpenBook", pinned: pin, readLive: async () => ({ ...pin, upgradeAuthority: pk(99) }) }],
    alert: async (e) => { alerts.push(e); }, onUpgrade: () => {},
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, "critical");
  assert.match(alerts[0].title, /OpenBook/);
});

test("checkIdentities: a clean upgrade -> critical alert AND an onUpgrade re-pin signal", async () => {
  const alerts: AlertEvent[] = []; const upgrades: string[] = [];
  await checkIdentities({
    targets: [{ name: "oracle", pinned: pin, readLive: async () => ({ ...pin, deploymentSlot: 200n, executableSha256: shaHex(2) }) }],
    alert: async (e) => { alerts.push(e); }, onUpgrade: (n) => upgrades.push(n),
  });
  assert.equal(alerts.length, 1);
  assert.deepEqual(upgrades, ["oracle"]);
});

test("checkIdentities: a read that fails is itself a critical alert (fail closed, not silent)", async () => {
  const alerts: AlertEvent[] = [];
  const r = await checkIdentities({
    targets: [{ name: "OpenBook", pinned: pin, readLive: async () => { throw new Error("rpc down"); } }],
    alert: async (e) => { alerts.push(e); }, onUpgrade: () => {},
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, "critical");
  assert.equal(r.find((x) => x.name === "OpenBook")!.status, "error");
});

test("readLiveIdentity: reads Program -> ProgramData via RPC and assembles the identity", async () => {
  const { readLiveIdentity } = await import("../services/keeper/src/identity-monitor.js");
  const { BPF_UPGRADEABLE_LOADER } = await import("../services/keeper/src/identity.js");
  const PROG = pk(1), PD = pk(2);
  // Program account: variant 2 + programdata pubkey
  const progData = Buffer.alloc(36); progData.writeUInt32LE(2, 0); new PublicKey(PD).toBuffer().copy(progData, 4);
  // ProgramData: variant 3 + slot + Some(auth) + ELF
  const elf = Buffer.from("elf"); const pdHead = Buffer.alloc(45); pdHead.writeUInt32LE(3, 0);
  pdHead.writeBigUInt64LE(282042596n, 4); pdHead[12] = 1; new PublicKey(pk(3)).toBuffer().copy(pdHead, 13);
  const pdData = Buffer.concat([pdHead, elf]);
  const conn: any = {
    getAccountInfo: async (addr: PublicKey) =>
      addr.toBase58() === PROG ? { owner: BPF_UPGRADEABLE_LOADER, data: progData }
      : addr.toBase58() === PD ? { owner: BPF_UPGRADEABLE_LOADER, data: pdData } : null,
  };
  const id = await readLiveIdentity(conn, PROG);
  assert.equal(id.programId, PROG);
  assert.equal(id.programdata, PD);
  assert.equal(id.deploymentSlot, 282042596n);
  assert.equal(id.executableSha256, createHash("sha256").update(elf).digest("hex"));
});

test("readLiveIdentity: a non-upgradeable program (localnet --bpf-program) is rejected, no ProgramData to hash", async () => {
  const { readLiveIdentity } = await import("../services/keeper/src/identity-monitor.js");
  const conn: any = { getAccountInfo: async () => ({ owner: new PublicKey(pk(7)), data: Buffer.alloc(36) }) };
  await assert.rejects(readLiveIdentity(conn, pk(1)), /upgradeable loader|non-upgradeable/i);
});

test("checkIdentities: hashRequired=false downgrades a non-upgradeable program to a WARN (localnet)", async () => {
  const { NonUpgradeableError } = await import("../services/keeper/src/identity-monitor.js");
  const alerts: AlertEvent[] = [];
  const r = await checkIdentities({
    targets: [{ name: "OpenBook", pinned: pin, readLive: async () => { throw new NonUpgradeableError("no ProgramData"); } }],
    alert: async (e) => { alerts.push(e); }, onUpgrade: () => {}, hashRequired: false,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, "warn");
  assert.equal(r[0].status, "unverifiable");
});

test("checkIdentities: hashRequired=true keeps a non-upgradeable program a CRITICAL error (devnet)", async () => {
  const { NonUpgradeableError } = await import("../services/keeper/src/identity-monitor.js");
  const alerts: AlertEvent[] = [];
  const r = await checkIdentities({
    targets: [{ name: "OpenBook", pinned: pin, readLive: async () => { throw new NonUpgradeableError("no ProgramData"); } }],
    alert: async (e) => { alerts.push(e); }, onUpgrade: () => {}, hashRequired: true,
  });
  assert.equal(alerts[0].level, "critical");
  assert.equal(r[0].status, "error");
});

test("pinned decoders reject an undersized account (layout guard)", async () => {
  const { pinnedOpenbookFromConfig, pinnedOracleFromFeedVersion } = await import("../services/keeper/src/identity-monitor.js");
  assert.throws(() => pinnedOpenbookFromConfig(Buffer.alloc(400)), /too small|layout/i);
  assert.throws(() => pinnedOracleFromFeedVersion(Buffer.alloc(100)), /too small|layout/i);
});
