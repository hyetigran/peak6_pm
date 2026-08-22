/**
 * Executable-identity drift detection (#25, ADR-0030). Pure parsers for the
 * BPF Upgradeable Loader Program / ProgramData accounts + the drift/upgrade
 * classification. No RPC — fixture bytes. Run: tsx --test tests/keeper-identity.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  parseProgramAccount, parseProgramData, compareIdentity, type ExecutableIdentity,
} from "../services/keeper/src/identity.js";

const pk = (b: number) => new PublicKey(Buffer.alloc(32, b)).toBase58();

// A Program account: u32(2) LE + programdata pubkey (32).
function programAccount(programdata: string): Buffer {
  const b = Buffer.alloc(36);
  b.writeUInt32LE(2, 0);
  new PublicKey(programdata).toBuffer().copy(b, 4);
  return b;
}
// A ProgramData account: u32(3) + slot(u64) + Option<Pubkey> auth + ELF bytes.
function programData(slot: bigint, auth: string | null, elf: Buffer): Buffer {
  const head = Buffer.alloc(45);
  head.writeUInt32LE(3, 0);
  head.writeBigUInt64LE(slot, 4);
  if (auth) { head[12] = 1; new PublicKey(auth).toBuffer().copy(head, 13); } else { head[12] = 0; }
  return Buffer.concat([head, elf]);
}

const ELF = Buffer.from("fake-elf-bytes-of-a-program");
const shaOf = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

test("parseProgramAccount extracts the ProgramData address (rejects a non-Program variant)", () => {
  assert.equal(parseProgramAccount(programAccount(pk(7))).programdata, pk(7));
  const bad = Buffer.alloc(36); bad.writeUInt32LE(1, 0); // Buffer variant, not Program
  assert.throws(() => parseProgramAccount(bad), /not an upgradeable Program/i);
});

test("parseProgramData extracts slot, upgrade authority, and the executable hash", () => {
  const d = parseProgramData(programData(282042596n, pk(9), ELF));
  assert.equal(d.deploymentSlot, 282042596n);
  assert.equal(d.upgradeAuthority, pk(9));
  assert.equal(d.executableSha256, shaOf(ELF));
});

test("parseProgramData reports a null (immutable) upgrade authority", () => {
  assert.equal(parseProgramData(programData(1n, null, ELF)).upgradeAuthority, null);
});

const pinned: ExecutableIdentity = {
  programId: pk(1), programdata: pk(2), deploymentSlot: 282042596n,
  executableSha256: shaOf(ELF), upgradeAuthority: pk(3),
};

test("compareIdentity: identical live identity is OK", () => {
  assert.equal(compareIdentity(pinned, { ...pinned }).status, "ok");
});

test("compareIdentity: a slot+hash change under the same authority is an UPGRADE (surface for re-pin, not auto-adopt)", () => {
  const r = compareIdentity(pinned, { ...pinned, deploymentSlot: 300000000n, executableSha256: shaOf(Buffer.from("new-elf")) });
  assert.equal(r.status, "upgrade");
  assert.deepEqual(r.changed.sort(), ["deploymentSlot", "executableSha256"]);
});

test("compareIdentity: a changed upgrade authority is DRIFT (identity substitution)", () => {
  const r = compareIdentity(pinned, { ...pinned, upgradeAuthority: pk(99) });
  assert.equal(r.status, "drift");
  assert.ok(r.changed.includes("upgradeAuthority"));
});

test("compareIdentity: a changed ProgramData address is DRIFT", () => {
  assert.equal(compareIdentity(pinned, { ...pinned, programdata: pk(88) }).status, "drift");
});

test("compareIdentity: a slot change with the SAME hash is DRIFT (inconsistent, not a clean upgrade)", () => {
  const r = compareIdentity(pinned, { ...pinned, deploymentSlot: 999n });
  assert.equal(r.status, "drift");
  assert.ok(r.changed.includes("deploymentSlot"));
});

test("compareIdentity: authority going to null (immutable) is DRIFT — a state change to alert on", () => {
  assert.equal(compareIdentity(pinned, { ...pinned, upgradeAuthority: null }).status, "drift");
});
