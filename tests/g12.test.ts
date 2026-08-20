/**
 * G12 — Deployment identities, metadata, quote, recovery (PRD v0.7.1 §15).
 *
 *   1. quote-mint validation: initialize rejects wrong owner/decimals;
 *      create_venue_market rejects any mint but the pinned one (the exact
 *      Circle Devnet USDC address pin is this stored config value — verified
 *      against the real mint on devnet under issue #8)
 *   2. ADR-0016 ordering: a pair cannot bind without published metadata
 *      (zero hash rejected), so no mint can ever precede metadata
 *   3. recovery aggregate drill: pause + one-way fuse + admin prune + settle
 *      + direct Pair Redemption, all while paused AND expired — full refund
 *   4. Squads V4 fixture (immutable mainnet build dec8d3e0…): 2-of-3
 *      multisig, vault PDA derivation, and the loader drill — upgrade
 *      authority moved to the vault, ONE approval cannot execute, TWO
 *      approvals execute a real BPF-loader SetAuthority through the vault PDA
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  TransactionMessage, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccount, createAssociatedTokenAccountIdempotent, createMint, getAccount, mintTo,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import * as ob from "./lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate();
const seller = Keypair.generate();
const market = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let yesMint: PublicKey, noMint: PublicKey, quoteMint: PublicKey, badMint9: PublicKey, otherMint6: PublicKey;
let pairPda: PublicKey, collateralVault: PublicKey;
let baseVault: PublicKey, quoteVault: PublicKey;
let sellerYes: PublicKey, sellerNo: PublicKey, sellerQuote: PublicKey, sellerOo: PublicKey;

const LOT = 1_000_000n;

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function expectFail(p: Promise<unknown>, needle: string, label: string) {
  try { await p; } catch (e: any) {
    const text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`;
    assert.ok(text.includes(needle), `${label}: failed but without "${needle}":\n${text}`);
    return;
  }
  assert.fail(`${label}: expected failure, but transaction succeeded`);
}

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator — use scripts/run-suite.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [payer, seller]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 50_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  pairPda = ob.pairVaultPda(market.publicKey);
  quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  badMint9 = await createMint(conn, payer, payer.publicKey, null, 9);
  otherMint6 = await createMint(conn, payer, payer.publicKey, null, 6);
  yesMint = await createMint(conn, payer, pairPda, null, 6);
  noMint = await createMint(conn, payer, pairPda, null, 6);
  collateralVault = await createAssociatedTokenAccountIdempotent(conn, payer, quoteMint, pairPda, undefined, undefined, undefined, true);
  sellerQuote = await createAssociatedTokenAccount(conn, payer, quoteMint, seller.publicKey);
  sellerYes = await createAssociatedTokenAccount(conn, payer, yesMint, seller.publicKey);
  sellerNo = await createAssociatedTokenAccount(conn, payer, noMint, seller.publicKey);
  await mintTo(conn, payer, quoteMint, sellerQuote, payer, 100_000_000n);
});

test("G12.1 quote-mint validation and pin", async () => {
  // wrong decimals rejected at initialize (nothing persists)
  await expectFail(send([ob.harnessInitializeIx(payer.publicKey, badMint9)], [payer]),
    "WrongQuoteMint", "9-decimal mint at initialize");
  // a non-mint account rejected
  await expectFail(send([ob.harnessInitializeIx(payer.publicKey, seller.publicKey)], [payer]),
    "WrongQuoteMint", "non-mint account at initialize");
  // the pinned 6-decimal mint accepted
  await send([ob.harnessInitializeIx(payer.publicKey, quoteMint)], [payer]);

  // venue creation with a DIFFERENT 6-decimal mint must fail on the pin
  const bookRent = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE);
  const heapRent = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
  await send([
    ob.bookAccountIx(payer.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, heap, ob.EVENT_HEAP_SPACE, heapRent),
  ], [payer, bids, asks, heap]);
  const auth = ob.marketAuthorityPda(market.publicKey);
  const mkCreate = (qm: PublicKey) => {
    const nameBuf = Buffer.from("G12-YES/U");
    const len = Buffer.alloc(4); len.writeUInt32LE(nameBuf.length);
    return new TransactionInstruction({
      programId: ob.HARNESS_PID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ob.harnessConfigPda(), isSigner: false, isWritable: false },
        { pubkey: ob.venueAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: market.publicKey, isSigner: true, isWritable: true },
        { pubkey: auth, isSigner: false, isWritable: false },
        { pubkey: bids.publicKey, isSigner: false, isWritable: true },
        { pubkey: asks.publicKey, isSigner: false, isWritable: true },
        { pubkey: heap.publicKey, isSigner: false, isWritable: true },
        { pubkey: ob.ataFor(yesMint, auth), isSigner: false, isWritable: true },
        { pubkey: ob.ataFor(qm, auth), isSigner: false, isWritable: true },
        { pubkey: yesMint, isSigner: false, isWritable: false },
        { pubkey: qm, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ob.TOKEN_PID, isSigner: false, isWritable: false },
        { pubkey: ob.ATA_PID, isSigner: false, isWritable: false },
        { pubkey: ob.eventAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: PublicKey.findProgramAddressSync([Buffer.from("meridian_fee_admin_sentinel")], SystemProgram.programId)[0], isSigner: false, isWritable: false },
        { pubkey: ob.OPENBOOK_PID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([ob.disc("create_venue_market"), len, nameBuf, Buffer.alloc(8)]),
    });
  };
  await expectFail(send([mkCreate(otherMint6)], [payer, market]), "WrongQuoteMint", "unpinned quote mint at venue creation");
  await send([mkCreate(quoteMint)], [payer, market]);
  baseVault = ob.ataFor(yesMint, auth);
  quoteVault = ob.ataFor(quoteMint, auth);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, payer.publicKey)], [payer]);
});

test("G12.2 metadata must exist before any mint (ADR-0016 ordering)", async () => {
  await expectFail(send([ob.harnessInitPairIx(payer.publicKey, {
    market: market.publicKey, yesMint, noMint, quoteVault: collateralVault,
    metadataHash: Buffer.alloc(32), // nothing published
  })], [payer]), "MetadataUnset", "pair binding without published metadata");
  const mh = crypto.createHash("sha256").update("meridian-g12-metadata-vector").digest();
  await send([ob.harnessInitPairIx(payer.publicKey, {
    market: market.publicKey, yesMint, noMint, quoteVault: collateralVault, metadataHash: mh,
  })], [payer]);
  // with metadata bound, minting works — the ordering is structural
  await send([ob.harnessMintPairIx(seller.publicKey, market.publicKey, 5n * LOT, {
    yesMint, noMint, quoteVault: collateralVault,
    userQuote: sellerQuote, userYes: sellerYes, userNo: sellerNo,
  })], [seller]);
  const pv = (await conn.getAccountInfo(pairPda))!.data;
  assert.ok(pv.subarray(8 + 32 * 4 + 8, 8 + 32 * 4 + 8 + 32).equals(mh), "bound metadata hash stored");
});

test("G12.3 recovery aggregate drill: paused + fused, everything still recoverable", async () => {
  await send([ob.createOoIndexerIx(payer.publicKey, seller.publicKey),
    ob.createOoAccountIx(payer.publicKey, seller.publicKey, 1, market.publicKey)], [payer, seller]);
  sellerOo = ob.ooAccountPda(seller.publicKey, 1);
  const q0 = (await getAccount(conn, sellerQuote)).amount;
  // rest an ask, then pause AND fire the one-way fuse
  await send([ob.harnessPlaceLimitOrderIx({
    user: seller.publicKey, ooAccount: sellerOo, userTokenAccount: sellerYes,
    market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    eventHeap: heap.publicKey, marketVault: baseVault,
    args: { side: ob.Side.Ask, priceLots: 50n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 50n,
      clientOrderId: 1n, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
      selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  })], [seller]);
  await send([ob.harnessSetPausedIx(payer.publicKey, market.publicKey, true)], [payer]);
  await send([ob.harnessExpireMarketIx(payer.publicKey, market.publicKey)], [payer]);
  // recovery under the worst state: admin prune, owner settle, direct redemption
  await send([ob.harnessPruneOrdersIx(payer.publicKey, {
    ooAccount: sellerOo, market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey, limit: 8,
  })], [payer]);
  await send([ob.settleFundsIx({
    owner: seller.publicKey, ooAccount: sellerOo, market: market.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: quoteVault,
    userBaseAccount: sellerYes, userQuoteAccount: sellerQuote,
  })], [seller]);
  await send([ob.harnessRedeemPairDirectIx(seller.publicKey, market.publicKey, 5n * LOT, {
    yesMint, noMint, quoteVault: collateralVault,
    userQuote: sellerQuote, userYes: sellerYes, userNo: sellerNo,
  })], [seller]);
  assert.equal((await getAccount(conn, sellerQuote)).amount, q0 + 5n * LOT, "full recovery: all 5 pairs of collateral back");
  assert.equal((await getAccount(conn, collateralVault)).amount, 0n, "vault empty after full direct redemption");
});

test("G12.4 Squads V4 loader drill: 1-of-2 cannot execute, 2-of-3 moves real upgrade authority", async () => {
  // fixture identity
  const sq = fs.readFileSync("fixtures/squads_v4.so");
  assert.equal(crypto.createHash("sha256").update(sq).digest("hex"),
    "dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c",
    "immutable mainnet Squads V4 build (authority none at slot 302582236)");
  const [a, b, c] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const kp of [a, b]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 2_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  const programConfigPda = multisig.getProgramConfigPda({})[0];
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
  await send([multisig.instructions.multisigCreateV2({
    multisigPda, createKey: createKey.publicKey, creator: payer.publicKey,
    members: [a, b, c].map(m => ({ key: m.publicKey, permissions: multisig.types.Permissions.all() })),
    threshold: 2, configAuthority: null, timeLock: 0, rentCollector: null,
    treasury: programConfig.treasury,
  })], [payer, createKey]);

  // a dummy UPGRADEABLE program whose authority the vault will control
  const scratch = "/private/tmp/claude-501/-Users-tig-Desktop-gauntlet-peak6-pm/1051f57b-1906-420e-9bb2-a94ac09c9bdc/scratchpad";
  const payerFile = `${scratch}/g12-payer.json`;
  const progKeyFile = `${scratch}/g12-dummy-program.json`;
  fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
  const progKp = Keypair.generate();
  fs.writeFileSync(progKeyFile, JSON.stringify([...progKp.secretKey]));
  execFileSync("solana", ["program", "deploy", "--program-id", progKeyFile,
    "target/deploy/m0_harness.so", "-u", "localhost", "-k", payerFile,
    "--commitment", "confirmed"], { stdio: "pipe" });
  const programDataPda = PublicKey.findProgramAddressSync(
    [progKp.publicKey.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
  // hand authority to the VAULT PDA (the M6 flow's starting state)
  execFileSync("solana", ["program", "set-upgrade-authority", progKp.publicKey.toBase58(),
    "--new-upgrade-authority", vaultPda.toBase58(), "-u", "localhost", "-k", payerFile,
    "--skip-new-upgrade-authority-signer-check", "--commitment", "confirmed"], { stdio: "pipe" });

  // vault transaction: the raw BPF-loader SetAuthority instruction (enum 4)
  const setAuthIx = new TransactionInstruction({
    programId: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    keys: [
      { pubkey: programDataPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: true, isWritable: false },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([4, 0, 0, 0]),
  });
  const txMessage = new TransactionMessage({
    payerKey: vaultPda, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
    instructions: [setAuthIx],
  });
  await send([multisig.instructions.vaultTransactionCreate({
    multisigPda, transactionIndex: 1n, creator: a.publicKey,
    vaultIndex: 0, ephemeralSigners: 0, transactionMessage: txMessage,
  })], [a]);
  await send([multisig.instructions.proposalCreate({ multisigPda, transactionIndex: 1n, creator: a.publicKey })], [a]);
  await send([multisig.instructions.proposalApprove({ multisigPda, transactionIndex: 1n, member: a.publicKey })], [a]);

  // ONE approval must not execute
  const exec1 = await multisig.instructions.vaultTransactionExecute({
    connection: conn, multisigPda, transactionIndex: 1n, member: a.publicKey,
  });
  await expectFail(send([exec1.instruction], [a]), "", "execute with one approval");

  // second approval executes; the loader instruction runs signed by the vault PDA
  await send([multisig.instructions.proposalApprove({ multisigPda, transactionIndex: 1n, member: b.publicKey })], [b]);
  const exec2 = await multisig.instructions.vaultTransactionExecute({
    connection: conn, multisigPda, transactionIndex: 1n, member: a.publicKey,
  });
  await send([exec2.instruction], [a]);
  // upgrade authority is back with the payer — verified on-chain
  const pd = (await conn.getAccountInfo(programDataPda))!.data;
  // ProgramData: [4B enum][8B slot][1B option][32B authority]
  assert.equal(pd[12], 1, "authority option set");
  assert.ok(new PublicKey(pd.subarray(13, 45)).equals(payer.publicKey),
    "2-of-3 vault executed the loader SetAuthority: authority moved by the multisig");
});
