/** Meridian program instruction builders (anchor-compatible; no IDL client). */
import { createHash } from "node:crypto";
import {
  AccountMeta, PublicKey, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";

export const MERIDIAN_PID = new PublicKey("FF6mu5FFb1q1Qz88x1HnhkePdF8Q1dXWnTfUUSkzUT3t");
export const OPENBOOK_PID = new PublicKey("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb");
export const TOKEN_PID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Anchor global instruction discriminator. */
export const disc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const u8 = (n: number) => Buffer.from([n & 0xff]);
const bool = (b: boolean) => Buffer.from([b ? 1 : 0]);

// --- PDAs ---
export const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN_PID)[0];
export const feedVersionPda = (ticker: number, versionId: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("transport_version"), Buffer.from([ticker]), u32(versionId)], MERIDIAN_PID)[0];
export const outcomeMarketPda = (ticker: number, tradingDay: number, strike: bigint) =>
  PublicKey.findProgramAddressSync([Buffer.from("outcome_market"), Buffer.from([ticker]), u32(tradingDay), u64(strike)], MERIDIAN_PID)[0];
export const settlementRecordPda = (ticker: number, tradingDay: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("settlement_record"), Buffer.from([ticker]), u32(tradingDay)], MERIDIAN_PID)[0];
export const yesMintPda = (market: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("yes_mint"), market.toBuffer()], MERIDIAN_PID)[0];
export const noMintPda = (market: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("no_mint"), market.toBuffer()], MERIDIAN_PID)[0];
export const ataFor = (mint: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ATA_PID)[0];

export function initializeConfigIx(opts: {
  governance: PublicKey; quoteMint: PublicKey; openbookProgramData: PublicKey;
  operator: PublicKey; pauseAuthority: PublicKey; overrideAuthority: PublicKey;
  supportedTickerMask: number; openbookDeploymentSlot: bigint;
  openbookExecutableSha256: Buffer; openbookUpgradeAuthority: PublicKey;
  minSamples: number; maxStaleSlots: bigint; maxPriceBandBps: number;
}): TransactionInstruction {
  const data = Buffer.concat([
    disc("initialize_config"),
    opts.operator.toBuffer(), opts.pauseAuthority.toBuffer(), opts.overrideAuthority.toBuffer(),
    u8(opts.supportedTickerMask), u64(opts.openbookDeploymentSlot),
    opts.openbookExecutableSha256, opts.openbookUpgradeAuthority.toBuffer(),
    u8(opts.minSamples), u64(opts.maxStaleSlots), u16(opts.maxPriceBandBps),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: opts.governance, isSigner: true, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: true },
    { pubkey: opts.quoteMint, isSigner: false, isWritable: false },
    { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    { pubkey: opts.openbookProgramData, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: MERIDIAN_PID, keys, data });
}

export function registerTransportIx(opts: {
  governance: PublicKey; versionId: number; tickerId: number; feed: PublicKey;
}): TransactionInstruction {
  const z = Buffer.alloc(32);
  const data = Buffer.concat([
    disc("register_transport"), u32(opts.versionId), u8(opts.tickerId),
    z, z, u64(0n), z, z, opts.feed.toBuffer(), z, u16(1), u16(1), u32(0),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: opts.governance, isSigner: true, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: false },
    { pubkey: feedVersionPda(opts.tickerId, opts.versionId), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: MERIDIAN_PID, keys, data });
}

export function createOutcomeMarketIx(opts: {
  operator: PublicKey; quoteMint: PublicKey; tickerId: number; tradingDay: number;
  strike: bigint; versionId: number; priorClose: bigint;
  mintOpenTs: bigint; tradeOpenTs: bigint; closeTs: bigint;
  metadataManifest: Buffer; normalDelaySecs: number; overrideDelaySecs: number;
}): TransactionInstruction {
  const market = outcomeMarketPda(opts.tickerId, opts.tradingDay, opts.strike);
  const data = Buffer.concat([
    disc("create_outcome_market"), u8(opts.tickerId), u32(opts.tradingDay), u64(opts.strike),
    u64(opts.priorClose), i64(opts.mintOpenTs), i64(opts.tradeOpenTs), i64(opts.closeTs),
    opts.metadataManifest, u32(opts.normalDelaySecs), u32(opts.overrideDelaySecs),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: opts.operator, isSigner: true, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: false },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: settlementRecordPda(opts.tickerId, opts.tradingDay), isSigner: false, isWritable: true },
    { pubkey: feedVersionPda(opts.tickerId, opts.versionId), isSigner: false, isWritable: false },
    { pubkey: opts.quoteMint, isSigner: false, isWritable: false },
    { pubkey: yesMintPda(market), isSigner: false, isWritable: true },
    { pubkey: noMintPda(market), isSigner: false, isWritable: true },
    { pubkey: ataFor(opts.quoteMint, market), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    { pubkey: ATA_PID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: MERIDIAN_PID, keys, data });
}
