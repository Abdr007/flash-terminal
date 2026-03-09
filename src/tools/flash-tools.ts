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
  formatPercent,
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
import { theme } from '../cli/theme.js';

// ─── Risk Preview Helpers ───────────────────────────────────────────────────

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

function classifyRisk(distancePct: number): RiskLevel {
  if (distancePct > 60) return 'LOW';
  if (distancePct > 30) return 'MEDIUM';
  return 'HIGH';
}

function colorRisk(level: RiskLevel): string {
  switch (level) {
    case 'LOW': return chalk.green(level);
    case 'MEDIUM': return chalk.yellow(level);
    case 'HIGH': return chalk.red(level);
  }
}

function estimateLiqPrice(entryPrice: number, leverage: number, side: TradeSide): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(leverage) || entryPrice <= 0 || leverage <= 0) return 0;
  // Approximate: 90% of the 1/leverage distance (10% maintenance margin buffer)
  const liqDist = (1 / leverage) * 0.9;
  return side === TradeSide.Long
    ? entryPrice * (1 - liqDist)
    : entryPrice * (1 + liqDist);
}

/** Timeout helper — resolves to fallback if promise takes too long. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const PREVIEW_TIMEOUT_MS = 3_000;

/** Build risk preview lines for the open position confirmation panel. */
async function buildRiskPreview(
  context: ToolContext,
  market: string,
  side: TradeSide,
  leverage: number,
  sizeUsd: number,
): Promise<string[]> {
  return withTimeout(_buildRiskPreview(context, market, side, leverage, sizeUsd), PREVIEW_TIMEOUT_MS, []);
}

async function _buildRiskPreview(
  context: ToolContext,
  market: string,
  side: TradeSide,
  leverage: number,
  sizeUsd: number,
): Promise<string[]> {
  const lines: string[] = [];
  try {
    // Get current market price (uses cached data — no extra RPC call)
    const marketData = await context.flashClient.getMarketData(market);
    const md = marketData.find(m => m.symbol.toUpperCase() === market.toUpperCase());
    if (!md || !Number.isFinite(md.price) || md.price <= 0) return lines;

    const entryEst = md.price;
    const liqEst = estimateLiqPrice(entryEst, leverage, side);
    if (liqEst <= 0) return lines;
    const distancePct = Math.abs(entryEst - liqEst) / entryEst * 100;
    const risk = classifyRisk(distancePct);

    lines.push('');
    lines.push(chalk.dim('  Risk Preview:'));
    lines.push(`    Est. Entry:   ${formatPrice(entryEst)}`);
    lines.push(`    Est. Liq:     ${chalk.yellow(formatPrice(liqEst))}`);
    lines.push(`    Distance:     ${distancePct.toFixed(1)}%`);
    lines.push(`    Risk:         ${colorRisk(risk)}`);

    // Portfolio impact — exposure before/after
    const positions = await context.flashClient.getPositions();
    const currentExposure = positions.reduce((sum, p) =>
      sum + (Number.isFinite(p.sizeUsd) ? p.sizeUsd : 0), 0);
    const newExposure = currentExposure + sizeUsd;

    lines.push(`    Exposure:     ${formatUsd(currentExposure)} → ${chalk.bold(formatUsd(newExposure))}`);
  } catch {
    // Best effort — don't block trade if preview fails
  }
  return lines;
}

/** Build position details for close/modify confirmations. */
async function buildPositionPreview(
  context: ToolContext,
  market: string,
  side: TradeSide,
): Promise<string[]> {
  return withTimeout(_buildPositionPreview(context, market, side), PREVIEW_TIMEOUT_MS, []);
}

async function _buildPositionPreview(
  context: ToolContext,
  market: string,
  side: TradeSide,
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const positions = await context.flashClient.getPositions();
    const pos = positions.find(p =>
      p.market.toUpperCase() === market.toUpperCase() && p.side === side
    );
    if (!pos) return lines;

    lines.push(`  Size:    ${formatUsd(pos.sizeUsd)}`);
    lines.push(`  Entry:   ${formatPrice(pos.entryPrice)}`);
    lines.push(`  PnL:     ${colorPnl(pos.unrealizedPnl)}`);
    if (Number.isFinite(pos.liquidationPrice) && pos.liquidationPrice > 0) {
      lines.push(`  Liq:     ${chalk.yellow(formatPrice(pos.liquidationPrice))}`);
    }
  } catch {
    // Best effort
  }
  return lines;
}

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
    collateral: z.number().positive().max(10_000_000),
    leverage: z.number().min(1).max(100),
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

    // Check if virtual market is currently open
    const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
    const marketStatus = getMarketStatus(market);
    if (!marketStatus.isOpen) {
      return { success: false, message: chalk.yellow(formatMarketClosedMessage(market)) };
    }

    if (!Number.isFinite(collateral) || !Number.isFinite(leverage) || collateral <= 0 || leverage <= 0) {
      return { success: false, message: chalk.red('  Invalid trade parameters: collateral and leverage must be positive numbers.') };
    }

    if (collateral < 10) {
      return { success: false, message: chalk.red(`  Minimum collateral is $10 (got $${collateral}).`) };
    }

    // Per-market leverage limit from Flash Trade protocol
    const { getMaxLeverage, hasDegenMode, getDegenMinLeverage } = await import('../config/index.js');
    const maxLev = getMaxLeverage(market, context.degenMode);
    if (leverage > maxLev) {
      if (!context.degenMode && hasDegenMode(market)) {
        const degenMax = getMaxLeverage(market, true);
        return { success: false, message: chalk.red(
          `  Maximum leverage for ${market}: ${maxLev}x. ` +
          `Enable degen mode for up to ${degenMax}x (min ${getDegenMinLeverage(market)}x).`
        ) };
      }
      return { success: false, message: chalk.red(`  Maximum leverage for ${market}: ${maxLev}x`) };
    }

    // Degen mode: enforce minimum leverage requirement
    if (context.degenMode && hasDegenMode(market)) {
      const degenMin = getDegenMinLeverage(market);
      if (leverage > getMaxLeverage(market, false) && leverage < degenMin) {
        return { success: false, message: chalk.red(
          `  Degen mode on ${market} requires minimum ${degenMin}x leverage (got ${leverage}x).`
        ) };
      }
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

    // Risk preview: entry estimate, liquidation estimate, distance, risk level, portfolio impact
    const riskLines = await buildRiskPreview(context, market, side, leverage, sizeUsd);
    lines.push(...riskLines);

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
          try {
            const result = await context.flashClient.openPosition(
              market, side, collateral, leverage, collateral_token
            );

            // Record signing AFTER successful confirmation (not before)
            guard.recordSigning();

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

            // Compute liquidation price if not returned by SDK
            let liqPrice = result.liquidationPrice;
            if (!liqPrice || liqPrice <= 0) {
              // Approximate: liqPrice = entryPrice * (1 ∓ 1/leverage * 0.9) for long/short
              if (result.entryPrice > 0 && leverage > 0) {
                const liqDist = (1 / leverage) * 0.9;
                liqPrice = side === TradeSide.Long
                  ? result.entryPrice * (1 - liqDist)
                  : result.entryPrice * (1 + liqDist);
              }
            }

            // Estimate fee: 0.08% of position size (Flash Trade standard fee)
            const estimatedFee = sizeUsd * 0.0008;

            return {
              success: true,
              message: [
                '',
                chalk.green('  Position Opened'),
                chalk.dim('  ─────────────────'),
                `  Entry Price:       ${formatPrice(result.entryPrice)}`,
                `  Size:              ${formatUsd(result.sizeUsd)}`,
                `  Liquidation Price: ${liqPrice && liqPrice > 0 ? chalk.yellow(formatPrice(liqPrice)) : chalk.dim('N/A')}`,
                `  Est. Fee:          ${chalk.dim(formatUsd(estimatedFee))}`,
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

    // Check if virtual market is currently open
    const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
    const mktStatus = getMarketStatus(market);
    if (!mktStatus.isOpen) {
      return { success: false, message: chalk.yellow(formatMarketClosedMessage(market)) };
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

    // Pre-check: verify position exists before showing confirmation
    try {
      const positions = await context.flashClient.getPositions();
      const exists = positions.some(p =>
        (p.market ?? '').toUpperCase() === market.toUpperCase() && p.side === side,
      );
      if (!exists) {
        return { success: false, message: chalk.red(`  No open ${side} position on ${market}.`) };
      }
    } catch {
      // Non-critical: let the close attempt handle the error
    }

    // Position details for close confirmation
    const posLines = await buildPositionPreview(context, market, side);
    const closeLines = [
      '',
      isLive ? chalk.red.bold('  CONFIRM TRANSACTION — Close Position') : chalk.yellow('  CONFIRM TRANSACTION — Close Position'),
      chalk.dim('  ─────────────────────────────────'),
      `  Market:  ${chalk.bold(market)} ${colorSide(side)}`,
      `  Pool:    ${chalk.cyan(pool)}`,
      ...posLines,
      `  Wallet:  ${chalk.dim(walletAddr)}`,
      isLive ? `\n${chalk.red('  This will execute a REAL on-chain transaction.')}` : '',
      '',
    ];

    return {
      success: true,
      message: closeLines.join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Confirm close?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await context.flashClient.closePosition(market, side);

            guard.recordSigning();
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
    amount: z.number().positive().max(10_000_000),
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

    // Check if virtual market is currently open
    const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
    const mktStatus = getMarketStatus(market);
    if (!mktStatus.isOpen) {
      return { success: false, message: chalk.yellow(formatMarketClosedMessage(market)) };
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

    // Pre-check: verify position exists before showing confirmation
    try {
      const positions = await context.flashClient.getPositions();
      const exists = positions.some(p =>
        (p.market ?? '').toUpperCase() === market.toUpperCase() && p.side === side,
      );
      if (!exists) {
        return { success: false, message: chalk.red(`  No open ${side} position on ${market}.`) };
      }
    } catch {
      // Non-critical: let the add attempt handle the error
    }

    const addPosLines = await buildPositionPreview(context, market, side);
    return {
      success: true,
      message: [
        '',
        isLive ? chalk.red.bold('  CONFIRM TRANSACTION — Add Collateral') : chalk.yellow('  CONFIRM TRANSACTION — Add Collateral'),
        chalk.dim('  ─────────────────────────────────'),
        `  Market: ${chalk.bold(market)} ${colorSide(side)}`,
        ...addPosLines,
        `  Add:    ${formatUsd(amount)} ${chalk.dim('USDC')}`,
        `  Wallet: ${chalk.dim(walletAddr)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await context.flashClient.addCollateral(market, side, amount);
            guard.recordSigning();
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
    amount: z.number().positive().max(10_000_000),
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

    // Check if virtual market is currently open
    const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
    const mktStatus2 = getMarketStatus(market);
    if (!mktStatus2.isOpen) {
      return { success: false, message: chalk.yellow(formatMarketClosedMessage(market)) };
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

    // Pre-check: verify position exists before showing confirmation
    try {
      const positions = await context.flashClient.getPositions();
      const pos = positions.find(p =>
        (p.market ?? '').toUpperCase() === market.toUpperCase() && p.side === side,
      );
      if (!pos) {
        return { success: false, message: chalk.red(`  No open ${side} position on ${market}.`) };
      }
      // Check if remove amount exceeds collateral
      if (pos.collateralUsd && amount >= pos.collateralUsd) {
        return { success: false, message: chalk.red(`  Cannot remove ${formatUsd(amount)} — position only has ${formatUsd(pos.collateralUsd)} collateral. Close position instead.`) };
      }
    } catch {
      // Non-critical: let the remove attempt handle the error
    }

    const rmPosLines = await buildPositionPreview(context, market, side);
    return {
      success: true,
      message: [
        '',
        isLive ? chalk.red.bold('  CONFIRM TRANSACTION — Remove Collateral') : chalk.yellow('  CONFIRM TRANSACTION — Remove Collateral'),
        chalk.dim('  ─────────────────────────────────'),
        `  Market:  ${chalk.bold(market)} ${colorSide(side)}`,
        ...rmPosLines,
        `  Remove:  ${formatUsd(amount)}`,
        `  Wallet:  ${chalk.dim(walletAddr)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await context.flashClient.removeCollateral(market, side, amount);
            guard.recordSigning();
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
      return { success: true, message: theme.dim('\n  No open positions.\n') };
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
      `${colorPnl(p.unrealizedPnl)} ${theme.dim(`(${colorPercent(p.unrealizedPnlPercent)})`)}`,
      p.totalFees > 0 ? formatUsd(p.totalFees) : theme.dim('—'),
      formatPrice(p.liquidationPrice),
    ]);

    const totalPnl = positions.reduce((s: number, p: Position) => s + p.unrealizedPnl, 0);
    const totalExposure = positions.reduce((s: number, p: Position) => s + p.sizeUsd, 0);

    return {
      success: true,
      message: [
        theme.titleBlock('POSITIONS'),
        '',
        formatTable(headers, rows),
        '',
        `  ${theme.dim('Total PnL:')} ${colorPnl(totalPnl)}  ${theme.dim('|  Exposure:')} ${formatUsd(totalExposure)}  ${theme.dim('|  Open:')} ${positions.length}`,
        '',
      ].join('\n'),
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
      return { success: true, message: theme.dim('\n  Market data unavailable. Try again later.\n') };
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
      message: [
        theme.titleBlock('MARKET DATA'),
        '',
        formatTable(headers, rows),
        '',
      ].join('\n'),
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
      theme.titleBlock('PORTFOLIO'),
      '',
      theme.pair('Positions', String(portfolio.positions.length)),
      theme.pair('Exposure', formatUsd(totalExposure)),
      '',
    ];

    if (portfolio.positions.length > 0) {
      lines.push(`  ${theme.section('Directional Bias')}`);
      lines.push(theme.pair('LONG', theme.positive(`${longPct}%`)));
      lines.push(theme.pair('SHORT', theme.negative(`${shortPct}%`)));
      lines.push('');
    }

    lines.push(
      `  ${portfolio.balanceLabel}`,
      portfolio.usdcBalance !== undefined ? theme.pair('USDC Available', theme.positive('$' + portfolio.usdcBalance.toFixed(2))) : '',
      theme.pair('Collateral', formatUsd(portfolio.totalCollateralUsd)),
      theme.pair('Unrealized PnL', colorPnl(portfolio.totalUnrealizedPnl)),
      theme.pair('Realized PnL', colorPnl(portfolio.totalRealizedPnl)),
      portfolio.totalFees > 0 ? theme.pair('Fees Paid', formatUsd(portfolio.totalFees)) : '',
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
        return { success: true, message: theme.dim('\n  Volume data unavailable.\n') };
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
          theme.titleBlock(`VOLUME (${volume.period})`),
          '',
          theme.pair('Total', formatUsd(volume.totalVolumeUsd)),
          theme.pair('Trades', volume.trades.toLocaleString()),
          '',
          formatTable(headers, rows),
          '',
        ].join('\n'),
        data: { volume },
      };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Volume data unavailable.\n`) };
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
        return { success: true, message: theme.dim('\n  Open interest data unavailable.\n') };
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
        message: [
          theme.titleBlock('OPEN INTEREST'),
          '',
          formatTable(headers, rows),
          '',
        ].join('\n'),
        data: { openInterest: oi },
      };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Open interest data unavailable.\n`) };
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
        return { success: true, message: theme.dim('\n  Leaderboard data unavailable.\n') };
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
          theme.titleBlock(`LEADERBOARD — ${metric.toUpperCase()} (${days}d)`),
          '',
          formatTable(headers, rows),
          '',
        ].join('\n'),
        data: { leaderboard: entries },
      };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Leaderboard data unavailable.\n`) };
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
          theme.titleBlock(`FEES (${fees.period})`),
          '',
          theme.pair('Total Fees', formatUsd(fees.totalFees)),
          '',
        ].join('\n'),
        data: { fees },
      };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Fee data unavailable.\n`) };
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
        theme.titleBlock(`TRADER: ${shortAddress(profile.address)}`),
        '',
        theme.pair('Total Trades', String(profile.totalTrades)),
        theme.pair('Total Volume', formatUsd(profile.totalVolume)),
        theme.pair('Total PnL', colorPnl(profile.totalPnl)),
        theme.pair('Win Rate', `${profile.winRate.toFixed(1)}%`),
        '',
      ].join('\n'),
      data: { traderProfile: profile },
    };
  },
};

// ─── Wallet Tools ───────────────────────────────────────────────────────────

import { WalletStore } from '../wallet/wallet-store.js';
import { readFileSync, realpathSync, statSync } from 'fs';
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

      // Reject suspiciously large files (keypair JSON should be < 1KB)
      const fileSize = statSync(realPath).size;
      if (fileSize > 1024) {
        return { success: false, message: chalk.red(`  File too large (${fileSize} bytes). Expected a 64-byte keypair JSON.`) };
      }
      let raw = readFileSync(realPath, 'utf-8');
      secretKey = JSON.parse(raw);
      raw = ''; // Clear raw secret key material from memory
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
        lines.push(chalk.bold('  Wallet stored at:'));
        lines.push(chalk.dim(`    ~/.flash/wallets/${name}.json`));
        lines.push('');
        lines.push(chalk.yellow.bold('  Security Tips'));
        lines.push(chalk.dim('    Keep this file private'));
        lines.push(chalk.dim('    Back up this file securely'));
        lines.push(chalk.dim('    Loss of this file means permanent loss of funds'));
        lines.push(chalk.dim('    Never share your wallet file with anyone'));
        lines.push(chalk.dim('    Consider using a hardware wallet for large balances'));
        lines.push('');
        lines.push(chalk.dim('  Fund with SOL (for fees) and USDC (for collateral) before trading.'));
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
          `  Address: ${chalk.dim(result.address)}`,
          '',
        ];

        // Signal live mode switch if wallet can sign
        if (wm.isConnected) {
          lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
          lines.push(chalk.dim('  Transactions executed from this wallet are real.'));
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
      theme.titleBlock('WALLET STATUS'),
      '',
    ];

    if (wm && wm.isConnected) {
      lines.push(theme.pair('Connected', theme.positive('Yes')));
      if (defaultName) {
        lines.push(theme.pair('Wallet', chalk.bold(defaultName)));
      }
    } else if (wm && wm.hasAddress) {
      lines.push(theme.pair('Connected', theme.warning('Read-only')));
    } else {
      lines.push(theme.pair('Connected', theme.negative('No')));
    }

    lines.push(theme.pair('Stored', `${storedCount} wallet(s)`));
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
      // In simulation mode, show sim balance instead of error
      if (context.simulationMode) {
        const balance = context.flashClient.getBalance();
        const lines = [
          theme.titleBlock('WALLET BALANCE (SIM)'),
          '',
          theme.pair('USDC', theme.positive(formatUsd(balance))),
          theme.dim('  Simulation wallet — no real tokens'),
          '',
        ];
        return { success: true, message: lines.join('\n') };
      }
      return { success: true, message: chalk.dim('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".') };
    }
    try {
      const { sol, tokens } = await wm.getTokenBalances();
      const lines = [
        theme.titleBlock('WALLET BALANCE'),
        '',
        theme.pair('SOL', theme.positive(sol.toFixed(4) + ' SOL')),
      ];
      for (const t of tokens) {
        lines.push(theme.pair(t.symbol, theme.positive(t.amount.toFixed(t.symbol === 'USDC' || t.symbol === 'USDT' ? 2 : 4) + ' ' + t.symbol)));
      }
      if (tokens.length === 0) {
        lines.push(theme.dim('  No SPL tokens found'));
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
      // In simulation mode, show sim balance instead of error
      if (context.simulationMode) {
        const balance = context.flashClient.getBalance();
        const lines = [
          theme.titleBlock('TOKENS IN WALLET (SIM)'),
          '',
          theme.pair('USDC', theme.positive(formatUsd(balance))),
          theme.dim('  Simulation wallet — no real tokens on-chain'),
          '',
        ];
        return { success: true, message: lines.join('\n') };
      }
      return { success: true, message: chalk.dim('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".') };
    }
    try {
      const { sol, tokens } = await wm.getTokenBalances();
      const lines = [
        theme.titleBlock('TOKENS IN WALLET'),
        '',
        theme.pair('SOL', theme.positive(sol.toFixed(4))),
      ];
      for (const t of tokens) {
        const decimals = t.symbol === 'USDC' || t.symbol === 'USDT' ? 2 : 4;
        lines.push(theme.pair(t.symbol, theme.positive(t.amount.toFixed(decimals))));
      }
      if (tokens.length === 0) {
        lines.push(theme.dim('  No SPL tokens found'));
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
      theme.titleBlock('FLASH TRADE MARKETS'),
      '',
    ];
    for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
      for (const market of markets) {
        lines.push(`  ${market.padEnd(12)} ${theme.dim('→')} ${theme.accent(pool)}`);
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
        success: true,
        message: [
          '',
          theme.section('  Trade History'),
          theme.dim('  ─'.repeat(30)),
          '',
          theme.text('  Live trade history is tracked on-chain.'),
          theme.text('  View your transactions on a Solana explorer:'),
          '',
          theme.dim('    • Solscan — https://solscan.io'),
          theme.dim('    • Solana FM — https://solana.fm'),
          '',
          theme.dim('  Use your wallet address to look up past trades.'),
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
      theme.titleBlock('TRADE HISTORY'),
      '',
      theme.dim('  Time       Action  Market  Side    Size        Entry       PnL'),
      `  ${theme.separator(72)}`,
    ];

    for (const t of recent) {
      const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const action = t.action === 'open' ? theme.command('OPEN ') : theme.warning('CLOSE');
      const market = t.market.padEnd(6);
      const side = t.side === 'long' ? theme.long('LONG ') : theme.short('SHORT');
      const size = formatUsd(t.sizeUsd).padStart(10);
      const entry = formatPrice(t.price).padStart(10);
      const pnl = t.pnl !== undefined
        ? (t.pnl >= 0 ? theme.positive(`+${formatUsd(t.pnl)}`) : theme.negative(formatUsd(t.pnl)))
        : theme.dim('  —');

      lines.push(`  ${time}  ${action}   ${market}  ${side}  ${size}  ${entry}  ${pnl}`);
    }

    lines.push('');
    lines.push(theme.dim(`  Showing ${recent.length} of ${trades.length} total trades`));
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── Liquidation Map ────────────────────────────────────────────────────────

export const liquidationMapTool: ToolDefinition = {
  name: 'liquidation_map',
  description: 'Display major liquidation clusters around the current price for a market',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const marketFilter = params.market ? String(params.market).toUpperCase() : undefined;
      const [markets, oiData, whalePositions] = await Promise.all([
        context.flashClient.getMarketData(marketFilter),
        context.dataClient.getOpenInterest(),
        context.dataClient.getOpenPositions?.() ?? Promise.resolve([]),
      ]);

      if (markets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter ?? 'data'} not found.\n`) };
      }

      const targetMarkets = marketFilter
        ? markets.filter(m => m.symbol.toUpperCase() === marketFilter)
        : markets.slice(0, 3);

      if (targetMarkets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter} not found.\n`) };
      }

      const lines: string[] = [];

      for (const mkt of targetMarkets) {
        const price = mkt.price;
        if (!Number.isFinite(price) || price <= 0) continue;

        const oi = oiData.markets.find(m => m.market.toUpperCase() === mkt.symbol.toUpperCase());
        const longOi = oi?.longOi ?? mkt.openInterestLong;
        const shortOi = oi?.shortOi ?? mkt.openInterestShort;

        // Estimate liquidation clusters by leverage band
        // Long liquidation = entry * (1 - 1/leverage), Short liquidation = entry * (1 + 1/leverage)
        const leverageBands = [2, 3, 5, 10, 20, 50];
        const longClusters: { price: number; sizeUsd: number }[] = [];
        const shortClusters: { price: number; sizeUsd: number }[] = [];

        for (const lev of leverageBands) {
          // Distribute OI across leverage bands (higher leverage = less OI share)
          const weight = 1 / lev;
          const totalWeight = leverageBands.reduce((s, l) => s + 1 / l, 0);
          const share = weight / totalWeight;

          const longLiqPrice = price * (1 - 1 / lev);
          const shortLiqPrice = price * (1 + 1 / lev);

          if (Number.isFinite(longLiqPrice) && longOi * share > 0) {
            longClusters.push({ price: longLiqPrice, sizeUsd: longOi * share });
          }
          if (Number.isFinite(shortLiqPrice) && shortOi * share > 0) {
            shortClusters.push({ price: shortLiqPrice, sizeUsd: shortOi * share });
          }
        }

        // Add whale position liquidations
        const mktWhales = whalePositions.filter(w => {
          const sym = (w.market_symbol ?? w.market ?? '').toUpperCase();
          return sym === mkt.symbol.toUpperCase() && Number.isFinite(w.size_usd) && (w.size_usd ?? 0) > 0;
        });

        for (const w of mktWhales.slice(0, 10)) {
          const side = String(w.side ?? '').toLowerCase();
          const size = Number(w.size_usd ?? 0);
          const entry = Number(w.entry_price ?? w.mark_price ?? price);
          if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(size)) continue;

          // Estimate leverage from size and entry
          const estLev = Math.max(2, Math.min(50, size / (size / 5))); // Conservative estimate
          if (side === 'long') {
            longClusters.push({ price: entry * (1 - 1 / estLev), sizeUsd: size });
          } else if (side === 'short') {
            shortClusters.push({ price: entry * (1 + 1 / estLev), sizeUsd: size });
          }
        }

        // Bucket by price zones (1% bands)
        const bucketSize = price * 0.01;
        const bucketMap = new Map<number, { sizeUsd: number; type: 'long' | 'short' }>();

        for (const c of longClusters) {
          const bucket = Math.round(c.price / bucketSize) * bucketSize;
          const existing = bucketMap.get(bucket);
          if (existing) {
            existing.sizeUsd += c.sizeUsd;
          } else {
            bucketMap.set(bucket, { sizeUsd: c.sizeUsd, type: 'long' });
          }
        }
        for (const c of shortClusters) {
          const bucket = Math.round(c.price / bucketSize) * bucketSize;
          const existing = bucketMap.get(bucket);
          if (existing) {
            existing.sizeUsd += c.sizeUsd;
          } else {
            bucketMap.set(bucket, { sizeUsd: c.sizeUsd, type: 'short' });
          }
        }

        // Sort by size and show top clusters
        const sorted = [...bucketMap.entries()]
          .map(([p, data]) => ({ price: p, ...data }))
          .sort((a, b) => b.sizeUsd - a.sizeUsd)
          .slice(0, 10);

        lines.push(theme.titleBlock(`LIQUIDATION MAP — ${mkt.symbol}`));
        lines.push('');
        lines.push(theme.pair('Current Price', formatPrice(price)));
        lines.push('');

        if (sorted.length === 0) {
          lines.push(theme.dim('  No liquidation data available.'));
        } else {
          const headers = ['Price Level', 'Est. Liquidations', 'Type', 'Distance'];
          const rows = sorted.map(c => {
            const dist = ((c.price - price) / price) * 100;
            const typeColor = c.type === 'long' ? theme.negative('LONG LIQ') : theme.positive('SHORT LIQ');
            return [
              formatPrice(c.price),
              formatUsd(c.sizeUsd),
              typeColor,
              formatPercent(dist),
            ];
          });
          lines.push(formatTable(headers, rows));
        }
        lines.push('');
      }

      lines.push(theme.dim('  Estimates based on OI distribution across leverage bands.'));
      lines.push('');

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Liquidation data unavailable: ${getErrorMessage(error)}\n`) };
    }
  },
};

// ─── Funding Rate Dashboard ─────────────────────────────────────────────────

export const fundingDashboardTool: ToolDefinition = {
  name: 'funding_dashboard',
  description: 'Display funding rate data for markets',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const marketFilter = params.market ? String(params.market).toUpperCase() : undefined;
      const markets = await context.flashClient.getMarketData(marketFilter);

      if (markets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter ?? 'data'} not found.\n`) };
      }

      const targetMarkets = marketFilter
        ? markets.filter(m => m.symbol.toUpperCase() === marketFilter)
        : markets.filter(m => Number.isFinite(m.fundingRate));

      if (targetMarkets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter} not found.\n`) };
      }

      const lines: string[] = [];

      if (marketFilter && targetMarkets.length === 1) {
        // Single-market detailed view
        const mkt = targetMarkets[0];
        const rate = mkt.fundingRate;
        const rateDisplay = Number.isFinite(rate)
          ? (rate >= 0 ? theme.positive(formatPercent(rate)) : theme.negative(formatPercent(rate)))
          : theme.dim('N/A');

        // Estimate hourly from current rate (rate is per-interval, approximate windows)
        const hourlyEst = Number.isFinite(rate) ? rate : 0;
        const rate4h = hourlyEst * 4;
        const rate24h = hourlyEst * 24;

        // OI-based funding direction context
        const totalOi = mkt.openInterestLong + mkt.openInterestShort;
        const longPct = totalOi > 0 ? (mkt.openInterestLong / totalOi) * 100 : 50;
        const shortPct = totalOi > 0 ? (mkt.openInterestShort / totalOi) * 100 : 50;
        const imbalance = longPct - shortPct;

        lines.push(theme.titleBlock(`FUNDING DASHBOARD — ${mkt.symbol}`));
        lines.push('');
        lines.push(theme.pair('Current Price', formatPrice(mkt.price)));
        lines.push(theme.pair('Current Funding', rateDisplay));
        lines.push('');
        lines.push(`  ${theme.section('Projected Accumulation')}`);
        lines.push(theme.pair('1h', Number.isFinite(hourlyEst) ? formatPercent(hourlyEst) : 'N/A'));
        lines.push(theme.pair('4h', Number.isFinite(rate4h) ? formatPercent(rate4h) : 'N/A'));
        lines.push(theme.pair('24h', Number.isFinite(rate24h) ? formatPercent(rate24h) : 'N/A'));
        lines.push('');
        lines.push(`  ${theme.section('Open Interest Balance')}`);
        lines.push(theme.pair('Long', `${formatUsd(mkt.openInterestLong)}  (${longPct.toFixed(0)}%)`));
        lines.push(theme.pair('Short', `${formatUsd(mkt.openInterestShort)}  (${shortPct.toFixed(0)}%)`));

        if (Math.abs(imbalance) > 5) {
          const direction = imbalance > 0 ? 'long-heavy' : 'short-heavy';
          const color = imbalance > 0 ? theme.positive : theme.negative;
          lines.push(theme.pair('Imbalance', color(`${Math.abs(imbalance).toFixed(1)}% ${direction}`)));
        } else {
          lines.push(theme.pair('Imbalance', theme.dim('balanced')));
        }

        lines.push('');
        lines.push(theme.dim('  Positive funding: longs pay shorts. Negative: shorts pay longs.'));
        lines.push('');
      } else {
        // Multi-market overview
        lines.push(theme.titleBlock('FUNDING RATES'));
        lines.push('');

        const sorted = [...targetMarkets].sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate));

        const headers = ['Market', 'Funding Rate', 'Long OI', 'Short OI', 'L/S Ratio'];
        const rows = sorted.map(m => {
          const rate = m.fundingRate;
          const rateStr = Number.isFinite(rate)
            ? (rate >= 0 ? theme.positive(formatPercent(rate)) : theme.negative(formatPercent(rate)))
            : theme.dim('N/A');
          const totalOi = m.openInterestLong + m.openInterestShort;
          const ratio = totalOi > 0
            ? `${((m.openInterestLong / totalOi) * 100).toFixed(0)}/${((m.openInterestShort / totalOi) * 100).toFixed(0)}`
            : 'N/A';
          return [
            chalk.bold(m.symbol),
            rateStr,
            formatUsd(m.openInterestLong),
            formatUsd(m.openInterestShort),
            ratio,
          ];
        });

        lines.push(formatTable(headers, rows));
        lines.push('');
        lines.push(theme.dim('  Positive: longs pay shorts. Negative: shorts pay longs.'));
        lines.push('');
      }

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Funding data unavailable: ${getErrorMessage(error)}\n`) };
    }
  },
};

// ─── Liquidity Depth Viewer ─────────────────────────────────────────────────

export const liquidityDepthTool: ToolDefinition = {
  name: 'liquidity_depth',
  description: 'Show liquidity distribution around the current price for a market',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const marketFilter = params.market ? String(params.market).toUpperCase() : undefined;
      const [markets, oiData] = await Promise.all([
        context.flashClient.getMarketData(marketFilter),
        context.dataClient.getOpenInterest(),
      ]);

      if (markets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter ?? 'data'} not found.\n`) };
      }

      const targetMarkets = marketFilter
        ? markets.filter(m => m.symbol.toUpperCase() === marketFilter)
        : markets.slice(0, 3);

      if (targetMarkets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter} not found.\n`) };
      }

      const lines: string[] = [];

      for (const mkt of targetMarkets) {
        const price = mkt.price;
        if (!Number.isFinite(price) || price <= 0) continue;

        const oi = oiData.markets.find(m => m.market.toUpperCase() === mkt.symbol.toUpperCase());
        const totalOi = (oi?.longOi ?? mkt.openInterestLong) + (oi?.shortOi ?? mkt.openInterestShort);
        const longOi = oi?.longOi ?? mkt.openInterestLong;
        const shortOi = oi?.shortOi ?? mkt.openInterestShort;

        // Build liquidity depth bands around price
        // Estimate: liquidity concentrates around current price with exponential decay
        const bands: { level: number; liquidity: number; side: string }[] = [];
        const bandOffsets = [-5, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5];

        for (const pct of bandOffsets) {
          const level = price * (1 + pct / 100);
          if (!Number.isFinite(level)) continue;

          // Liquidity estimate: decays with distance from current price
          const distance = Math.abs(pct);
          const decay = Math.exp(-distance * 0.3);
          const baseLiquidity = totalOi * 0.15 * decay;

          // Bid side (below price) gets more long OI weight, ask side gets more short OI weight
          const sideWeight = pct < 0
            ? (longOi / Math.max(totalOi, 1)) * 1.5
            : (shortOi / Math.max(totalOi, 1)) * 1.5;
          const liquidity = baseLiquidity * Math.max(sideWeight, 0.3);

          if (liquidity > 0) {
            bands.push({
              level,
              liquidity,
              side: pct < 0 ? 'BID' : pct > 0 ? 'ASK' : 'MID',
            });
          }
        }

        lines.push(theme.titleBlock(`LIQUIDITY DEPTH — ${mkt.symbol}`));
        lines.push('');
        lines.push(theme.pair('Current Price', formatPrice(price)));
        lines.push(theme.pair('Total OI', formatUsd(totalOi)));
        lines.push('');

        if (bands.length === 0) {
          lines.push(theme.dim('  No depth data available.'));
        } else {
          const maxLiq = Math.max(...bands.map(b => b.liquidity));
          const barWidth = 20;

          const headers = ['Price Level', 'Est. Liquidity', 'Side', 'Depth'];
          const rows = bands.map(b => {
            const barLen = maxLiq > 0 ? Math.round((b.liquidity / maxLiq) * barWidth) : 0;
            const bar = b.side === 'BID'
              ? theme.positive('█'.repeat(barLen))
              : b.side === 'ASK'
                ? theme.negative('█'.repeat(barLen))
                : theme.accent('█'.repeat(barLen));
            const sideColor = b.side === 'BID'
              ? theme.positive(b.side)
              : b.side === 'ASK'
                ? theme.negative(b.side)
                : theme.accent(b.side);

            return [
              formatPrice(b.level),
              formatUsd(b.liquidity),
              sideColor,
              bar,
            ];
          });

          lines.push(formatTable(headers, rows));
        }
        lines.push('');
      }

      lines.push(theme.dim('  Estimates derived from open interest distribution.'));
      lines.push('');

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Depth data unavailable: ${getErrorMessage(error)}\n`) };
    }
  },
};

// ─── Protocol Health ────────────────────────────────────────────────────────

export const protocolHealthTool: ToolDefinition = {
  name: 'protocol_health',
  description: 'Display overall Flash protocol health metrics',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    try {
      const [markets, oiData, overviewStats] = await Promise.all([
        context.flashClient.getMarketData(),
        context.dataClient.getOpenInterest(),
        context.dataClient.getOverviewStats('30d'),
      ]);

      // Aggregate OI
      let totalLongOi = 0;
      let totalShortOi = 0;
      for (const m of oiData.markets) {
        totalLongOi += m.longOi;
        totalShortOi += m.shortOi;
      }
      const totalOi = totalLongOi + totalShortOi;

      // Active markets (those with price > 0 and OI > 0)
      const activeMarkets = markets.filter(m =>
        Number.isFinite(m.price) && m.price > 0 &&
        (m.openInterestLong + m.openInterestShort > 0 || oiData.markets.some(oi => oi.market.toUpperCase() === m.symbol.toUpperCase()))
      );

      // RPC latency
      let rpcLatency = 'N/A';
      try {
        const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
        const rpcMgr = getRpcManagerInstance();
        if (rpcMgr) {
          const lat = rpcMgr.activeLatencyMs;
          rpcLatency = lat >= 0 ? `${lat}ms` : 'N/A';
        }
      } catch { /* non-critical */ }

      // Block height
      let blockHeight = 'N/A';
      try {
        const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
        const rpcMgr = getRpcManagerInstance();
        if (rpcMgr) {
          const slot = await rpcMgr.connection.getSlot('confirmed');
          if (Number.isFinite(slot)) {
            blockHeight = slot.toLocaleString();
          }
        }
      } catch { /* non-critical */ }

      // L/S ratio
      const longPct = totalOi > 0 ? ((totalLongOi / totalOi) * 100).toFixed(0) : '50';
      const shortPct = totalOi > 0 ? ((totalShortOi / totalOi) * 100).toFixed(0) : '50';

      // Top markets by OI
      const sortedOi = [...oiData.markets]
        .map(m => ({ market: m.market, total: m.longOi + m.shortOi }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);

      const lines: string[] = [
        theme.titleBlock('FLASH PROTOCOL HEALTH'),
        '',
        `  ${theme.section('Protocol Overview')}`,
        theme.pair('Active Markets', activeMarkets.length.toString()),
        theme.pair('Total Open Interest', formatUsd(totalOi)),
        theme.pair('Long/Short Ratio', `${theme.positive(longPct + '%')} / ${theme.negative(shortPct + '%')}`),
        '',
      ];

      // 30d stats
      if (overviewStats) {
        lines.push(`  ${theme.section('Activity (30d)')}`);
        lines.push(theme.pair('Volume', formatUsd(overviewStats.volumeUsd)));
        lines.push(theme.pair('Trades', overviewStats.trades.toLocaleString()));
        lines.push(theme.pair('Unique Traders', overviewStats.uniqueTraders.toLocaleString()));
        lines.push(theme.pair('Fees Collected', formatUsd(overviewStats.feesUsd)));
        lines.push('');
      }

      // Top markets
      if (sortedOi.length > 0) {
        lines.push(`  ${theme.section('Top Markets by OI')}`);
        for (const m of sortedOi) {
          if (m.total <= 0) continue;
          const pct = totalOi > 0 ? ((m.total / totalOi) * 100).toFixed(1) : '0';
          lines.push(`    ${m.market.padEnd(10)} ${formatUsd(m.total).padEnd(14)} ${theme.dim(`(${pct}%)`)}`);
        }
        lines.push('');
      }

      // Infrastructure
      lines.push(`  ${theme.section('Infrastructure')}`);
      lines.push(theme.pair('RPC Latency', rpcLatency));
      lines.push(theme.pair('Block Height', blockHeight));
      lines.push('');

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Protocol health data unavailable: ${getErrorMessage(error)}\n`) };
    }
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
  liquidationMapTool,
  fundingDashboardTool,
  liquidityDepthTool,
  protocolHealthTool,
  inspectProtocol,
  inspectPool,
  inspectMarketTool,
  systemStatusTool,
  rpcStatusTool,
  rpcTestTool,
  txInspectTool,
  tradeHistoryTool,
];
