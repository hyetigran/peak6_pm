/** ADR-0038 one-shot: reset config.governance as the program upgrade authority. Usage: RPC_URL=… NEW_GOV=<pubkey> [UPGRADE_AUTHORITY_KEYPAIR=~/.config/solana/id.json] pnpm exec tsx scripts/reset-governance.ts */
import fs from "node:fs";
import os from "node:os";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as m from "@meridian/sdk/meridian";
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const auth = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.UPGRADE_AUTHORITY_KEYPAIR ?? os.homedir() + "/.config/solana/id.json", "utf8"))));
const newGov = new PublicKey(process.env.NEW_GOV!);
const gov = async () => new PublicKey((await conn.getAccountInfo(m.configPda()))!.data.subarray(m.CONFIG_GOVERNANCE_OFFSET, m.CONFIG_GOVERNANCE_OFFSET + 32)).toBase58();
console.log("config", m.configPda().toBase58(), "programdata", m.meridianProgramData().toBase58());
console.log("governance before:", await gov());
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(m.resetGovernanceIx({ upgradeAuthority: auth.publicKey, newGovernance: newGov })), [auth], { commitment: "confirmed" });
console.log("sig:", sig);
console.log("governance after: ", await gov());
