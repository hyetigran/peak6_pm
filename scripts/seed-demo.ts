/**
 * Seed a localnet demo: initialize Config, register a transport, and create a
 * spread of Active Outcome Markets (with OpenBook venues) across MAG7 tickers
 * so the frontend shows real data. Uses the localnet-featured meridian build.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import fs from "node:fs";
import * as m from "../tests/lib/meridian.js";
import * as ob from "../tests/lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const OPENBOOK_PROGRAMDATA = new PublicKey("DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB");
const conn = new Connection(RPC, "confirmed");

// tickers: [id, name, priorClose$, strikes$]
const SET: [number, string, number, number[]][] = [
  [1, "AAPL", 231, [220, 230, 240]],
  [6, "NVDA", 178, [170, 180]],
  [5, "MSFT", 512, [500, 520]],
];
const DAY = 20260825;

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  return sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
}

async function main() {
  const gov = Keypair.generate(), operator = Keypair.generate();
  for (const kp of [gov, operator]) await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 200e9), "confirmed");
  const quoteMint = await createMint(conn, gov, gov.publicKey, null, 6);

  await send([m.initializeConfigIx({
    governance: gov.publicKey, quoteMint, openbookProgramData: OPENBOOK_PROGRAMDATA,
    operator: operator.publicKey, pauseAuthority: gov.publicKey, overrideAuthority: gov.publicKey,
    supportedTickerMask: 0xfe, openbookDeploymentSlot: 282042596n,
    openbookExecutableSha256: Buffer.alloc(32, 0xaa), openbookUpgradeAuthority: PublicKey.default,
    minSamples: 3, maxStaleSlots: 1_000_000n, maxPriceBandBps: 50,
  })], [gov]);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const to = now - 30n, mo = to - 1800n, cl = to + 6n * 3600n; // trading open, closes in ~6h
  let created = 0;

  for (const [tid, name, prior, strikes] of SET) {
    await send([m.registerTransportIx({ governance: gov.publicKey, versionId: 1, tickerId: tid, feed: Keypair.generate().publicKey })], [gov]);
    for (const s of strikes) {
      const strike = BigInt(s) * 1_000_000n;
      await send([m.createOutcomeMarketIx({
        operator: operator.publicKey, quoteMint, tickerId: tid, tradingDay: DAY, strike,
        versionId: 1, priorClose: BigInt(prior) * 1_000_000n, mintOpenTs: mo, tradeOpenTs: to, closeTs: cl,
        metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: 0, overrideDelaySecs: 0,
      })], [operator]);
      // attach a venue so the market is Active
      const market = m.outcomeMarketPda(tid, DAY, strike);
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
        yesMint, quoteMint, name: `${name}-${s}-YES/USD`, timeExpiry: 0n,
      })], [operator, obMarket]);
      created++;
      process.stdout.write(`\rseeded ${created} markets  `);
    }
  }
  fs.writeFileSync(".demo-faucet.json", JSON.stringify({ quoteMint: quoteMint.toBase58(), authority: [...gov.secretKey] }));
  fs.writeFileSync(".demo-config.json", JSON.stringify({ quoteMint: quoteMint.toBase58(), governance: [...gov.secretKey], operator: [...operator.secretKey], day: DAY }, null, 2));
  console.log(`\ndone: ${created} Active markets across ${SET.length} tickers. quoteMint=${quoteMint.toBase58()}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
