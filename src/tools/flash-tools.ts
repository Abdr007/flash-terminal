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
import { getSigningGuard, SigningAuditEntry } from '../security/signing-guard.js';
import { updateLastWallet, clearLastWallet } from '../wallet/session.js';
import chalk from 'chalk';

// ─── Pre-Trade Validation ───────────────────────────────────────────────────

function validateLiveTradeContext(context: ToolContext): string | null {
  if (context.simulationMode) return null;
  if (!context.walletManager || !context.walletManager.isConnected) {
    return 'No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".';
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

    // Resolve pool for this market
    const { getPoolForMarket } = await import('../config/index.js');
    const pool = getPoolForMarket(market);
    if (!pool) {
      return { success: false, message: chalk.red(`  Market not supported on Flash Trade: ${market}`) };
    }

    if (!Number.isFinite(collateral) || !Number.isFinite(leverage) || collateral <= 0 || leverage <= 0) {
      return { success: false, message: chalk.red('  Invalid trade parameters: collateral and leverage must be positive numbers.') };
    }

    if (collateral < 10) {
      return { success: false, message: chalk.red(`  Minimum collateral is $10 (got $${collateral}).`) };
    }

    const sizeUsd = collateral * leverage;
    const isLive = !context.simulationMode;
    const guard = getSigningGuard();
    const walletAddr = context.walletAddress ?? 'unknown';
    const estimatedFee = (sizeUsd * 8) / 10_000; // 0.08% Flash Trade fee

    // ── Signing Guard: Trade Limit Check ──
    const limitCheck = guard.checkTradeLimits({ collateral, leverage, sizeUsd, market });
    if (!limitCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market, side, collateral, leverage, sizeUsd,
        walletAddress: walletAddr,
        result: 'rejected',
        reason: limitCheck.reason,
      });
      return { success: false, message: chalk.red(`  Trade rejected: ${limitCheck.reason}`) };
    }

    // ── Signing Guard: Rate Limit Check ──
    const rateCheck = guard.checkRateLimit();
    if (!rateCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market, side, collateral, leverage, sizeUsd,
        walletAddress: walletAddr,
        result: 'rate_limited',
        reason: rateCheck.reason,
      });
      return { success: false, message: chalk.red(`  ${rateCheck.reason}`) };
    }

    // ── Build Confirmation Summary ──
    const lines = [
      '',
      isLive ? chalk.red.bold('  CONFIRM TRANSACTION') : chalk.yellow('  CONFIRM TRANSACTION'),
      chalk.dim('  ─────────────────────────────────'),
      `  Market:      ${chalk.bold(market)} ${colorSide(side)}`,
      `  Pool:        ${chalk.cyan(pool)}`,
      `  Leverage:    ${chalk.bold(leverage + 'x')}`,
      `  Collateral:  ${chalk.bold(formatUsd(collateral))} ${chalk.dim('USDC')}`,
      `  Size:        ${chalk.bold(formatUsd(sizeUsd))}`,
      `  Est. Fee:    ${chalk.dim(formatUsd(estimatedFee))}`,
      `  Wallet:      ${chalk.dim(walletAddr)}`,
    ];

    // Show configured limits
    const limits = guard.limits;
    if (limits.maxCollateralPerTrade > 0 || limits.maxPositionSize > 0 || limits.maxLeverage > 0) {
      lines.push('');
      lines.push(chalk.dim('  Limits:'));
      if (limits.maxCollateralPerTrade > 0) lines.push(chalk.dim(`    Max Collateral: ${formatUsd(limits.maxCollateralPerTrade)}`));
      if (limits.maxPositionSize > 0) lines.push(chalk.dim(`    Max Position:   ${formatUsd(limits.maxPositionSize)}`));
      if (limits.maxLeverage > 0) lines.push(chalk.dim(`    Max Leverage:   ${limits.maxLeverage}x`));
    }

    if (isLive) {
      const warnings = buildLiveTradeWarnings(market, leverage, collateral);
      if (warnings.length > 0) {
        lines.push('');
        for (const w of warnings) {
          lines.push(`  ${chalk.yellow('!')} ${chalk.yellow(w)}`);
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
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Execute trade?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          // Record signing for rate limiter
          guard.recordSigning();

          try {
            const result = await context.flashClient.openPosition(
              market, side, collateral, leverage, collateral_token
            );

            // Audit log — successful
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'open',
              market, side, collateral, leverage, sizeUsd,
              walletAddress: walletAddr,
              result: 'confirmed',
            });

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
            // Audit log — failed
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'open',
              market, side, collateral, leverage, sizeUsd,
              walletAddress: walletAddr,
              result: 'failed',
              reason: getErrorMessage(error),
            });
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

    const { getPoolForMarket } = await import('../config/index.js');
    const pool = getPoolForMarket(market);
    if (!pool) {
      return { success: false, message: chalk.red(`  Market not supported on Flash Trade: ${market}`) };
    }

    const isLive = !context.simulationMode;
    const guard = getSigningGuard();
    const walletAddr = context.walletAddress ?? 'unknown';

    // Rate limit check
    const rateCheck = guard.checkRateLimit();
    if (!rateCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'close', market, side,
        walletAddress: walletAddr,
        result: 'rate_limited', reason: rateCheck.reason,
      });
      return { success: false, message: chalk.red(`  ${rateCheck.reason}`) };
    }

    return {
      success: true,
      message: [
        '',
        isLive ? chalk.red.bold('  CONFIRM TRANSACTION — Close Position') : chalk.yellow('  CONFIRM TRANSACTION — Close Position'),
        chalk.dim('  ─────────────────────────────────'),
        `  Market:  ${chalk.bold(market)} ${colorSide(side)}`,
        `  Pool:    ${chalk.cyan(pool)}`,
        `  Wallet:  ${chalk.dim(walletAddr)}`,
        isLive ? `\n${chalk.red('  This will execute a REAL on-chain transaction.')}` : '',
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Confirm close?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          guard.recordSigning();
          try {
            const result = await context.flashClient.closePosition(market, side);

            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'close', market, side,
              walletAddress: walletAddr,
              result: 'confirmed',
            });

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
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'close', market, side,
              walletAddress: walletAddr,
              result: 'failed', reason: getErrorMessage(error),
            });
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

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    const { getPoolForMarket } = await import('../config/index.js');
    const pool = getPoolForMarket(market);
    if (!pool) {
      return { success: false, message: chalk.red(`  Market not supported on Flash Trade: ${market}`) };
    }

    const isLive = !context.simulationMode;
    const guard = getSigningGuard();
    const walletAddr = context.walletAddress ?? 'unknown';

    const rateCheck = guard.checkRateLimit();
    if (!rateCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'add_collateral', market, side,
        collateral: amount, walletAddress: walletAddr,
        result: 'rate_limited', reason: rateCheck.reason,
      });
      return { success: false, message: chalk.red(`  ${rateCheck.reason}`) };
    }

    return {
      success: true,
      message: [
        '',
        isLive ? chalk.red.bold('  CONFIRM TRANSACTION — Add Collateral') : chalk.yellow('  CONFIRM TRANSACTION — Add Collateral'),
        chalk.dim('  ─────────────────────────────────'),
        `  Market: ${chalk.bold(market)} ${colorSide(side)}`,
        `  Amount: ${formatUsd(amount)} ${chalk.dim('USDC')}`,
        `  Wallet: ${chalk.dim(walletAddr)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          guard.recordSigning();
          try {
            const result = await context.flashClient.addCollateral(market, side, amount);
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'add_collateral', market, side,
              collateral: amount, walletAddress: walletAddr,
              result: 'confirmed',
            });
            const txDisplay = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: chalk.green(`  Collateral added. TX: ${chalk.dim(txDisplay)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'add_collateral', market, side,
              collateral: amount, walletAddress: walletAddr,
              result: 'failed', reason: getErrorMessage(error),
            });
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

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    const { getPoolForMarket } = await import('../config/index.js');
    const pool = getPoolForMarket(market);
    if (!pool) {
      return { success: false, message: chalk.red(`  Market not supported on Flash Trade: ${market}`) };
    }

    const isLive = !context.simulationMode;
    const guard = getSigningGuard();
    const walletAddr = context.walletAddress ?? 'unknown';

    const rateCheck = guard.checkRateLimit();
    if (!rateCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'remove_collateral', market, side,
        collateral: amount, walletAddress: walletAddr,
        result: 'rate_limited', reason: rateCheck.reason,
      });
      return { success: false, message: chalk.red(`  ${rateCheck.reason}`) };
    }

    return {
      success: true,
      message: [
        '',
        isLive ? chalk.red.bold('  CONFIRM TRANSACTION — Remove Collateral') : chalk.yellow('  CONFIRM TRANSACTION — Remove Collateral'),
        chalk.dim('  ─────────────────────────────────'),
        `  Market: ${chalk.bold(market)} ${colorSide(side)}`,
        `  Amount: ${formatUsd(amount)}`,
        `  Wallet: ${chalk.dim(walletAddr)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          guard.recordSigning();
          try {
            const result = await context.flashClient.removeCollateral(market, side, amount);
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'remove_collateral', market, side,
              collateral: amount, walletAddress: walletAddr,
              result: 'confirmed',
            });
            const txDisplay = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: chalk.green(`  Collateral removed. TX: ${chalk.dim(txDisplay)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'remove_collateral', market, side,
              collateral: amount, walletAddress: walletAddr,
              result: 'failed', reason: getErrorMessage(error),
            });
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
      return { success: true, message: chalk.dim('\n  No open positions.\n') };
    }

    const headers = ['Market', 'Side', 'Lev', 'Size', 'Collateral', 'Entry', 'Mark', 'PnL', 'Fees', 'Liq'];
    const rows = positions.map((p: Position) => [
      chalk.bold(p.market),
      colorSide(p.side),
      `${p.leverage.toFixed(1)}x`,
      formatUsd(p.sizeUsd),
      formatUsd(p.collateralUsd),
      formatPrice(p.entryPrice),
      formatPrice(p.markPrice),
      `${colorPnl(p.unrealizedPnl)} ${chalk.dim(`(${colorPercent(p.unrealizedPnlPercent)})`)}`,
      p.totalFees > 0 ? formatUsd(p.totalFees) : chalk.dim('—'),
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
      return { success: true, message: chalk.dim('\n  Market data unavailable. Try again later.\n') };
    }

    // Enrich with fstats OI data and CoinGecko 24h change
    try {
      const { PriceService } = await import('../data/prices.js');
      const priceSvc = new PriceService();
      const [oi, cgPrices] = await Promise.all([
        context.dataClient.getOpenInterest().catch(() => ({ markets: [] as MarketOI[] })),
        priceSvc.getPrices(markets.map(m => m.symbol)).catch(() => new Map()),
      ]);
      for (const m of markets) {
        const oiData = oi.markets.find(
          (o: MarketOI) => o.market.includes(m.symbol)
        );
        if (oiData) {
          m.openInterestLong = oiData.longOi;
          m.openInterestShort = oiData.shortOi;
        }
        const cgPrice = cgPrices.get(m.symbol);
        if (cgPrice && m.priceChange24h === 0) {
          m.priceChange24h = cgPrice.priceChange24h;
        }
      }
    } catch { /* ignore enrichment errors */ }

    const headers = ['Market', 'Price', '24h Change', 'OI Long', 'OI Short', 'Max Lev'];
    const rows = markets.map((m: MarketData) => [
      chalk.bold(m.symbol),
      formatPrice(m.price),
      colorPercent(m.priceChange24h),
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

    // Compute directional bias
    let longExposure = 0;
    let shortExposure = 0;
    for (const p of portfolio.positions) {
      if (p.side === TradeSide.Long) longExposure += p.sizeUsd;
      else shortExposure += p.sizeUsd;
    }
    const totalExposure = longExposure + shortExposure;
    const longPct = totalExposure > 0 ? ((longExposure / totalExposure) * 100).toFixed(0) : '0';
    const shortPct = totalExposure > 0 ? ((shortExposure / totalExposure) * 100).toFixed(0) : '0';

    const lines = [
      '',
      chalk.bold('  Portfolio Summary'),
      chalk.dim('  ─────────────────────────────────────────'),
      '',
      `  Total Positions:  ${portfolio.positions.length}`,
      `  Total Exposure:   ${formatUsd(totalExposure)}`,
      '',
    ];

    if (portfolio.positions.length > 0) {
      lines.push(chalk.bold('  Directional Bias'));
      lines.push(`  LONG:  ${longPct}%`);
      lines.push(`  SHORT: ${shortPct}%`);
      lines.push('');
    }

    lines.push(
      `  ${portfolio.balanceLabel}`,
      portfolio.usdcBalance !== undefined ? `  USDC Available:   ${chalk.green('$' + portfolio.usdcBalance.toFixed(2))}` : '',
      `  Collateral:       ${formatUsd(portfolio.totalCollateralUsd)}`,
      `  Unrealized PnL:   ${colorPnl(portfolio.totalUnrealizedPnl)}`,
      `  Realized PnL:     ${colorPnl(portfolio.totalRealizedPnl)}`,
      portfolio.totalFees > 0 ? `  Fees Paid:        ${formatUsd(portfolio.totalFees)}` : '',
      '',
    );

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
        return { success: true, message: chalk.dim('\n  Volume data unavailable.\n') };
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
      return { success: false, message: chalk.dim(`\n  Volume data unavailable.\n`) };
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
        return { success: true, message: chalk.dim('\n  Open interest data unavailable.\n') };
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
      return { success: false, message: chalk.dim(`\n  Open interest data unavailable.\n`) };
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
        return { success: true, message: chalk.dim('\n  Leaderboard data unavailable.\n') };
      }

      const headers = ['#', 'Trader', 'PnL', 'Volume', 'Trades', 'Win Rate'];
      const rows = entries.map((e: LeaderboardEntry) => [
        `${e.rank}`,
        shortAddress(e.address),
        colorPnl(e.pnl),
        formatUsd(e.volume),
        e.trades.toString(),
        `${e.winRate.toFixed(0)}%`,
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
      return { success: false, message: chalk.dim(`\n  Leaderboard data unavailable.\n`) };
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
      return { success: false, message: chalk.dim(`\n  Fee data unavailable.\n`) };
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
        `  Win Rate:     ${profile.winRate.toFixed(1)}%`,
        '',
      ].join('\n'),
      data: { traderProfile: profile },
    };
  },
};

// ─── Wallet Tools ───────────────────────────────────────────────────────────

import { WalletStore } from '../wallet/wallet-store.js';
import { readFileSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const walletStore = new WalletStore();

export const walletImport: ToolDefinition = {
  name: 'wallet_import',
  description: 'Import a wallet from a keypair JSON file and store it locally',
  parameters: z.object({
    name: z.string(),
    path: z.string(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { name, path } = params as { name: string; path: string };

    if (!name || !path) {
      return {
        success: true,
        message: [
          '',
          chalk.bold('  Import Wallet'),
          chalk.dim('  ─────────────────'),
          '',
          `  Usage: ${chalk.cyan('wallet import <name> <path>')}`,
          '',
          `  Example: ${chalk.dim('wallet import main ~/.config/solana/id.json')}`,
          '',
        ].join('\n'),
      };
    }

    let secretKey: number[] | undefined;
    try {
      // Path validation: restrict to home directory, resolve symlinks
      const resolvedPath = resolve(path);
      const home = homedir();
      const homePrefix = home.endsWith('/') ? home : home + '/';
      if (resolvedPath !== home && !resolvedPath.startsWith(homePrefix)) {
        return { success: false, message: chalk.red(`  Wallet path must be within home directory (${home}).`) };
      }
      let realPath: string;
      try {
        realPath = realpathSync(resolvedPath);
      } catch {
        return { success: false, message: chalk.red(`  Wallet file not found: ${resolvedPath}`) };
      }
      if (realPath !== home && !realPath.startsWith(homePrefix)) {
        return { success: false, message: chalk.red('  Wallet path resolves outside home directory (symlink?).') };
      }

      const raw = readFileSync(realPath, 'utf-8');
      secretKey = JSON.parse(raw);
      const result = walletStore.importWallet(name, secretKey!);

      // Auto-set as default
      walletStore.setDefault(name);

      // Auto-connect the wallet
      const wm = context.walletManager;
      if (wm) {
        wm.loadFromFile(result.path);
        context.walletAddress = result.address;
        context.walletName = name;
      }

      // Persist session
      updateLastWallet(name);

      const canSign = wm?.isConnected ?? false;
      const lines = [
        '',
        chalk.green('  Wallet Imported'),
        chalk.dim('  ─────────────────'),
        `  Name:    ${chalk.bold(name)}`,
        `  Address: ${chalk.cyan(result.address)}`,
        `  Set as default wallet.`,
        '',
      ];

      if (canSign) {
        lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
        lines.push('');
      }

      return {
        success: true,
        message: lines.join('\n'),
        data: canSign ? { walletConnected: true } : undefined,
      };
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Failed to import wallet: ${getErrorMessage(error)}`) };
    } finally {
      // Zero sensitive data from memory
      if (Array.isArray(secretKey)) {
        secretKey.fill(0);
      }
    }
  },
};

export const walletList: ToolDefinition = {
  name: 'wallet_list',
  description: 'List all stored wallets',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const wallets = walletStore.listWallets();
    const defaultName = walletStore.getDefault();

    if (wallets.length === 0) {
      return {
        success: true,
        message: [
          '',
          chalk.dim('  No wallets stored.'),
          chalk.dim('  Use "wallet import <name> <path>" to import a wallet.'),
          '',
        ].join('\n'),
      };
    }

    const lines = [
      '',
      chalk.bold('  Stored Wallets'),
      chalk.dim('  ─────────────────'),
    ];

    for (const name of wallets) {
      const isDefault = name === defaultName;
      const tag = isDefault ? chalk.green(' (default)') : '';
      lines.push(`  ${chalk.bold(name)}${tag}`);
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

export const walletUse: ToolDefinition = {
  name: 'wallet_use',
  description: 'Switch to a stored wallet and set it as default',
  parameters: z.object({
    name: z.string(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { name } = params as { name: string };
    try {
      const walletPath = walletStore.getWalletPath(name);
      walletStore.setDefault(name);
      updateLastWallet(name);

      // Connect the wallet
      const wm = context.walletManager;
      if (wm) {
        const result = wm.loadFromFile(walletPath);
        context.walletAddress = result.address;
        context.walletName = name;

        const lines = [
          '',
          chalk.green(`  Switched to wallet: ${chalk.bold(name)}`),
          '',
        ];

        // Signal live mode switch if wallet can sign
        if (wm.isConnected) {
          lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
          lines.push('');
        }

        return {
          success: true,
          message: lines.join('\n'),
          data: wm.isConnected ? { walletConnected: true } : undefined,
        };
      }

      return { success: false, message: chalk.red('  Wallet manager not available') };
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Failed to switch wallet: ${getErrorMessage(error)}`) };
    }
  },
};

export const walletRemove: ToolDefinition = {
  name: 'wallet_remove',
  description: 'Remove a stored wallet',
  parameters: z.object({
    name: z.string(),
  }),
  execute: async (params): Promise<ToolResult> => {
    const { name } = params as { name: string };
    try {
      walletStore.removeWallet(name);
      return {
        success: true,
        message: chalk.green(`  Wallet "${name}" removed.`),
      };
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Failed to remove wallet: ${getErrorMessage(error)}`) };
    }
  },
};

export const walletStatus: ToolDefinition = {
  name: 'wallet_status',
  description: 'Show current wallet connection status',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    const defaultName = walletStore.getDefault();
    const storedCount = walletStore.listWallets().length;

    const lines = [
      '',
      chalk.bold('  Wallet Status'),
      chalk.dim('  ─────────────────'),
    ];

    if (wm && wm.isConnected) {
      lines.push(`  Connected: ${chalk.green('Yes')}`);
      if (defaultName) {
        lines.push(`  Wallet:    ${chalk.bold(defaultName)}`);
      }
    } else if (wm && wm.hasAddress) {
      lines.push(`  Connected: ${chalk.yellow('Read-only')}`);
    } else {
      lines.push(`  Connected: ${chalk.red('No')}`);
    }

    lines.push(`  Stored:    ${storedCount} wallet(s)`);
    lines.push('');

    if (!wm?.isConnected && storedCount === 0) {
      lines.push(chalk.dim('  Use "wallet import <name> <path>" to add a wallet.'));
      lines.push('');
    }

    return { success: true, message: lines.join('\n') };
  },
};

export const walletDisconnect: ToolDefinition = {
  name: 'wallet_disconnect',
  description: 'Disconnect the currently active wallet',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || (!wm.isConnected && !wm.hasAddress)) {
      return { success: true, message: chalk.dim('  No wallet connected.') };
    }

    // Clear wallet from runtime
    wm.disconnect();
    context.walletAddress = 'unknown';
    context.walletName = '';
    clearLastWallet();

    // Clear default so it won't auto-load next startup
    const config = walletStore.getDefault();
    if (config) {
      walletStore.clearDefault();
    }

    const isLive = !context.simulationMode;

    const lines = [
      '',
      chalk.green('  Wallet disconnected.'),
    ];

    if (isLive) {
      lines.push('');
      lines.push(chalk.yellow('  Live trading disabled until a wallet is connected.'));
      lines.push(chalk.dim('  Use "wallet import", "wallet use", or "wallet connect" to reconnect.'));
    }

    lines.push('');

    return {
      success: true,
      message: lines.join('\n'),
      data: { disconnected: true },
    };
  },
};

export const walletAddress: ToolDefinition = {
  name: 'wallet_address',
  description: 'Show connected wallet address',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) {
      return { success: true, message: chalk.dim('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".') };
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
      return { success: true, message: chalk.dim('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".') };
    }
    try {
      const { sol, tokens } = await wm.getTokenBalances();
      const lines = [
        '',
        chalk.bold('  Wallet Balance'),
        chalk.dim('  ─────────────────'),
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

export const walletTokens: ToolDefinition = {
  name: 'wallet_tokens',
  description: 'Detect all tokens in the connected wallet',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || (!wm.isConnected && !wm.hasAddress)) {
      return { success: true, message: chalk.dim('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".') };
    }
    try {
      const { sol, tokens } = await wm.getTokenBalances();
      const lines = [
        '',
        chalk.bold('  TOKENS IN WALLET'),
        chalk.dim('  ─────────────────'),
        `  SOL     ${chalk.green(sol.toFixed(4))}`,
      ];
      for (const t of tokens) {
        const decimals = t.symbol === 'USDC' || t.symbol === 'USDT' ? 2 : 4;
        lines.push(`  ${t.symbol.padEnd(8)}${chalk.green(t.amount.toFixed(decimals))}`);
      }
      if (tokens.length === 0) {
        lines.push(chalk.dim('  No SPL tokens found'));
      }
      lines.push('');
      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: `  Failed to fetch wallet tokens: ${getErrorMessage(error)}` };
    }
  },
};

export const flashMarkets: ToolDefinition = {
  name: 'flash_markets_list',
  description: 'List all Flash Trade markets with pool mapping',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const { POOL_MARKETS } = await import('../config/index.js');
    const lines = [
      '',
      chalk.bold('  FLASH TRADE MARKETS'),
      chalk.dim('  ─────────────────────'),
    ];
    for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
      for (const market of markets) {
        lines.push(`  ${market.padEnd(12)} → ${chalk.yellow(pool)}`);
      }
    }
    lines.push('');
    return { success: true, message: lines.join('\n') };
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
    if (!path) {
      return {
        success: false,
        message: [
          chalk.red('  Missing path. Usage:'),
          '',
          `    ${chalk.cyan('wallet connect <path>')}`,
          '',
          chalk.dim('  Example: wallet connect ~/.config/solana/id.json'),
        ].join('\n'),
      };
    }
    const wm = context.walletManager;
    if (!wm) {
      return { success: false, message: chalk.red('  Wallet manager not available') };
    }
    try {
      const { address } = wm.loadFromFile(path);
      context.walletAddress = address;
      context.walletName = 'wallet';
      updateLastWallet('wallet');

      const canSign = wm.isConnected;
      const lines = [
        '',
        chalk.green('  Wallet Connected'),
        chalk.dim('  ─────────────────'),
        '',
      ];

      if (canSign) {
        lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
        lines.push('');
      }

      return {
        success: true,
        message: lines.join('\n'),
        data: canSign ? { walletConnected: true } : undefined,
      };
    } catch (error: unknown) {
      return { success: false, message: `  Failed to connect wallet: ${getErrorMessage(error)}` };
    }
  },
};

// ─── Export all tools ────────────────────────────────────────────────────────

// ─── Risk Monitor Commands ──────────────────────────────────────────────────

export const riskMonitorOn: ToolDefinition = {
  name: 'risk_monitor_on',
  description: 'Start real-time position risk monitoring',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const { getRiskMonitor } = await import('../monitor/risk-monitor.js');
    const monitor = getRiskMonitor(context.flashClient);
    const msg = monitor.start();
    return { success: true, message: msg };
  },
};

export const riskMonitorOff: ToolDefinition = {
  name: 'risk_monitor_off',
  description: 'Stop real-time position risk monitoring',
  parameters: z.object({}),
  execute: async (_params): Promise<ToolResult> => {
    const { getActiveRiskMonitor } = await import('../monitor/risk-monitor.js');
    const monitor = getActiveRiskMonitor();
    if (!monitor) {
      return { success: true, message: chalk.yellow('  Risk monitor is not running.') };
    }
    const msg = monitor.stop();
    return { success: true, message: msg };
  },
};

// ─── Protocol Inspector Commands ────────────────────────────────────────────

export const inspectProtocol: ToolDefinition = {
  name: 'inspect_protocol',
  description: 'Inspect Flash Trade protocol state',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const { ProtocolInspector } = await import('../protocol/protocol-inspector.js');
    const inspector = new ProtocolInspector();
    const msg = await inspector.inspectProtocol();
    return { success: true, message: msg };
  },
};

export const inspectPool: ToolDefinition = {
  name: 'inspect_pool',
  description: 'Inspect a specific Flash Trade pool',
  parameters: z.object({ pool: z.string().optional() }),
  execute: async (params): Promise<ToolResult> => {
    const { pool } = params as { pool?: string };
    if (!pool) {
      return { success: false, message: chalk.red('  Usage: inspect pool <pool_name>  (e.g. inspect pool Crypto.1)') };
    }
    const { ProtocolInspector } = await import('../protocol/protocol-inspector.js');
    const inspector = new ProtocolInspector();
    const msg = await inspector.inspectPool(pool);
    return { success: true, message: msg };
  },
};

export const inspectMarketTool: ToolDefinition = {
  name: 'inspect_market',
  description: 'Deep-inspect a specific market',
  parameters: z.object({ market: z.string().optional() }),
  execute: async (params): Promise<ToolResult> => {
    const { market } = params as { market?: string };
    if (!market) {
      return { success: false, message: chalk.red('  Usage: inspect market <asset>  (e.g. inspect market SOL)') };
    }
    const { ProtocolInspector } = await import('../protocol/protocol-inspector.js');
    const inspector = new ProtocolInspector();
    const msg = await inspector.inspectMarket(market);
    return { success: true, message: msg };
  },
};

// ─── System Diagnostics Tools ───────────────────────────────────────────────

export const systemStatusTool: ToolDefinition = {
  name: 'system_status',
  description: 'Display system health overview',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const { getSystemDiagnostics } = await import('../system/system-diagnostics.js');
    const diag = getSystemDiagnostics();
    if (!diag) {
      return { success: true, message: chalk.dim('  System diagnostics not initialized.') };
    }
    const msg = await diag.systemStatus();
    return { success: true, message: msg };
  },
};

export const rpcStatusTool: ToolDefinition = {
  name: 'rpc_status',
  description: 'Show active RPC connection info',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
    const mgr = getRpcManagerInstance();
    if (!mgr) {
      return { success: true, message: chalk.dim('  RPC manager not initialized.') };
    }
    const latency = await mgr.measureLatency();
    const msg = mgr.formatStatus(latency);
    return { success: true, message: msg };
  },
};

export const rpcTestTool: ToolDefinition = {
  name: 'rpc_test',
  description: 'Test all configured RPC endpoints',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const { getSystemDiagnostics } = await import('../system/system-diagnostics.js');
    const diag = getSystemDiagnostics();
    if (!diag) {
      return { success: true, message: chalk.dim('  System diagnostics not initialized.') };
    }
    const msg = await diag.rpcTest();
    return { success: true, message: msg };
  },
};

export const txInspectTool: ToolDefinition = {
  name: 'tx_inspect',
  description: 'Inspect a transaction by signature',
  parameters: z.object({ signature: z.string().optional() }),
  execute: async (params): Promise<ToolResult> => {
    const { signature } = params as { signature?: string };
    if (!signature) {
      return { success: false, message: chalk.red('  Usage: tx inspect <signature>') };
    }
    const { getSystemDiagnostics } = await import('../system/system-diagnostics.js');
    const diag = getSystemDiagnostics();
    if (!diag) {
      return { success: true, message: chalk.dim('  System diagnostics not initialized.') };
    }
    const msg = await diag.txInspect(signature);
    return { success: true, message: msg };
  },
};

// ─── Trade History / Journal ──────────────────────────────────────────────────

const tradeHistoryTool: ToolDefinition = {
  name: 'trade_history',
  description: 'Show recent trade history',
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const client = context.flashClient;
    if (!client.getTradeHistory) {
      return {
        success: false,
        message: [
          '',
          chalk.yellow('  Trade history is only available in simulation mode.'),
          chalk.dim('  Live trade history can be viewed on Solscan.'),
          '',
        ].join('\n'),
      };
    }

    const trades = client.getTradeHistory();
    if (trades.length === 0) {
      return {
        success: true,
        message: [
          '',
          chalk.dim('  No trades recorded yet.'),
          chalk.dim('  Execute a trade and it will appear here.'),
          '',
        ].join('\n'),
      };
    }

    // Show most recent 20 trades
    const recent = trades.slice(-20).reverse();

    const lines: string[] = [
      '',
      chalk.bold('  TRADE HISTORY'),
      chalk.dim('  ──────────────────────────────────────────────────────────────────────'),
      '',
      chalk.dim('  Time       Action  Market  Side    Size        Entry       PnL'),
      chalk.dim('  ──────────────────────────────────────────────────────────────────────'),
    ];

    for (const t of recent) {
      const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const action = t.action === 'open' ? chalk.cyan('OPEN ') : chalk.yellow('CLOSE');
      const market = t.market.padEnd(6);
      const side = t.side === 'long' ? chalk.green('LONG ') : chalk.red('SHORT');
      const size = formatUsd(t.sizeUsd).padStart(10);
      const entry = formatPrice(t.price).padStart(10);
      const pnl = t.pnl !== undefined
        ? (t.pnl >= 0 ? chalk.green(`+${formatUsd(t.pnl)}`) : chalk.red(formatUsd(t.pnl)))
        : chalk.dim('  —');

      lines.push(`  ${time}  ${action}   ${market}  ${side}  ${size}  ${entry}  ${pnl}`);
    }

    lines.push('');
    lines.push(chalk.dim(`  Showing ${recent.length} of ${trades.length} total trades`));
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

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
  walletImport,
  walletList,
  walletUse,
  walletRemove,
  walletDisconnect,
  walletStatus,
  walletAddress,
  walletBalance,
  walletTokens,
  walletConnect,
  flashMarkets,
  riskMonitorOn,
  riskMonitorOff,
  inspectProtocol,
  inspectPool,
  inspectMarketTool,
  systemStatusTool,
  rpcStatusTool,
  rpcTestTool,
  txInspectTool,
  tradeHistoryTool,
];
