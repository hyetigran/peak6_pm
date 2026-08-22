/**
 * Executable-identity drift detection (#25, ADR-0030).
 *
 * V1 binds to the canonical OpenBook deployment and treats its retained upgrade
 * authority as a MONITORED, fail-closed risk (ADR-0030). The program halts
 * fail-closed per-CPI on a ProgramData/slot mismatch; this is the OFF-CHAIN
 * layer that NOTICES drift and pages, so a change is not merely halted but seen.
 * A verified upgrade reopens the architecture for an explicit re-pin decision —
 * it is never auto-adopted.
 *
 * Parsers for the BPF Upgradeable Loader account states (bincode):
 *   Program      = u32(2) ++ programdata_address: Pubkey
 *   ProgramData  = u32(3) ++ slot: u64 ++ Option<Pubkey> upgrade_authority ++ ELF
 * The executable hash is sha256 over the ELF bytes (offset 45 onward); it is
 * self-consistent across reads, so any re-upload changes it.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** The metadata prefix before the ELF in a ProgramData account (u32 + u64 + Option<Pubkey>). */
const PROGRAMDATA_HEADER_LEN = 45;

export interface ExecutableIdentity {
  programId: string;
  programdata: string;
  deploymentSlot: bigint;
  executableSha256: string; // hex
  upgradeAuthority: string | null; // null == immutable (None)
}

/** Program account (upgradeable loader) → its ProgramData address. */
export function parseProgramAccount(data: Buffer): { programdata: string } {
  if (data.length < 36 || data.readUInt32LE(0) !== 2) {
    throw new Error("account is not an upgradeable Program (expected loader variant 2)");
  }
  return { programdata: new PublicKey(data.subarray(4, 36)).toBase58() };
}

/** ProgramData account → deployment slot, upgrade authority, executable hash. */
export function parseProgramData(data: Buffer): { deploymentSlot: bigint; upgradeAuthority: string | null; executableSha256: string } {
  if (data.length < PROGRAMDATA_HEADER_LEN || data.readUInt32LE(0) !== 3) {
    throw new Error("account is not ProgramData (expected loader variant 3)");
  }
  const deploymentSlot = data.readBigUInt64LE(4);
  const hasAuth = data[12] === 1;
  const upgradeAuthority = hasAuth ? new PublicKey(data.subarray(13, 45)).toBase58() : null;
  const executableSha256 = createHash("sha256").update(data.subarray(PROGRAMDATA_HEADER_LEN)).digest("hex");
  return { deploymentSlot, upgradeAuthority, executableSha256 };
}

export type DriftStatus = "ok" | "upgrade" | "drift";
export interface DriftResult { status: DriftStatus; changed: string[]; detail: string }

/** Compare a live identity to the pinned snapshot (ADR-0030).
 *  - identical                                   → ok
 *  - ONLY (deploymentSlot AND executableSha256)  → upgrade (a clean redeploy
 *      under the same authority/programdata; surface for an explicit re-pin)
 *  - anything else changed                       → drift (identity substitution,
 *      authority change, or an inconsistent slot/hash — fail-closed alert)
 */
export function compareIdentity(pinned: ExecutableIdentity, live: ExecutableIdentity): DriftResult {
  const fields: (keyof ExecutableIdentity)[] = ["programId", "programdata", "deploymentSlot", "executableSha256", "upgradeAuthority"];
  const changed = fields.filter((f) => String(pinned[f]) !== String(live[f])).map(String);
  if (changed.length === 0) return { status: "ok", changed, detail: "identity unchanged" };
  const cleanUpgrade = changed.length === 2 && changed.includes("deploymentSlot") && changed.includes("executableSha256");
  if (cleanUpgrade) {
    return { status: "upgrade", changed, detail: `verified upgrade: slot ${pinned.deploymentSlot}->${live.deploymentSlot}. Reopen the architecture and re-pin (ADR-0030) — do not auto-adopt.` };
  }
  return { status: "drift", changed, detail: `identity drift on ${changed.join(", ")} — fail closed (ADR-0030)` };
}
