import { z } from 'zod';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { formatUsd } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { POOL_NAMES } from '../config/index.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';

const NOT_AVAILABLE_MSG = chalk.yellow(
  '  Earn features are not available in simulation mode. Connect a wallet for live LP/staking.',
);

/** Load pool FLP token info dynamically from SDK PoolConfig */
function getPoolEarnInfo(): Array<{ poolName: string; flp: string; sflp: string; tokens: string[] }> {
  try {
    const { PoolConfig } = require('flash-sdk');
    const result: Array<{ poolName: string; flp: string; sflp: string; tokens: string[] }> = [];
    for (const name of POOL_NAMES) {
      try {
        const pc = PoolConfig.fromIdsByName(name, 'mainnet-beta');
        const tokens = (pc.tokens as Array<{ symbol: string }>).map((t: { symbol: string }) => t.symbol);
        result.push({
          poolName: name,
          flp: pc.compoundingLpTokenSymbol || 'FLP',
          sflp: pc.stakedLpTokenSymbol || 'sFLP',
          tokens,
        });
      } catch {
        // Pool not loadable by SDK
      }
    }
    return result;
  } catch {
    return [];
  }
}

// ─── earn add-liquidity ──────────────────────────────────────────────────────

export const earnAddLiquidityTool: ToolDefinition = {
  name: 'earn_add_liquidity',
  description: 'Add liquidity to a Flash Trade pool',
  parameters: z.object({
    token: z.string().max(20).default('USDC'),
    amount: z.number().positive(),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { token, amount, pool } = params as { token: string; amount: number; pool?: string };
    const client = context.flashClient;

    if (!client.addLiquidity) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    try {
      const result = await client.addLiquidity(token.toUpperCase(), amount, pool);
      const lines = [
        '',
        `  ${theme.accentBold('LIQUIDITY ADDED')}`,
        '',
        `  ${chalk.dim('Token:')}  ${token.toUpperCase()}`,
        `  ${chalk.dim('Amount:')} ${formatUsd(amount)}`,
        `  ${chalk.dim('Tx:')}     ${result.txSignature}`,
        '',
        `  ${result.message}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Add liquidity failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn remove-liquidity ───────────────────────────────────────────────────

export const earnRemoveLiquidityTool: ToolDefinition = {
  name: 'earn_remove_liquidity',
  description: 'Remove liquidity from a Flash Trade pool',
  parameters: z.object({
    token: z.string().max(20).default('USDC'),
    percent: z.number().min(1).max(100),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { token, percent, pool } = params as { token: string; percent: number; pool?: string };
    const client = context.flashClient;

    if (!client.removeLiquidity) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return { success: false, message: chalk.red('  Percent must be between 1 and 100.') };
    }

    try {
      const result = await client.removeLiquidity(token.toUpperCase(), percent, pool);
      const lines = [
        '',
        `  ${theme.accentBold('LIQUIDITY REMOVED')}`,
        '',
        `  ${chalk.dim('Token:')}   ${token.toUpperCase()}`,
        `  ${chalk.dim('Percent:')} ${percent}%`,
        `  ${chalk.dim('Tx:')}      ${result.txSignature}`,
        '',
        `  ${result.message}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Remove liquidity failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn stake ──────────────────────────────────────────────────────────────

export const earnStakeTool: ToolDefinition = {
  name: 'earn_stake',
  description: 'Stake FLP tokens for rewards',
  parameters: z.object({
    amount: z.number().positive(),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount, pool } = params as { amount: number; pool?: string };
    const client = context.flashClient;

    if (!client.stakeFLP) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Stake amount must be a positive number.') };
    }

    try {
      const result = await client.stakeFLP(amount, pool);
      const lines = [
        '',
        `  ${theme.accentBold('FLP STAKED')}`,
        '',
        `  ${chalk.dim('Amount:')} ${formatUsd(amount)}`,
        `  ${chalk.dim('Tx:')}     ${result.txSignature}`,
        '',
        `  ${result.message}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Stake failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn unstake ────────────────────────────────────────────────────────────

export const earnUnstakeTool: ToolDefinition = {
  name: 'earn_unstake',
  description: 'Unstake FLP tokens',
  parameters: z.object({
    percent: z.number().min(1).max(100),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { percent, pool } = params as { percent: number; pool?: string };
    const client = context.flashClient;

    if (!client.unstakeFLP) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return { success: false, message: chalk.red('  Percent must be between 1 and 100.') };
    }

    try {
      const result = await client.unstakeFLP(percent, pool);
      const lines = [
        '',
        `  ${theme.accentBold('FLP UNSTAKED')}`,
        '',
        `  ${chalk.dim('Percent:')} ${percent}%`,
        `  ${chalk.dim('Tx:')}      ${result.txSignature}`,
        '',
        `  ${result.message}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Unstake failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn claim-rewards ──────────────────────────────────────────────────────

export const earnClaimRewardsTool: ToolDefinition = {
  name: 'earn_claim_rewards',
  description: 'Claim all pending LP/staking rewards',
  parameters: z.object({
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { pool } = params as { pool?: string };
    const client = context.flashClient;

    if (!client.claimRewards) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    try {
      const result = await client.claimRewards(pool);
      const lines = [
        '',
        `  ${theme.accentBold('REWARDS CLAIMED')}`,
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
        '',
        `  ${result.message}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Claim rewards failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn status ─────────────────────────────────────────────────────────────

export const earnStatusTool: ToolDefinition = {
  name: 'earn_status',
  description: 'View all pools, FLP tokens, and earn commands',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const pools = getPoolEarnInfo();

    const lines = [
      '',
      `  ${theme.accentBold('EARN')}  ${chalk.dim('— LP & Staking on Flash Trade')}`,
      '',
      `  ${chalk.dim('─'.repeat(60))}`,
      `  ${chalk.bold('Pool'.padEnd(16))}${chalk.bold('FLP Token'.padEnd(12))}${chalk.bold('Staked'.padEnd(12))}${chalk.bold('Pool Tokens')}`,
      `  ${chalk.dim('─'.repeat(60))}`,
    ];

    for (const pool of pools) {
      const tokensStr = pool.tokens.join(', ');
      lines.push(
        `  ${chalk.white(pool.poolName.padEnd(16))}${chalk.green(pool.flp.padEnd(12))}${chalk.yellow(pool.sflp.padEnd(12))}${chalk.dim(tokensStr)}`,
      );
    }

    lines.push(`  ${chalk.dim('─'.repeat(60))}`);
    lines.push('');
    lines.push(`  ${chalk.dim('Commands')}  ${chalk.dim('(add pool:<name> to target a specific pool)')}`);
    lines.push('');
    lines.push(`    ${chalk.cyan('earn add-liquidity $100')}                Add USDC to default pool`);
    lines.push(`    ${chalk.cyan('earn add-liquidity $100 SOL')}            Add SOL liquidity`);
    lines.push(`    ${chalk.cyan('earn add-liquidity $100 pool:Governance.1')}  Add to specific pool`);
    lines.push(`    ${chalk.cyan('earn remove-liquidity 50%')}              Remove 50% of LP`);
    lines.push(`    ${chalk.cyan('earn stake $200')}                        Stake FLP → sFLP`);
    lines.push(`    ${chalk.cyan('earn stake $200 pool:Virtual.1')}         Stake in specific pool`);
    lines.push(`    ${chalk.cyan('earn unstake 25%')}                       Unstake 25% of sFLP`);
    lines.push(`    ${chalk.cyan('earn claim')}                             Claim pending rewards`);
    lines.push(`    ${chalk.cyan('earn claim pool:Ondo.1')}                 Claim from specific pool`);
    lines.push('');
    lines.push(`  ${chalk.dim('Note: Earn features require a connected wallet (live mode).')}`);
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

export const allEarnTools: ToolDefinition[] = [
  earnAddLiquidityTool,
  earnRemoveLiquidityTool,
  earnStakeTool,
  earnUnstakeTool,
  earnClaimRewardsTool,
  earnStatusTool,
];
