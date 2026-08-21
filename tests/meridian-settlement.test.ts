/**
 * Meridian settlement lifecycle (localnet, localnet-featured build): create ->
 * mint -> finalize the shared Settlement Record -> settle the Outcome Market
 * (derive the winner) -> Outcome Redemption of the winning token for $1.
 * Timing floors are relaxed by the `localnet` build feature; the record
 * CONTRACT and outcome derivation are the real ones.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import * as m from "./lib/meridian.js";
import * as ob from "./lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const gov = Keypair.generate(), operator = Keypair.generate(), alice = Keypair.generate();
let quoteMint: PublicKey, market: PublicKey, yesMint: PublicKey, noMint: PublicKey, vault: PublicKey;
let feed: PublicKey;
let aliceQuote: PublicKey, aliceYes: PublicKey, aliceNo: PublicKey;
const OPENBOOK_PROGRAMDATA = new PublicKey("DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB");
const AAPL = 1, DAY = 20260822, STRIKE = 230_000_000n;
const MSFT = 5, MSFT_STRIKE = 500_000_000n; // negative-owner case
const WRONG_ORACLE = Keypair.generate().publicKey; // not the harness => owner mismatch
let CLOSE = 0n;
const LOT = 1_000_000n;

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  return sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
}
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };

function finalizeNormalIx(cranker: PublicKey, close1e6: bigint, slot: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.MERIDIAN_PID,
    keys: [
      { pubkey: cranker, isSigner: true, isWritable: true },
      { pubkey: m.configPda(), isSigner: false, isWritable: false },
      { pubkey: m.settlementRecordPda(AAPL, DAY), isSigner: false, isWritable: true },
      { pubkey: feed, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([m.disc("finalize_settlement_normal"), u64(close1e6), Buffer.from([1]),
      i64(BigInt(Math.floor(Date.now()/1000))), u64(slot), Buffer.from([3]), Buffer.alloc(32, 9)]),
  });
}
function settleMarketIx(cranker: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.MERIDIAN_PID,
    keys: [
      { pubkey: cranker, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: m.settlementRecordPda(AAPL, DAY), isSigner: false, isWritable: false },
    ],
    data: m.disc("settle_market"),
  });
}
function redeemWinningIx(user: PublicKey, winningMint: PublicKey, userWinning: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.MERIDIAN_PID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: winningMint, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: userWinning, isSigner: false, isWritable: true },
      { pubkey: aliceQuote, isSigner: false, isWritable: true },
      { pubkey: m.TOKEN_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([m.disc("redeem_winning"), u64(amount)]),
  });
}

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [gov, operator, alice]) {
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 20_000_000_000), "confirmed");
  }
  quoteMint = await createMint(conn, gov, gov.publicKey, null, 6);
  feed = ob.mockFeedPda(AAPL); // the harness mock delivery feed Meridian reads
  await send([m.initializeConfigIx({
    governance: gov.publicKey, quoteMint, openbookProgramData: OPENBOOK_PROGRAMDATA,
    operator: operator.publicKey, pauseAuthority: gov.publicKey, overrideAuthority: gov.publicKey,
    supportedTickerMask: 0xfe, openbookDeploymentSlot: 282042596n,
    openbookExecutableSha256: Buffer.alloc(32, 0xaa), openbookUpgradeAuthority: PublicKey.default,
    minSamples: 3, maxStaleSlots: 1_000_000n, maxPriceBandBps: 50,
  })], [gov]);
  await send([m.registerTransportIx({ governance: gov.publicKey, versionId: 1, tickerId: AAPL, feed, oracleProgram: ob.HARNESS_PID })], [gov]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  // localnet build: close ~40s out (margin for setup), normal delay 0
  CLOSE = now + 40n;
  await send([m.createOutcomeMarketIx({
    operator: operator.publicKey, quoteMint, tickerId: AAPL, tradingDay: DAY, strike: STRIKE,
    versionId: 1, priorClose: 225_000_000n, mintOpenTs: now - 100n, tradeOpenTs: now - 50n, closeTs: CLOSE,
    metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: 0, overrideDelaySecs: 0,
  })], [operator]);
  market = m.outcomeMarketPda(AAPL, DAY, STRIKE);
  yesMint = m.yesMintPda(market); noMint = m.noMintPda(market); vault = m.ataFor(quoteMint, market);
  aliceQuote = await createAssociatedTokenAccount(conn, gov, quoteMint, alice.publicKey);
  aliceYes = await createAssociatedTokenAccount(conn, gov, yesMint, alice.publicKey);
  aliceNo = await createAssociatedTokenAccount(conn, gov, noMint, alice.publicKey);
  await mintTo(conn, gov, quoteMint, aliceQuote, gov, 100_000_000n);
  await send([m.mintPairIx(alice.publicKey, market, 10n * LOT, {
    yesMint, noMint, collateralVault: vault, userQuote: aliceQuote, userYes: aliceYes, userNo: aliceNo,
  })], [alice]);

  // negative-owner case (S4): an MSFT transport pinned to a NON-harness oracle
  // program, same close window as AAPL so no extra wait is needed.
  await send([m.registerTransportIx({ governance: gov.publicKey, versionId: 1, tickerId: MSFT, feed: ob.mockFeedPda(MSFT), oracleProgram: WRONG_ORACLE })], [gov]);
  await send([m.createOutcomeMarketIx({
    operator: operator.publicKey, quoteMint, tickerId: MSFT, tradingDay: DAY, strike: MSFT_STRIKE,
    versionId: 1, priorClose: 490_000_000n, mintOpenTs: now - 100n, tradeOpenTs: now - 50n, closeTs: CLOSE,
    metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: 0, overrideDelaySecs: 0,
  })], [operator]);
});

async function chainNow(): Promise<bigint> {
  const d = (await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111")))!.data;
  return d.readBigInt64LE(32);
}
test("S1 finalize the shared Settlement Record (normal path)", async () => {
  for (let i = 0; i < 90; i++) { if (await chainNow() >= CLOSE) break; await new Promise(r => setTimeout(r, 1000)); }
  assert.ok(await chainNow() >= CLOSE, "past close_ts");
  const slot = BigInt(await conn.getSlot("confirmed"));
  // publish the Official Close to the mock feed; finalize (localnet) reads it.
  // Pass 0 as the close arg: the program requires official_close > 0, so a
  // FinalOracle result here proves the value came from the feed, not the arg.
  await send([ob.publishMockFeedIx(operator.publicKey, AAPL, 235_000_000n)], [operator]); // $235 close
  await send([finalizeNormalIx(operator.publicKey, 0n, slot)], [operator]);
  const rec = (await conn.getAccountInfo(m.settlementRecordPda(AAPL, DAY)))!.data;
  assert.equal(rec[8], 1, "record state FinalOracle (read from feed, not the 0 arg)");
});

test("S2 settle_market derives Yes (close $235 >= strike $230)", async () => {
  await send([settleMarketIx(operator.publicKey)], [operator]);
  const d = (await conn.getAccountInfo(market))!.data;
  // outcome byte: after lifecycle block. Read it robustly by re-deriving offset.
  // state(47) then activity(48) paused(49) permPause(50) permReason(51,52)
  //   emgExp(53) emgTs(54..62) emgReason(62,63) settlePrice(64..72) outcome(72)
  assert.equal(d[72], 1, "outcome == Yes");
  assert.equal(d[47], 3, "state == Settled");
});

test("S3 Outcome Redemption: winning Yes token pays $1, losing No pays 0", async () => {
  const q0 = (await getAccount(conn, aliceQuote)).amount;
  await send([redeemWinningIx(alice.publicKey, yesMint, aliceYes, 10n * LOT)], [alice]);
  assert.equal((await getAccount(conn, aliceQuote)).amount - q0, 10n * LOT, "10 Yes redeemed for 10 USDC");
  assert.equal((await getAccount(conn, aliceYes)).amount, 0n, "Yes burned");
  // the losing No is still held but worth 0 (no redemption path pays it)
  assert.equal((await getAccount(conn, aliceNo)).amount, 10n * LOT, "No tokens remain, worth 0");
});

test("S4 finalize rejects a feed not owned by the pinned oracle program", async () => {
  const slot = BigInt(await conn.getSlot("confirmed"));
  // publish the MSFT feed (harness-owned, valid data) so this exercises the
  // OWNER pin specifically: the MSFT record pins a different oracle program.
  await send([ob.publishMockFeedIx(operator.publicKey, MSFT, 505_000_000n)], [operator]);
  const msftFinalize = new TransactionInstruction({
    programId: m.MERIDIAN_PID,
    keys: [
      { pubkey: operator.publicKey, isSigner: true, isWritable: true },
      { pubkey: m.configPda(), isSigner: false, isWritable: false },
      { pubkey: m.settlementRecordPda(MSFT, DAY), isSigner: false, isWritable: true },
      { pubkey: ob.mockFeedPda(MSFT), isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([m.disc("finalize_settlement_normal"), u64(505_000_000n), Buffer.from([1]),
      i64(BigInt(Math.floor(Date.now() / 1000))), u64(slot), Buffer.from([3]), Buffer.alloc(32, 9)]),
  });
  await assert.rejects(
    () => send([msftFinalize], [operator]),
    /0x1789|6025|WrongDeliveryOwner/i,
    "wrong-owner feed must reject with WrongDeliveryOwner",
  );
});
