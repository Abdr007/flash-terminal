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

// ─── Pool Alias Map ─────────────────────────────────────────────────────────
// Human-friendly names → protocol pool IDs. Shared with interpreter.

const POOL_ALIAS_TO_NAME: Record<string, string> = {
  'Crypto.1': 'crypto',
  'Virtual.1': 'virtual',
  'Governance.1': 'governance',
  'Community.1': 'community',
  'Community.2': 'meme',
  'Trump.1': 'trump',
  'Ore.1': 'ore',
  'Ondo.1': 'ondo',
};

/** Reverse: get human alias for a pool name */
function poolAlias(poolName: string): string {
  return POOL_ALIAS_TO_NAME[poolName] ?? poolName;
}

const VALID_POOLS = Object.values(POOL_ALIAS_TO_NAME);

function invalidPoolError(pool: string): ToolResult {
  const lines = [
    '',
    chalk.red(`  Invalid pool: "${pool}"`),
    '',
    `  ${chalk.dim('Available pools:')}`,
    '',
  ];
  for (const alias of VALID_POOLS) {
    lines.push(`    ${chalk.cyan(alias)}`);
  }
  lines.push('');
  return { success: false, message: lines.join('\n') };
}

/** Load pool FLP token info dynamically from SDK PoolConfig */
function getPoolEarnInfo(): Array<{ poolName: string; alias: string; flp: string; sflp: string; tokens: string[] }> {
  try {
    const { PoolConfig } = require('flash-sdk');
    const result: Array<{ poolName: string; alias: string; flp: string; sflp: string; tokens: string[] }> = [];
    for (const name of POOL_NAMES) {
      try {
        const pc = PoolConfig.fromIdsByName(name, 'mainnet-beta');
        const tokens = (pc.tokens as Array<{ symbol: string }>).map((t: { symbol: string }) => t.symbol);
        result.push({
          poolName: name,
          alias: poolAlias(name),
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
      const alias = pool ? poolAlias(pool) : 'crypto';
      const lines = [
        '',
        `  ${theme.accentBold('EARN TRANSACTION CONFIRMED')}`,
        '',
        `  ${chalk.dim('Action:')} Add Liquidity`,
        `  ${chalk.dim('Pool:')}   ${alias}`,
        `  ${chalk.dim('Amount:')} ${formatUsd(amount)}`,
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
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
      return { success: false, message: chalk.red('  Value must be between 1% and 100%.') };
    }

    try {
      const result = await client.removeLiquidity(token.toUpperCase(), percent, pool);
      const alias = pool ? poolAlias(pool) : 'crypto';
      const lines = [
        '',
        `  ${theme.accentBold('EARN TRANSACTION CONFIRMED')}`,
        '',
        `  ${chalk.dim('Action:')}  Remove Liquidity`,
        `  ${chalk.dim('Pool:')}    ${alias}`,
        `  ${chalk.dim('Percent:')} ${percent}%`,
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
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
      const alias = pool ? poolAlias(pool) : 'crypto';
      const lines = [
        '',
        `  ${theme.accentBold('EARN TRANSACTION CONFIRMED')}`,
        '',
        `  ${chalk.dim('Action:')} Stake FLP`,
        `  ${chalk.dim('Pool:')}   ${alias}`,
        `  ${chalk.dim('Amount:')} ${formatUsd(amount)}`,
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
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
      return { success: false, message: chalk.red('  Value must be between 1% and 100%.') };
    }

    try {
      const result = await client.unstakeFLP(percent, pool);
      const alias = pool ? poolAlias(pool) : 'crypto';
      const lines = [
        '',
        `  ${theme.accentBold('EARN TRANSACTION CONFIRMED')}`,
        '',
        `  ${chalk.dim('Action:')}  Unstake FLP`,
        `  ${chalk.dim('Pool:')}    ${alias}`,
        `  ${chalk.dim('Percent:')} ${percent}%`,
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
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
      const alias = pool ? poolAlias(pool) : 'all pools';
      const lines = [
        '',
        `  ${theme.accentBold('EARN TRANSACTION CONFIRMED')}`,
        '',
        `  ${chalk.dim('Action:')} Claim Rewards`,
        `  ${chalk.dim('Pool:')}   ${alias}`,
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
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
  description: 'View all pools and earn commands',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const pools = getPoolEarnInfo();

    const COL = 16;
    const lines = [
      '',
      `  ${theme.accentBold('EARN POOLS')}`,
      '',
    ];

    for (const pool of pools) {
      // Filter out USDC/WSOL/JITOSOL from display — they're collateral, not markets
      const displayTokens = pool.tokens
        .filter(t => !['USDC', 'USDT', 'WSOL', 'JITOSOL', 'XAUT'].includes(t))
        .join('  ');
      lines.push(
        `    ${chalk.cyan(pool.alias.padEnd(COL))}${chalk.dim(displayTokens)}`,
      );
    }

    lines.push('');
    lines.push(`  ${theme.accentBold('Commands')}`,);
    lines.push('');
    lines.push(`    ${chalk.cyan('earn add $100 crypto')}              Add liquidity`);
    lines.push(`    ${chalk.cyan('earn remove 50% crypto')}            Remove liquidity`);
    lines.push(`    ${chalk.cyan('earn stake $200 governance')}        Stake FLP`);
    lines.push(`    ${chalk.cyan('earn unstake 25% governance')}       Unstake FLP`);
    lines.push(`    ${chalk.cyan('earn claim')}                        Claim all rewards`);
    lines.push(`    ${chalk.cyan('earn claim crypto')}                 Claim from pool`);
    lines.push('');
    lines.push(`  ${chalk.dim('Default pool: crypto. Earn requires a connected wallet.')}`);
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
