/**
 * FAF Token Tools
 *
 * CLI tools for FAF governance staking, revenue claiming,
 * VIP tier management, and referral system.
 */

import { z } from 'zod';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { formatUsd } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { IS_AGENT } from '../no-dna.js';
import {
  VIP_TIERS, VOLTAGE_TIERS, getVipTier, getNextTier, formatFaf,
  FAF_DECIMALS, UNSTAKE_UNLOCK_DAYS,
} from '../token/faf-registry.js';
import { getFafStakeInfo, getFafBalance } from '../token/faf-data.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getStakeContext(context: any) {
  const wm = context.walletManager;
  if (!wm?.isConnected) return { error: chalk.dim('  No wallet connected.') };

  const client = context.flashClient;
  if (!client?.perpClient || !client?.poolConfig) {
    return { error: chalk.dim('  FAF staking requires a live trading connection.') };
  }

  const { PublicKey } = await import('@solana/web3.js');
  const userPk = new PublicKey(context.walletAddress);

  return { client, perpClient: client.perpClient, poolConfig: client.poolConfig, userPk, wm, connection: client.connection };
}

// ─── faf status (dashboard) ─────────────────────────────────────────────────

export const fafStatusTool: ToolDefinition = {
  name: 'faf_status',
  description: 'FAF staking dashboard — stake, rewards, VIP tier',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: true, message: ctx.error as string };

    const { perpClient, poolConfig, userPk, connection } = ctx;

    const stakeInfo = await getFafStakeInfo(perpClient, poolConfig, userPk);
    const walletBalance = await getFafBalance(connection, userPk);

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'faf_status',
          wallet_balance_faf: walletBalance,
          staked_faf: stakeInfo?.stakedAmount ?? 0,
          vip_level: stakeInfo?.level ?? 0,
          fee_discount: stakeInfo?.tier.feeDiscount ?? 0,
          pending_rewards_faf: stakeInfo?.pendingRewards ?? 0,
          pending_revenue_usdc: stakeInfo?.pendingRevenue ?? 0,
          withdraw_requests: stakeInfo?.withdrawRequestCount ?? 0,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('FAF STAKING DASHBOARD')}`,
      `  ${theme.separator(50)}`,
      '',
    ];

    if (!stakeInfo || stakeInfo.stakedAmount === 0) {
      lines.push(theme.pair('Wallet FAF', walletBalance > 0 ? formatFaf(walletBalance) : '0 FAF'));
      lines.push(theme.pair('Staked', '0 FAF'));
      lines.push(theme.pair('VIP Tier', 'Level 0 (no discount)'));
      lines.push('');
      lines.push(chalk.dim('  Stake FAF to earn 50% protocol revenue + fee discounts.'));
      lines.push(chalk.dim('  Use "faf stake <amount>" to start.'));
    } else {
      const tier = stakeInfo.tier;
      const nextTier = getNextTier(stakeInfo.level);

      lines.push(theme.pair('Wallet FAF', formatFaf(walletBalance)));
      lines.push(theme.pair('Staked', chalk.green(formatFaf(stakeInfo.stakedAmount))));
      lines.push(theme.pair('VIP Tier', `Level ${stakeInfo.level} (${tier.feeDiscount}% fee discount)`));
      lines.push('');

      if (stakeInfo.pendingRewards > 0) {
        lines.push(theme.pair('FAF Rewards', chalk.green(formatFaf(stakeInfo.pendingRewards))));
      }
      if (stakeInfo.pendingRevenue > 0) {
        lines.push(theme.pair('USDC Revenue', chalk.green(formatUsd(stakeInfo.pendingRevenue))));
      }
      if (stakeInfo.pendingRewards === 0 && stakeInfo.pendingRevenue === 0) {
        lines.push(theme.pair('Pending', chalk.dim('No claimable rewards')));
      }

      if (stakeInfo.withdrawRequestCount > 0) {
        lines.push('');
        lines.push(theme.pair('Unstake Requests', `${stakeInfo.withdrawRequestCount} active (${UNSTAKE_UNLOCK_DAYS}-day unlock)`));
      }

      if (nextTier) {
        const needed = nextTier.fafRequired - stakeInfo.stakedAmount;
        lines.push('');
        lines.push(chalk.dim(`  Next tier: Level ${nextTier.level} (stake ${formatFaf(needed)} more → ${nextTier.feeDiscount}% discount)`));
      }
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── faf stake ──────────────────────────────────────────────────────────────

export const fafStakeTool: ToolDefinition = {
  name: 'faf_stake',
  description: 'Stake FAF tokens for revenue sharing + VIP tier',
  parameters: z.object({
    amount: z.number().positive(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount } = params as { amount: number };
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: false, message: ctx.error as string };

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const { client, perpClient, poolConfig, userPk, connection } = ctx;
    const balance = await getFafBalance(connection, userPk);
    if (balance < amount) {
      return { success: false, message: chalk.red(`  Insufficient FAF: have ${formatFaf(balance)}, need ${formatFaf(amount)}`) };
    }

    try {
      const nativeAmount = BigInt(Math.floor(amount * Math.pow(10, FAF_DECIMALS)));
      const BN = (await import('bn.js')).default;
      const result = await perpClient.depositTokenStake(userPk, userPk, new BN(nativeAmount.toString()), poolConfig);
      const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);

      const newTier = getVipTier(balance); // approximate — will refresh on next status
      const lines = [
        '',
        `  ${theme.accentBold('FAF STAKED')}`,
        '',
        theme.pair('Amount', formatFaf(amount)),
        theme.pair('VIP Tier', `Level ${newTier.level} (${newTier.feeDiscount}% discount)`),
        '',
        `  ${chalk.dim('Tx:')} ${sig}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: sig };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Stake failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── faf unstake ────────────────────────────────────────────────────────────

export const fafUnstakeTool: ToolDefinition = {
  name: 'faf_unstake',
  description: 'Request FAF unstake (90-day linear unlock)',
  parameters: z.object({
    amount: z.number().positive(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount } = params as { amount: number };
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: false, message: ctx.error as string };

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const { client, perpClient, poolConfig, userPk } = ctx;

    try {
      const nativeAmount = BigInt(Math.floor(amount * Math.pow(10, FAF_DECIMALS)));
      const BN = (await import('bn.js')).default;
      const result = await perpClient.unstakeTokenRequest(userPk, new BN(nativeAmount.toString()), poolConfig);
      const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);

      const lines = [
        '',
        `  ${theme.accentBold('UNSTAKE REQUESTED')}`,
        '',
        theme.pair('Amount', formatFaf(amount)),
        theme.pair('Unlock', `Linear over ${UNSTAKE_UNLOCK_DAYS} days`),
        '',
        chalk.dim('  You continue earning revenue until tokens fully unlock.'),
        '',
        `  ${chalk.dim('Tx:')} ${sig}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: sig };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Unstake request failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── faf claim ──────────────────────────────────────────────────────────────

export const fafClaimTool: ToolDefinition = {
  name: 'faf_claim',
  description: 'Claim FAF rewards and/or USDC revenue',
  parameters: z.object({
    type: z.enum(['all', 'rewards', 'revenue', 'rebate']).default('all'),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { type } = params as { type: string };
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: false, message: ctx.error as string };

    const { client, perpClient, poolConfig, userPk } = ctx;
    const claimed: string[] = [];
    const sigs: string[] = [];

    try {
      // Claim FAF rewards
      if (type === 'all' || type === 'rewards') {
        try {
          const result = await perpClient.collectTokenReward(userPk, poolConfig);
          const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);
          claimed.push('FAF rewards');
          sigs.push(sig);
        } catch (e: unknown) {
          if (type === 'rewards') throw e;
          // Non-critical if claiming all — may not have rewards
        }
      }

      // Claim USDC revenue
      if (type === 'all' || type === 'revenue') {
        try {
          const result = await perpClient.collectRevenue(userPk, 'USDC', poolConfig);
          const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);
          claimed.push('USDC revenue');
          sigs.push(sig);
        } catch (e: unknown) {
          if (type === 'revenue') throw e;
        }
      }

      // Claim referral rebates
      if (type === 'all' || type === 'rebate') {
        try {
          const result = await perpClient.collectRebate(userPk, 'USDC', poolConfig);
          const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);
          claimed.push('referral rebates');
          sigs.push(sig);
        } catch (e: unknown) {
          if (type === 'rebate') throw e;
        }
      }

      if (claimed.length === 0) {
        return { success: true, message: chalk.dim('  No claimable rewards found.') };
      }

      const lines = [
        '',
        `  ${theme.accentBold('REWARDS CLAIMED')}`,
        '',
        theme.pair('Claimed', claimed.join(', ')),
        '',
      ];
      for (const sig of sigs) {
        lines.push(`  ${chalk.dim('Tx:')} ${sig}`);
      }
      lines.push('');
      return { success: true, message: lines.join('\n'), txSignature: sigs[0] };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Claim failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── faf tier ───────────────────────────────────────────────────────────────

export const fafTierTool: ToolDefinition = {
  name: 'faf_tier',
  description: 'Show VIP tier levels and benefits',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    // Try to get user's current tier
    let currentLevel = 0;
    try {
      const ctx = await getStakeContext(context);
      if (!('error' in ctx)) {
        const info = await getFafStakeInfo(ctx.perpClient, ctx.poolConfig, ctx.userPk);
        if (info) currentLevel = info.level;
      }
    } catch { /* non-critical */ }

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'faf_tier',
          current_level: currentLevel,
          tiers: VIP_TIERS.map(t => ({
            level: t.level, faf_required: t.fafRequired,
            fee_discount: t.feeDiscount, referral_rebate: t.referralRebate,
          })),
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('VIP TIER LEVELS')}`,
      `  ${theme.separator(65)}`,
      '',
      `  ${'Level'.padEnd(10)} ${'FAF Required'.padEnd(14)} ${'Fee Disc.'.padEnd(12)} ${'Referral'.padEnd(12)} ${'Spot LO'.padEnd(10)} DCA`,
      `  ${theme.separator(65)}`,
    ];

    for (const tier of VIP_TIERS) {
      const marker = tier.level === currentLevel ? chalk.green(' ←') : '';
      const faf = tier.fafRequired === 0 ? '0' : formatFaf(tier.fafRequired);
      lines.push(
        `  ${(`Level ${tier.level}`).padEnd(10)} ${faf.padEnd(14)} ${(tier.feeDiscount + '%').padEnd(12)} ${(tier.referralRebate + '%').padEnd(12)} ${(tier.spotLoDiscount + '%').padEnd(10)} ${tier.dcaDiscount}%${marker}`
      );
    }

    lines.push('');
    lines.push(chalk.dim('  Stake FAF to unlock fee discounts and higher referral rebates.'));
    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── faf rewards ────────────────────────────────────────────────────────────

export const fafRewardsTool: ToolDefinition = {
  name: 'faf_rewards',
  description: 'Show pending FAF rewards and USDC revenue',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: true, message: ctx.error as string };

    const { perpClient, poolConfig, userPk } = ctx;
    const info = await getFafStakeInfo(perpClient, poolConfig, userPk);

    if (!info) {
      return { success: true, message: chalk.dim('  No FAF staking position found. Use "faf stake" to start.') };
    }

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'faf_rewards',
          pending_faf: info.pendingRewards,
          pending_usdc: info.pendingRevenue,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('PENDING REWARDS')}`,
      `  ${theme.separator(40)}`,
      '',
      theme.pair('FAF Rewards', info.pendingRewards > 0 ? chalk.green(formatFaf(info.pendingRewards)) : chalk.dim('0 FAF')),
      theme.pair('USDC Revenue', info.pendingRevenue > 0 ? chalk.green(formatUsd(info.pendingRevenue)) : chalk.dim('$0.00')),
      '',
    ];

    if (info.pendingRewards > 0 || info.pendingRevenue > 0) {
      lines.push(chalk.dim('  Use "faf claim" to collect all rewards.'));
      lines.push('');
    }

    return { success: true, message: lines.join('\n') };
  },
};

// ─── Export All ──────────────────────────────────────────────────────────────

export const allFafTools: ToolDefinition[] = [
  fafStatusTool,
  fafStakeTool,
  fafUnstakeTool,
  fafClaimTool,
  fafTierTool,
  fafRewardsTool,
];
