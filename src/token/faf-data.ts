/**
 * FAF Live Data
 *
 * Reads FAF staking state from on-chain accounts via Flash SDK.
 * All values are live — never estimated or hardcoded.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { PoolConfig, PerpetualsClient, TokenStakeAccount } from 'flash-sdk';
import { FAF_MINT, FAF_DECIMALS, FAF_TOKEN_VAULT, getVipTier, VipTier } from './faf-registry.js';
import { getLogger } from '../utils/logger.js';
import BN from 'bn.js';

export interface FafStakeInfo {
  /** User's staked FAF amount (UI units) */
  stakedAmount: number;
  /** VIP tier level (0-6) */
  level: number;
  /** VIP tier details */
  tier: VipTier;
  /** Pending FAF reward tokens (UI units) */
  pendingRewards: number;
  /** Pending USDC revenue (UI units) */
  pendingRevenue: number;
  /** Number of active unstake requests */
  withdrawRequestCount: number;
  /** Raw stake account (for SDK calls) */
  rawAccount: TokenStakeAccount | null;
}

/**
 * Read user's FAF staking position from on-chain.
 * Returns null if user has no stake account.
 */
export async function getFafStakeInfo(
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  userPublicKey: PublicKey,
): Promise<FafStakeInfo | null> {
  const logger = getLogger();

  let stakeAccount: TokenStakeAccount | null = null;
  try {
    stakeAccount = await perpClient.getTokenStakeAccount(poolConfig, userPublicKey);
  } catch {
    // No stake account — user hasn't staked
    return null;
  }

  if (!stakeAccount || !stakeAccount.isInitialized) return null;

  const stakedAmount = stakeAccount.activeStakeAmount
    ? new BN(stakeAccount.activeStakeAmount.toString()).toNumber() / Math.pow(10, FAF_DECIMALS)
    : 0;

  const level = stakeAccount.level ?? 0;
  const tier = getVipTier(stakedAmount);

  // Pending rewards (FAF tokens)
  let pendingRewards = 0;
  try {
    if (stakeAccount.rewardTokens) {
      pendingRewards = new BN(stakeAccount.rewardTokens.toString()).toNumber() / Math.pow(10, FAF_DECIMALS);
    }
  } catch { /* non-critical */ }

  // Pending revenue (USDC)
  let pendingRevenue = 0;
  try {
    if (stakeAccount.unclaimedRevenueAmount) {
      pendingRevenue = new BN(stakeAccount.unclaimedRevenueAmount.toString()).toNumber() / Math.pow(10, 6); // USDC = 6 decimals
    }
  } catch { /* non-critical */ }

  const withdrawRequestCount = stakeAccount.withdrawRequestCount ?? 0;

  logger.debug('FAF', `Stake info: ${stakedAmount} FAF, level ${level}, rewards ${pendingRewards} FAF, revenue $${pendingRevenue}`);

  return {
    stakedAmount,
    level,
    tier,
    pendingRewards,
    pendingRevenue,
    withdrawRequestCount,
    rawAccount: stakeAccount,
  };
}

/**
 * Get user's FAF token balance (not staked — in wallet).
 */
export async function getFafBalance(connection: Connection, userPublicKey: PublicKey): Promise<number> {
  try {
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    const accounts = await connection.getTokenAccountsByOwner(userPublicKey, {
      mint: FAF_MINT,
      programId: TOKEN_PROGRAM_ID,
    });
    if (accounts.value.length === 0) return 0;
    const data = accounts.value[0].account.data;
    const amount = data.readBigUInt64LE(64);
    return Number(amount) / Math.pow(10, FAF_DECIMALS);
  } catch {
    return 0;
  }
}
