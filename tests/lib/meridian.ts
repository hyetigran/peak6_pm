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

// --- trading builders (reuse tests/lib/openbook.ts for OO/book/PDAs) ---
import * as ob from "./openbook.js";

export const marketAuthorityPda = (obMarket: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("Market"), obMarket.toBuffer()], OPENBOOK_PID)[0];
export const eventAuthorityPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], OPENBOOK_PID)[0];
const FEE_ADMIN_SENTINEL = PublicKey.findProgramAddressSync(
  [Buffer.from("meridian_fee_admin_sentinel")], SystemProgram.programId)[0];

const str = (s: string) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };

export function createVenueMarketIx(opts: {
  operator: PublicKey; market: PublicKey; obMarket: PublicKey; bids: PublicKey;
  asks: PublicKey; eventHeap: PublicKey; yesMint: PublicKey; quoteMint: PublicKey;
  name: string; timeExpiry: bigint;
}): TransactionInstruction {
  const auth = marketAuthorityPda(opts.obMarket);
  const exp = Buffer.alloc(8); exp.writeBigInt64LE(opts.timeExpiry);
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: opts.operator, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: opts.market, isSigner: false, isWritable: true },
      { pubkey: opts.obMarket, isSigner: true, isWritable: true },
      { pubkey: auth, isSigner: false, isWritable: false },
      { pubkey: opts.bids, isSigner: false, isWritable: true },
      { pubkey: opts.asks, isSigner: false, isWritable: true },
      { pubkey: opts.eventHeap, isSigner: false, isWritable: true },
      { pubkey: ob.ataFor(opts.yesMint, auth), isSigner: false, isWritable: true },
      { pubkey: ob.ataFor(opts.quoteMint, auth), isSigner: false, isWritable: true },
      { pubkey: opts.yesMint, isSigner: false, isWritable: false },
      { pubkey: opts.quoteMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: ATA_PID, isSigner: false, isWritable: false },
      { pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: FEE_ADMIN_SENTINEL, isSigner: false, isWritable: false },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("create_venue_market"), str(opts.name), exp]),
  });
}

const u64b = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

export function mintPairIx(user: PublicKey, market: PublicKey, qAtoms: bigint, o: {
  yesMint: PublicKey; noMint: PublicKey; collateralVault: PublicKey;
  userQuote: PublicKey; userYes: PublicKey; userNo: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: o.yesMint, isSigner: false, isWritable: true },
      { pubkey: o.noMint, isSigner: false, isWritable: true },
      { pubkey: o.collateralVault, isSigner: false, isWritable: true },
      { pubkey: o.userQuote, isSigner: false, isWritable: true },
      { pubkey: o.userYes, isSigner: false, isWritable: true },
      { pubkey: o.userNo, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("mint_pair"), u64b(qAtoms)]),
  });
}

export function redeemPairDirectIx(user: PublicKey, market: PublicKey, qAtoms: bigint, o: {
  yesMint: PublicKey; noMint: PublicKey; collateralVault: PublicKey;
  userQuote: PublicKey; userYes: PublicKey; userNo: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: o.yesMint, isSigner: false, isWritable: true },
      { pubkey: o.noMint, isSigner: false, isWritable: true },
      { pubkey: o.collateralVault, isSigner: false, isWritable: true },
      { pubkey: o.userQuote, isSigner: false, isWritable: true },
      { pubkey: o.userYes, isSigner: false, isWritable: true },
      { pubkey: o.userNo, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("redeem_pair_direct"), u64b(qAtoms)]),
  });
}

export function placeLimitOrderIx(o: {
  user: PublicKey; market: PublicKey; ooAccount: PublicKey; userTokenAccount: PublicKey;
  obMarket: PublicKey; bids: PublicKey; asks: PublicKey; eventHeap: PublicKey;
  marketVault: PublicKey; args: ob.PlaceOrderArgs;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: o.user, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: o.market, isSigner: false, isWritable: true },
      { pubkey: o.ooAccount, isSigner: false, isWritable: true },
      { pubkey: o.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: o.obMarket, isSigner: false, isWritable: true },
      { pubkey: o.bids, isSigner: false, isWritable: true },
      { pubkey: o.asks, isSigner: false, isWritable: true },
      { pubkey: o.eventHeap, isSigner: false, isWritable: true },
      { pubkey: o.marketVault, isSigner: false, isWritable: true },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("place_limit_order"), ob.encodePlaceOrderArgs(o.args)]),
  });
}

export function placeTakeOrderIx(o: {
  user: PublicKey; market: PublicKey; obMarket: PublicKey; bids: PublicKey; asks: PublicKey;
  marketBaseVault: PublicKey; marketQuoteVault: PublicKey; eventHeap: PublicKey;
  userBase: PublicKey; userQuote: PublicKey; makerOoAccounts: PublicKey[]; args: ob.PlaceTakeOrderArgs;
}): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: o.user, isSigner: true, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: false },
    { pubkey: o.market, isSigner: false, isWritable: true },
    { pubkey: o.obMarket, isSigner: false, isWritable: true },
    { pubkey: marketAuthorityPda(o.obMarket), isSigner: false, isWritable: false },
    { pubkey: o.bids, isSigner: false, isWritable: true },
    { pubkey: o.asks, isSigner: false, isWritable: true },
    { pubkey: o.marketBaseVault, isSigner: false, isWritable: true },
    { pubkey: o.marketQuoteVault, isSigner: false, isWritable: true },
    { pubkey: o.eventHeap, isSigner: false, isWritable: true },
    { pubkey: o.userBase, isSigner: false, isWritable: true },
    { pubkey: o.userQuote, isSigner: false, isWritable: true },
    { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const oo of o.makerOoAccounts) keys.push({ pubkey: oo, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys,
    data: Buffer.concat([disc("place_take_order"), ob.encodePlaceTakeOrderArgs(o.args)]),
  });
}
