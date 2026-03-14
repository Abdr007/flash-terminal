import { z } from 'zod';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { formatUsd } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { getPoolRegistry, resolvePool, resolveTokenMint } from '../earn/pool-registry.js';
import { getPoolMetrics, getPoolMetric } from '../earn/pool-data.js';
import { IS_AGENT, agentOutput } from '../no-dna.js';

const NOT_AVAILABLE_MSG = chalk.yellow(
  '  Earn features are not available in simulation mode. Connect a wallet for live LP/staking.',
);

function poolNotFound(name: string): ToolResult {
  const pools = getPoolRegistry();
  const lines = [
    '',
    chalk.red(`  Unknown pool: "${name}"`),
    '',
    chalk.dim('  Available pools:'),
    '',
  ];
  for (const p of pools) {
    lines.push(`    ${chalk.cyan(p.aliases[0].padEnd(12))} ${p.displayName}`);
  }
  lines.push('');
  return { success: false, message: lines.join('\n') };
}

// ─── earn pools ─────────────────────────────────────────────────────────────

export const earnPoolsTool: ToolDefinition = {
  name: 'earn_status',
  description: 'View all pools with live yield metrics',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const registry = getPoolRegistry();
    const metrics = await getPoolMetrics();

    if (IS_AGENT) {
      const poolData = registry.map(p => {
        const m = metrics.get(p.poolId);
        return {
          pool_id: p.poolId,
          display_name: p.displayName,
          alias: p.aliases[0],
          flp: p.flpSymbol,
          sflp: p.sflpSymbol,
          assets: p.assets,
          fee_share: p.feeShare,
          tvl: m?.tvl ?? 0,
          apy_7d: m?.apy7d ?? 0,
          apr_7d: m?.apr7d ?? 0,
          flp_price: m?.flpPrice ?? 0,
          sflp_price: m?.sflpPrice ?? 0,
        };
      });
      return { success: true, message: JSON.stringify({ action: 'earn_pools', pools: poolData }) };
    }

    const lines = [
      '',
      `  ${theme.accentBold('FLASH LIQUIDITY POOLS')}`,
      '',
      `  ${'Pool'.padEnd(12)} ${'TVL'.padEnd(10)} ${'APY'.padEnd(10)} ${'APR'.padEnd(10)} Assets`,
      `  ${theme.separator(60)}`,
    ];

    for (const pool of registry) {
      const m = metrics.get(pool.poolId);
      const tvl = m?.tvl ? formatUsd(m.tvl) : '-';
      const apy = m?.apy7d ? `${m.apy7d.toFixed(1)}%` : '-';
      const apr = m?.apr7d ? `${m.apr7d.toFixed(1)}%` : '-';
      const assets = pool.assets.slice(0, 4).join(' ');
      lines.push(`  ${chalk.cyan(pool.aliases[0].padEnd(12))} ${tvl.padEnd(10)} ${chalk.green(apy.padEnd(10))} ${apy === '-' ? apr.padEnd(10) : apr.padEnd(10)} ${chalk.dim(assets)}`);
    }

    lines.push('');
    lines.push(`  ${theme.section('Commands')}`);
    lines.push('');
    lines.push(`    ${chalk.cyan('earn info <pool>')}            Pool details`);
    lines.push(`    ${chalk.cyan('earn deposit <pool> <$>')}     Mint FLP (auto-compound)`);
    lines.push(`    ${chalk.cyan('earn withdraw <pool> <%>')}    Burn FLP → USDC`);
    lines.push(`    ${chalk.cyan('earn stake <pool> <$>')}       Mint sFLP (USDC rewards)`);
    lines.push(`    ${chalk.cyan('earn unstake <pool> <%>')}     Burn sFLP → USDC`);
    lines.push(`    ${chalk.cyan('earn claim <pool>')}           Claim sFLP rewards`);
    lines.push(`    ${chalk.cyan('earn positions')}              Your active positions`);
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn info <pool> ───────────────────────────────────────────────────────

export const earnInfoTool: ToolDefinition = {
  name: 'earn_info',
  description: 'View detailed pool information',
  parameters: z.object({
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, _context): Promise<ToolResult> => {
    const { pool: poolAlias } = params as { pool?: string };
    const poolName = poolAlias ?? 'crypto';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    const m = await getPoolMetric(pool.poolId);

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'earn_info',
          pool_id: pool.poolId,
          display_name: pool.displayName,
          assets: pool.assets,
          fee_share: pool.feeShare,
          flp: pool.flpSymbol,
          sflp: pool.sflpSymbol,
          tvl: m?.tvl ?? 0,
          apy_7d: m?.apy7d ?? 0,
          apr_7d: m?.apr7d ?? 0,
          flp_price: m?.flpPrice ?? 0,
          sflp_price: m?.sflpPrice ?? 0,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold(pool.displayName)}`,
      `  ${theme.separator(40)}`,
      '',
      theme.pair('Pool ID', pool.poolId),
      theme.pair('Fee Share', `${(pool.feeShare * 100).toFixed(0)}%`),
      '',
      theme.pair('FLP Token', `${pool.flpSymbol}${m?.flpPrice ? ` ($${m.flpPrice.toFixed(3)})` : ''}`),
      theme.pair('sFLP Token', `${pool.sflpSymbol}${m?.sflpPrice ? ` ($${m.sflpPrice.toFixed(3)})` : ''}`),
      '',
    ];

    if (m) {
      lines.push(theme.pair('TVL', formatUsd(m.tvl)));
      lines.push(theme.pair('7D APY (FLP)', chalk.green(`${m.apy7d.toFixed(2)}%`)));
      lines.push(theme.pair('7D APR (sFLP)', chalk.green(`${m.apr7d.toFixed(2)}%`)));
      lines.push('');
    }

    lines.push(`  ${theme.dim('Assets:')} ${pool.assets.join(', ')}`);
    lines.push('');
    lines.push(`  ${theme.dim('FLP = auto-compound (fees grow token value)')}`);
    lines.push(`  ${theme.dim('sFLP = staked (fees paid in USDC hourly)')}`);
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn deposit (FLP) ─────────────────────────────────────────────────────

export const earnAddLiquidityTool: ToolDefinition = {
  name: 'earn_add_liquidity',
  description: 'Deposit USDC → mint FLP (auto-compounding)',
  parameters: z.object({
    token: z.string().max(20).default('USDC'),
    amount: z.number().positive(),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount, pool: poolAlias } = params as { token: string; amount: number; pool?: string };
    const client = context.flashClient;
    if (!client.addLiquidity) return { success: false, message: NOT_AVAILABLE_MSG };

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    try {
      const result = await client.addLiquidity('USDC', amount, pool.poolId);
      const lines = [
        '',
        `  ${theme.accentBold('DEPOSIT CONFIRMED')}`,
        '',
        theme.pair('Pool', pool.displayName),
        theme.pair('Deposited', formatUsd(amount) + ' USDC'),
        theme.pair('Received', pool.flpSymbol + ' (auto-compound)'),
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Deposit failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn withdraw (FLP) ────────────────────────────────────────────────────

export const earnRemoveLiquidityTool: ToolDefinition = {
  name: 'earn_remove_liquidity',
  description: 'Burn FLP → receive USDC',
  parameters: z.object({
    token: z.string().max(20).default('USDC'),
    percent: z.number().min(1).max(100),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { percent, pool: poolAlias } = params as { token: string; percent: number; pool?: string };
    const client = context.flashClient;
    if (!client.removeLiquidity) return { success: false, message: NOT_AVAILABLE_MSG };

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    try {
      const result = await client.removeLiquidity('USDC', percent, pool.poolId);
      const lines = [
        '',
        `  ${theme.accentBold('WITHDRAWAL CONFIRMED')}`,
        '',
        theme.pair('Pool', pool.displayName),
        theme.pair('Withdrawn', `${percent}% of ${pool.flpSymbol}`),
        theme.pair('Received', 'USDC'),
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Withdrawal failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn stake (sFLP) ──────────────────────────────────────────────────────

export const earnStakeTool: ToolDefinition = {
  name: 'earn_stake',
  description: 'Deposit USDC → mint sFLP (USDC rewards)',
  parameters: z.object({
    amount: z.number().positive(),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount, pool: poolAlias } = params as { amount: number; pool?: string };
    const client = context.flashClient;
    if (!client.stakeFLP) return { success: false, message: NOT_AVAILABLE_MSG };

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    try {
      const result = await client.stakeFLP(amount, pool.poolId);
      const lines = [
        '',
        `  ${theme.accentBold('STAKE CONFIRMED')}`,
        '',
        theme.pair('Pool', pool.displayName),
        theme.pair('Staked', formatUsd(amount) + ' USDC'),
        theme.pair('Received', pool.sflpSymbol + ' (USDC rewards)'),
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

// ─── earn unstake (sFLP) ────────────────────────────────────────────────────

export const earnUnstakeTool: ToolDefinition = {
  name: 'earn_unstake',
  description: 'Burn sFLP → receive USDC',
  parameters: z.object({
    percent: z.number().min(1).max(100),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { percent, pool: poolAlias } = params as { percent: number; pool?: string };
    const client = context.flashClient;
    if (!client.unstakeFLP) return { success: false, message: NOT_AVAILABLE_MSG };

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    try {
      const result = await client.unstakeFLP(percent, pool.poolId);
      const lines = [
        '',
        `  ${theme.accentBold('UNSTAKE CONFIRMED')}`,
        '',
        theme.pair('Pool', pool.displayName),
        theme.pair('Unstaked', `${percent}% of ${pool.sflpSymbol}`),
        theme.pair('Received', 'USDC'),
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

// ─── earn claim ─────────────────────────────────────────────────────────────

export const earnClaimRewardsTool: ToolDefinition = {
  name: 'earn_claim_rewards',
  description: 'Claim pending sFLP rewards (USDC)',
  parameters: z.object({
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { pool: poolAlias } = params as { pool?: string };
    const client = context.flashClient;
    if (!client.claimRewards) return { success: false, message: NOT_AVAILABLE_MSG };

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    try {
      const result = await client.claimRewards(pool.poolId);
      const lines = [
        '',
        `  ${theme.accentBold('REWARDS CLAIMED')}`,
        '',
        theme.pair('Pool', pool.displayName),
        theme.pair('Received', 'USDC rewards'),
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Claim failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn positions ─────────────────────────────────────────────────────────

export const earnPositionsTool: ToolDefinition = {
  name: 'earn_positions',
  description: 'View your active liquidity positions',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) {
      return { success: true, message: chalk.dim('  No wallet connected.') };
    }

    const registry = getPoolRegistry();
    const metrics = await getPoolMetrics();

    // Get all token balances
    let tokenData: { sol: number; tokens: Array<{ mint: string; amount: number }> } | null = null;
    try {
      tokenData = await wm.getTokenBalances();
    } catch {
      return { success: false, message: chalk.red('  Failed to fetch token balances.') };
    }

    if (!tokenData) {
      return { success: true, message: chalk.dim('  No token data available.') };
    }

    const positions: Array<{ pool: string; type: string; balance: number; value: number; rewards: string }> = [];

    for (const token of tokenData.tokens) {
      const resolved = resolveTokenMint(token.mint);
      if (!resolved) continue;

      const { pool, type } = resolved;
      const m = metrics.get(pool.poolId);
      const price = type === 'FLP' ? (m?.flpPrice ?? 0) : (m?.sflpPrice ?? 0);
      const value = token.amount * price;

      if (token.amount > 0.001) {
        positions.push({
          pool: pool.aliases[0],
          type,
          balance: token.amount,
          value,
          rewards: type === 'sFLP' ? 'USDC hourly' : 'auto-compound',
        });
      }
    }

    if (positions.length === 0) {
      return {
        success: true,
        message: [
          '',
          chalk.dim('  No active earn positions.'),
          chalk.dim('  Use "earn deposit <pool> <amount>" to start earning.'),
          '',
        ].join('\n'),
      };
    }

    if (IS_AGENT) {
      return { success: true, message: JSON.stringify({ action: 'earn_positions', positions }) };
    }

    const lines = [
      '',
      `  ${theme.accentBold('YOUR EARN POSITIONS')}`,
      '',
      `  ${'Pool'.padEnd(12)} ${'Type'.padEnd(8)} ${'Balance'.padEnd(14)} ${'Value'.padEnd(12)} Rewards`,
      `  ${theme.separator(60)}`,
    ];

    for (const pos of positions) {
      lines.push(
        `  ${chalk.cyan(pos.pool.padEnd(12))} ${pos.type.padEnd(8)} ${pos.balance.toFixed(4).padEnd(14)} ${formatUsd(pos.value).padEnd(12)} ${chalk.dim(pos.rewards)}`
      );
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── Export All ──────────────────────────────────────────────────────────────

export const allEarnTools: ToolDefinition[] = [
  earnPoolsTool,
  earnInfoTool,
  earnAddLiquidityTool,
  earnRemoveLiquidityTool,
  earnStakeTool,
  earnUnstakeTool,
  earnClaimRewardsTool,
  earnPositionsTool,
];
