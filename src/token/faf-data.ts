/**
 * FAF Live Data
 *
 * Reads FAF staking state from on-chain accounts via Flash SDK.
 * All values are live — never estimated or hardcoded.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { PoolConfig, PerpetualsClient, TokenStakeAccount } from 'flash-sdk';
import { FAF_MINT, FAF_DECIMALS, getVipTier, VipTier, VOLTAGE_TIERS } from './faf-registry.js';
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

  let stakeAccount: TokenStakeAccount | null;
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

// ─── Unstake Requests ──────────────────────────────────────────────────────

export interface FafUnstakeRequest {
  /** Request index (0-based) */
  index: number;
  /** Amount being unstaked (UI units) */
  amount: number;
  /** Unix timestamp when the unstake was requested */
  timestamp: number;
}

/**
 * Read pending unstake (withdraw) requests from the TokenStakeAccount.
 * Returns an empty array if no stake account or no requests.
 */
export async function getFafUnstakeRequests(
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  userPublicKey: PublicKey,
): Promise<FafUnstakeRequest[]> {
  let stakeAccount: TokenStakeAccount | null;
  try {
    stakeAccount = await perpClient.getTokenStakeAccount(poolConfig, userPublicKey);
  } catch {
    return [];
  }
  if (!stakeAccount || !stakeAccount.isInitialized) return [];

  const requests: FafUnstakeRequest[] = [];
  const withdrawRequests = (stakeAccount as unknown as Record<string, unknown>).withdrawRequests as Array<Record<string, unknown>> ?? (stakeAccount as unknown as Record<string, unknown>).withdrawRequest as Array<Record<string, unknown>> ?? [];
  for (let i = 0; i < withdrawRequests.length; i++) {
    const req = withdrawRequests[i];
    if (!req) continue;
    const amount = new BN(req.amount?.toString() ?? '0').toNumber() / Math.pow(10, FAF_DECIMALS);
    const timestamp = new BN(req.timestamp?.toString() ?? '0').toNumber();
    if (amount <= 0) continue;
    requests.push({ index: i, amount, timestamp });
  }
  return requests;
}

// ─── Voltage Info ──────────────────────────────────────────────────────────

export interface FafVoltageInfo {
  /** Voltage tier level (0-based index into VOLTAGE_TIERS) */
  level: number;
  /** Tier name (e.g. "Rookie", "Degen", etc.) */
  tierName: string;
  /** Points multiplier */
  multiplier: number;
  /** Number of trades contributing to voltage */
  tradeCounter: number;
}

/**
 * Read voltage points info from the TokenStakeAccount.
 * Returns null if no stake account.
 */
export async function getVoltageInfo(
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  userPublicKey: PublicKey,
): Promise<FafVoltageInfo | null> {
  let stakeAccount: TokenStakeAccount | null;
  try {
    stakeAccount = await perpClient.getTokenStakeAccount(poolConfig, userPublicKey);
  } catch {
    return null;
  }
  if (!stakeAccount || !stakeAccount.isInitialized) return null;

  const level = Math.min((stakeAccount as unknown as Record<string, unknown>).voltageLevel as number ?? 0, VOLTAGE_TIERS.length - 1);
  const tier = VOLTAGE_TIERS[level] ?? VOLTAGE_TIERS[0];
  const tradeCounter = (stakeAccount as unknown as Record<string, unknown>).tradeCounter ?? 0;

  return {
    level,
    tierName: tier.name,
    multiplier: tier.multiplier,
    tradeCounter: typeof tradeCounter === 'number' ? tradeCounter : new BN(tradeCounter.toString()).toNumber(),
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
