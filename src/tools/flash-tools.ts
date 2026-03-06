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
  getLeverageLimits,
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

// ─── Pre-Trade Validation ───────────────────────────────────────────────────

function validateLiveTradeContext(context: ToolContext): string | null {
  if (context.simulationMode) return null;
  if (!context.walletManager || !context.walletManager.isConnected) {
    return 'No wallet connected. Use "wallet connect <path>" first.';
  }
  return null;
}

function buildLiveTradeWarnings(market: string, leverage: number, collateral?: number): string[] {
  const warnings: string[] = [];
  const limits = getLeverageLimits(market);

  if (leverage < limits.min) warnings.push(`Leverage ${leverage}x is below minimum ${limits.min}x for ${market}`);
  if (leverage > limits.max) warnings.push(`Leverage ${leverage}x exceeds maximum ${limits.max}x for ${market}`);
  if (leverage >= 20) warnings.push(`High leverage (${leverage}x) — liquidation risk is significant`);
  if (leverage >= 50) warnings.push('Extreme leverage — small price moves can liquidate');

  const liqDistance = (1 / leverage) * 100;
  if (liqDistance < 5) {
    warnings.push(`Liquidation within ${liqDistance.toFixed(1)}% price move`);
  }

  if (collateral !== undefined && collateral > 1000) {
    warnings.push(`Large collateral amount: ${formatUsd(collateral)}`);
  }

  return warnings;
}

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

    // Pre-trade validation for live mode
    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    const sizeUsd = collateral * leverage;
    const isLive = !context.simulationMode;

    const lines = [
      '',
      isLive ? chalk.red.bold('  LIVE TRADE — Opening Position') : chalk.yellow('  Opening Position'),
      chalk.dim('  ─────────────────'),
      `  Market:     ${chalk.bold(market)} ${colorSide(side)}`,
      `  Leverage:   ${chalk.bold(leverage + 'x')}`,
      `  Collateral: ${chalk.bold(formatUsd(collateral))} ${chalk.dim('USDC')}`,
      `  Size:       ${chalk.bold(formatUsd(sizeUsd))}`,
    ];

    if (isLive) {
      const warnings = buildLiveTradeWarnings(market, leverage, collateral);
      if (warnings.length > 0) {
        lines.push('');
        for (const w of warnings) {
          lines.push(`  ${chalk.yellow('⚠')} ${chalk.yellow(w)}`);
        }
      }
      lines.push('');
      lines.push(chalk.red('  This will execute a REAL on-chain transaction.'));
    }

    lines.push('');

    return {
      success: true,
      message: lines.join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Execute LIVE trade?' : 'Execute trade?',
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
            return { success: false, message: `  Failed to open position: ${getErrorMessage(error)}` };
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

    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    const isLive = !context.simulationMode;

    return {
      success: true,
      message: [
        '',
        isLive ? chalk.red.bold('  LIVE TRADE — Closing Position') : chalk.yellow('  Closing Position'),
        chalk.dim('  ─────────────────'),
        `  Market: ${chalk.bold(market)} ${colorSide(side)}`,
        isLive ? `\n${chalk.red('  This will execute a REAL on-chain transaction.')}` : '',
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Execute LIVE close?' : 'Confirm close?',
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
            return { success: false, message: `  Failed to close position: ${getErrorMessage(error)}` };
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

    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    const isLive = !context.simulationMode;

    return {
      success: true,
      message: [
        '',
        isLive ? chalk.red.bold('  LIVE — Adding Collateral') : chalk.yellow('  Adding Collateral'),
        chalk.dim('  ─────────────────'),
        `  Market: ${chalk.bold(market)} ${colorSide(side)}`,
        `  Amount: ${formatUsd(amount)} ${chalk.dim('USDC')}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Execute LIVE transaction?' : 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await context.flashClient.addCollateral(market, side, amount);
            const txDisplay = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: chalk.green(`  Collateral added. TX: ${chalk.dim(txDisplay)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            return { success: false, message: `  Failed: ${getErrorMessage(error)}` };
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

    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    const isLive = !context.simulationMode;

    return {
      success: true,
      message: [
        '',
        isLive ? chalk.red.bold('  LIVE — Removing Collateral') : chalk.yellow('  Removing Collateral'),
        chalk.dim('  ─────────────────'),
        `  Market: ${chalk.bold(market)} ${colorSide(side)}`,
        `  Amount: ${formatUsd(amount)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Execute LIVE transaction?' : 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await context.flashClient.removeCollateral(market, side, amount);
            const txDisplay = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: chalk.green(`  Collateral removed. TX: ${chalk.dim(txDisplay)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            return { success: false, message: `  Failed: ${getErrorMessage(error)}` };
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
      portfolio.usdcBalance !== undefined ? `  USDC Available: ${chalk.green('$' + portfolio.usdcBalance.toFixed(2))}` : '',
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
    try {
      const { period } = params as { period?: '7d' | '30d' | 'all' };
      const days = period === '7d' ? 7 : period === 'all' ? 365 : 30;
      const volume = await context.dataClient.getVolume(days);

      const recent = volume.dailyVolumes.slice(-7);
      if (recent.length === 0) {
        return { success: true, message: chalk.dim('  No volume data available. Try again later.') };
      }

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
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Unable to fetch volume data. Try again later. (${getErrorMessage(error)})`) };
    }
  },
};

export const flashGetOpenInterest: ToolDefinition = {
  name: 'flash_get_open_interest',
  description: 'Get open interest data',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    try {
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
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Unable to fetch open interest data. Try again later. (${getErrorMessage(error)})`) };
    }
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
    try {
      const { metric: rawMetric, period, limit: rawLimit } = params as {
        metric?: 'pnl' | 'volume';
        period?: number;
        limit?: number;
      };
      const metric = rawMetric ?? 'pnl';
      const days = period ?? 30;
      const limit = rawLimit ?? 10;

      const entries = await context.dataClient.getLeaderboard(metric, days, limit);

      if (entries.length === 0) {
        return { success: true, message: chalk.dim('  No leaderboard data available. Try again later.') };
      }

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
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Unable to fetch leaderboard. Try again later. (${getErrorMessage(error)})`) };
    }
  },
};

export const flashGetFees: ToolDefinition = {
  name: 'flash_get_fees',
  description: 'Get fee data',
  parameters: z.object({
    period: z.number().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
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
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Unable to fetch fee data. Try again later. (${getErrorMessage(error)})`) };
    }
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

// ─── Wallet Tools ───────────────────────────────────────────────────────────

export const walletAddress: ToolDefinition = {
  name: 'wallet_address',
  description: 'Show connected wallet address',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) {
      return { success: true, message: chalk.dim('  No wallet connected. Use "wallet connect <path>" to connect.') };
    }
    return {
      success: true,
      message: `  Wallet: ${chalk.cyan(wm.address)}`,
    };
  },
};

export const walletBalance: ToolDefinition = {
  name: 'wallet_balance',
  description: 'Fetch SOL and token balances for connected wallet',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) {
      return { success: true, message: chalk.dim('  No wallet connected. Use "wallet connect <path>" to connect.') };
    }
    try {
      const { sol, tokens } = await wm.getTokenBalances();
      const lines = [
        '',
        chalk.bold('  Wallet Balance'),
        chalk.dim('  ─────────────────'),
        `  Address: ${chalk.cyan(wm.address)}`,
        `  SOL:     ${chalk.green(sol.toFixed(4))} SOL`,
      ];
      for (const t of tokens) {
        lines.push(`  ${t.symbol.padEnd(7)}${chalk.green(t.amount.toFixed(t.symbol === 'USDC' || t.symbol === 'USDT' ? 2 : 4))} ${t.symbol}`);
      }
      if (tokens.length === 0) {
        lines.push(chalk.dim('  No SPL tokens found'));
      }
      lines.push('');
      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: `  Failed to fetch balance: ${getErrorMessage(error)}` };
    }
  },
};

export const walletConnect: ToolDefinition = {
  name: 'wallet_connect',
  description: 'Connect a wallet from a keypair file',
  parameters: z.object({
    path: z.string(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { path } = params as { path: string };
    const wm = context.walletManager;
    if (!wm) {
      return { success: false, message: chalk.red('  Wallet manager not available') };
    }
    try {
      const { address } = wm.loadFromFile(path);
      context.walletAddress = address;
      return {
        success: true,
        message: [
          '',
          chalk.green('  Wallet Connected'),
          chalk.dim('  ─────────────────'),
          `  Address: ${chalk.cyan(address)}`,
          '',
        ].join('\n'),
      };
    } catch (error: unknown) {
      return { success: false, message: `  Failed to connect wallet: ${getErrorMessage(error)}` };
    }
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
  walletAddress,
  walletBalance,
  walletConnect,
];
