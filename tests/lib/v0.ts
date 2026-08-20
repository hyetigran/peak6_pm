/** v0 + ALT sender — the G6/G7 composite mechanics. */
import {
  AddressLookupTableProgram, Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";

export async function createAlt(conn: Connection, payer: Keypair, addrs: PublicKey[]): Promise<PublicKey> {
  const slot = await conn.getSlot("finalized");
  const [createIx, alt] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  const send = async (ixs: TransactionInstruction[]) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    const sig = await conn.sendTransaction(tx);
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  };
  await send([createIx]);
  for (let i = 0; i < addrs.length; i += 20) {
    await send([AddressLookupTableProgram.extendLookupTable({
      lookupTable: alt, authority: payer.publicKey, payer: payer.publicKey,
      addresses: addrs.slice(i, i + 20),
    })]);
  }
  await new Promise(r => setTimeout(r, 1500)); // activates next slot
  return alt;
}

export async function sendV0(conn: Connection, altAddress: PublicKey | null, ixs: TransactionInstruction[], signers: Keypair[]) {
  const tables = [];
  if (altAddress) tables.push((await conn.getAddressLookupTable(altAddress)).value!);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message(tables);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return { sig, bytes: tx.serialize().length };
}
