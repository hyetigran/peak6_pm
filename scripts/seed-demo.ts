/**
 * Seed a localnet demo: initialize Config, register a transport, and create a
 * spread of Active Outcome Markets (with OpenBook venues) across MAG7 tickers
 * so the frontend shows real data. Uses the localnet-featured meridian build.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, createAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import fs from "node:fs";
import * as m from "@meridian/sdk/meridian";
import * as ob from "@meridian/sdk/openbook";
import { resolveSeedConfig, assertStrictSchedule } from "./seed-config.js";
import { deliveryPda, PYTH_ADAPTER_PID } from "../services/keeper/src/pyth-adapter.js";
import { decodeOutcomeMarket } from "../services/indexer/src/layout.js";

/** Load a keypair from a JSON secret-key file path, or null if unset. */
const loadKeypair = (path: string | undefined): Keypair | null =>
  path ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")))) : null;

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const SYS = "11111111111111111111111111111111"; // PublicKey.default (an unset optional pubkey)
const conn = new Connection(RPC, "confirmed");

// all 7 MAG7 tickers: [id, name, priorClose$]. Strikes are derived (below).
const SET: [number, string, number][] = [
  [1, "AAPL", 231],
  [2, "AMZN", 241],
  [3, "GOOGL", 204],
  [4, "META", 682],
  [5, "MSFT", 512],
  [6, "NVDA", 178],
  [7, "TSLA", 349],
];

// Strike ladder: prior close +/-3/6/9%, snapped to the on-chain $10 grid and
// deduped. validate_strike requires $10 multiples, so a 3% step under ~$333
// (< $10) collapses adjacent bands — cheaper names end up with fewer strikes.
const STRIKE_BANDS_PCT = [-9, -6, -3, 3, 6, 9];
const strikesFor = (prior: number): number[] =>
  [...new Set(STRIKE_BANDS_PCT.map((b) => Math.round((prior * (1 + b / 100)) / 10) * 10))].sort((a, b) => a - b);
const DAY = 20260825;

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  return sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
}

async function main() {
  const cfg = resolveSeedConfig(process.env);
  console.log(`[seed] mode=${cfg.mode} oracle=${process.env.DEMO_ORACLE ?? "harness"}`);
  if (cfg.mode === "devnet") {
    console.log("=".repeat(72));
    console.log("  SYNTHETIC PLUMBING DEMO (ADR-0028) — make demo-devnet");
    console.log("  Settlement Records seeded here are SYNTHETIC, not a real Nasdaq");
    console.log("  Official Close. This proves the create->mint->trade->settle wiring on");
    console.log("  a strict-build devnet; it does NOT satisfy G11 (that is oracle-e2e-devnet");
    console.log("  / #16, real provider #9). Do not treat this as settlement-correctness evidence.");
    console.log("=".repeat(72));
  }
  // localnet generates throwaway authorities and airdrops them; devnet loads the
  // real (externally funded) governance/operator keys — devnet has no faucet for
  // 200 SOL, and these authorities must persist across runs.
  const gov = loadKeypair(process.env.GOVERNANCE_KEYPAIR) ?? Keypair.generate();
  const operator = loadKeypair(process.env.OPERATOR_KEYPAIR_PATH) ?? Keypair.generate();
  if (cfg.mode === "localnet") {
    for (const kp of [gov, operator]) await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 200e9), "confirmed");
  }
  // localnet mints its own test quote token; devnet uses the pinned Circle USDC.
  const quoteMint = cfg.quoteMint ? new PublicKey(cfg.quoteMint) : await createMint(conn, gov, gov.publicKey, null, 6);

  // Fund a real wallet with test USD + SOL so it can trade in the browser
  // (defaults to the provided address; override with DEMO_WALLET).
  const DEMO_WALLET = process.env.DEMO_WALLET ?? "4pHCuvZqXzuxtesxvBLUK3n12VL7CBPkU7TrR239SvNt";
  try {
    const wallet = new PublicKey(DEMO_WALLET);
    const wata = await createAssociatedTokenAccount(conn, gov, quoteMint, wallet);
    await mintTo(conn, gov, quoteMint, wata, gov, 10_000_000_000n); // 10,000 test USD
    try { await conn.confirmTransaction(await conn.requestAirdrop(wallet, 5_000_000_000), "confirmed"); } catch {}
    console.log(`funded ${DEMO_WALLET}: 10,000 test USD + 5 SOL (quote mint ${quoteMint.toBase58()})`);
  } catch (e) { console.error("could not fund DEMO_WALLET:", (e as Error).message); }

  const exists = async (pk: PublicKey): Promise<boolean> => (await conn.getAccountInfo(pk)) !== null;

  // Idempotent: only initialize Config once (a devnet re-run after a partial
  // seed must not re-init — the account already exists).
  if (await exists(m.configPda())) {
    console.log("[seed] Config already initialized — skipping init");
  } else {
    await send([m.initializeConfigIx({
      governance: gov.publicKey, quoteMint, openbookProgramData: new PublicKey(cfg.openbookProgramData),
      operator: operator.publicKey, pauseAuthority: gov.publicKey, overrideAuthority: gov.publicKey,
      supportedTickerMask: 0xfe, openbookDeploymentSlot: cfg.openbookDeploymentSlot,
      openbookExecutableSha256: cfg.openbookExecutableSha256, openbookUpgradeAuthority: new PublicKey(cfg.openbookUpgradeAuthority),
      minSamples: 3, maxStaleSlots: 1_000_000n, maxPriceBandBps: 50,
    })], [gov]);
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const to = now - 30n, mo = to - 1800n, cl = to + 6n * 3600n; // trading open, closes in ~6h
  let created = 0, skipped = 0;
  const transports: Record<number, string> = {}; // tickerId -> delivery feed (needed to settle)

  // For the settlement walkthrough, DEMO_SETTLE makes TSLA (7) + GOOGL (3)
  // close soon — ALL their strikes, so the single per-ticker/day Settlement
  // Record stays consistent (a mixed close within one ticker/day would clash).
  // Window is tunable (DEMO_SETTLE_SECS: default 90s for tests, ~300 manual).
  const soonClose = now + BigInt(Number(process.env.DEMO_SETTLE_SECS ?? 90));
  const soonTickers = new Set(process.env.DEMO_SETTLE ? [3, 7] : []);
  // DEMO_TICKERS="3,7" restricts the seed to those ticker ids (fast e2e runs).
  const onlyTickers = process.env.DEMO_TICKERS ? new Set(process.env.DEMO_TICKERS.split(",").map(Number)) : null;
  const FULL: [number, string, number, number[], bigint][] =
    SET.filter(([t]) => !onlyTickers || onlyTickers.has(t))
      .map(([t, n, p]) => [t, n, p, strikesFor(p), soonTickers.has(t) ? soonClose : cl]);

  // Transport: localnet reads the harness mock feed by default. DEMO_ORACLE=pyth
  // (always on devnet) pins the Pyth adapter + its per-ticker delivery PDA (#16;
  // the keeper then runs KEEPER_ORACLE=pyth — see scripts/pyth-settle-e2e.sh).
  const PYTH = process.env.DEMO_ORACLE === "pyth" || cfg.mode === "devnet";
  const oracleProgram = cfg.oracleProgram ? new PublicKey(cfg.oracleProgram) : PYTH ? PYTH_ADAPTER_PID : ob.HARNESS_PID;
  const feedFor = (tid: number): PublicKey => (PYTH ? deliveryPda(tid) : ob.mockFeedPda(tid));

  for (const [tid, name, prior, strikes, close0] of FULL) {
    const feed = feedFor(tid);
    transports[tid] = feed.toBase58();
    // The shared SettlementRecord fixes close_ts for the whole ticker/day
    // (ADR-0023): if it already exists (a resumed seed), every remaining strike
    // must match its stored close_ts exactly — reuse it, don't recompute from now.
    let close = close0;
    const recInfo = await conn.getAccountInfo(m.settlementRecordPda(tid, DAY));
    if (recInfo) {
      close = recInfo.data.readBigInt64LE(16); // SettlementRecord.close_ts @16
      console.log(`[seed] ticker ${tid}: matching existing SettlementRecord close_ts ${close}`);
    }
    if (await exists(m.feedVersionPda(tid, 1))) {
      console.log(`[seed] transport for ticker ${tid} already registered — skipping`);
    } else {
      await send([m.registerTransportIx({ governance: gov.publicKey, versionId: 1, tickerId: tid, feed, oracleProgram })], [gov]);
    }
    for (const s of strikes) {
      const strike = BigInt(s) * 1_000_000n;
      const market = m.outcomeMarketPda(tid, DAY, strike);
      // Idempotent resume: skip a strike that is already fully created (has a
      // venue). A market that exists WITHOUT a venue (a partial seed that failed
      // mid-venue) falls through to have its venue attached — not skipped.
      const mInfo = await conn.getAccountInfo(market);
      if (mInfo && decodeOutcomeMarket(market.toBase58(), mInfo.data).openbookMarket !== SYS) { skipped++; continue; }
      if (cfg.mode === "devnet") {
        // Fail closed with a clear message before the strict build reverts with
        // an opaque InvalidSchedule (e.g. a sub-floor DEMO_SETTLE window).
        assertStrictSchedule(
          { mintOpen: Number(mo), tradeOpen: Number(to), close: Number(close), now: Number(now) },
          `${name}-${s}`,
        );
      }
      if (!mInfo) {
        await send([m.createOutcomeMarketIx({
          operator: operator.publicKey, quoteMint, tickerId: tid, tradingDay: DAY, strike,
          versionId: 1, priorClose: BigInt(prior) * 1_000_000n, mintOpenTs: mo, tradeOpenTs: to, closeTs: close,
          metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: cfg.normalDelaySecs, overrideDelaySecs: cfg.overrideDelaySecs,
        })], [operator]);
      } else {
        console.log(`[seed] ${name}-${s}: market exists without a venue — attaching venue`);
      }
      // attach a venue so the market is Active
      const yesMint = m.yesMintPda(market);
      const obMarket = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
      const bookRent = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE);
      const heapRent = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
      await send([
        ob.bookAccountIx(operator.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
        ob.bookAccountIx(operator.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
        ob.bookAccountIx(operator.publicKey, heap, ob.EVENT_HEAP_SPACE, heapRent),
      ], [operator, bids, asks, heap]);
      await send([m.createVenueMarketIx({
        operator: operator.publicKey, market, obMarket: obMarket.publicKey,
        bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
        yesMint, quoteMint, name: `${name}-${s}`, timeExpiry: 0n,
      })], [operator, obMarket]);
      // permanent Metaplex metadata for the Yes/No mints (names in wallets)
      try {
        await send([m.publishMetadataIx({
          operator: operator.publicKey, market, yesMint, noMint: m.noMintPda(market),
          yesName: `${name} $${s} YES`, yesSymbol: "mYES", noName: `${name} $${s} NO`, noSymbol: "mNO",
          uri: cfg.metadataUri.replace("{ticker}", name).replace("{strike}", String(s)),
        })], [operator]);
      } catch (e) { console.error(`\n[meta] ${name}-${s}:`, (e as Error).message.slice(0, 120)); }
      created++;
      process.stdout.write(`\rseeded ${created} markets  `);
    }
  }
  fs.writeFileSync(".demo-faucet.json", JSON.stringify({ quoteMint: quoteMint.toBase58(), authority: [...gov.secretKey] }));
  fs.writeFileSync(".demo-config.json", JSON.stringify({ quoteMint: quoteMint.toBase58(), governance: [...gov.secretKey], operator: [...operator.secretKey], day: DAY, transports }, null, 2));
  console.log(`\ndone: ${created} markets created${skipped ? `, ${skipped} already existed (skipped)` : ""} across ${FULL.length} tickers. quoteMint=${quoteMint.toBase58()}`);
  if (cfg.mode === "devnet") console.log("[seed] SYNTHETIC demo seeded (ADR-0028). Settlement here is not a real Official Close.");
}
main().catch((e) => { console.error(e); process.exit(1); });
