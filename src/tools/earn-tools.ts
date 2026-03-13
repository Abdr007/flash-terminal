import { z } from 'zod';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { formatUsd } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';

const NOT_AVAILABLE_MSG = chalk.yellow(
  '  Earn features are not available in simulation mode. Connect a wallet for live LP/staking.',
);

// ─── earn add-liquidity ──────────────────────────────────────────────────────

export const earnAddLiquidityTool: ToolDefinition = {
  name: 'earn_add_liquidity',
  description: 'Add liquidity to a Flash Trade pool',
  parameters: z.object({
    token: z.string().max(20).default('USDC'),
    amount: z.number().positive(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { token, amount } = params as { token: string; amount: number };
    const client = context.flashClient;

    if (!client.addLiquidity) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    try {
      const result = await client.addLiquidity(token.toUpperCase(), amount);
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
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { token, percent } = params as { token: string; percent: number };
    const client = context.flashClient;

    if (!client.removeLiquidity) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return { success: false, message: chalk.red('  Percent must be between 1 and 100.') };
    }

    try {
      const result = await client.removeLiquidity(token.toUpperCase(), percent);
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
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount } = params as { amount: number };
    const client = context.flashClient;

    if (!client.stakeFLP) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Stake amount must be a positive number.') };
    }

    try {
      const result = await client.stakeFLP(amount);
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
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { percent } = params as { percent: number };
    const client = context.flashClient;

    if (!client.unstakeFLP) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return { success: false, message: chalk.red('  Percent must be between 1 and 100.') };
    }

    try {
      const result = await client.unstakeFLP(percent);
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
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const client = context.flashClient;

    if (!client.claimRewards) {
      return { success: false, message: NOT_AVAILABLE_MSG };
    }

    try {
      const result = await client.claimRewards();
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
  description: 'View earn/LP/staking status and available commands',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const lines = [
      '',
      `  ${theme.accentBold('EARN')}  ${chalk.dim('— LP & Staking on Flash Trade')}`,
      '',
      `  ${chalk.dim('Liquidity')}`,
      `    ${chalk.cyan('earn add-liquidity $100')}        Add liquidity (default: USDC)`,
      `    ${chalk.cyan('earn add-liquidity $200 SOL')}    Add liquidity in SOL`,
      `    ${chalk.cyan('earn remove-liquidity 50%')}      Remove 50% of LP position`,
      '',
      `  ${chalk.dim('Staking')}`,
      `    ${chalk.cyan('earn stake $200')}                Stake FLP tokens`,
      `    ${chalk.cyan('earn unstake 25%')}               Unstake 25% of FLP`,
      '',
      `  ${chalk.dim('Rewards')}`,
      `    ${chalk.cyan('earn claim')}                     Claim all pending rewards`,
      '',
      `  ${chalk.dim('Note: Earn features require a connected wallet (live mode).')}`,
      '',
    ];
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
