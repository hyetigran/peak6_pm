/**
 * ADR-0038 — governance recovery by the program upgrade authority.
 *
 * Runs against a validator where Meridian is loaded through the UPGRADEABLE
 * loader (scripts/localnet.sh with MERIDIAN_UPGRADE_AUTHORITY) so a real
 * ProgramData account exists. Two modes, selected by RECOVERY_BUILD:
 *   1 — meridian.so built with `--features localnet,governance-recovery`:
 *       R1 a random signer is rejected (NotUpgradeAuthority)
 *       R2 the lost governance key itself cannot call it
 *       R3 the upgrade authority resets governance; pending is cleared;
 *          the NEW governance can propose_role and the old one cannot
 *       R4 default pubkey is rejected
 *   0 — strict build (no feature): R5 the discriminator does not exist.
 * `make governance-recovery-test` runs both.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import * as m from "@meridian/sdk/meridian";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const RECOVERY_BUILD = process.env.RECOVERY_BUILD === "1";
const AUTHORITY_PATH = process.env.MERIDIAN_UPGRADE_AUTHORITY ?? path.join(os.homedir(), ".config/solana/id.json");
const OPENBOOK_PROGRAMDATA = new PublicKey("DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB");

let conn: Connection;
const upgradeAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(AUTHORITY_PATH, "utf8"))));
const lostGov = Keypair.generate();
const newGov = Keypair.generate();
const stranger = Keypair.generate();
const operator = Keypair.generate();

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function expectFail(p: Promise<unknown>, needle: string, label: string) {
  assert.ok(needle.length > 0, `${label}: empty needle`);
  try { await p; } catch (e: any) {
    const text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`;
    assert.ok(text.includes(needle), `${label}: failed without "${needle}":\n${text}`);
    return;
  }
  assert.fail(`${label}: expected failure`);
}
const governanceOnChain = async () => new PublicKey((await conn.getAccountInfo(m.configPda()))!.data.subarray(m.CONFIG_GOVERNANCE_OFFSET, m.CONFIG_GOVERNANCE_OFFSET + 32));
const pendingGovOnChain = async () => new PublicKey((await conn.getAccountInfo(m.configPda()))!.data.subarray(m.CONFIG_PENDING_GOVERNANCE_OFFSET, m.CONFIG_PENDING_GOVERNANCE_OFFSET + 32));

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator — use make governance-recovery-test"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [upgradeAuthority, lostGov, newGov, stranger]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 20_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  // Precondition: Meridian really is an upgradeable program whose authority is our signer.
  const pd = (await conn.getAccountInfo(m.meridianProgramData()))!;
  assert.ok(pd, "ProgramData missing — validator must load Meridian with --upgradeable-program");
  const auth = new PublicKey(pd.data.subarray(13, 45)); // 4 tag + 8 slot + 1 option
  assert.equal(auth.toBase58(), upgradeAuthority.publicKey.toBase58(), "ProgramData upgrade authority");

  const quoteMint = await createMint(conn, lostGov, lostGov.publicKey, null, 6);
  await send([m.initializeConfigIx({
    governance: lostGov.publicKey, quoteMint, openbookProgramData: OPENBOOK_PROGRAMDATA,
    operator: operator.publicKey, pauseAuthority: lostGov.publicKey, overrideAuthority: lostGov.publicKey,
    supportedTickerMask: 0xfe, openbookDeploymentSlot: 282042596n, openbookExecutableSha256: Buffer.alloc(32, 0xaa),
    openbookUpgradeAuthority: PublicKey.default, minSamples: 3, maxStaleSlots: 150n, maxPriceBandBps: 50,
  })], [lostGov]);
  // Leave a pending governance proposal from the "lost" key so R3 can prove it is cleared.
  await send([m.proposeRoleIx({ governance: lostGov.publicKey, role: m.Role.Governance, pending: stranger.publicKey })], [lostGov]);
  assert.equal((await pendingGovOnChain()).toBase58(), stranger.publicKey.toBase58());
});

test("R1 a random signer cannot reset governance", { skip: !RECOVERY_BUILD }, async () => {
  await expectFail(
    send([m.resetGovernanceIx({ upgradeAuthority: stranger.publicKey, newGovernance: newGov.publicKey })], [stranger]),
    "NotUpgradeAuthority", "stranger");
  assert.equal((await governanceOnChain()).toBase58(), lostGov.publicKey.toBase58());
});

test("R2 the current governance key cannot reset governance either", { skip: !RECOVERY_BUILD }, async () => {
  await expectFail(
    send([m.resetGovernanceIx({ upgradeAuthority: lostGov.publicKey, newGovernance: newGov.publicKey })], [lostGov]),
    "NotUpgradeAuthority", "governance-as-signer");
});

test("R4 default pubkey is rejected", { skip: !RECOVERY_BUILD }, async () => {
  await expectFail(
    send([m.resetGovernanceIx({ upgradeAuthority: upgradeAuthority.publicKey, newGovernance: PublicKey.default })], [upgradeAuthority]),
    "InvalidGovernanceKey", "default key");
});

test("R3 the upgrade authority resets governance; old key is dead, new key governs", { skip: !RECOVERY_BUILD }, async () => {
  await send([m.resetGovernanceIx({ upgradeAuthority: upgradeAuthority.publicKey, newGovernance: newGov.publicKey })], [upgradeAuthority]);
  assert.equal((await governanceOnChain()).toBase58(), newGov.publicKey.toBase58(), "governance overwritten");
  assert.equal((await pendingGovOnChain()).toBase58(), PublicKey.default.toBase58(), "stale pending cleared");
  // The stranger the lost key had proposed can no longer accept.
  await expectFail(send([m.acceptRoleIx({ incoming: stranger.publicKey, role: m.Role.Governance })], [stranger]),
    "NoPendingRotation", "stale accept");
  // Old governance is locked out of propose_role; new governance is not.
  await expectFail(send([m.proposeRoleIx({ governance: lostGov.publicKey, role: m.Role.Operator, pending: stranger.publicKey })], [lostGov]),
    "Unauthorized", "old gov propose");
  await send([m.proposeRoleIx({ governance: newGov.publicKey, role: m.Role.OverrideAuthority, pending: newGov.publicKey })], [newGov]);
  await send([m.acceptRoleIx({ incoming: newGov.publicKey, role: m.Role.OverrideAuthority })], [newGov]);
  const cfg = (await conn.getAccountInfo(m.configPda()))!.data;
  assert.equal(new PublicKey(cfg.subarray(m.CONFIG_OVERRIDE_AUTHORITY_OFFSET, m.CONFIG_OVERRIDE_AUTHORITY_OFFSET + 32)).toBase58(),
    newGov.publicKey.toBase58(), "override rotated via the normal two-step path");
});

test("R5 strict build has no reset_governance instruction", { skip: RECOVERY_BUILD }, async () => {
  await expectFail(
    send([m.resetGovernanceIx({ upgradeAuthority: upgradeAuthority.publicKey, newGovernance: newGov.publicKey })], [upgradeAuthority]),
    "InstructionFallbackNotFound", "strict build");
  assert.equal((await governanceOnChain()).toBase58(), lostGov.publicKey.toBase58(), "governance untouched");
});
