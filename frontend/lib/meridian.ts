import {
  AccountMeta, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";

export const MERIDIAN = new PublicKey(process.env.NEXT_PUBLIC_MERIDIAN ?? "FF6mu5FFb1q1Qz88x1HnhkePdF8Q1dXWnTfUUSkzUT3t");
export const OPENBOOK = new PublicKey("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb");
export const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const DISC: Record<string, number[]> = {
  mint_pair: [19, 149, 94, 110, 181, 186, 33, 107],
  place_limit_order: [108, 176, 33, 186, 146, 229, 1, 197],
  place_take_order: [3, 44, 71, 3, 26, 199, 203, 85],
  redeem_pair_direct: [244, 116, 20, 210, 39, 49, 85, 1],
  redeem_winning: [191, 44, 57, 7, 31, 46, 190, 162],
  redeem_no_via_market: [35, 188, 183, 140, 192, 85, 133, 122],
  create_open_orders_indexer: [64, 64, 153, 255, 217, 71, 249, 133],
  create_open_orders_account: [204, 181, 175, 222, 40, 125, 188, 71],
};
const disc = (n: string) => Buffer.from(DISC[n]);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };

export const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN)[0];
export const ataFor = (mint: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
export const ooIndexerPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("OpenOrdersIndexer"), owner.toBuffer()], OPENBOOK)[0];
export const ooAccountPda = (owner: PublicKey, index: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("OpenOrders"), owner.toBuffer(), u32(index)], OPENBOOK)[0];
export const marketAuthorityPda = (obMarket: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("Market"), obMarket.toBuffer()], OPENBOOK)[0];

export const createAtaIx = (payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction =>
  new TransactionInstruction({
    programId: ATA,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataFor(mint, owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });

export function mintPairIx(user: PublicKey, market: PublicKey, q: bigint, o: {
  yesMint: PublicKey; noMint: PublicKey; collateralVault: PublicKey;
  userQuote: PublicKey; userYes: PublicKey; userNo: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN,
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
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("mint_pair"), u64(q)]),
  });
}

export function redeemPairDirectIx(user: PublicKey, market: PublicKey, q: bigint, o: {
  yesMint: PublicKey; noMint: PublicKey; collateralVault: PublicKey;
  userQuote: PublicKey; userYes: PublicKey; userNo: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN,
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: o.yesMint, isSigner: false, isWritable: true },
      { pubkey: o.noMint, isSigner: false, isWritable: true },
      { pubkey: o.collateralVault, isSigner: false, isWritable: true },
      { pubkey: o.userQuote, isSigner: false, isWritable: true },
      { pubkey: o.userYes, isSigner: false, isWritable: true },
      { pubkey: o.userNo, isSigner: false, isWritable: true },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("redeem_pair_direct"), u64(q)]),
  });
}

export function redeemWinningIx(user: PublicKey, market: PublicKey, winningMint: PublicKey, o: {
  collateralVault: PublicKey; userWinning: PublicKey; userQuote: PublicKey; amount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN,
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: winningMint, isSigner: false, isWritable: true },
      { pubkey: o.collateralVault, isSigner: false, isWritable: true },
      { pubkey: o.userWinning, isSigner: false, isWritable: true },
      { pubkey: o.userQuote, isSigner: false, isWritable: true },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("redeem_winning"), u64(o.amount)]),
  });
}

/** OpenOrders indexer + account (needed once per user per venue). */
export function createOoIxs(payer: PublicKey, obMarket: PublicKey): TransactionInstruction[] {
  const idxr = ooIndexerPda(payer);
  const acct = ooAccountPda(payer, 1);
  const none = { pubkey: OPENBOOK, isSigner: false, isWritable: false };
  const nameStr = (s: string) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  return [
    new TransactionInstruction({ programId: OPENBOOK, keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: idxr, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data: disc("create_open_orders_indexer") }),
    new TransactionInstruction({ programId: OPENBOOK, keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      none,
      { pubkey: idxr, isSigner: false, isWritable: true },
      { pubkey: acct, isSigner: false, isWritable: true },
      { pubkey: obMarket, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data: Buffer.concat([disc("create_open_orders_account"), nameStr("oo-1")]) }),
  ];
}

export enum Side { Bid = 0, Ask = 1 }
export enum OrderType { Limit = 0, ImmediateOrCancel = 1, PostOnly = 2 }
export enum STB { DecrementTake = 0, CancelProvide = 1, AbortTransaction = 2 }

function encPlaceOrder(a: { side: Side; priceLots: bigint; maxBaseLots: bigint; maxQuote: bigint; clientId: bigint; orderType: OrderType; stb: STB; limit: number }): Buffer {
  return Buffer.concat([
    Buffer.from([a.side]), i64(a.priceLots), i64(a.maxBaseLots), i64(a.maxQuote), u64(a.clientId),
    Buffer.from([a.orderType]), u64(0n), Buffer.from([a.stb]), Buffer.from([a.limit]),
  ]);
}
function encTake(a: { side: Side; priceLots: bigint; maxBaseLots: bigint; maxQuote: bigint; orderType: OrderType; limit: number }): Buffer {
  return Buffer.concat([
    Buffer.from([a.side]), i64(a.priceLots), i64(a.maxBaseLots), i64(a.maxQuote),
    Buffer.from([a.orderType]), Buffer.from([a.limit]),
  ]);
}

export function placeLimitOrderIx(o: {
  user: PublicKey; market: PublicKey; obMarket: PublicKey; bids: PublicKey; asks: PublicKey;
  eventHeap: PublicKey; marketVault: PublicKey; userTokenAccount: PublicKey; ooAccount: PublicKey;
  side: Side; priceLots: bigint; baseLots: bigint;
}): TransactionInstruction {
  const args = encPlaceOrder({ side: o.side, priceLots: o.priceLots, maxBaseLots: o.baseLots,
    maxQuote: o.priceLots * o.baseLots, clientId: BigInt(Date.now()), orderType: OrderType.PostOnly,
    stb: STB.AbortTransaction, limit: 16 });
  return new TransactionInstruction({
    programId: MERIDIAN,
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
      { pubkey: OPENBOOK, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("place_limit_order"), args]),
  });
}

export function placeTakeOrderIx(o: {
  user: PublicKey; market: PublicKey; obMarket: PublicKey; bids: PublicKey; asks: PublicKey;
  baseVault: PublicKey; quoteVault: PublicKey; eventHeap: PublicKey; userBase: PublicKey; userQuote: PublicKey;
  makerOos: PublicKey[]; side: Side; priceLots: bigint; baseLots: bigint;
}): TransactionInstruction {
  const args = encTake({ side: o.side, priceLots: o.priceLots, maxBaseLots: o.baseLots,
    maxQuote: o.priceLots * o.baseLots, orderType: OrderType.ImmediateOrCancel, limit: 16 });
  const keys: AccountMeta[] = [
    { pubkey: o.user, isSigner: true, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: false },
    { pubkey: o.market, isSigner: false, isWritable: true },
    { pubkey: o.obMarket, isSigner: false, isWritable: true },
    { pubkey: marketAuthorityPda(o.obMarket), isSigner: false, isWritable: false },
    { pubkey: o.bids, isSigner: false, isWritable: true },
    { pubkey: o.asks, isSigner: false, isWritable: true },
    { pubkey: o.baseVault, isSigner: false, isWritable: true },
    { pubkey: o.quoteVault, isSigner: false, isWritable: true },
    { pubkey: o.eventHeap, isSigner: false, isWritable: true },
    { pubkey: o.userBase, isSigner: false, isWritable: true },
    { pubkey: o.userQuote, isSigner: false, isWritable: true },
    { pubkey: OPENBOOK, isSigner: false, isWritable: false },
    { pubkey: TOKEN, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const oo of o.makerOos) keys.push({ pubkey: oo, isSigner: false, isWritable: true });
  return new TransactionInstruction({ programId: MERIDIAN, keys, data: Buffer.concat([disc("place_take_order"), args]) });
}

export const tradeYesAta = (market: PublicKey, yesMint: PublicKey) => ataFor(yesMint, market);

/** Idempotent-create the program Yes-trade ATA (owner = market PDA). */
export function createTradeAtaIx(payer: PublicKey, market: PublicKey, yesMint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataFor(yesMint, market), isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: yesMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

export function redeemNoViaMarketIx(user: PublicKey, o: {
  market: PublicKey; yesMint: PublicKey; noMint: PublicKey; collateralVault: PublicKey;
  userQuote: PublicKey; userNo: PublicKey; obMarket: PublicKey; bids: PublicKey; asks: PublicKey;
  baseVault: PublicKey; quoteVault: PublicKey; eventHeap: PublicKey;
  makerOos: PublicKey[]; qLots: bigint; priceLots: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(24);
  Buffer.from(DISC.redeem_no_via_market ?? []).copy(data);
  data.writeBigInt64LE(o.qLots, 8); data.writeBigInt64LE(o.priceLots, 16);
  const keys: AccountMeta[] = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: false },
    { pubkey: o.market, isSigner: false, isWritable: true },
    { pubkey: o.yesMint, isSigner: false, isWritable: true },
    { pubkey: o.noMint, isSigner: false, isWritable: true },
    { pubkey: o.collateralVault, isSigner: false, isWritable: true },
    { pubkey: ataFor(o.yesMint, o.market), isSigner: false, isWritable: true },
    { pubkey: o.userQuote, isSigner: false, isWritable: true },
    { pubkey: o.userNo, isSigner: false, isWritable: true },
    { pubkey: o.obMarket, isSigner: false, isWritable: true },
    { pubkey: marketAuthorityPda(o.obMarket), isSigner: false, isWritable: false },
    { pubkey: o.bids, isSigner: false, isWritable: true },
    { pubkey: o.asks, isSigner: false, isWritable: true },
    { pubkey: o.baseVault, isSigner: false, isWritable: true },
    { pubkey: o.quoteVault, isSigner: false, isWritable: true },
    { pubkey: o.eventHeap, isSigner: false, isWritable: true },
    { pubkey: OPENBOOK, isSigner: false, isWritable: false },
    { pubkey: TOKEN, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const oo of o.makerOos) keys.push({ pubkey: oo, isSigner: false, isWritable: true });
  return new TransactionInstruction({ programId: MERIDIAN, keys, data });
}
