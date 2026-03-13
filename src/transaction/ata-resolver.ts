/**
 * ATA (Associated Token Account) Resolver
 *
 * Ensures required token accounts exist before transaction execution.
 * If an ATA is missing, prepends a createAssociatedTokenAccountIdempotent
 * instruction to the transaction.
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

/**
 * Check which ATAs exist and return create instructions for missing ones.
 * Uses idempotent instruction — safe to include even if account exists.
 *
 * @param connection  Solana RPC connection
 * @param owner       Wallet public key (payer and owner)
 * @param mints       Token mints that need ATAs
 * @returns           Instructions to create missing ATAs (empty if all exist)
 */
export async function ensureATAs(
  connection: Connection,
  owner: PublicKey,
  mints: PublicKey[],
): Promise<TransactionInstruction[]> {
  if (mints.length === 0) return [];

  // Derive ATA addresses
  const ataAddresses = mints.map(mint =>
    getAssociatedTokenAddressSync(mint, owner, true),
  );

  // Batch check which accounts exist
  const accountInfos = await connection.getMultipleAccountsInfo(ataAddresses);

  const instructions: TransactionInstruction[] = [];
  for (let i = 0; i < mints.length; i++) {
    if (!accountInfos[i]) {
      // ATA does not exist — create it (idempotent = no-op if it exists by the time tx lands)
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,       // payer
          ataAddresses[i], // ATA address
          owner,       // owner
          mints[i],    // mint
          TOKEN_PROGRAM_ID,
        ),
      );
    }
  }

  return instructions;
}

/**
 * Get the ATA address for a given owner and mint (no RPC call).
 */
export function getATAAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true);
}
