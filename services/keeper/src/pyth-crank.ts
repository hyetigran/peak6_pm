/**
 * Devnet Pyth crank orchestration (#16) — the keeper's settlement transport on
 * the synthetic track. Per settlement it: (1) pulls the latest signed price
 * update from Hermes, (2) posts it on-chain as a PriceUpdateV2 via the Pyth
 * receiver, and (3) runs the adapter `crank` against that update in the SAME
 * transaction, writing the per-ticker delivery account Meridian then reads.
 *
 * DEVNET-GATED: the Pyth receiver + Wormhole live on devnet/mainnet (or a
 * cloned-local validator), so this can't run against a plain localnet — the
 * localnet demo keeps the m0-harness mock feed. Type-checked, not run-tested
 * here. Capture AT the close: Pyth equity feeds are RTH-only and go stale after
 * 16:00 ET, whereas settlement is ~close+20m.
 */
import type { VersionedTransaction, Signer } from "@solana/web3.js";
import type { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import type { HermesClient } from "@pythnetwork/hermes-client";
import { crankIx, PYTH_FEED_IDS, PYTH_ADAPTER_PID } from "./pyth-adapter.js";
import { PublicKey } from "@solana/web3.js";

/** Hermes wants the 0x-prefixed feed id; our config stores the bare hex. */
export const hermesFeedId = (tickerId: number): string => {
  const hex = PYTH_FEED_IDS[tickerId];
  if (!hex) throw new Error(`no Pyth feed id for ticker ${tickerId}`);
  return `0x${hex}`;
};

/** Build the pull→post→crank transaction(s) for one ticker. The caller signs
 *  (with the receiver's wallet + the returned ephemeral signers) and sends. */
export async function buildPythCrankTxs(opts: {
  receiver: PythSolanaReceiver;
  hermes: HermesClient;
  cranker: PublicKey;
  tickerId: number;
  maxAgeSecs?: bigint;
  adapter?: PublicKey;
}): Promise<{ tx: VersionedTransaction; signers: Signer[] }[]> {
  const feedId = hermesFeedId(opts.tickerId);
  const adapter = opts.adapter ?? PYTH_ADAPTER_PID;

  // base64: the receiver's addPostPriceUpdates expects base64-encoded updates
  // (Hermes v3 defaults to hex -> "Invalid accumulator message").
  const updates = await opts.hermes.getLatestPriceUpdates([feedId], { encoding: "base64" });
  const data = updates.binary.data; // base64 signed updates

  const builder = opts.receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates(data);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: (feedId: string) => PublicKey) => [
    {
      instruction: crankIx({
        cranker: opts.cranker,
        priceUpdate: getPriceUpdateAccount(feedId),
        tickerId: opts.tickerId,
        maxAgeSecs: opts.maxAgeSecs,
        adapter,
      }),
      signers: [],
    },
  ]);

  return builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 });
}
