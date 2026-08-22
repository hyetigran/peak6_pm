/**
 * Assertion half of `make pyth-settle-e2e` (#16): after the keeper has run in
 * KEEPER_ORACLE=pyth mode, prove that each closed ticker's Settlement Record
 * was finalized FROM the adapter-owned Pyth delivery account — i.e. the
 * on-chain Official Close equals the real Pyth price the adapter wrote, the
 * record pins that delivery account + the adapter as oracle program, and the
 * Outcome Markets are settled. Exits nonzero on any miss.
 *
 *   DEMO_CONFIG=.demo-config.json pnpm exec tsx scripts/pyth-settle-check.ts 3,7
 */
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import * as m from "@meridian/sdk/meridian";
import { deliveryPda, PYTH_ADAPTER_PID } from "../services/keeper/src/pyth-adapter.js";

// SettlementRecord (borsh, 8-byte discriminator): see state/settlement_record.rs
const REC = { STATE: 8, ORACLE_PROGRAM: 36, FEED: 172, OFFICIAL_CLOSE: 261, HALT: 269 } as const;
const STATE_FINAL_ORACLE = 1;
// delivery layout (adapter == harness): official_close_1e6@8 slot@16 halt@32 samples@33
const DLV = { CLOSE: 8, SLOT: 16, HALT: 32, SAMPLES: 33 } as const;

async function main() {
  const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
  const cfg = JSON.parse(fs.readFileSync(process.env.DEMO_CONFIG ?? ".demo-config.json", "utf8"));
  const tickers = (process.argv[2] ?? "3,7").split(",").map(Number);
  const indexer = process.env.KEEPER_INDEXER ?? "http://127.0.0.1:8787";
  const markets: any[] = (await (await fetch(`${indexer}/markets`)).json()).markets;
  let fails = 0;
  const fail = (msg: string) => { fails++; console.error(`  FAIL ${msg}`); };

  for (const tid of tickers) {
    const delivery = deliveryPda(tid);
    const record = m.settlementRecordPda(tid, cfg.day);
    const [dInfo, rInfo] = await Promise.all([conn.getAccountInfo(delivery), conn.getAccountInfo(record)]);
    console.log(`ticker ${tid}: delivery=${delivery.toBase58()} record=${record.toBase58()}`);
    if (!dInfo) { fail(`ticker ${tid}: delivery account not written (adapter crank never ran)`); continue; }
    if (!rInfo) { fail(`ticker ${tid}: settlement record missing (finalize never ran)`); continue; }
    const d = dInfo.data, r = rInfo.data;
    const pythClose = d.readBigUInt64LE(DLV.CLOSE);
    const recClose = r.readBigUInt64LE(REC.OFFICIAL_CLOSE);
    const recFeed = new PublicKey(r.subarray(REC.FEED, REC.FEED + 32));
    const recOracle = new PublicKey(r.subarray(REC.ORACLE_PROGRAM, REC.ORACLE_PROGRAM + 32));
    console.log(`  delivery: owner=${dInfo.owner.toBase58()} close=$${(Number(pythClose) / 1e6).toFixed(4)} slot=${d.readBigUInt64LE(DLV.SLOT)} halt=${d[DLV.HALT]} samples=${d[DLV.SAMPLES]}`);
    console.log(`  record:   state=${r[REC.STATE]} close=$${(Number(recClose) / 1e6).toFixed(4)} halt=${r[REC.HALT]} feed=${recFeed.toBase58()} oracle=${recOracle.toBase58()}`);

    if (!dInfo.owner.equals(PYTH_ADAPTER_PID)) fail(`ticker ${tid}: delivery owner is not the adapter`);
    if (pythClose <= 0n) fail(`ticker ${tid}: delivery close is zero`);
    // Layout self-check: the record must pin exactly this delivery PDA + the adapter
    // (also validates the hand-computed offsets — a wrong offset can't match).
    if (!recFeed.equals(delivery)) fail(`ticker ${tid}: record.oracle_feed != delivery PDA`);
    if (!recOracle.equals(PYTH_ADAPTER_PID)) fail(`ticker ${tid}: record.oracle_program_id != adapter`);
    if (r[REC.STATE] !== STATE_FINAL_ORACLE) fail(`ticker ${tid}: record state ${r[REC.STATE]} != FinalOracle`);
    if (recClose !== pythClose) fail(`ticker ${tid}: record close ${recClose} != Pyth delivery close ${pythClose}`);
    if (r[REC.HALT] !== d[DLV.HALT]) fail(`ticker ${tid}: record halt ${r[REC.HALT]} != delivery halt ${d[DLV.HALT]}`);

    const mine = markets.filter((x) => x.ticker_id === tid);
    const unsettled = mine.filter((x) => !x.settled_ts);
    console.log(`  markets:  ${mine.length} seeded, ${mine.length - unsettled.length} settled`);
    if (!mine.length) fail(`ticker ${tid}: no markets seeded`);
    if (unsettled.length) fail(`ticker ${tid}: ${unsettled.length} market(s) not settled`);
  }
  if (fails) { console.error(`\n[pyth-settle] FAIL (${fails})`); process.exit(1); }
  console.log("\n[pyth-settle] OK — Meridian finalized + settled from the REAL Pyth close via the adapter (keeper KEEPER_ORACLE=pyth)");
}
main().catch((e) => { console.error("[pyth-settle]", String(e).slice(0, 600)); process.exit(1); });
