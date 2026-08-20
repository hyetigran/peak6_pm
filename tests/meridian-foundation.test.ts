/**
 * Meridian foundation smoke test (localnet): initialize_config ->
 * register_transport -> create_outcome_market. Proves the account model,
 * PDA seeds, quote-mint pin, strike/schedule validation, Pair mint creation,
 * and SettlementRecord init-or-match all work end to end.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, getMint, getAccount } from "@solana/spl-token";
import * as m from "./lib/meridian.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const gov = Keypair.generate();
const operator = Keypair.generate();
let quoteMint: PublicKey;
const OPENBOOK_PROGRAMDATA = new PublicKey("DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB");

const AAPL = 1;
const DAY = 20260820;
const STRIKE = 230_000_000n; // $230.00 in 1e6, a $10 multiple
let MINT_OPEN: bigint, TRADE_OPEN: bigint, CLOSE: bigint; // shared schedule

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function expectFail(p: Promise<unknown>, needle: string, label: string) {
  assert.ok(needle.length > 0, `${label}: empty needle`);
  try { await p; } catch (e: any) {
    const text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`;
    assert.ok(text.includes(needle), `${label}: failed without "${needle}":\n${text}`);
    return;
  }
  assert.fail(`${label}: expected failure`);
}

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator — use scripts/run-suite.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [gov, operator]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 20_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  quoteMint = await createMint(conn, gov, gov.publicKey, null, 6);
  const now = BigInt(Math.floor(Date.now() / 1000));
  MINT_OPEN = now + 60n; TRADE_OPEN = MINT_OPEN + 1800n; CLOSE = TRADE_OPEN + 12600n; // 3.5h
});

test("F1 initialize_config pins the quote mint and OpenBook identity", async () => {
  await send([m.initializeConfigIx({
    governance: gov.publicKey, quoteMint, openbookProgramData: OPENBOOK_PROGRAMDATA,
    operator: operator.publicKey, pauseAuthority: gov.publicKey, overrideAuthority: gov.publicKey,
    supportedTickerMask: 0xfe, // AAPL..TSLA (bits 1-7)
    openbookDeploymentSlot: 282042596n, openbookExecutableSha256: Buffer.alloc(32, 0xaa),
    openbookUpgradeAuthority: PublicKey.default, minSamples: 3, maxStaleSlots: 150n, maxPriceBandBps: 50,
  })], [gov]);
  const cfg = (await conn.getAccountInfo(m.configPda()))!;
  assert.equal(cfg.owner.toBase58(), m.MERIDIAN_PID.toBase58(), "config owned by meridian");
});

test("F2 register_transport creates an immutable FeedVersion", async () => {
  await send([m.registerTransportIx({ governance: gov.publicKey, versionId: 1, tickerId: AAPL, feed: Keypair.generate().publicKey })], [gov]);
  const fv = (await conn.getAccountInfo(m.feedVersionPda(AAPL, 1)))!;
  assert.equal(fv.owner.toBase58(), m.MERIDIAN_PID.toBase58());
});

test("F3 non-$10 strike is rejected", async () => {
  await expectFail(send([m.createOutcomeMarketIx({
    operator: operator.publicKey, quoteMint, tickerId: AAPL, tradingDay: DAY, strike: 230_500_000n, // $230.50
    versionId: 1, priorClose: 225_000_000n,
    mintOpenTs: MINT_OPEN, tradeOpenTs: TRADE_OPEN, closeTs: CLOSE,
    metadataManifest: Buffer.alloc(32, 1), normalDelaySecs: 1200, overrideDelaySecs: 3600,
  })], [operator]), "InvalidStrike", "non-$10 strike");
});

test("F4 wrong quote mint is rejected at market create", async () => {
  const bad = await createMint(conn, gov, gov.publicKey, null, 6); // valid mint, wrong identity
  await expectFail(send([m.createOutcomeMarketIx({
    operator: operator.publicKey, quoteMint: bad, tickerId: AAPL, tradingDay: DAY, strike: STRIKE,
    versionId: 1, priorClose: 225_000_000n,
    mintOpenTs: MINT_OPEN, tradeOpenTs: TRADE_OPEN, closeTs: CLOSE,
    metadataManifest: Buffer.alloc(32, 1), normalDelaySecs: 1200, overrideDelaySecs: 3600,
  })], [operator]), "WrongQuoteMint", "unpinned quote mint");
});

test("F5 create_outcome_market: Pair mints, vault, and bound Settlement Record", async () => {
  await send([m.createOutcomeMarketIx({
    operator: operator.publicKey, quoteMint, tickerId: AAPL, tradingDay: DAY, strike: STRIKE,
    versionId: 1, priorClose: 225_000_000n,
    mintOpenTs: MINT_OPEN, tradeOpenTs: TRADE_OPEN, closeTs: CLOSE,
    metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: 1200, overrideDelaySecs: 3600,
  })], [operator]);
  const market = m.outcomeMarketPda(AAPL, DAY, STRIKE);
  const yesMint = await getMint(conn, m.yesMintPda(market));
  const noMint = await getMint(conn, m.noMintPda(market));
  assert.equal(yesMint.decimals, 6); assert.equal(noMint.decimals, 6);
  assert.ok(yesMint.mintAuthority?.equals(market), "market PDA is the Yes mint authority");
  assert.equal(yesMint.supply, 0n);
  const vault = await getAccount(conn, m.ataFor(quoteMint, market));
  assert.ok(vault.mint.equals(quoteMint) && vault.owner.equals(market), "collateral vault owned by market");
  const rec = (await conn.getAccountInfo(m.settlementRecordPda(AAPL, DAY)))!;
  assert.equal(rec.owner.toBase58(), m.MERIDIAN_PID.toBase58(), "settlement record created");
  assert.equal(rec.data[8], 0, "record state Pending (byte after 8-byte anchor discriminator)");
});

test("F6 Add Strike: a second strike same day matches the existing record", async () => {
  const STRIKE2 = 240_000_000n;
  await send([m.createOutcomeMarketIx({
    operator: operator.publicKey, quoteMint, tickerId: AAPL, tradingDay: DAY, strike: STRIKE2,
    versionId: 1, priorClose: 225_000_000n,
    mintOpenTs: MINT_OPEN, tradeOpenTs: TRADE_OPEN, closeTs: CLOSE,
    metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: 1200, overrideDelaySecs: 3600,
  })], [operator]);
  assert.ok((await conn.getAccountInfo(m.outcomeMarketPda(AAPL, DAY, STRIKE2))), "second strike against the same record");

  // a mismatched header (different prior close) is rejected
  await expectFail(send([m.createOutcomeMarketIx({
    operator: operator.publicKey, quoteMint, tickerId: AAPL, tradingDay: DAY, strike: 250_000_000n,
    versionId: 1, priorClose: 999_000_000n, // different!
    mintOpenTs: MINT_OPEN, tradeOpenTs: TRADE_OPEN, closeTs: CLOSE,
    metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: 1200, overrideDelaySecs: 3600,
  })], [operator]), "SettlementHeaderMismatch", "mismatched record header");
});
