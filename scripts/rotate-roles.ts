/**
 * ADR-0024 two-step role rotation driven by governance. Usage:
 *   RPC_URL=… GOVERNANCE_KEYPAIR=keys/governance-*.json \
 *   [OPERATOR_KEYPAIR=keys/operator-*.json] [OVERRIDE_KEYPAIR=keys/override-*.json] [PAUSE_KEYPAIR=…] \
 *   pnpm exec tsx scripts/rotate-roles.ts
 * For each keypair given: governance propose_role, then the new key accept_role.
 * Governance pays a tiny fee-funding transfer to each incoming key if it is empty.
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as m from "@meridian/sdk/meridian";

const conn = new Connection(process.env.RPC_URL!, "confirmed");
const load = (p?: string) => p ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))) : null;
const gov = load(process.env.GOVERNANCE_KEYPAIR)!;
const targets: Array<[string, m.RoleCode, number, Keypair | null]> = [
  ["operator", m.Role.Operator, m.CONFIG_OPERATOR_OFFSET, load(process.env.OPERATOR_KEYPAIR)],
  ["pause_authority", m.Role.PauseAuthority, m.CONFIG_PAUSE_AUTHORITY_OFFSET, load(process.env.PAUSE_KEYPAIR)],
  ["override_authority", m.Role.OverrideAuthority, m.CONFIG_OVERRIDE_AUTHORITY_OFFSET, load(process.env.OVERRIDE_KEYPAIR)],
];
const field = async (off: number) => new PublicKey((await conn.getAccountInfo(m.configPda()))!.data.subarray(off, off + 32)).toBase58();
const send = (ixs: any[], signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

for (const [name, role, off, kp] of targets) {
  if (!kp) continue;
  console.log(`${name}: ${await field(off)} -> ${kp.publicKey.toBase58()}`);
  if ((await conn.getBalance(kp.publicKey)) < 5_000_000)
    await send([SystemProgram.transfer({ fromPubkey: gov.publicKey, toPubkey: kp.publicKey, lamports: 10_000_000 })], [gov]);
  const p = await send([m.proposeRoleIx({ governance: gov.publicKey, role, pending: kp.publicKey })], [gov]);
  const a = await send([m.acceptRoleIx({ incoming: kp.publicKey, role })], [kp]);
  console.log(`  propose ${p}\n  accept  ${a}\n  now: ${await field(off)}`);
}
