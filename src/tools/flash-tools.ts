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
  humanizeSdkError,
  padVisibleStart,
} from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { getProtocolFeeRates, calcFeeUsd, ProtocolParameterError } from '../utils/protocol-fees.js';
import { DATA_STALENESS_WARNING_SECONDS } from '../core/risk-config.js';
import { computeSimulationLiquidationPrice } from '../utils/protocol-liq.js';
import { filterValidPositions } from '../core/invariants.js';
import { getSigningGuard, SigningAuditEntry } from '../security/signing-guard.js';
import { updateLastWallet, clearLastWallet } from '../wallet/session.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { resolveMarket } from '../utils/market-resolver.js';

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

/**
 * Compute pre-trade liquidation estimate using the same formula as
 * Flash SDK's getLiquidationPriceContractHelper().
 *
 * Uses protocol fee rates from CustodyAccount when available,
 * falls back to SDK defaults when on-chain fetch is unavailable.
 */
async function estimateLiqPrice(entryPrice: number, leverage: number, side: TradeSide, market: string, perpClient: unknown | null): Promise<number> {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(leverage) || entryPrice <= 0 || leverage <= 0) return 0;
  const feeRates = await getProtocolFeeRates(market, perpClient);
  const sizeUsd = 1; // normalized
  const collateralUsd = sizeUsd / leverage;
  return computeSimulationLiquidationPrice(entryPrice, sizeUsd, collateralUsd, side, feeRates.maintenanceMarginRate, feeRates.closeFeeRate);
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
    const perpClient = context.simulationMode ? null : (context.flashClient as any).perpClient ?? null;
    const liqEst = await estimateLiqPrice(entryEst, leverage, side, market, perpClient);
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

  // Rough pre-trade estimate — actual liq distance computed by SDK post-trade
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
    leverage: z.number().min(1).max(1000), // Absolute protocol max; per-market limits enforced below
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

    // Fetch fee rate from CustodyAccount via Flash SDK (cached, 60s TTL)
    const perpClient = context.simulationMode ? null : (context.flashClient as any).perpClient ?? null;
    let feeRates;
    try {
      feeRates = await getProtocolFeeRates(market, perpClient);
    } catch (err) {
      if (err instanceof ProtocolParameterError) {
        return { success: false, message: [
          '',
          chalk.red(`  Protocol parameter error detected for ${market}`),
          chalk.red('  CustodyAccount data invalid or RPC corrupted.'),
          chalk.red('  Please verify RPC integrity.'),
          chalk.dim(`  Detail: ${err.message}`),
          '',
        ].join('\n') };
      }
      throw err;
    }
    const estimatedFeeRate = feeRates.openFeeRate;
    const estimatedFee = calcFeeUsd(sizeUsd, estimatedFeeRate);

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
      `  Est. Fee:    ${chalk.dim('$' + estimatedFee.toFixed(4))}  ${chalk.dim(`(${(estimatedFeeRate * 100).toFixed(2)}%)`)}`,
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

            // Liquidation price from SDK (protocol math)
            const liqPrice = result.liquidationPrice ?? 0;

            // Fee from protocol — use pre-trade estimate (actual fee captured in position.totalFees)
            const executionFee = sizeUsd * estimatedFeeRate;

            // Log session trade (store openFeePaid for fee visibility)
            if (context.sessionTrades) {
              // Cap session trades to prevent unbounded memory growth in long sessions
              if (context.sessionTrades.length >= 500) context.sessionTrades.shift();
              context.sessionTrades.push({
                action: 'open', market, side, leverage, collateral,
                sizeUsd: result.sizeUsd, entryPrice: result.entryPrice,
                openFeePaid: executionFee,
                txSignature: result.txSignature, timestamp: Date.now(),
              });
            }

            // Re-read position from protocol for actual on-chain values
            let actualSize = result.sizeUsd;
            let actualCollateral = collateral;
            let actualLiq = liqPrice;
            if (!context.simulationMode) {
              try {
                const freshPositions = await context.flashClient.getPositions();
                const pos = freshPositions.find(
                  (p) => p.market === market && p.side === side
                );
                if (pos) {
                  actualSize = pos.sizeUsd;
                  actualCollateral = pos.collateralUsd;
                  actualLiq = pos.liquidationPrice;
                }
              } catch {
                // Non-critical: fall back to SDK response values
              }
            }

            return {
              success: true,
              message: [
                '',
                chalk.green('  Position Opened'),
                chalk.dim('  ─────────────────'),
                `  Entry Price:       ${formatPrice(result.entryPrice)}`,
                `  Size:              ${formatUsd(actualSize)}`,
                `  Collateral:        ${formatUsd(actualCollateral)}`,
                `  Liquidation Price: ${actualLiq && actualLiq > 0 ? chalk.yellow(formatPrice(actualLiq)) : chalk.dim('N/A')}`,
                `  Est. Fee:          ${chalk.dim('$' + executionFee.toFixed(4))}`,
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
            return { success: false, message: `  Failed to open position: ${humanizeSdkError(getErrorMessage(error), collateral, leverage)}` };
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

            // Log session trade
            if (context.sessionTrades) {
              // Cap session trades to prevent unbounded memory growth in long sessions
              if (context.sessionTrades.length >= 500) context.sessionTrades.shift();
              context.sessionTrades.push({
                action: 'close', market, side,
                exitPrice: result.exitPrice, pnl: result.pnl,
                txSignature: result.txSignature, timestamp: Date.now(),
              });
            }

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
            // Log session trade
            if (context.sessionTrades) {
              // Cap session trades to prevent unbounded memory growth in long sessions
              if (context.sessionTrades.length >= 500) context.sessionTrades.shift();
              context.sessionTrades.push({
                action: 'add_collateral', market, side, collateral: amount,
                txSignature: result.txSignature, timestamp: Date.now(),
              });
            }

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

            // Log session trade
            if (context.sessionTrades) {
              // Cap session trades to prevent unbounded memory growth in long sessions
              if (context.sessionTrades.length >= 500) context.sessionTrades.shift();
              context.sessionTrades.push({
                action: 'remove_collateral', market, side, collateral: amount,
                txSignature: result.txSignature, timestamp: Date.now(),
              });
            }

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
    const rawPositions = await context.flashClient.getPositions();
    const positions = filterValidPositions(rawPositions);
    if (positions.length === 0) {
      return { success: true, message: theme.dim('\n  No open positions.\n') };
    }

    // Build fee lookup from session trades for fee visibility
    // (protocol settles open fees immediately, so on-chain unsettledFees may read 0)
    const sessionFeeLookup = new Map<string, number>();
    if (context.sessionTrades) {
      for (const t of context.sessionTrades) {
        if (t.action === 'open' && t.openFeePaid && t.openFeePaid > 0) {
          sessionFeeLookup.set(`${t.market}:${t.side}`, t.openFeePaid);
        }
      }
    }

    const headers = ['Market', 'Side', 'Lev', 'Size', 'Collateral', 'Entry', 'Mark', 'PnL', 'Fees', 'Liq'];
    const rows = positions.map((p: Position) => {
      const pnlSign = p.unrealizedPnl >= 0 ? '+' : '';
      const liqDist = p.markPrice > 0 && p.liquidationPrice > 0
        ? Math.abs((p.markPrice - p.liquidationPrice) / p.markPrice) * 100
        : 0;
      const liqStr = p.liquidationPrice > 0
        ? `${formatPrice(p.liquidationPrice)} ${theme.dim(`(${liqDist.toFixed(1)}%)`)}`
        : theme.dim('—');
      // Total fees = on-chain unsettled fees + session-tracked open fee
      const sessionFee = sessionFeeLookup.get(`${p.market}:${p.side}`) ?? 0;
      const displayFees = p.totalFees > 0 ? p.totalFees : sessionFee;
      return [
        chalk.bold(p.market),
        colorSide(p.side),
        `${p.leverage.toFixed(1)}x`,
        formatUsd(p.sizeUsd),
        formatUsd(p.collateralUsd),
        formatPrice(p.entryPrice),
        formatPrice(p.markPrice),
        `${pnlSign}${colorPnl(p.unrealizedPnl)} ${theme.dim(`(${colorPercent(p.unrealizedPnlPercent)})`)}`,
        formatUsd(displayFees),
        liqStr,
      ];
    });

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
    const { market: rawMarket } = params as { market?: string };
    const market = rawMarket ? resolveMarket(rawMarket) : undefined;
    const markets = await context.flashClient.getMarketData(market);
    if (markets.length === 0) {
      return { success: true, message: theme.dim('\n  Market data unavailable. Try again later.\n') };
    }

    // Enrich with fstats OI data and Pyth 24h change
    try {
      const { PriceService } = await import('../data/prices.js');
      const priceSvc = new PriceService();
      const [oi, pythPrices] = await Promise.all([
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
        const pythPrice = pythPrices.get(m.symbol);
        if (pythPrice && m.priceChange24h === 0) {
          m.priceChange24h = pythPrice.priceChange24h;
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
          theme.dim(`  Data updated: ${new Date().toLocaleTimeString()}`),
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
          theme.dim(`  Data updated: ${new Date().toLocaleTimeString()}`),
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

      const lines = [
        theme.titleBlock(`PROTOCOL FEES (${fees.period})`),
        '',
        theme.pair('Total Fees', formatUsd(fees.totalFees)),
      ];

      // Fee distribution breakdown (from latest day)
      const totalDistribution = fees.lpShare + fees.tokenShare + fees.teamShare;
      if (totalDistribution > 0) {
        lines.push('');
        lines.push(`  ${theme.section('Fee Distribution (latest day)')}`);
        lines.push(theme.pair('LP Share', formatUsd(fees.lpShare)));
        lines.push(theme.pair('Token Share', formatUsd(fees.tokenShare)));
        lines.push(theme.pair('Team Share', formatUsd(fees.teamShare)));
      }

      // Daily trend (last 7 days if available)
      if (fees.dailyFees.length > 1) {
        const recent = fees.dailyFees.slice(-7);
        const avg = recent.reduce((s, d) => s + d.totalFees, 0) / recent.length;
        lines.push('');
        lines.push(`  ${theme.section('Daily Trend')}`);
        lines.push(theme.pair(`${recent.length}d Avg`, formatUsd(avg)));

        // Show last 7 days
        for (const d of recent) {
          const dateStr = d.date.length >= 10 ? d.date.slice(5, 10) : d.date;
          lines.push(`    ${theme.dim(dateStr)}  ${formatUsd(d.totalFees)}`);
        }
      }

      // Trading fee rate info
      lines.push('');
      lines.push(`  ${theme.section('Trading Fee Rate')}`);
      lines.push(theme.pair('Source', 'On-chain CustodyAccount (per-market)'));
      lines.push(theme.pair('Note', theme.dim('Fees are deducted from collateral at execution')));

      lines.push('');

      return {
        success: true,
        message: lines.join('\n'),
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
    const { POOL_MARKETS, isTradeablePool } = await import('../config/index.js');
    const lines = [
      theme.titleBlock('FLASH TRADE MARKETS'),
      '',
    ];
    for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
      const tradeable = isTradeablePool(pool);
      for (const market of markets) {
        const tag = tradeable ? '' : theme.dim(' (coming soon)');
        lines.push(`  ${market.padEnd(12)} ${theme.dim('→')} ${theme.accent(pool)}${tag}`);
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
    const { path: inputPath } = params as { path: string };
    if (!inputPath) {
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

    // If input looks like a wallet name (no path separators, no extension),
    // check if it matches a stored wallet and suggest "wallet use" instead.
    const looksLikeName = !inputPath.includes('/') && !inputPath.includes('\\') && !inputPath.includes('.');
    if (looksLikeName) {
      const { WalletStore } = await import('../wallet/wallet-store.js');
      const store = new WalletStore();
      const wallets = store.listWallets().map(n => n.toLowerCase());
      if (wallets.includes(inputPath.toLowerCase())) {
        return {
          success: false,
          message: [
            '',
            chalk.yellow(`  "${inputPath}" is a saved wallet name, not a file path.`),
            '',
            `  ${chalk.dim('Use:')}  ${chalk.cyan(`wallet use ${inputPath}`)}`,
            '',
          ].join('\n'),
        };
      }
    }

    const wm = context.walletManager;
    if (!wm) {
      return { success: false, message: chalk.red('  Wallet manager not available') };
    }
    try {
      const { address } = wm.loadFromFile(inputPath);
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
    const { market: rawMarket } = params as { market?: string };
    if (!rawMarket) {
      return { success: false, message: chalk.red('  Usage: inspect market <asset>  (e.g. inspect market SOL)') };
    }
    const market = resolveMarket(rawMarket);
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

export const protocolStatusTool: ToolDefinition = {
  name: 'protocol_status',
  description: 'Show protocol connection status overview',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const lines: string[] = [
      '',
      chalk.bold('  PROTOCOL STATUS'),
      chalk.dim('  ────────────────────────────────────────'),
      '',
    ];

    // 1. Program ID
    try {
      const { PoolConfig } = await import('flash-sdk');
      const pc = PoolConfig.fromIdsByName('Crypto.1', 'mainnet-beta');
      lines.push(`  Program ID:    ${chalk.cyan(pc.programId.toString())}`);
    } catch {
      lines.push(`  Program ID:    ${chalk.dim('unavailable')}`);
    }

    // 2. RPC Slot
    try {
      const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
      const mgr = getRpcManagerInstance();
      if (mgr) {
        const slot = mgr.activeSlot > 0 ? mgr.activeSlot : await mgr.connection.getSlot('confirmed');
        lines.push(`  RPC Slot:      ${chalk.green(slot.toLocaleString())}`);
        const active = mgr.activeEndpoint;
        lines.push(`  Active RPC:    ${chalk.cyan(active.label)}`);
        const latency = mgr.activeLatencyMs;
        lines.push(`  RPC Latency:   ${latency >= 0 ? chalk.green(`${latency}ms`) : chalk.dim('N/A')}`);
        const lag = mgr.activeSlotLag;
        lines.push(`  Slot Lag:      ${lag === 0 ? chalk.green('0') : lag > 0 ? chalk.yellow(String(lag)) : chalk.dim('N/A')}`);
      } else {
        lines.push(`  RPC Slot:      ${chalk.dim('not connected')}`);
      }
    } catch {
      lines.push(`  RPC Slot:      ${chalk.red('error')}`);
    }

    // 3. Oracle Health — ping Pyth Hermes with latency measurement
    try {
      const oracleStart = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const resp = await fetch('https://hermes.pyth.network/api/latest_vaas?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', {
        signal: controller.signal,
      });
      clearTimeout(timer);
      const oracleMs = Math.round(performance.now() - oracleStart);
      lines.push(`  Oracle Health: ${resp.ok ? chalk.green(`OK (${oracleMs}ms)`) : chalk.red(`HTTP ${resp.status}`)}`);
    } catch {
      lines.push(`  Oracle Health: ${chalk.red('unreachable')}`);
    }

    // 4. SDK Connection
    const simMode = context?.simulationMode ?? true;
    if (simMode) {
      lines.push(`  SDK:           ${chalk.yellow('Simulation mode (no live SDK)')}`);
    } else {
      try {
        const perpClient = (context?.flashClient as any)?.perpClient;
        if (perpClient) {
          lines.push(`  SDK:           ${chalk.green('Connected')}`);
        } else {
          lines.push(`  SDK:           ${chalk.red('No perpClient')}`);
        }
      } catch {
        lines.push(`  SDK:           ${chalk.red('Error')}`);
      }
    }

    // 5. Active Markets (tradeable markets only — consistent with protocol health)
    try {
      const { getProtocolStatsService } = await import('../data/protocol-stats.js');
      const pss = getProtocolStatsService(context.dataClient);
      const stats = await pss.getStats();
      lines.push(`  Markets:       ${chalk.bold(String(stats.activeMarkets))} active`);
    } catch {
      lines.push(`  Markets:       ${chalk.dim('unavailable')}`);
    }

    // 6. Wallet status
    const walletAddr = context?.walletAddress;
    if (walletAddr && walletAddr !== 'unknown') {
      lines.push(`  Wallet:        ${chalk.cyan(walletAddr.slice(0, 4) + '...' + walletAddr.slice(-4))}`);
    } else {
      lines.push(`  Wallet:        ${chalk.dim('not connected')}`);
    }

    // 7. Mode
    lines.push(`  Mode:          ${simMode ? chalk.yellow('Simulation') : chalk.red('Live Trading')}`);

    lines.push('');
    return { success: true, message: lines.join('\n') };
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

export const txDebugTool: ToolDefinition = {
  name: 'tx_debug',
  description: 'Debug a transaction with protocol-level inspection',
  parameters: z.object({ signature: z.string().optional(), showState: z.boolean().optional() }),
  execute: async (params): Promise<ToolResult> => {
    const { signature, showState } = params as { signature?: string; showState?: boolean };
    if (!signature) {
      return { success: false, message: chalk.red('  Usage: tx debug <signature> [--state]') };
    }
    const { getSystemDiagnostics } = await import('../system/system-diagnostics.js');
    const diag = getSystemDiagnostics();
    if (!diag) {
      return { success: true, message: chalk.dim('  System diagnostics not initialized.') };
    }
    const msg = await diag.txDebug(signature, showState ?? false);
    return { success: true, message: msg };
  },
};

// ─── Trade History / Journal ──────────────────────────────────────────────────

const tradeHistoryTool: ToolDefinition = {
  name: 'trade_history',
  description: 'Show recent trade history',
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const client = context.flashClient;

    // In simulation mode, use the SimulatedFlashClient's full history
    if (client.getTradeHistory) {
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

      const recent = trades.slice(-20).reverse();
      const lines: string[] = [
        theme.titleBlock('TRADE HISTORY'),
        '',
        theme.dim('  Time       Action  Market  Side    Entry       Exit        Collateral  PnL'),
        `  ${theme.separator(82)}`,
      ];

      for (const t of recent) {
        const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour12: false });
        const action = t.action === 'open' ? theme.command('OPEN ') : theme.warning('CLOSE');
        const market = t.market.padEnd(6);
        const side = t.side === 'long' ? theme.long('LONG ') : theme.short('SHORT');
        const isClose = t.action === 'close';
        const entryStr = isClose
          ? formatPrice(t.entryPrice ?? 0).padStart(10)
          : formatPrice(t.price).padStart(10);
        const exitStr = isClose
          ? formatPrice(t.price).padStart(10)
          : padVisibleStart(theme.dim('—'), 10);
        const coll = formatUsd(t.collateralUsd).padStart(10);
        const pnl = t.pnl !== undefined
          ? (t.pnl >= 0 ? theme.positive(`+${formatUsd(t.pnl)}`) : theme.negative(formatUsd(t.pnl)))
          : padVisibleStart(theme.dim('—'), 5);

        lines.push(`  ${time}  ${action}   ${market}  ${side}  ${entryStr}  ${exitStr}  ${coll}  ${pnl}`);
      }

      lines.push('');
      lines.push(theme.dim(`  Showing ${recent.length} of ${trades.length} total trades`));
      lines.push('');

      return { success: true, message: lines.join('\n') };
    }

    // Live mode: show session trades (trades executed in this terminal session)
    const sessionTrades = context.sessionTrades ?? [];
    if (sessionTrades.length === 0) {
      return {
        success: true,
        message: [
          '',
          theme.section('  Trade History'),
          theme.dim('  ─'.repeat(30)),
          '',
          theme.dim('  No trades executed in this session.'),
          '',
          theme.dim('  For full history, view on a Solana explorer:'),
          theme.dim('    • Solscan — https://solscan.io'),
          theme.dim('    • Solana FM — https://solana.fm'),
          '',
        ].join('\n'),
      };
    }

    const recent = sessionTrades.slice(-20).reverse();
    const lines: string[] = [
      theme.titleBlock('SESSION TRADE HISTORY'),
      '',
      theme.dim('  Time       Action       Market    Side    Entry       Exit        Collateral  PnL'),
      `  ${theme.separator(88)}`,
    ];

    for (const t of recent) {
      const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const actionLabels: Record<string, string> = {
        open: 'OPEN',
        close: 'CLOSE',
        add_collateral: 'ADD COLL',
        remove_collateral: 'RM COLL',
      };
      const actionStr = theme.command((actionLabels[t.action] ?? t.action).padEnd(10));
      const market = (t.market ?? '').padEnd(9);
      const side = (t.side ?? '').toUpperCase() === 'LONG' ? theme.long('LONG ') : theme.short('SHORT');
      const entryStr = t.entryPrice !== undefined ? formatPrice(t.entryPrice).padStart(10) : padVisibleStart(theme.dim('—'), 10);
      const exitStr = t.exitPrice !== undefined ? formatPrice(t.exitPrice).padStart(10) : padVisibleStart(theme.dim('—'), 10);
      const coll = t.collateral !== undefined ? formatUsd(t.collateral).padStart(10) : padVisibleStart(theme.dim('—'), 10);
      const pnl = t.pnl !== undefined
        ? (t.pnl >= 0 ? theme.positive(`+${formatUsd(t.pnl)}`) : theme.negative(formatUsd(t.pnl)))
        : padVisibleStart(theme.dim('—'), 5);

      lines.push(`  ${time}  ${actionStr} ${market} ${side}  ${entryStr}  ${exitStr}  ${coll}  ${pnl}`);
    }

    lines.push('');
    lines.push(theme.dim(`  ${recent.length} trade(s) this session`));
    lines.push(theme.dim('  Full history: https://solscan.io'));
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── Liquidation Map ────────────────────────────────────────────────────────

export const liquidationMapTool: ToolDefinition = {
  name: 'liquidation_map',
  description: 'Display liquidation risk data: OI by leverage band and whale position analysis',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const marketFilter = params.market ? resolveMarket(String(params.market)) : undefined;
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
        const totalOi = longOi + shortOi;

        lines.push(theme.titleBlock(`LIQUIDATION RISK — ${mkt.symbol}`));
        lines.push('');
        lines.push(theme.pair('Current Price', formatPrice(price)));
        lines.push(theme.pair('Total OI', formatUsd(totalOi)));
        lines.push(theme.pair('Long OI', formatUsd(longOi)));
        lines.push(theme.pair('Short OI', formatUsd(shortOi)));
        lines.push('');

        // ── Liquidation price levels by leverage ──
        // Show WHERE liquidation would occur for each leverage tier
        // This is mathematical fact, not estimated distribution
        lines.push(`  ${theme.section('Liquidation Price by Leverage')}`);
        lines.push(theme.dim('  If a position was opened at current price:'));
        lines.push('');

        const leverageBands = [2, 3, 5, 10, 20, 50, 100];
        const levHeaders = ['Leverage', 'Long Liq Price', 'Short Liq Price', 'Distance'];
        const levRows = leverageBands.map(lev => {
          const longLiq = price * (1 - 1 / lev);
          const shortLiq = price * (1 + 1 / lev);
          const distPct = (1 / lev) * 100;
          return [
            `${lev}x`,
            formatPrice(longLiq),
            formatPrice(shortLiq),
            `${distPct.toFixed(1)}%`,
          ];
        });
        lines.push(formatTable(levHeaders, levRows));
        lines.push('');

        // ── Whale positions with known data ──
        const mktWhales = whalePositions.filter(w => {
          const sym = (w.market_symbol ?? w.market ?? '').toUpperCase();
          return sym === mkt.symbol.toUpperCase() && Number.isFinite(w.size_usd) && (w.size_usd ?? 0) > 0;
        }).sort((a, b) => (Number(b.size_usd) ?? 0) - (Number(a.size_usd) ?? 0));

        if (mktWhales.length > 0) {
          lines.push(`  ${theme.section('Whale Positions')}`);
          lines.push('');

          const whaleHeaders = ['Side', 'Size', 'Entry Price', 'Dist from Current'];
          const whaleRows = mktWhales.slice(0, 10).map(w => {
            const side = String(w.side ?? '?').toUpperCase();
            const size = Number(w.size_usd ?? 0);
            const entry = Number(w.entry_price ?? w.mark_price ?? 0);
            const dist = entry > 0 ? ((price - entry) / entry) * 100 : 0;
            const sideColor = side === 'LONG' ? theme.positive(side.padEnd(6)) : theme.negative(side.padEnd(6));
            return [
              sideColor,
              formatUsd(size),
              entry > 0 ? formatPrice(entry) : theme.dim('N/A'),
              Number.isFinite(dist) ? formatPercent(dist) : theme.dim('N/A'),
            ];
          });
          lines.push(formatTable(whaleHeaders, whaleRows));
          lines.push('');
        }

        // OI imbalance summary
        if (totalOi > 0) {
          const longPct = (longOi / totalOi) * 100;
          const imbalance = Math.abs(longPct - 50);
          if (imbalance > 10) {
            const direction = longPct > 50 ? 'long-heavy' : 'short-heavy';
            lines.push(chalk.yellow(`  OI is ${direction} (${longPct.toFixed(0)}/${(100 - longPct).toFixed(0)}) — cascading liquidations more likely on the heavy side.`));
            lines.push('');
          }
        }
      }

      lines.push(theme.dim('  Source: Pyth Hermes (price) | fstats (OI, whale positions)'));
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
  description: 'Display OI imbalance and fee accrual data for markets',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const marketFilter = params.market ? resolveMarket(String(params.market)) : undefined;
      const markets = await context.flashClient.getMarketData(marketFilter);

      if (markets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter ?? 'data'} not found.\n`) };
      }

      // Enrich with real OI data from fstats (getMarketData returns zero OI)
      const oiData = await context.dataClient.getOpenInterest().catch(() => ({ markets: [] }));
      for (const mkt of markets) {
        const oiEntry = oiData.markets.find((m: any) => m.market?.toUpperCase()?.includes(mkt.symbol.toUpperCase()));
        if (oiEntry) {
          mkt.openInterestLong = oiEntry.longOi ?? 0;
          mkt.openInterestShort = oiEntry.shortOi ?? 0;
        }
      }

      const targetMarkets = marketFilter
        ? markets.filter(m => m.symbol.toUpperCase() === marketFilter)
        : markets.filter(m => m.openInterestLong + m.openInterestShort > 0);

      if (targetMarkets.length === 0) {
        return { success: false, message: theme.negative(`\n  No market data available${marketFilter ? ` for ${marketFilter}` : ''}.\n`) };
      }

      const lines: string[] = [];

      if (marketFilter && targetMarkets.length === 1) {
        // Single-market detailed view
        const mkt = targetMarkets[0];
        const totalOi = mkt.openInterestLong + mkt.openInterestShort;
        const longPct = totalOi > 0 ? (mkt.openInterestLong / totalOi) * 100 : 50;
        const shortPct = totalOi > 0 ? (mkt.openInterestShort / totalOi) * 100 : 50;
        const imbalance = longPct - shortPct;

        lines.push(theme.titleBlock(`OI & FEE DASHBOARD — ${mkt.symbol}`));
        lines.push('');
        lines.push(theme.pair('Current Price', formatPrice(mkt.price)));
        lines.push('');
        lines.push(`  ${theme.section('Open Interest')}`);
        lines.push(theme.pair('Total OI', formatUsd(totalOi)));
        lines.push(theme.pair('Long OI', `${formatUsd(mkt.openInterestLong)}  (${longPct.toFixed(0)}%)`));
        lines.push(theme.pair('Short OI', `${formatUsd(mkt.openInterestShort)}  (${shortPct.toFixed(0)}%)`));

        if (Math.abs(imbalance) > 5) {
          const direction = imbalance > 0 ? 'long-heavy' : 'short-heavy';
          const color = imbalance > 0 ? theme.positive : theme.negative;
          lines.push(theme.pair('Imbalance', color(`${Math.abs(imbalance).toFixed(1)}% ${direction}`)));
        } else {
          lines.push(theme.pair('Imbalance', theme.dim('balanced')));
        }

        // Fee accrual from positions (if user has positions in this market)
        lines.push('');
        lines.push(`  ${theme.section('Fee Structure')}`);
        lines.push(theme.dim('  Flash Trade uses borrow/lock fees, not periodic funding rates.'));
        lines.push(theme.dim('  Fees accrue as unsettledFeesUsd on each position.'));

        // Try to show actual fee rates from CustodyAccount
        try {
          const { PoolConfig } = await import('flash-sdk');
          const { getPoolForMarket: gp } = await import('../config/index.js');
          const poolName = gp(mkt.symbol);
          if (poolName) {
            const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
            const custodies = pc.custodies as Array<{ custodyAccount: any; symbol: string }>;
            const custody = custodies.find(c => c.symbol.toUpperCase() === mkt.symbol.toUpperCase());
            if (custody) {
              const perpClient = (context.flashClient as any).perpClient;
              if (perpClient) {
                const RATE_POWER = 1_000_000_000;
                const custodyAcct = await perpClient.program.account.custody.fetch(custody.custodyAccount);
                const openFee = parseFloat(custodyAcct.fees.openPosition.toString()) / RATE_POWER * 100;
                const closeFee = parseFloat(custodyAcct.fees.closePosition.toString()) / RATE_POWER * 100;
                lines.push('');
                lines.push(theme.pair('Open Fee', `${openFee.toFixed(4)}%`));
                lines.push(theme.pair('Close Fee', `${closeFee.toFixed(4)}%`));
              }
            }
          }
        } catch {
          // Fee rate fetch is best-effort
        }

        lines.push('');
        lines.push(theme.dim('  Source: fstats (OI) | Flash SDK (fee rates)'));
        lines.push('');
      } else {
        // Multi-market overview
        lines.push(theme.titleBlock('OI IMBALANCE'));
        lines.push('');

        // Sort by total OI descending
        const sorted = [...targetMarkets].sort((a, b) =>
          (b.openInterestLong + b.openInterestShort) - (a.openInterestLong + a.openInterestShort)
        );

        const headers = ['Market', 'Long OI', 'Short OI', 'Total OI', 'L/S Ratio', 'Bias'];
        const rows = sorted.map(m => {
          const totalOi = m.openInterestLong + m.openInterestShort;
          const longPct = totalOi > 0 ? (m.openInterestLong / totalOi) * 100 : 50;
          const ratio = totalOi > 0
            ? `${longPct.toFixed(0)}/${(100 - longPct).toFixed(0)}`
            : 'N/A';
          const imbalance = longPct - 50;
          let bias = theme.dim('balanced');
          if (imbalance > 10) bias = theme.positive('LONG');
          else if (imbalance < -10) bias = theme.negative('SHORT');
          return [
            chalk.bold(m.symbol),
            formatUsd(m.openInterestLong),
            formatUsd(m.openInterestShort),
            formatUsd(totalOi),
            ratio,
            bias,
          ];
        });

        lines.push(formatTable(headers, rows));
        lines.push('');
        lines.push(theme.dim('  Flash Trade uses borrow/lock fees, not periodic funding rates.'));
        lines.push(theme.dim('  Source: fstats (OI data)'));
        lines.push('');
      }

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Market data unavailable: ${getErrorMessage(error)}\n`) };
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
      const marketFilter = params.market ? resolveMarket(String(params.market)) : undefined;
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
        const longOi = oi?.longOi ?? mkt.openInterestLong;
        const shortOi = oi?.shortOi ?? mkt.openInterestShort;
        const totalOi = longOi + shortOi;
        const longPct = totalOi > 0 ? (longOi / totalOi) * 100 : 50;
        const shortPct = totalOi > 0 ? 100 - longPct : 50;

        lines.push(theme.titleBlock(`LIQUIDITY OVERVIEW — ${mkt.symbol}`));
        lines.push('');
        lines.push(theme.pair('Price', formatPrice(price)));
        lines.push(theme.pair('Open Interest', formatUsd(totalOi)));
        lines.push(theme.pair('  Long OI', `${formatUsd(longOi)} (${longPct.toFixed(1)}%)`));
        lines.push(theme.pair('  Short OI', `${formatUsd(shortOi)} (${shortPct.toFixed(1)}%)`));
        lines.push(theme.pair('Long / Short', `${longPct.toFixed(0)} / ${shortPct.toFixed(0)}`));
        lines.push('');
        lines.push(theme.dim('  Orderbook depth unavailable for this perpetual market.'));
        lines.push(theme.dim('  Flash Trade uses pool-based liquidity, not an orderbook.'));
        lines.push('');
      }

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
      const { getProtocolStatsService } = await import('../data/protocol-stats.js');
      const pss = getProtocolStatsService(context.dataClient);
      const stats = await pss.getStats();

      // RPC latency
      let rpcLatency = 'N/A';
      let blockHeight = 'N/A';
      try {
        const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
        const rpcMgr = getRpcManagerInstance();
        if (rpcMgr) {
          const lat = rpcMgr.activeLatencyMs;
          rpcLatency = lat >= 0 ? `${lat}ms` : 'N/A';
          const slot = rpcMgr.activeSlot > 0 ? rpcMgr.activeSlot : await rpcMgr.connection.getSlot('confirmed');
          if (Number.isFinite(slot)) blockHeight = slot.toLocaleString();
        }
      } catch { /* non-critical */ }

      // Top markets by OI
      const top5 = stats.marketsByOI.filter(m => m.total > 0).slice(0, 5);

      const dataAge = pss.getDataAge();
      const freshnessStr = dataAge >= 0
        ? (dataAge > DATA_STALENESS_WARNING_SECONDS
          ? chalk.yellow(`  ⚠ Data updated: ${dataAge}s ago — protocol data may be stale`)
          : theme.dim(`  Data updated: ${dataAge}s ago`))
        : '';

      const lines: string[] = [
        theme.titleBlock('FLASH PROTOCOL HEALTH'),
        '',
        `  ${theme.section('Protocol Overview')}`,
        theme.pair('Active Markets', stats.activeMarkets.toString()),
        theme.pair('Open Interest', formatUsd(stats.totalOpenInterest)),
        theme.pair('Long/Short Ratio', `${theme.positive(stats.longPct + '%')} / ${theme.negative(stats.shortPct + '%')}`),
        '',
      ];

      // 30d stats
      if (stats.volume30d > 0 || stats.trades30d > 0) {
        lines.push(`  ${theme.section('Activity (30d)')}`);
        lines.push(theme.pair('Volume', formatUsd(stats.volume30d)));
        lines.push(theme.pair('Trades', stats.trades30d.toLocaleString()));
        lines.push(theme.pair('Unique Traders', stats.traders30d.toLocaleString()));
        lines.push(theme.pair('Fees Collected', formatUsd(stats.fees30d)));
        lines.push('');
      }

      // Top markets
      if (top5.length > 0) {
        lines.push(`  ${theme.section('Top Markets by OI')}`);
        for (const m of top5) {
          const pct = stats.totalOpenInterest > 0 ? ((m.total / stats.totalOpenInterest) * 100).toFixed(1) : '0';
          lines.push(`    ${m.market.padEnd(10)} ${formatUsd(m.total).padEnd(14)} ${theme.dim(`(${pct}%)`)}`);
        }
        lines.push('');
      }

      // Infrastructure
      lines.push(`  ${theme.section('Infrastructure')}`);
      lines.push(theme.pair('RPC Latency', rpcLatency));
      lines.push(theme.pair('Block Height', blockHeight));
      lines.push('');
      if (freshnessStr) lines.push(freshnessStr);
      lines.push('');

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Protocol health data unavailable: ${getErrorMessage(error)}\n`) };
    }
  },
};

// ─── system_audit ────────────────────────────────────────────────────────────

const systemAuditTool: ToolDefinition = {
  name: 'system_audit',
  description: 'Verify protocol data integrity across all subsystems',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const lines: string[] = [
      theme.titleBlock('SYSTEM AUDIT'),
      '',
    ];

    let passCount = 0;
    let failCount = 0;

    const pass = (msg: string) => { passCount++; lines.push(theme.positive(`  ✔ ${msg}`)); };
    const fail = (msg: string) => { failCount++; lines.push(theme.negative(`  ✘ ${msg}`)); };

    // 1. Fee engine vs on-chain custody
    lines.push(`  ${theme.section('Fee Engine')}`);
    const testMarkets = ['SOL', 'BTC', 'ETH'];
    for (const market of testMarkets) {
      try {
        const rates = await getProtocolFeeRates(market, context.simulationMode ? null : (context.flashClient as any).perpClient ?? null);
        if (rates.source === 'on-chain') {
          pass(`${market}: on-chain (open=${(rates.openFeeRate * 100).toFixed(4)}%, close=${(rates.closeFeeRate * 100).toFixed(4)}%)`);
        } else {
          fail(`${market}: using sdk-default fallback (not on-chain)`);
        }
      } catch (e) {
        fail(`${market}: ${getErrorMessage(e)}`);
      }
    }
    lines.push('');

    // 2. Protocol statistics consistency
    lines.push(`  ${theme.section('Protocol Statistics')}`);
    try {
      const { getProtocolStatsService } = await import('../data/protocol-stats.js');
      const pss = getProtocolStatsService(context.dataClient);
      const stats = await pss.getStats();
      if (stats.activeMarkets > 0) {
        pass(`Active markets: ${stats.activeMarkets}`);
      } else {
        fail('No active markets detected');
      }
      if (stats.totalOpenInterest > 0) {
        pass(`Total OI: ${formatUsd(stats.totalOpenInterest)}`);
      } else {
        fail('No open interest data');
      }
      const lsSum = stats.longPct + stats.shortPct;
      if (lsSum >= 99 && lsSum <= 101) {
        pass(`Long/Short split: ${stats.longPct}%/${stats.shortPct}% (sums to ${lsSum}%)`);
      } else {
        fail(`Long/Short split doesn't sum to 100: ${lsSum}%`);
      }
    } catch (e) {
      fail(`Stats service: ${getErrorMessage(e)}`);
    }
    lines.push('');

    // 3. Cache synchronization
    lines.push(`  ${theme.section('Cache Sync')}`);
    try {
      const { getProtocolStatsService } = await import('../data/protocol-stats.js');
      const pss = getProtocolStatsService(context.dataClient);
      const dataAge = pss.getDataAge();
      if (dataAge >= 0 && dataAge < 30) {
        pass(`Protocol stats cache age: ${dataAge}s`);
      } else if (dataAge >= 30) {
        fail(`Protocol stats cache stale: ${dataAge}s`);
      } else {
        pass('Protocol stats not yet cached (will fetch on demand)');
      }
    } catch {
      fail('Cache check failed');
    }
    lines.push('');

    // 4. Position data integrity
    lines.push(`  ${theme.section('Position Data')}`);
    try {
      const positions = await context.flashClient.getPositions();
      if (positions.length === 0) {
        pass('No open positions (nothing to validate)');
      } else {
        let posValid = true;
        for (const p of positions) {
          if (!Number.isFinite(p.entryPrice) || p.entryPrice <= 0) {
            fail(`${p.market}: invalid entry price ${p.entryPrice}`);
            posValid = false;
          }
          if (!Number.isFinite(p.sizeUsd) || p.sizeUsd <= 0) {
            fail(`${p.market}: invalid size ${p.sizeUsd}`);
            posValid = false;
          }
          if (!Number.isFinite(p.collateralUsd) || p.collateralUsd <= 0) {
            fail(`${p.market}: invalid collateral ${p.collateralUsd}`);
            posValid = false;
          }
          if (p.totalFees < 0) {
            fail(`${p.market}: negative fees ${p.totalFees}`);
            posValid = false;
          }
        }
        if (posValid) {
          pass(`All ${positions.length} position(s) pass integrity checks`);
        }
      }
    } catch (e) {
      fail(`Position fetch: ${getErrorMessage(e)}`);
    }
    lines.push('');

    // 5. Custody parsing
    lines.push(`  ${theme.section('Custody Accounts')}`);
    try {
      const { RATE_POWER, BPS_POWER } = await import('../utils/protocol-fees.js');
      if (RATE_POWER === 1_000_000_000 && BPS_POWER === 10_000) {
        pass('RATE_POWER=1e9, BPS_POWER=10000 — matches Flash SDK');
      } else {
        fail(`Constant mismatch: RATE_POWER=${RATE_POWER}, BPS_POWER=${BPS_POWER}`);
      }
    } catch {
      fail('Could not verify custody constants');
    }
    lines.push('');

    // Summary
    lines.push(`  ${theme.separator(40)}`);
    lines.push('');
    lines.push(`  ${theme.dim('Pass:')} ${theme.positive(String(passCount))}  ${theme.dim('Fail:')} ${failCount > 0 ? theme.negative(String(failCount)) : theme.dim('0')}`);
    lines.push('');

    if (failCount === 0) {
      lines.push(theme.positive('  All systems verified.'));
    } else {
      lines.push(theme.warning(`  ${failCount} check(s) failed. Review details above.`));
    }
    lines.push('');

    return { success: failCount === 0, message: lines.join('\n') };
  },
};

// ─── tx_metrics ──────────────────────────────────────────────────────────────

const txMetricsTool: ToolDefinition = {
  name: 'tx_metrics',
  description: 'Show ultra-TX engine performance metrics',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const { getUltraTxEngine } = await import('../core/ultra-tx-engine.js');
    const engine = getUltraTxEngine();
    if (!engine) {
      return { success: false, message: 'Ultra-TX engine not initialized (simulation mode or no wallet connected).' };
    }

    const s = engine.getMetricsSummary();
    if (s.totalTxs === 0) {
      return { success: true, message: theme.titleBlock('TX ENGINE METRICS') + '\n\n  No transactions recorded yet.\n' };
    }

    const lines = [
      theme.titleBlock('TX ENGINE METRICS'),
      '',
      theme.pair('Transactions', String(s.totalTxs)),
      theme.pair('Avg Total Latency', `${s.avgTotalLatencyMs}ms`),
      theme.pair('Avg Confirm Time', `${s.avgConfirmLatencyMs}ms`),
      theme.pair('P50 Confirm', `${s.p50ConfirmMs}ms`),
      theme.pair('P95 Confirm', `${s.p95ConfirmMs}ms`),
      theme.pair('Avg Blockhash Fetch', s.avgBlockhashLatencyMs === 0 ? 'pre-cached' : `${s.avgBlockhashLatencyMs}ms`),
      theme.pair('Avg Build Time', `${s.avgBuildTimeMs}ms`),
      theme.pair('WS Confirmation', `${s.wsConfirmPct}%`),
      theme.pair('Avg Broadcast Endpoints', `${s.avgBroadcastCount}`),
      theme.pair('Avg Rebroadcasts', `${s.avgRebroadcastCount}`),
      '',
      theme.titleBlock('LEADER ROUTING'),
      '',
      theme.pair('Leader Routed', `${s.leaderRoutedPct}%`),
      theme.pair('Avg Slot Delay', s.avgSlotDelay > 0 ? `${s.avgSlotDelay} slots` : 'n/a'),
      theme.pair('Fastest Endpoint', s.fastestEndpoint ?? 'n/a'),
      '',
    ];

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
  liquidationMapTool,
  fundingDashboardTool,
  liquidityDepthTool,
  protocolHealthTool,
  inspectProtocol,
  inspectPool,
  inspectMarketTool,
  systemStatusTool,
  protocolStatusTool,
  rpcStatusTool,
  rpcTestTool,
  txInspectTool,
  txDebugTool,
  tradeHistoryTool,
  systemAuditTool,
  txMetricsTool,
];
