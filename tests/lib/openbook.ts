/**
 * Hand-built OpenBook V2 v1.7 + M0-harness instruction builders, generated
 * from the MIT IDL (fixtures/openbook_v2_idl.json, commit 796a470033bc) and
 * account layouts only. Sizes and PDA seeds cite the pinned source.
 */
import { createHash } from "node:crypto";
import {
  AccountMeta,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * OpenBook program ID under test. v1.7's compiled-in declare_id check means
 * the unpatched artifact executes ONLY at the canonical ID; a re-ID'd copy
 * needs the documented 32-byte declare_id patch (see pin evidence file).
 */
export const OPENBOOK_PID = new PublicKey(
  process.env.OPENBOOK_PID ?? "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb",
);
export const HARNESS_PID = new PublicKey("3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr");
export const TOKEN_PID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Unsignable NUMS key used as collect_fee_admin sentinel in harness markets. */
export const FEE_ADMIN_SENTINEL = new PublicKey("1nc1nerator11111111111111111111111111111111");

/** ts/client/src/client.ts:65-66 at the pin. */
export const BOOKSIDE_SPACE = 90944 + 8;
export const EVENT_HEAP_SPACE = 91280 + 8;

export const disc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const f32le = (n: number) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const str = (s: string) => Buffer.concat([u32le(Buffer.byteLength(s)), Buffer.from(s)]);

export enum Side { Bid = 0, Ask = 1 }
export enum PlaceOrderType { Limit = 0, ImmediateOrCancel = 1, PostOnly = 2, Market = 3, PostOnlySlide = 4 }
export enum SelfTradeBehavior { DecrementTake = 0, CancelProvide = 1, AbortTransaction = 2 }

export interface PlaceOrderArgs {
  side: Side; priceLots: bigint; maxBaseLots: bigint; maxQuoteLotsIncludingFees: bigint;
  clientOrderId: bigint; orderType: PlaceOrderType; expiryTimestamp: bigint;
  selfTradeBehavior: SelfTradeBehavior; limit: number;
}
export interface PlaceTakeOrderArgs {
  side: Side; priceLots: bigint; maxBaseLots: bigint; maxQuoteLotsIncludingFees: bigint;
  orderType: PlaceOrderType; limit: number;
}

export const encodePlaceOrderArgs = (a: PlaceOrderArgs): Buffer =>
  Buffer.concat([
    Buffer.from([a.side]), i64le(a.priceLots), i64le(a.maxBaseLots),
    i64le(a.maxQuoteLotsIncludingFees), u64le(a.clientOrderId),
    Buffer.from([a.orderType]), u64le(a.expiryTimestamp),
    Buffer.from([a.selfTradeBehavior]), Buffer.from([a.limit]),
  ]);
export const encodePlaceTakeOrderArgs = (a: PlaceTakeOrderArgs): Buffer =>
  Buffer.concat([
    Buffer.from([a.side]), i64le(a.priceLots), i64le(a.maxBaseLots),
    i64le(a.maxQuoteLotsIncludingFees), Buffer.from([a.orderType]), Buffer.from([a.limit]),
  ]);

// --- PDAs -------------------------------------------------------------
/** accounts_ix/create_market.rs: seeds = ["Market", market] */
export const marketAuthorityPda = (market: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("Market"), market.toBuffer()], OPENBOOK_PID)[0];
/** anchor #[event_cpi] authority */
export const eventAuthorityPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], OPENBOOK_PID)[0];
/** accounts_ix/create_open_orders_indexer.rs */
export const ooIndexerPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("OpenOrdersIndexer"), owner.toBuffer()], OPENBOOK_PID)[0];
/** accounts_ix/create_open_orders_account.rs: index = created_counter + 1 (u32 LE) */
export const ooAccountPda = (owner: PublicKey, index: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("OpenOrders"), owner.toBuffer(), u32le(index)], OPENBOOK_PID)[0];
export const venueAuthorityPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("venue_authority")], HARNESS_PID)[0];
export const harnessConfigPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], HARNESS_PID)[0];
export const ataFor = (mint: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ATA_PID)[0];

// --- OpenBook direct instructions --------------------------------------
/** anchor 0.28 optional account: None == callee program id, read-only. */
const NONE: AccountMeta = { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false };

export function createMarketIx(opts: {
  market: PublicKey; payer: PublicKey; baseMint: PublicKey; quoteMint: PublicKey;
  bids: PublicKey; asks: PublicKey; eventHeap: PublicKey; name: string;
  quoteLotSize: bigint; baseLotSize: bigint; makerFee: bigint; takerFee: bigint;
  timeExpiry: bigint; openOrdersAdmin: PublicKey | null; closeMarketAdmin: PublicKey | null;
}): TransactionInstruction {
  const auth = marketAuthorityPda(opts.market);
  const data = Buffer.concat([
    disc("create_market"), str(opts.name),
    f32le(0.1), Buffer.from([0]), // OracleConfigParams{conf_filter, max_staleness_slots: None}
    i64le(opts.quoteLotSize), i64le(opts.baseLotSize),
    i64le(opts.makerFee), i64le(opts.takerFee), i64le(opts.timeExpiry),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: opts.market, isSigner: true, isWritable: true },
    { pubkey: auth, isSigner: false, isWritable: false },
    { pubkey: opts.bids, isSigner: false, isWritable: true },
    { pubkey: opts.asks, isSigner: false, isWritable: true },
    { pubkey: opts.eventHeap, isSigner: false, isWritable: true },
    { pubkey: opts.payer, isSigner: true, isWritable: true },
    { pubkey: ataFor(opts.baseMint, auth), isSigner: false, isWritable: true },
    { pubkey: ataFor(opts.quoteMint, auth), isSigner: false, isWritable: true },
    { pubkey: opts.baseMint, isSigner: false, isWritable: false },
    { pubkey: opts.quoteMint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    { pubkey: ATA_PID, isSigner: false, isWritable: false },
    NONE, NONE, // oracle_a, oracle_b
    { pubkey: FEE_ADMIN_SENTINEL, isSigner: false, isWritable: false },
    opts.openOrdersAdmin ? { pubkey: opts.openOrdersAdmin, isSigner: false, isWritable: false } : NONE,
    NONE, // consume_events_admin: None => permissionless crank
    opts.closeMarketAdmin ? { pubkey: opts.closeMarketAdmin, isSigner: false, isWritable: false } : NONE,
    { pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: OPENBOOK_PID, keys, data });
}

export const bookAccountIx = (payer: PublicKey, acc: Keypair, space: number, lamports: number) =>
  SystemProgram.createAccount({
    fromPubkey: payer, newAccountPubkey: acc.publicKey,
    lamports, space, programId: OPENBOOK_PID,
  });

export function createOoIndexerIx(payer: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: ooIndexerPda(owner), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("create_open_orders_indexer"),
  });
}

export function createOoAccountIx(payer: PublicKey, owner: PublicKey, index: number, market: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      NONE, // delegate: None
      { pubkey: ooIndexerPda(owner), isSigner: false, isWritable: true },
      { pubkey: ooAccountPda(owner, index), isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("create_open_orders_account"), str(`oo-${index}`)]),
  });
}

/** DIRECT place_order — the G2 negative path. adminMeta controls the bypass shape. */
export function directPlaceOrderIx(opts: {
  signer: PublicKey; ooAccount: PublicKey; userTokenAccount: PublicKey;
  market: PublicKey; bids: PublicKey; asks: PublicKey; eventHeap: PublicKey;
  marketVault: PublicKey; adminMeta: AccountMeta; args: PlaceOrderArgs;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [
      { pubkey: opts.signer, isSigner: true, isWritable: false },
      { pubkey: opts.ooAccount, isSigner: false, isWritable: true },
      opts.adminMeta,
      { pubkey: opts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: opts.market, isSigner: false, isWritable: true },
      { pubkey: opts.bids, isSigner: false, isWritable: true },
      { pubkey: opts.asks, isSigner: false, isWritable: true },
      { pubkey: opts.eventHeap, isSigner: false, isWritable: true },
      { pubkey: opts.marketVault, isSigner: false, isWritable: true },
      NONE, NONE,
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("place_order"), encodePlaceOrderArgs(opts.args)]),
  });
}

/** DIRECT place_take_order — G2 negative path for the take side. */
export function directPlaceTakeOrderIx(opts: {
  signer: PublicKey; market: PublicKey; bids: PublicKey; asks: PublicKey;
  eventHeap: PublicKey; marketBaseVault: PublicKey; marketQuoteVault: PublicKey;
  userBaseAccount: PublicKey; userQuoteAccount: PublicKey;
  adminMeta: AccountMeta; args: PlaceTakeOrderArgs;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [
      { pubkey: opts.signer, isSigner: true, isWritable: true },
      { pubkey: opts.signer, isSigner: true, isWritable: true }, // penalty_payer
      { pubkey: opts.market, isSigner: false, isWritable: true },
      { pubkey: marketAuthorityPda(opts.market), isSigner: false, isWritable: false },
      { pubkey: opts.bids, isSigner: false, isWritable: true },
      { pubkey: opts.asks, isSigner: false, isWritable: true },
      { pubkey: opts.marketBaseVault, isSigner: false, isWritable: true },
      { pubkey: opts.marketQuoteVault, isSigner: false, isWritable: true },
      { pubkey: opts.eventHeap, isSigner: false, isWritable: true },
      { pubkey: opts.userBaseAccount, isSigner: false, isWritable: true },
      { pubkey: opts.userQuoteAccount, isSigner: false, isWritable: true },
      NONE, NONE,
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      opts.adminMeta,
    ],
    data: Buffer.concat([disc("place_take_order"), encodePlaceTakeOrderArgs(opts.args)]),
  });
}

// --- Harness instructions ----------------------------------------------
/** Mock settlement-delivery feed PDA (harness), one per ticker. */
export const mockFeedPda = (tickerId: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("mock_feed"), Buffer.from([tickerId])], HARNESS_PID)[0];

/** Publish an Official Close to a ticker's mock feed; Meridian reads it back. */
export function publishMockFeedIx(payer: PublicKey, tickerId: number, price1e6: bigint): TransactionInstruction {
  const data = Buffer.concat([disc("publish_mock_feed"), Buffer.from([tickerId]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(price1e6); return b; })()]);
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: mockFeedPda(tickerId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function harnessInitializeIx(admin: PublicKey, quoteMint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: harnessConfigPda(), isSigner: false, isWritable: true },
      { pubkey: venueAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("initialize"),
  });
}

export function harnessPlaceLimitOrderIx(opts: {
  user: PublicKey; ooAccount: PublicKey; userTokenAccount: PublicKey;
  market: PublicKey; bids: PublicKey; asks: PublicKey; eventHeap: PublicKey;
  marketVault: PublicKey; args: PlaceOrderArgs;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: opts.user, isSigner: true, isWritable: false },
      { pubkey: harnessConfigPda(), isSigner: false, isWritable: false },
      { pubkey: venueGatePda(opts.market), isSigner: false, isWritable: false },
      { pubkey: venueAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: opts.ooAccount, isSigner: false, isWritable: true },
      { pubkey: opts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: opts.market, isSigner: false, isWritable: true },
      { pubkey: opts.bids, isSigner: false, isWritable: true },
      { pubkey: opts.asks, isSigner: false, isWritable: true },
      { pubkey: opts.eventHeap, isSigner: false, isWritable: true },
      { pubkey: opts.marketVault, isSigner: false, isWritable: true },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("place_limit_order"), encodePlaceOrderArgs(opts.args)]),
  });
}

export function harnessPlaceTakeOrderIx(opts: {
  user: PublicKey; market: PublicKey; bids: PublicKey; asks: PublicKey;
  eventHeap: PublicKey; marketBaseVault: PublicKey; marketQuoteVault: PublicKey;
  userBaseAccount: PublicKey; userQuoteAccount: PublicKey;
  makerOoAccounts: PublicKey[]; args: PlaceTakeOrderArgs;
}): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: opts.user, isSigner: true, isWritable: true },
    { pubkey: harnessConfigPda(), isSigner: false, isWritable: false },
    { pubkey: venueGatePda(opts.market), isSigner: false, isWritable: false },
    { pubkey: venueAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: opts.market, isSigner: false, isWritable: true },
    { pubkey: marketAuthorityPda(opts.market), isSigner: false, isWritable: false },
    { pubkey: opts.bids, isSigner: false, isWritable: true },
    { pubkey: opts.asks, isSigner: false, isWritable: true },
    { pubkey: opts.marketBaseVault, isSigner: false, isWritable: true },
    { pubkey: opts.marketQuoteVault, isSigner: false, isWritable: true },
    { pubkey: opts.eventHeap, isSigner: false, isWritable: true },
    { pubkey: opts.userBaseAccount, isSigner: false, isWritable: true },
    { pubkey: opts.userQuoteAccount, isSigner: false, isWritable: true },
    { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const oo of opts.makerOoAccounts) keys.push({ pubkey: oo, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys,
    data: Buffer.concat([disc("place_take_order"), encodePlaceTakeOrderArgs(opts.args)]),
  });
}

// --- G3 additions ------------------------------------------------------
export const venueGatePda = (market: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("venue_gate"), market.toBuffer()], HARNESS_PID)[0];

export function harnessCreateVenueGateIx(
  admin: PublicKey, market: PublicKey, tradeOpenTs: bigint, closeTs: bigint,
  rentRefund: PublicKey, // ADR-0027 snapshot — always explicit, never defaulted
): TransactionInstruction {
  const data = Buffer.concat([disc("create_venue_gate"), i64le(tradeOpenTs), i64le(closeTs), rentRefund.toBuffer()]);
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: harnessConfigPda(), isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: venueGatePda(market), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function harnessSetPausedIx(admin: PublicKey, market: PublicKey, paused: boolean): TransactionInstruction {
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: harnessConfigPda(), isSigner: false, isWritable: false },
      { pubkey: venueGatePda(market), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("set_paused"), Buffer.from([paused ? 1 : 0])]),
  });
}

export function harnessExpireMarketIx(admin: PublicKey, market: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: harnessConfigPda(), isSigner: false, isWritable: false },
      { pubkey: venueAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: disc("expire_market"),
  });
}

/** DIRECT set_market_expired — negative-path builder (G3). */
export function directSetMarketExpiredIx(closeMarketAdmin: PublicKey, market: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [
      { pubkey: closeMarketAdmin, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
    ],
    data: disc("set_market_expired"),
  });
}

/** Cancel one order by its venue-returned u128 id (owner-signed). */
export function cancelOrderIx(owner: PublicKey, ooAccount: PublicKey, market: PublicKey, bidsAcc: PublicKey, asksAcc: PublicKey, orderId: bigint): TransactionInstruction {
  const data = Buffer.alloc(24);
  disc("cancel_order").copy(data);
  data.writeBigUInt64LE(orderId & 0xffffffffffffffffn, 8);
  data.writeBigUInt64LE(orderId >> 64n, 16);
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: ooAccount, isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: bidsAcc, isSigner: false, isWritable: true },
      { pubkey: asksAcc, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Recovery path: owner-signed, never gated by the harness. */
export function cancelAllOrdersIx(owner: PublicKey, ooAccount: PublicKey, market: PublicKey, bids: PublicKey, asks: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: ooAccount, isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: bids, isSigner: false, isWritable: true },
      { pubkey: asks, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("cancel_all_orders"), Buffer.from([0]), Buffer.from([255])]), // side: None, limit 255
  });
}

/** Recovery path: settle free funds back to the user. Referrer forced to None. */
export function settleFundsIx(opts: {
  owner: PublicKey; ooAccount: PublicKey; market: PublicKey;
  marketBaseVault: PublicKey; marketQuoteVault: PublicKey;
  userBaseAccount: PublicKey; userQuoteAccount: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [
      { pubkey: opts.owner, isSigner: true, isWritable: true },
      { pubkey: opts.owner, isSigner: true, isWritable: true }, // penalty_payer
      { pubkey: opts.ooAccount, isSigner: false, isWritable: true },
      { pubkey: opts.market, isSigner: false, isWritable: true },
      { pubkey: marketAuthorityPda(opts.market), isSigner: false, isWritable: false },
      { pubkey: opts.marketBaseVault, isSigner: false, isWritable: true },
      { pubkey: opts.marketQuoteVault, isSigner: false, isWritable: true },
      { pubkey: opts.userBaseAccount, isSigner: false, isWritable: true },
      { pubkey: opts.userQuoteAccount, isSigner: false, isWritable: true },
      NONE, // referrer: None
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("settle_funds"),
  });
}

/** Pinned Market byte offsets (state/market.rs field order; OracleConfig = 88). */
export const MARKET_TIME_EXPIRY_OFFSET = 48;
export const MARKET_COLLECT_FEE_ADMIN_OFFSET = 56;
export const MARKET_OPEN_ORDERS_ADMIN_OFFSET = 88;
export const MARKET_CONSUME_EVENTS_ADMIN_OFFSET = 120;
export const MARKET_CLOSE_MARKET_ADMIN_OFFSET = 152;
export const MARKET_QUOTE_LOT_SIZE_OFFSET = 448;
export const MARKET_BASE_LOT_SIZE_OFFSET = 456;
export const MARKET_MAKER_FEE_OFFSET = 480;
export const MARKET_TAKER_FEE_OFFSET = 488;
export const MARKET_FEES_ACCRUED_OFFSET = 496;      // u128
export const MARKET_FEES_TO_REFERRERS_OFFSET = 512; // u128
export const MARKET_REFERRER_REBATES_OFFSET = 528;  // u64
export const MARKET_FEES_AVAILABLE_OFFSET = 536;    // u64
/** Market.time_expiry lives at offset 48: 8 disc + bump,base_dec,quote_dec,padding1[5] (=8) + market_authority (32). */
export const readTimeExpiry = (marketData: Buffer): bigint => marketData.readBigInt64LE(48);

/** Permissionless crank (consume_events_admin = None on harness Venue Markets).
 * At the pin (instructions/consume_events.rs): limit caps at
 * MAX_EVENTS_CONSUME = 8; each event's owner OpenOrders account MUST be in
 * remaining accounts or the event is SKIPPED (left on the heap); args carry a
 * trailing slots: Option<Vec<usize>> (None here). */
export function consumeEventsIx(market: PublicKey, eventHeap: PublicKey, limit: bigint, ownerOos: PublicKey[]): TransactionInstruction {
  const data = Buffer.alloc(17);
  disc("consume_events").copy(data);
  data.writeBigUInt64LE(limit, 8);
  data[16] = 0; // slots: None
  const keys = [
    NONE, // consume_events_admin: None => permissionless
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: eventHeap, isSigner: false, isWritable: true },
    ...ownerOos.map(k => ({ pubkey: k, isSigner: false, isWritable: true })),
  ];
  return new TransactionInstruction({ programId: OPENBOOK_PID, keys, data });
}

export function harnessPruneOrdersIx(admin: PublicKey, opts: {
  ooAccount: PublicKey; market: PublicKey; bids: PublicKey; asks: PublicKey; limit: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: harnessConfigPda(), isSigner: false, isWritable: false },
      { pubkey: venueAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: opts.ooAccount, isSigner: false, isWritable: true },
      { pubkey: opts.market, isSigner: false, isWritable: false },
      { pubkey: opts.bids, isSigner: false, isWritable: true },
      { pubkey: opts.asks, isSigner: false, isWritable: true },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("prune_orders"), Buffer.from([opts.limit])]),
  });
}

export function harnessCloseVenueMarketIx(admin: PublicKey, opts: {
  market: PublicKey; bids: PublicKey; asks: PublicKey; eventHeap: PublicKey;
  solDestination: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: harnessConfigPda(), isSigner: false, isWritable: false },
      { pubkey: venueGatePda(opts.market), isSigner: false, isWritable: false },
      { pubkey: venueAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: opts.market, isSigner: false, isWritable: true },
      { pubkey: opts.bids, isSigner: false, isWritable: true },
      { pubkey: opts.asks, isSigner: false, isWritable: true },
      { pubkey: opts.eventHeap, isSigner: false, isWritable: true },
      { pubkey: opts.solDestination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: disc("close_venue_market"),
  });
}

/** Owner-signed OO cleanup: rent back to the owner's chosen destination. */
export function closeOoAccountIx(owner: PublicKey, indexer: PublicKey, ooAccount: PublicKey, solDestination: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: indexer, isSigner: false, isWritable: true },
      { pubkey: ooAccount, isSigner: false, isWritable: true },
      { pubkey: solDestination, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("close_open_orders_account"),
  });
}

// --- G5: pair collateral model -----------------------------------------
export const pairVaultPda = (market: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("pair_vault"), market.toBuffer()], HARNESS_PID)[0];

export function harnessInitPairIx(admin: PublicKey, opts: {
  market: PublicKey; yesMint: PublicKey; noMint: PublicKey; quoteVault: PublicKey;
  metadataHash?: Buffer; // 32 bytes; defaults to a test-vector hash
}): TransactionInstruction {
  const mh = opts.metadataHash ?? Buffer.alloc(32, 7);
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: harnessConfigPda(), isSigner: false, isWritable: false },
      { pubkey: opts.market, isSigner: false, isWritable: false },
      { pubkey: pairVaultPda(opts.market), isSigner: false, isWritable: true },
      { pubkey: opts.yesMint, isSigner: false, isWritable: false },
      { pubkey: opts.noMint, isSigner: false, isWritable: false },
      { pubkey: opts.quoteVault, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("init_pair"), mh]),
  });
}

const u64buf = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

function pairAccounts(user: PublicKey, market: PublicKey, opts: {
  yesMint: PublicKey; noMint: PublicKey; quoteVault: PublicKey;
  userQuote: PublicKey; userYes: PublicKey; userNo: PublicKey;
}) {
  return [
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: pairVaultPda(market), isSigner: false, isWritable: true },
    { pubkey: opts.yesMint, isSigner: false, isWritable: true },
    { pubkey: opts.noMint, isSigner: false, isWritable: true },
    { pubkey: opts.quoteVault, isSigner: false, isWritable: true },
    { pubkey: opts.userQuote, isSigner: false, isWritable: true },
    { pubkey: opts.userYes, isSigner: false, isWritable: true },
    { pubkey: opts.userNo, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
  ];
}

export function harnessMintPairIx(user: PublicKey, market: PublicKey, qAtoms: bigint, opts: Parameters<typeof pairAccounts>[2]): TransactionInstruction {
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: pairAccounts(user, market, opts),
    data: Buffer.concat([disc("mint_pair"), u64buf(qAtoms)]),
  });
}

export function harnessRedeemPairDirectIx(user: PublicKey, market: PublicKey, qAtoms: bigint, opts: Parameters<typeof pairAccounts>[2]): TransactionInstruction {
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: pairAccounts(user, market, opts),
    data: Buffer.concat([disc("redeem_pair_direct"), u64buf(qAtoms)]),
  });
}

export function harnessRedeemNoViaMarketIx(user: PublicKey, opts: {
  market: PublicKey; yesMint: PublicKey; noMint: PublicKey; quoteVault: PublicKey;
  tradeYesAta: PublicKey; userQuote: PublicKey; userNo: PublicKey;
  bids: PublicKey; asks: PublicKey; eventHeap: PublicKey;
  marketBaseVault: PublicKey; marketQuoteVault: PublicKey;
  makerOoAccounts: PublicKey[]; qLots: bigint; priceLots: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(24);
  disc("redeem_no_via_market").copy(data);
  data.writeBigInt64LE(opts.qLots, 8);
  data.writeBigInt64LE(opts.priceLots, 16);
  const keys = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: harnessConfigPda(), isSigner: false, isWritable: false },
    { pubkey: venueGatePda(opts.market), isSigner: false, isWritable: false },
    { pubkey: venueAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: pairVaultPda(opts.market), isSigner: false, isWritable: true },
    { pubkey: opts.yesMint, isSigner: false, isWritable: true },
    { pubkey: opts.noMint, isSigner: false, isWritable: true },
    { pubkey: opts.quoteVault, isSigner: false, isWritable: true },
    { pubkey: opts.tradeYesAta, isSigner: false, isWritable: true },
    { pubkey: opts.userQuote, isSigner: false, isWritable: true },
    { pubkey: opts.userNo, isSigner: false, isWritable: true },
    { pubkey: opts.market, isSigner: false, isWritable: true },
    { pubkey: marketAuthorityPda(opts.market), isSigner: false, isWritable: false },
    { pubkey: opts.bids, isSigner: false, isWritable: true },
    { pubkey: opts.asks, isSigner: false, isWritable: true },
    { pubkey: opts.marketBaseVault, isSigner: false, isWritable: true },
    { pubkey: opts.marketQuoteVault, isSigner: false, isWritable: true },
    { pubkey: opts.eventHeap, isSigner: false, isWritable: true },
    { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const oo of opts.makerOoAccounts) keys.push({ pubkey: oo, isSigner: false, isWritable: true });
  return new TransactionInstruction({ programId: HARNESS_PID, keys, data });
}

/** Builder-side knowing-self-cross check (G5): scan the user's own OpenOrders
 * for resting asks at or below the intended buy price.
 *
 * OpenOrder layout at the pin (state/open_orders_account.rs:426-438, size
 * assert 40): id u128 @0, client_id u64 @16, locked_price i64 @24,
 * is_free u8 @32, side_and_tree u8 @33, padding[6]. `open_orders[24]` is the
 * LAST field of OpenOrdersAccount (line 36), so the array is tail-anchored.
 * Asks have odd side_and_tree (AskFixed=1, AskOraclePegged=3); V1 builders
 * never place pegged orders, and both variants are odd regardless. */
export function wouldKnowinglySelfCross(ooData: Buffer, side: "buy", priceLots: bigint): boolean {
  const OO_ARRAY_TAIL = ooData.length - 24 * 40;
  for (let i = 0; i < 24; i++) {
    const off = OO_ARRAY_TAIL + i * 40;
    const isFree = ooData[off + 32];
    const sideAndTree = ooData[off + 33];
    const lockedPrice = ooData.readBigInt64LE(off + 24);
    if (isFree === 0 && (sideAndTree & 1) === 1 && lockedPrice <= priceLots) return true;
  }
  return false;
}

/** The G5 builder rule made executable: detect a knowing self-cross and route
 * to direct Pair Redemption instead of the market-assisted path. */
export function chooseSellNoRoute(ooData: Buffer, priceLots: bigint): "market" | "direct-pair-redemption" {
  return wouldKnowinglySelfCross(ooData, "buy", priceLots) ? "direct-pair-redemption" : "market";
}

/** EventHeap header: free_head u16 @8, used_head u16 @10, count u16 @12. */
export const EVENT_HEAP_COUNT_OFFSET = 12;
export const MAX_NUM_EVENTS = 600;       // heap.rs:9
export const MAX_EVENTS_CONSUME = 8;     // consume_events.rs:11
export const PRACTICAL_INLINE_FILLS = 11; // G6-measured SBF-heap bound (contiguous probe)
