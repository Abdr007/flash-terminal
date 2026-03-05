import { z } from 'zod';
import {
  ToolDefinition,
  ToolContext,
  ToolResult,
  TradeSide,
  Position,
  MarketData,
  MarketOI,
  DailyVolume,
  LeaderboardEntry,
} from '../types/index.js';
import {
  formatUsd,
  formatPrice,
  colorPnl,
  colorPercent,
  colorSide,
  formatTable,
  shortAddress,
} from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import chalk from 'chalk';

// ─── flash_open_position ─────────────────────────────────────────────────────

export const flashOpenPosition: ToolDefinition = {
  name: 'flash_open_position',
  description: 'Open a leveraged trading position on Flash Trade',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    collateral: z.number().positive(),
    leverage: z.number().min(1).max(500),
    collateral_token: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side, collateral, leverage, collateral_token } = params as {
      market: string;
      side: TradeSide;
      collateral: number;
      leverage: number;
      collateral_token?: string;
    };
    const sizeUsd = collateral * leverage;

    const prompt = [
      '',
      chalk.yellow('  Opening Position'),
      chalk.dim('  ─────────────────'),
      `  Market:     ${chalk.bold(market)} ${colorSide(side)}`,
      `  Leverage:   ${chalk.bold(leverage + 'x')}`,
      `  Collateral: ${chalk.bold(formatUsd(collateral))}`,
      `  Size:       ${chalk.bold(formatUsd(sizeUsd))}`,
      '',
    ].join('\n');

    return {
      success: true,
      message: prompt,
      requiresConfirmation: true,
      confirmationPrompt: 'Execute trade?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await context.flashClient.openPosition(
              market, side, collateral, leverage, collateral_token
            );
            const txLink = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: [
                '',
                chalk.green('  Position Opened'),
                chalk.dim('  ─────────────────'),
                `  Entry Price: ${formatPrice(result.entryPrice)}`,
                `  Size:        ${formatUsd(result.sizeUsd)}`,
                `  TX: ${chalk.dim(txLink)}`,
                '',
              ].join('\n'),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            return { success: false, message: `Failed to open position: ${getErrorMessage(error)}` };
          }
        },
      },
    };
  },
};

// ─── flash_close_position ────────────────────────────────────────────────────

export const flashClosePosition: ToolDefinition = {
  name: 'flash_close_position',
  description: 'Close an existing trading position',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side } = params as { market: string; side: TradeSide };

    return {
      success: true,
      message: [
        '',
        chalk.yellow('  Closing Position'),
        chalk.dim('  ─────────────────'),
        `  Market: ${chalk.bold(market)} ${colorSide(side)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: 'Confirm close?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await context.flashClient.closePosition(market, side);
            const pnlStr = result.pnl !== undefined ? `  PnL: ${colorPnl(result.pnl)}\n` : '';
            const txLink = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: [
                '',
                chalk.green('  Position Closed'),
                chalk.dim('  ─────────────────'),
                `  Exit Price: ${formatPrice(result.exitPrice)}`,
                pnlStr,
                `  TX: ${chalk.dim(txLink)}`,
                '',
              ].join('\n'),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            return { success: false, message: `Failed to close position: ${getErrorMessage(error)}` };
          }
        },
      },
    };
  },
};

// ─── flash_add_collateral ────────────────────────────────────────────────────

export const flashAddCollateral: ToolDefinition = {
  name: 'flash_add_collateral',
  description: 'Add collateral to an existing position',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    amount: z.number().positive(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side, amount } = params as { market: string; side: TradeSide; amount: number };

    return {
      success: true,
      message: [
        '',
        chalk.yellow('  Adding Collateral'),
        chalk.dim('  ─────────────────'),
        `  Market: ${chalk.bold(market)} ${colorSide(side)}`,
        `  Amount: ${formatUsd(amount)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await context.flashClient.addCollateral(market, side, amount);
            return {
              success: true,
              message: chalk.green(`  Collateral added. TX: ${chalk.dim(result.txSignature)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            return { success: false, message: `Failed: ${getErrorMessage(error)}` };
          }
        },
      },
    };
  },
};

// ─── flash_remove_collateral ─────────────────────────────────────────────────

export const flashRemoveCollateral: ToolDefinition = {
  name: 'flash_remove_collateral',
  description: 'Remove collateral from an existing position',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    amount: z.number().positive(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side, amount } = params as { market: string; side: TradeSide; amount: number };

    return {
      success: true,
      message: [
        '',
        chalk.yellow('  Removing Collateral'),
        chalk.dim('  ─────────────────'),
        `  Market: ${chalk.bold(market)} ${colorSide(side)}`,
        `  Amount: ${formatUsd(amount)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await context.flashClient.removeCollateral(market, side, amount);
            return {
              success: true,
              message: chalk.green(`  Collateral removed. TX: ${chalk.dim(result.txSignature)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            return { success: false, message: `Failed: ${getErrorMessage(error)}` };
          }
        },
      },
    };
  },
};

// ─── flash_get_positions ─────────────────────────────────────────────────────

export const flashGetPositions: ToolDefinition = {
  name: 'flash_get_positions',
  description: 'Get all open positions',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const positions = await context.flashClient.getPositions();
    if (positions.length === 0) {
      return { success: true, message: chalk.dim('  No open positions') };
    }

    const headers = ['Market', 'Side', 'Leverage', 'Size', 'Collateral', 'PnL', 'Liq Price'];
    const rows = positions.map((p: Position) => [
      chalk.bold(p.market),
      colorSide(p.side),
      `${p.leverage.toFixed(1)}x`,
      formatUsd(p.sizeUsd),
      formatUsd(p.collateralUsd),
      `${colorPnl(p.unrealizedPnl)} ${chalk.dim(`(${colorPercent(p.unrealizedPnlPercent)})`)}`,
      formatPrice(p.liquidationPrice),
    ]);

    return {
      success: true,
      message: '\n' + formatTable(headers, rows) + '\n',
      data: { positions },
    };
  },
};

// ─── flash_get_market_data ───────────────────────────────────────────────────

export const flashGetMarketData: ToolDefinition = {
  name: 'flash_get_market_data',
  description: 'Get market prices and data',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market } = params as { market?: string };
    const markets = await context.flashClient.getMarketData(market);
    if (markets.length === 0) {
      return { success: true, message: chalk.dim('  No market data available') };
    }

    // Enrich with fstats OI data if available
    try {
      const oi = await context.dataClient.getOpenInterest();
      for (const m of markets) {
        const oiData = oi.markets.find(
          (o: MarketOI) => o.market.includes(m.symbol)
        );
        if (oiData) {
          m.openInterestLong = oiData.longOi;
          m.openInterestShort = oiData.shortOi;
        }
      }
    } catch { /* ignore fstats errors */ }

    const headers = ['Market', 'Price', 'OI Long', 'OI Short', 'Max Lev'];
    const rows = markets.map((m: MarketData) => [
      chalk.bold(m.symbol),
      formatPrice(m.price),
      formatUsd(m.openInterestLong),
      formatUsd(m.openInterestShort),
      `${m.maxLeverage}x`,
    ]);

    return {
      success: true,
      message: '\n' + formatTable(headers, rows) + '\n',
      data: { markets },
    };
  },
};

// ─── flash_get_portfolio ─────────────────────────────────────────────────────

export const flashGetPortfolio: ToolDefinition = {
  name: 'flash_get_portfolio',
  description: 'Get portfolio overview',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const portfolio = await context.flashClient.getPortfolio();

    const lines = [
      '',
      chalk.bold('  Portfolio Summary'),
      chalk.dim('  ─────────────────────'),
      `  Wallet:         ${shortAddress(portfolio.walletAddress)}`,
      `  ${portfolio.balanceLabel}`,
      `  Collateral:     ${formatUsd(portfolio.totalCollateralUsd)}`,
      `  Position Value: ${formatUsd(portfolio.totalPositionValue)}`,
      `  Unrealized PnL: ${colorPnl(portfolio.totalUnrealizedPnl)}`,
      `  Positions:      ${portfolio.positions.length}`,
      '',
    ];

    return {
      success: true,
      message: lines.join('\n'),
      data: { portfolio },
    };
  },
};

// ─── Analytics Tools ─────────────────────────────────────────────────────────

export const flashGetVolume: ToolDefinition = {
  name: 'flash_get_volume',
  description: 'Get trading volume data from fstats.io',
  parameters: z.object({
    period: z.enum(['7d', '30d', 'all']).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { period } = params as { period?: '7d' | '30d' | 'all' };
    const days = period === '7d' ? 7 : period === 'all' ? 365 : 30;
    const volume = await context.dataClient.getVolume(days);

    const recent = volume.dailyVolumes.slice(-7);
    const headers = ['Date', 'Volume', 'Trades', 'Long', 'Short'];
    const rows = recent.map((d: DailyVolume) => [
      d.date,
      formatUsd(d.volumeUsd),
      d.trades.toString(),
      formatUsd(d.longVolume),
      formatUsd(d.shortVolume),
    ]);

    return {
      success: true,
      message: [
        '',
        chalk.bold(`  Volume (${volume.period})`),
        chalk.dim('  ─────────────────────'),
        `  Total: ${formatUsd(volume.totalVolumeUsd)}`,
        `  Trades: ${volume.trades.toLocaleString()}`,
        '',
        formatTable(headers, rows),
        '',
      ].join('\n'),
      data: { volume },
    };
  },
};

export const flashGetOpenInterest: ToolDefinition = {
  name: 'flash_get_open_interest',
  description: 'Get open interest data',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const oi = await context.dataClient.getOpenInterest();

    if (oi.markets.length === 0) {
      return { success: true, message: chalk.dim('  No OI data available') };
    }

    const headers = ['Market', 'Long OI', 'Short OI', 'L Positions', 'S Positions'];
    const rows = oi.markets.map((m: MarketOI) => [
      chalk.bold(m.market),
      formatUsd(m.longOi),
      formatUsd(m.shortOi),
      m.longPositions.toString(),
      m.shortPositions.toString(),
    ]);

    return {
      success: true,
      message: '\n' + formatTable(headers, rows) + '\n',
      data: { openInterest: oi },
    };
  },
};

export const flashGetLeaderboard: ToolDefinition = {
  name: 'flash_get_leaderboard',
  description: 'Get trader leaderboard',
  parameters: z.object({
    metric: z.enum(['pnl', 'volume']).optional(),
    period: z.number().optional(),
    limit: z.number().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { metric: rawMetric, period, limit: rawLimit } = params as {
      metric?: 'pnl' | 'volume';
      period?: number;
      limit?: number;
    };
    const metric = rawMetric ?? 'pnl';
    const days = period ?? 30;
    const limit = rawLimit ?? 10;

    const entries = await context.dataClient.getLeaderboard(metric, days, limit);

    const headers = ['#', 'Trader', 'PnL', 'Volume', 'Trades', 'Win Rate'];
    const rows = entries.map((e: LeaderboardEntry) => [
      `${e.rank}`,
      shortAddress(e.address),
      colorPnl(e.pnl),
      formatUsd(e.volume),
      e.trades.toString(),
      `${(e.winRate * 100).toFixed(0)}%`,
    ]);

    return {
      success: true,
      message: [
        '',
        chalk.bold(`  Leaderboard — ${metric.toUpperCase()} (${days}d)`),
        '',
        formatTable(headers, rows),
        '',
      ].join('\n'),
      data: { leaderboard: entries },
    };
  },
};

export const flashGetFees: ToolDefinition = {
  name: 'flash_get_fees',
  description: 'Get fee data',
  parameters: z.object({
    period: z.number().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { period } = params as { period?: number };
    const days = period ?? 30;
    const fees = await context.dataClient.getFees(days);

    return {
      success: true,
      message: [
        '',
        chalk.bold(`  Fees (${fees.period})`),
        chalk.dim('  ─────────────────'),
        `  Total Fees: ${formatUsd(fees.totalFees)}`,
        '',
      ].join('\n'),
      data: { fees },
    };
  },
};

export const flashGetTraderProfile: ToolDefinition = {
  name: 'flash_get_trader_profile',
  description: 'Get a trader profile',
  parameters: z.object({
    address: z.string(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { address } = params as { address: string };
    const profile = await context.dataClient.getTraderProfile(address);

    return {
      success: true,
      message: [
        '',
        chalk.bold(`  Trader: ${shortAddress(profile.address)}`),
        chalk.dim('  ─────────────────────'),
        `  Total Trades: ${profile.totalTrades}`,
        `  Total Volume: ${formatUsd(profile.totalVolume)}`,
        `  Total PnL:    ${colorPnl(profile.totalPnl)}`,
        `  Win Rate:     ${(profile.winRate * 100).toFixed(1)}%`,
        '',
      ].join('\n'),
      data: { traderProfile: profile },
    };
  },
};

// ─── Export all tools ────────────────────────────────────────────────────────

export const allFlashTools: ToolDefinition[] = [
  flashOpenPosition,
  flashClosePosition,
  flashAddCollateral,
  flashRemoveCollateral,
  flashGetPositions,
  flashGetMarketData,
  flashGetPortfolio,
  flashGetVolume,
  flashGetOpenInterest,
  flashGetLeaderboard,
  flashGetFees,
  flashGetTraderProfile,
];
