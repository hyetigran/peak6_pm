/** Meridian program instruction builders (anchor-compatible; no IDL client). */
import { createHash } from "node:crypto";
import {
  AccountMeta, PublicKey, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";

export const MERIDIAN_PID = new PublicKey("HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD");
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
  oracleProgram?: PublicKey; // owner Meridian pins the feed to (harness mock on localnet, the Pyth adapter on devnet)
}): TransactionInstruction {
  const z = Buffer.alloc(32);
  const oracle = (opts.oracleProgram ?? PublicKey.default).toBuffer();
  const data = Buffer.concat([
    disc("register_transport"), u32(opts.versionId), u8(opts.tickerId),
    oracle, z, u64(0n), z, z, opts.feed.toBuffer(), z, u16(1), u16(1), u32(0),
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

export const TOKEN_METADATA_PID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
export const metadataPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PID.toBuffer(), mint.toBuffer()], TOKEN_METADATA_PID)[0];

export function publishMetadataIx(o: {
  operator: PublicKey; market: PublicKey; yesMint: PublicKey; noMint: PublicKey;
  yesName: string; yesSymbol: string; noName: string; noSymbol: string; uri: string;
}): TransactionInstruction {
  const data = Buffer.concat([
    disc("publish_metadata"), str(o.yesName), str(o.yesSymbol), str(o.noName), str(o.noSymbol), str(o.uri),
  ]);
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: o.operator, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: o.market, isSigner: false, isWritable: false },
      { pubkey: o.yesMint, isSigner: false, isWritable: false },
      { pubkey: o.noMint, isSigner: false, isWritable: false },
      { pubkey: metadataPda(o.yesMint), isSigner: false, isWritable: true },
      { pubkey: metadataPda(o.noMint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_METADATA_PID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
    ],
    data,
  });
}

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

export const tradeYesAtaFor = (market: PublicKey, yesMint: PublicKey) => ob.ataFor(yesMint, market);

export function redeemNoViaMarketIx(user: PublicKey, o: {
  market: PublicKey; yesMint: PublicKey; noMint: PublicKey; collateralVault: PublicKey;
  userQuote: PublicKey; userNo: PublicKey; obMarket: PublicKey; bids: PublicKey; asks: PublicKey;
  marketBaseVault: PublicKey; marketQuoteVault: PublicKey; eventHeap: PublicKey;
  makerOos: PublicKey[]; qLots: bigint; priceLots: bigint;
}): TransactionInstruction {
  const auth = marketAuthorityPda(o.obMarket);
  const tradeYesAta = ob.ataFor(o.yesMint, o.market);
  const data = Buffer.alloc(24);
  disc("redeem_no_via_market").copy(data);
  data.writeBigInt64LE(o.qLots, 8);
  data.writeBigInt64LE(o.priceLots, 16);
  const keys = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: false },
    { pubkey: o.market, isSigner: false, isWritable: true },
    { pubkey: o.yesMint, isSigner: false, isWritable: true },
    { pubkey: o.noMint, isSigner: false, isWritable: true },
    { pubkey: o.collateralVault, isSigner: false, isWritable: true },
    { pubkey: tradeYesAta, isSigner: false, isWritable: true },
    { pubkey: o.userQuote, isSigner: false, isWritable: true },
    { pubkey: o.userNo, isSigner: false, isWritable: true },
    { pubkey: o.obMarket, isSigner: false, isWritable: true },
    { pubkey: auth, isSigner: false, isWritable: false },
    { pubkey: o.bids, isSigner: false, isWritable: true },
    { pubkey: o.asks, isSigner: false, isWritable: true },
    { pubkey: o.marketBaseVault, isSigner: false, isWritable: true },
    { pubkey: o.marketQuoteVault, isSigner: false, isWritable: true },
    { pubkey: o.eventHeap, isSigner: false, isWritable: true },
    { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const oo of o.makerOos) keys.push({ pubkey: oo, isSigner: false, isWritable: true });
  return new TransactionInstruction({ programId: MERIDIAN_PID, keys, data });
}

// --- Venue closure / rent recycling (ADR-0027) --------------------------
// Both permissionless: the OutcomeMarket PDA signs as OpenBook close_market_admin.

/** OutcomeMarket byte offsets the venue-close path needs (state/market.rs order). */
export const OUTCOME_MARKET_VENUE_OFFSETS = {
  OPENBOOK_MARKET: 274, BIDS: 338, ASKS: 370, EVENT_HEAP: 402,
  VENUE_RENT_REFUND: 563, VENUE_CLOSED_TS: 603,
} as const;
export const readVenueRefundAddress = (d: Buffer): PublicKey =>
  new PublicKey(d.subarray(OUTCOME_MARKET_VENUE_OFFSETS.VENUE_RENT_REFUND, OUTCOME_MARKET_VENUE_OFFSETS.VENUE_RENT_REFUND + 32));
export const readVenueClosedTs = (d: Buffer): bigint => d.readBigInt64LE(OUTCOME_MARKET_VENUE_OFFSETS.VENUE_CLOSED_TS);

/** prune_venue_orders(limit): cancel one OpenOrders account's resting orders on a
 *  Settled/Abandoned market (expires the venue first if needed). */
export function pruneVenueOrdersIx(o: {
  market: PublicKey; obMarket: PublicKey; ooAccount: PublicKey; bids: PublicKey; asks: PublicKey; limit?: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: o.market, isSigner: false, isWritable: false },
      { pubkey: o.obMarket, isSigner: false, isWritable: true },
      { pubkey: o.ooAccount, isSigner: false, isWritable: true },
      { pubkey: o.bids, isSigner: false, isWritable: true },
      { pubkey: o.asks, isSigner: false, isWritable: true },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("prune_venue_orders"), Buffer.from([o.limit ?? 255])]),
  });
}

/** close_venue: reclaim OpenBook market/bids/asks/heap rent to the snapshotted
 *  venue_rent_refund_address (the program rejects any other destination). */
export function closeVenueIx(o: {
  market: PublicKey; obMarket: PublicKey; bids: PublicKey; asks: PublicKey; eventHeap: PublicKey; solDestination: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: o.market, isSigner: false, isWritable: true },
      { pubkey: o.obMarket, isSigner: false, isWritable: true },
      { pubkey: o.bids, isSigner: false, isWritable: true },
      { pubkey: o.asks, isSigner: false, isWritable: true },
      { pubkey: o.eventHeap, isSigner: false, isWritable: true },
      { pubkey: o.solDestination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: disc("close_venue"),
  });
}
