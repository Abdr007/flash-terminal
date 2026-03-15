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
  formatPercent,
  colorPnl,
  colorPercent,
  colorSide,
  formatTable,
  shortAddress,
  humanizeSdkError,
  padVisible,
  padVisibleStart,
} from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { getProtocolFeeRates, calcFeeUsd, ProtocolParameterError } from '../utils/protocol-fees.js';
import { DATA_STALENESS_WARNING_SECONDS } from '../core/risk-config.js';
import { filterValidPositions } from '../core/invariants.js';
import { getSigningGuard } from '../security/signing-guard.js';
import { getTradingGate } from '../security/trading-gate.js';
import { getCircuitBreaker } from '../security/circuit-breaker.js';
import {
  logKillSwitchBlock,
  logExposureBlock,
  logCircuitBreakerBlock,
  logTradeStart,
  logTradeSuccess,
  logTradeFailure,
} from '../observability/trade-events.js';
import { updateLastWallet, clearLastWallet } from '../wallet/session.js';
import { getShadowEngine } from '../shadow/shadow-engine.js';
import { logShadowTrade } from '../observability/shadow-events.js';
import { getTradeJournal } from '../journal/trade-journal.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { resolveMarket } from '../utils/market-resolver.js';

// ─── Trade Helpers (extracted to trade-helpers.ts) ──────────────────────────

import {
  buildRiskPreview,
  buildPositionPreview,
  validateLiveTradeContext,
  buildLiveTradeWarnings,
} from './trade-helpers.js';

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
    takeProfit: z.number().positive().optional(),
    stopLoss: z.number().positive().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side, collateral, leverage, collateral_token, takeProfit, stopLoss } = params as {
      market: string;
      side: TradeSide;
      collateral: number;
      leverage: number;
      collateral_token?: string;
      takeProfit?: number;
      stopLoss?: number;
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

    // ── Trading Gate: Kill Switch ──
    const gate = getTradingGate();
    const killCheck = gate.checkKillSwitch();
    if (!killCheck.allowed) {
      logKillSwitchBlock(market, side);
      return { success: false, message: chalk.red(`  ${killCheck.reason}`) };
    }

    // ── Trading Gate: Exposure Check ──
    const exposureCheck = await gate.checkExposure(sizeUsd, context.flashClient);
    if (!exposureCheck.allowed) {
      logExposureBlock(market, side, sizeUsd, 0, gate.maxPortfolioExposure);
      return { success: false, message: chalk.red(`  ${exposureCheck.reason}`) };
    }

    // ── Circuit Breaker ──
    const breaker = getCircuitBreaker();
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      logCircuitBreakerBlock(market, side, breakerCheck.reason ?? 'unknown');
      return { success: false, message: chalk.red(`  ${breakerCheck.reason}`) };
    }

    const guard = getSigningGuard();
    const walletAddr = context.walletAddress ?? 'unknown';

    // Fetch fee rate from CustodyAccount via Flash SDK (cached, 60s TTL)
    const perpClient = context.simulationMode ? null : (context.flashClient as unknown as Record<string, unknown>).perpClient ?? null;
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

    // Show TP/SL targets in confirmation summary if provided inline
    if (takeProfit !== undefined || stopLoss !== undefined) {
      lines.push('');
      if (takeProfit !== undefined) lines.push(`  Take Profit: ${chalk.green('$' + takeProfit.toFixed(2))}`);
      if (stopLoss !== undefined) lines.push(`  Stop Loss:   ${chalk.red('$' + stopLoss.toFixed(2))}`);
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
          logTradeStart('open', market, side, { collateral, leverage, sizeUsd });
          // Journal: record pending BEFORE broadcast
          const journal = getTradeJournal();
          const journalId = journal.recordPending({ market, side: side.toString(), action: 'open', collateral, leverage, sizeUsd });
          try {
            // Use atomic method when TP/SL are provided (single transaction)
            const useAtomic = (takeProfit !== undefined || stopLoss !== undefined)
              && context.flashClient.openPositionAtomic
              && !context.simulationMode;

            const result = useAtomic
              ? await context.flashClient.openPositionAtomic!(
                  market, side, collateral, leverage, collateral_token,
                  takeProfit, stopLoss,
                )
              : await context.flashClient.openPosition(
                  market, side, collateral, leverage, collateral_token,
                );

            // Journal: mark confirmed and remove
            journal.recordSent(journalId, result.txSignature);
            journal.recordConfirmed(journalId);
            journal.remove(journalId);

            // Record trade open in circuit breaker
            getCircuitBreaker().recordOpen();

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

            logTradeSuccess('open', market, side, { txSignature: result.txSignature, entryPrice: result.entryPrice, sizeUsd: actualSize });

            // Shadow trade — fire-and-forget, completely isolated
            try {
              const shadowResult = await getShadowEngine().shadowOpen(market, side, collateral, leverage);
              if (shadowResult) logShadowTrade(shadowResult);
            } catch { /* shadow must never affect live pipeline */ }

            // TP/SL display lines
            const tpSlLines: string[] = [];
            const atomicIncluded = (result as unknown as Record<string, unknown>).triggerOrdersIncluded === true;

            if (atomicIncluded) {
              // TP/SL were included in the atomic transaction
              if (takeProfit !== undefined) {
                tpSlLines.push(`  Take Profit:       ${chalk.green('$' + takeProfit.toFixed(2))} ${chalk.dim('(on-chain, atomic)')}`);
              }
              if (stopLoss !== undefined) {
                tpSlLines.push(`  Stop Loss:         ${chalk.red('$' + stopLoss.toFixed(2))} ${chalk.dim('(on-chain, atomic)')}`);
              }
            } else if (takeProfit !== undefined || stopLoss !== undefined) {
              // Sequential fallback — place TP/SL as separate transactions
              const client = context.flashClient;
              if (client.placeTriggerOrder && !context.simulationMode) {
                if (takeProfit !== undefined) {
                  try {
                    await client.placeTriggerOrder(market, side, takeProfit, false);
                    tpSlLines.push(`  Take Profit:       ${chalk.green('$' + takeProfit.toFixed(2))} ${chalk.dim('(on-chain)')}`);
                  } catch { /* TP is non-critical */ }
                }
                if (stopLoss !== undefined) {
                  try {
                    await client.placeTriggerOrder(market, side, stopLoss, true);
                    tpSlLines.push(`  Stop Loss:         ${chalk.red('$' + stopLoss.toFixed(2))} ${chalk.dim('(on-chain)')}`);
                  } catch { /* SL is non-critical */ }
                }
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
                ...tpSlLines,
                `  TX: ${chalk.dim(txLink)}`,
                '',
              ].join('\n'),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            // Journal: remove on failure (trade did not land)
            journal.remove(journalId);
            logTradeFailure('open', market, side, getErrorMessage(error));
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
  description: 'Close an existing trading position (full or partial)',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    closePercent: z.number().min(1).max(100).optional(),
    closeAmount: z.number().positive().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side, closePercent, closeAmount } = params as {
      market: string; side: TradeSide; closePercent?: number; closeAmount?: number;
    };

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

    // ── Trading Gate: Kill Switch ──
    const gate = getTradingGate();
    const killCheck = gate.checkKillSwitch();
    if (!killCheck.allowed) {
      logKillSwitchBlock(market, side);
      return { success: false, message: chalk.red(`  ${killCheck.reason}`) };
    }

    // ── Circuit Breaker ──
    const breaker = getCircuitBreaker();
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      logCircuitBreakerBlock(market, side, breakerCheck.reason ?? 'unknown');
      return { success: false, message: chalk.red(`  ${breakerCheck.reason}`) };
    }

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

    // Pre-check: verify position exists and validate partial close
    try {
      const positions = await context.flashClient.getPositions();
      const pos = positions.find(p =>
        (p.market ?? '').toUpperCase() === market.toUpperCase() && p.side === side,
      );
      if (!pos) {
        return { success: false, message: chalk.red(`  No open ${side} position on ${market}.`) };
      }
      const positionSizeUsd = pos.sizeUsd;

      // Validate partial close amount
      if (closePercent !== undefined) {
        if (closePercent > 100) {
          return { success: false, message: chalk.red(`  Close percentage cannot exceed 100%.`) };
        }
      }
      if (closeAmount !== undefined && closeAmount > positionSizeUsd) {
        return { success: false, message: chalk.red(`  Close amount $${closeAmount.toFixed(2)} exceeds position size $${positionSizeUsd.toFixed(2)}.`) };
      }
    } catch {
      // Non-critical: let the close attempt handle the error
    }

    // Build close description
    const isPartialClose = (closePercent !== undefined && closePercent < 100) || closeAmount !== undefined;
    let closeDesc = 'Full Close';
    if (closePercent !== undefined && closePercent < 100) {
      closeDesc = `Partial Close — ${closePercent}%`;
    } else if (closeAmount !== undefined) {
      closeDesc = `Partial Close — $${closeAmount.toFixed(2)}`;
    }

    // Position details for close confirmation
    const posLines = await buildPositionPreview(context, market, side);
    const titleLabel = isPartialClose ? 'Partial Close Position' : 'Close Position';
    const closeLines = [
      '',
      isLive ? chalk.red.bold(`  CONFIRM TRANSACTION — ${titleLabel}`) : chalk.yellow(`  CONFIRM TRANSACTION — ${titleLabel}`),
      chalk.dim('  ─────────────────────────────────'),
      `  Market:  ${chalk.bold(market)} ${colorSide(side)}`,
      `  Pool:    ${chalk.cyan(pool)}`,
      `  Action:  ${chalk.bold(closeDesc)}`,
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
          logTradeStart('close', market, side);
          const journal = getTradeJournal();
          const journalId = journal.recordPending({ market, side: side.toString(), action: 'close' });
          try {
            const result = await context.flashClient.closePosition(
              market, side, undefined, closePercent, closeAmount
            );

            // Journal: confirmed
            journal.recordSent(journalId, result.txSignature);
            journal.recordConfirmed(journalId);
            journal.remove(journalId);

            // Record PnL in circuit breaker
            if (Number.isFinite(result.pnl)) {
              getCircuitBreaker().recordTrade(result.pnl);
            }

            guard.recordSigning();
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: result.isPartial ? 'partial_close' : 'close', market, side,
              walletAddress: walletAddr,
              result: 'confirmed',
            });

            // Log session trade
            if (context.sessionTrades) {
              if (context.sessionTrades.length >= 500) context.sessionTrades.shift();
              context.sessionTrades.push({
                action: result.isPartial ? 'partial_close' : 'close', market, side,
                exitPrice: result.exitPrice, pnl: result.pnl,
                txSignature: result.txSignature, timestamp: Date.now(),
              });
            }

            const pnlStr = result.pnl !== undefined ? `  PnL: ${colorPnl(result.pnl)}\n` : '';
            const txLink = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            const tradeType = result.isPartial ? 'partial_close' : 'close';
            logTradeSuccess(tradeType, market, side, { txSignature: result.txSignature, exitPrice: result.exitPrice, pnl: result.pnl });

            // Shadow trade — fire-and-forget, completely isolated
            if (!result.isPartial) {
              try {
                const shadowResult = await getShadowEngine().shadowClose(market, side);
                if (shadowResult) logShadowTrade(shadowResult);
              } catch { /* shadow must never affect live pipeline */ }
            }

            // Build output message
            const outputLines = [''];
            if (result.isPartial) {
              outputLines.push(chalk.green('  Partial Close Executed'));
              outputLines.push(chalk.dim('  ─────────────────'));
              outputLines.push(`  Market:     ${chalk.bold(market)} ${colorSide(side)}`);
              outputLines.push(`  Closed:     ${formatUsd(result.closedSizeUsd ?? 0)}`);
              outputLines.push(`  Remaining:  ${formatUsd(result.remainingSizeUsd ?? 0)}`);
              outputLines.push(`  Exit Price: ${formatPrice(result.exitPrice)}`);
              if (pnlStr) outputLines.push(pnlStr.trimEnd());
              outputLines.push(`  TX: ${chalk.dim(txLink)}`);
            } else {
              outputLines.push(chalk.green('  Position Closed'));
              outputLines.push(chalk.dim('  ─────────────────'));
              outputLines.push(`  Exit Price: ${formatPrice(result.exitPrice)}`);
              if (pnlStr) outputLines.push(pnlStr.trimEnd());
              outputLines.push(`  TX: ${chalk.dim(txLink)}`);
            }
            outputLines.push('');

            return {
              success: true,
              message: outputLines.join('\n'),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            journal.remove(journalId);
            logTradeFailure('close', market, side, getErrorMessage(error));
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

    // ── Trading Gate: Kill Switch ──
    const gate = getTradingGate();
    const killCheck = gate.checkKillSwitch();
    if (!killCheck.allowed) {
      logKillSwitchBlock(market, side);
      return { success: false, message: chalk.red(`  ${killCheck.reason}`) };
    }

    // ── Circuit Breaker ──
    const breaker = getCircuitBreaker();
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      logCircuitBreakerBlock(market, side, breakerCheck.reason ?? 'unknown');
      return { success: false, message: chalk.red(`  ${breakerCheck.reason}`) };
    }

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
          const journal = getTradeJournal();
          const journalId = journal.recordPending({ market, side: side.toString(), action: 'add_collateral', collateral: amount });
          try {
            const result = await context.flashClient.addCollateral(market, side, amount);
            journal.recordSent(journalId, result.txSignature);
            journal.recordConfirmed(journalId);
            journal.remove(journalId);
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

            // Shadow trade — fire-and-forget, completely isolated
            try {
              const shadowResult = await getShadowEngine().shadowAddCollateral(market, side, amount);
              if (shadowResult) logShadowTrade(shadowResult);
            } catch { /* shadow must never affect live pipeline */ }

            const txDisplay = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: chalk.green(`  Collateral added. TX: ${chalk.dim(txDisplay)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            journal.remove(journalId);
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

    // ── Trading Gate: Kill Switch ──
    const gate = getTradingGate();
    const killCheck = gate.checkKillSwitch();
    if (!killCheck.allowed) {
      logKillSwitchBlock(market, side);
      return { success: false, message: chalk.red(`  ${killCheck.reason}`) };
    }

    // ── Circuit Breaker ──
    const breaker = getCircuitBreaker();
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      logCircuitBreakerBlock(market, side, breakerCheck.reason ?? 'unknown');
      return { success: false, message: chalk.red(`  ${breakerCheck.reason}`) };
    }

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
          const journal = getTradeJournal();
          const journalId = journal.recordPending({ market, side: side.toString(), action: 'remove_collateral', collateral: amount });
          try {
            const result = await context.flashClient.removeCollateral(market, side, amount);
            journal.recordSent(journalId, result.txSignature);
            journal.recordConfirmed(journalId);
            journal.remove(journalId);
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

            // Shadow trade — fire-and-forget, completely isolated
            try {
              const shadowResult = await getShadowEngine().shadowRemoveCollateral(market, side, amount);
              if (shadowResult) logShadowTrade(shadowResult);
            } catch { /* shadow must never affect live pipeline */ }

            const txDisplay = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: chalk.green(`  Collateral removed. TX: ${chalk.dim(txDisplay)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            journal.remove(journalId);
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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

const walletStore = new WalletStore();

export const walletImport: ToolDefinition = {
  name: 'wallet_import',
  description: 'Register a wallet from a keypair JSON file path (no key material stored)',
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
          `  ${chalk.cyan('wallet import <name> <path>')}`,
          chalk.dim('  wallet import main ~/.config/solana/id.json'),
          '',
          chalk.dim('  Only the file path is stored — your private key is never copied.'),
          '',
        ].join('\n'),
      };
    }

    try {
      const result = walletStore.registerWallet(name, path);

      // Auto-set as default
      walletStore.setDefault(name);

      // Auto-connect the wallet directly from the original file
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
        `  Path:    ${chalk.dim(result.path)}`,
        `  Address: ${chalk.cyan(result.address)}`,
        '',
        chalk.dim('  No key material stored by Flash Terminal.'),
        '',
      ];

      if (canSign) {
        lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
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
      chalk.bold('  Registered Wallets'),
      chalk.dim('  ─────────────────'),
    ];

    for (const name of wallets) {
      const isDefault = name === defaultName;
      const tag = isDefault ? chalk.green(' (default)') : '';
      lines.push(`  ${chalk.bold(name)}${tag}`);
      try {
        const entry = walletStore.getWalletEntry(name);
        lines.push(chalk.dim(`    ${entry.path}`));
      } catch { /* skip */ }
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
  description: 'Remove a registered wallet (does not delete the keypair file)',
  parameters: z.object({
    name: z.string(),
  }),
  execute: async (params): Promise<ToolResult> => {
    const { name } = params as { name: string };
    try {
      walletStore.removeWallet(name);
      return {
        success: true,
        message: [
          chalk.green(`  Wallet "${name}" removed.`),
          chalk.dim('  Your keypair file was not deleted.'),
        ].join('\n'),
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

    lines.push(theme.pair('Registered', `${storedCount} wallet(s)`));
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
        const decimals = t.symbol === 'USDC' || t.symbol === 'USDT' ? 2 : t.amount >= 1000 ? 2 : 4;
        lines.push(theme.pair(t.symbol, theme.positive(`${t.amount.toFixed(decimals)} ${t.symbol}`)));
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
  execute: async (_params, _context): Promise<ToolResult> => {
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
        const perpClient = (context?.flashClient as unknown as Record<string, unknown>)?.perpClient;
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

// ─── Trade Lifecycle Aggregation ─────────────────────────────────────────────

interface AggregatedTrade {
  timestamp: number;
  market: string;
  side: string;
  leverage: number;
  entryPrice: number;
  exitPrice?: number;
  sizeUsd: number;
  collateral: number;
  pnl?: number;
  closed: boolean;
  closeReason?: string;
}

/**
 * Aggregate raw trade events into lifecycle trade records.
 * Events are processed chronologically; OPEN creates a record,
 * ADD/REMOVE_COLLATERAL adjusts it, CLOSE finalizes it.
 */
function aggregateTradeEvents(events: Array<{
  action: string;
  market: string;
  side: string;
  leverage?: number;
  collateral?: number;
  collateralUsd?: number;
  sizeUsd?: number;
  entryPrice?: number;
  exitPrice?: number;
  price?: number;
  pnl?: number;
  closeReason?: string;
  timestamp: number;
}>): AggregatedTrade[] {
  const active = new Map<string, AggregatedTrade>();
  const completed: AggregatedTrade[] = [];

  // Process in chronological order
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  for (const ev of sorted) {
    const market = (ev.market ?? '').toUpperCase();
    const side = (ev.side ?? '').toLowerCase();
    const key = `${market}-${side}`;

    if (ev.action === 'open') {
      // If there's already an active trade for this key, push it as-is (orphaned open)
      const existing = active.get(key);
      if (existing) completed.push(existing);

      active.set(key, {
        timestamp: ev.timestamp,
        market,
        side,
        leverage: ev.leverage ?? (ev.collateralUsd && ev.sizeUsd ? ev.sizeUsd / ev.collateralUsd : 0),
        entryPrice: ev.entryPrice ?? ev.price ?? 0,
        sizeUsd: ev.sizeUsd ?? 0,
        collateral: ev.collateral ?? ev.collateralUsd ?? 0,
        closed: false,
      });
    } else if (ev.action === 'add_collateral') {
      const trade = active.get(key);
      if (trade) {
        trade.collateral += ev.collateral ?? ev.collateralUsd ?? 0;
        if (trade.collateral > 0) trade.leverage = trade.sizeUsd / trade.collateral;
      }
    } else if (ev.action === 'remove_collateral') {
      const trade = active.get(key);
      if (trade) {
        trade.collateral -= ev.collateral ?? ev.collateralUsd ?? 0;
        if (trade.collateral > 0) trade.leverage = trade.sizeUsd / trade.collateral;
      }
    } else if (ev.action === 'close') {
      const trade = active.get(key);
      if (trade) {
        trade.exitPrice = ev.exitPrice ?? ev.price;
        trade.pnl = ev.pnl;
        trade.closeReason = ev.closeReason;
        trade.closed = true;
        completed.push(trade);
        active.delete(key);
      } else {
        // Close without matching open (position opened before session)
        completed.push({
          timestamp: ev.timestamp,
          market,
          side,
          leverage: 0,
          entryPrice: ev.entryPrice ?? 0,
          exitPrice: ev.exitPrice ?? ev.price,
          sizeUsd: ev.sizeUsd ?? 0,
          collateral: ev.collateral ?? ev.collateralUsd ?? 0,
          pnl: ev.pnl,
          closeReason: ev.closeReason,
          closed: true,
        });
      }
    }
  }

  // Remaining active trades (still open)
  for (const trade of active.values()) {
    completed.push(trade);
  }

  // Sort by open timestamp (most recent first for display)
  return completed.sort((a, b) => b.timestamp - a.timestamp);
}

/** Render aggregated trade rows into formatted table lines. */
function renderAggregatedRows(trades: AggregatedTrade[]): string[] {
  const rows: string[] = [];
  for (const t of trades) {
    const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const market = padVisible(t.market, 5);
    const side = padVisible(t.side === 'long' ? theme.long('LONG') : theme.short('SHORT'), 5);
    const lev = padVisible(t.leverage > 0 ? `${Math.round(t.leverage)}x` : theme.dim('—'), 4);
    const entryStr = padVisibleStart(t.entryPrice > 0 ? `$${formatPrice(t.entryPrice)}` : theme.dim('—'), 10);
    const exitStr = padVisibleStart(t.exitPrice !== undefined ? `$${formatPrice(t.exitPrice)}` : theme.dim('—'), 10);
    const sizeStr = padVisibleStart(t.sizeUsd > 0 ? formatUsd(t.sizeUsd) : theme.dim('—'), 8);
    const coll = padVisibleStart(t.collateral > 0 ? formatUsd(t.collateral) : theme.dim('—'), 8);
    const pnlStr = t.pnl !== undefined
      ? padVisibleStart(t.pnl >= 0 ? theme.positive(`+${formatUsd(t.pnl)}`) : theme.negative(formatUsd(t.pnl)), 8)
      : padVisibleStart(theme.dim('—'), 8);
    const reason = t.closeReason
      ? (t.closeReason === 'TAKE_PROFIT' ? theme.positive('TP') : t.closeReason === 'STOP_LOSS' ? theme.negative('SL') : t.closeReason)
      : '';

    rows.push(`  ${time}  ${market}  ${side}  ${lev}  ${entryStr}  ${exitStr}  ${sizeStr}  ${coll}  ${pnlStr}  ${reason}`);
  }
  return rows;
}

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

      const aggregated = aggregateTradeEvents(trades);
      const recent = aggregated.slice(0, 20);
      const lines: string[] = [
        theme.titleBlock('TRADE HISTORY'),
        '',
        theme.dim('  Time       Market  Side   Lev    Entry       Exit       Size     Collateral  PnL     Reason'),
        `  ${theme.separator(104)}`,
        ...renderAggregatedRows(recent),
        '',
        theme.dim(`  Showing ${recent.length} of ${aggregated.length} trade(s)`),
        '',
      ];

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

    const aggregated = aggregateTradeEvents(sessionTrades);
    const recent = aggregated.slice(0, 20);
    const lines: string[] = [
      theme.titleBlock('SESSION TRADE HISTORY'),
      '',
      theme.dim('  Time      Market  Side   Lev       Entry        Exit      Size      Coll       PnL'),
      `  ${theme.separator(88)}`,
      ...renderAggregatedRows(recent),
      '',
      theme.dim(`  ${recent.length} trade(s) this session`),
      theme.dim('  Full history: https://solscan.io'),
      '',
    ];

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
        }).sort((a, b) => (Number(b.size_usd) || 0) - (Number(a.size_usd) || 0));

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
      const oiData = await context.dataClient.getOpenInterest().catch(() => ({ markets: [] as MarketOI[] }));
      for (const mkt of markets) {
        const oiEntry = oiData.markets.find((m) => m.market?.toUpperCase()?.includes(mkt.symbol.toUpperCase()));
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
            const custodies = pc.custodies as Array<{ custodyAccount: unknown; symbol: string }>;
            const custody = custodies.find(c => c.symbol.toUpperCase() === mkt.symbol.toUpperCase());
            if (custody) {
              const perpClient = (context.flashClient as unknown as Record<string, unknown>).perpClient as Record<string, unknown> | undefined;
              if (perpClient) {
                const RATE_POWER = 1_000_000_000;
                const program = (perpClient as Record<string, unknown>).program as Record<string, unknown>;
                const acct = (program.account as Record<string, unknown>).custody as Record<string, unknown>;
                const custodyAcct = await (acct.fetch as (addr: unknown) => Promise<Record<string, unknown>>)(custody.custodyAccount);
                const fees = custodyAcct.fees as Record<string, unknown>;
                const openFee = parseFloat(String(fees.openPosition)) / RATE_POWER * 100;
                const closeFee = parseFloat(String(fees.closePosition)) / RATE_POWER * 100;
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
        const rates = await getProtocolFeeRates(market, context.simulationMode ? null : (context.flashClient as unknown as Record<string, unknown>).perpClient ?? null);
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

    const w = 26; // label width for alignment
    const lines = [
      theme.titleBlock('TX ENGINE METRICS'),
      '',
      theme.pair('Transactions', String(s.totalTxs), w),
      theme.pair('Avg Total Latency', `${s.avgTotalLatencyMs}ms`, w),
      theme.pair('Avg Confirm Time', `${s.avgConfirmLatencyMs}ms`, w),
      theme.pair('P50 Confirm', `${s.p50ConfirmMs}ms`, w),
      theme.pair('P95 Confirm', `${s.p95ConfirmMs}ms`, w),
      theme.pair('Avg Blockhash Fetch', s.avgBlockhashLatencyMs === 0 ? 'pre-cached' : `${s.avgBlockhashLatencyMs}ms`, w),
      theme.pair('Avg Build Time', `${s.avgBuildTimeMs}ms`, w),
      theme.pair('WS Confirmation', `${s.wsConfirmPct}%`, w),
      theme.pair('Avg Broadcast Endpoints', `${s.avgBroadcastCount}`, w),
      theme.pair('Avg Rebroadcasts', `${s.avgRebroadcastCount}`, w),
      '',
      theme.titleBlock('LEADER ROUTING'),
      '',
      theme.pair('Routing Mode', s.leaderRoutedPct > 0 || s.tpuForwardedPct > 0 ? 'Leader Aware' : 'Standard', w),
      theme.pair('Leader Routed', `${s.leaderRoutedPct}%`, w),
      theme.pair('TPU Forwarded', `${s.tpuForwardedPct}%`, w),
      theme.pair('Avg Slot Delay', s.avgSlotDelay > 0 ? `${s.avgSlotDelay} slots` : 'n/a', w),
      theme.pair('Fastest Endpoint', s.fastestEndpoint ? s.fastestEndpoint.replace(/[?&](api[-_]?key|token|secret|auth)=[^&]*/gi, '') .replace(/\/v2\/[a-zA-Z0-9_-]{10,}/, '/v2/***') : 'n/a', w),
      '',
    ];

    return { success: true, message: lines.join('\n') };
  },
};

// ─── TP/SL Tools (On-Chain via Flash SDK) ─────────────────────────────────────

const setTpSlTool: ToolDefinition = {
  name: 'set_tp_sl',
  description: 'Set take-profit or stop-loss for a position (on-chain)',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    type: z.enum(['tp', 'sl']),
    price: z.number().positive(),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { market, side, type, price } = params as {
      market: string; side: TradeSide; type: 'tp' | 'sl'; price: number;
    };

    if (context.simulationMode) {
      return {
        success: false,
        message: '  On-chain TP/SL requires live mode. TP/SL orders are placed on the Flash Trade protocol and require a real wallet.',
      };
    }

    const client = context.flashClient;
    if (!client.placeTriggerOrder) {
      return { success: false, message: '  TP/SL orders are not supported by the current client.' };
    }

    try {
      const isStopLoss = type === 'sl';
      const result = await client.placeTriggerOrder(market, side, price, isStopLoss);
      const label = isStopLoss ? 'Stop-Loss' : 'Take-Profit';
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: [
          '',
          chalk.green(`  ${label} Set (On-Chain)`),
          chalk.dim('  ─────────────────'),
          `  Market:    ${result.market} ${result.side.toUpperCase()}`,
          `  Price:     $${price.toFixed(2)}`,
          chalk.dim(`  TX: ${txLink}`),
          '',
        ].join('\n'),
      };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to set ${type.toUpperCase()}: ${getErrorMessage(err)}` };
    }
  },
};

const removeTpSlTool: ToolDefinition = {
  name: 'remove_tp_sl',
  description: 'Remove take-profit or stop-loss from a position (on-chain)',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    type: z.enum(['tp', 'sl']),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { market, side, type } = params as {
      market: string; side: TradeSide; type: 'tp' | 'sl';
    };

    if (context.simulationMode) {
      return {
        success: false,
        message: '  On-chain TP/SL requires live mode.',
      };
    }

    const client = context.flashClient;
    if (!client.getUserOrders || !client.cancelTriggerOrder) {
      return { success: false, message: '  Cancel trigger orders not supported by the current client.' };
    }

    try {
      const isStopLoss = type === 'sl';
      // Find the order to cancel
      const orders = await client.getUserOrders();
      const targetType = isStopLoss ? 'stop_loss' : 'take_profit';
      const order = orders.find(
        o => o.market === market.toUpperCase() && o.side === side && o.type === targetType
      );
      if (!order) {
        return { success: false, message: `  No ${type.toUpperCase()} order found for ${market} ${side}.` };
      }

      const result = await client.cancelTriggerOrder(market, side, order.orderId, isStopLoss);
      const label = isStopLoss ? 'Stop-Loss' : 'Take-Profit';
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: [
          '',
          chalk.green(`  ${label} Removed (On-Chain)`),
          chalk.dim(`  TX: ${txLink}`),
          '',
        ].join('\n'),
      };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to remove ${type.toUpperCase()}: ${getErrorMessage(err)}` };
    }
  },
};

const tpSlStatusTool: ToolDefinition = {
  name: 'tp_sl_status',
  description: 'Show all active TP/SL targets (on-chain)',
  parameters: z.object({}),
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.simulationMode) {
      return {
        success: true,
        message: [
          '',
          chalk.dim('  On-chain TP/SL requires live mode.'),
          chalk.dim('  In simulation, TP/SL orders are not available.'),
          '',
        ].join('\n'),
      };
    }

    const client = context.flashClient;
    if (!client.getUserOrders) {
      return { success: false, message: '  Order fetching not supported by the current client.' };
    }

    try {
      const orders = await client.getUserOrders();
      const triggerOrders = orders.filter(o => o.type === 'take_profit' || o.type === 'stop_loss');

      if (triggerOrders.length === 0) {
        return {
          success: true,
          message: [
            '',
            chalk.dim('  No active TP/SL targets on-chain.'),
            chalk.dim('  Use "set tp <market> <side> $<price>" to add one.'),
            '',
          ].join('\n'),
        };
      }

      const lines = [
        '',
        `  ${chalk.bold('ON-CHAIN TP/SL TARGETS')}`,
        chalk.dim(`  ${'─'.repeat(44)}`),
        '',
      ];

      // Group by market-side
      const grouped = new Map<string, typeof triggerOrders>();
      for (const o of triggerOrders) {
        const key = `${o.market}-${o.side}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(o);
      }

      for (const [key, ords] of grouped) {
        const [market, side] = key.split('-');
        const tp = ords.find(o => o.type === 'take_profit');
        const sl = ords.find(o => o.type === 'stop_loss');
        const tpStr = tp ? `TP: $${tp.price.toFixed(2)}` : chalk.dim('TP: —');
        const slStr = sl ? `SL: $${sl.price.toFixed(2)}` : chalk.dim('SL: —');
        lines.push(`  ${chalk.bold(`${market} ${side!.toUpperCase()}`)}`);
        lines.push(`    ${tpStr}  |  ${slStr}`);
        lines.push('');
      }

      return { success: true, message: lines.join('\n') };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to fetch TP/SL targets: ${getErrorMessage(err)}` };
    }
  },
};

// ─── Limit Order Tools (On-Chain via Flash SDK) ─────────────────────────────

const limitOrderPlaceTool: ToolDefinition = {
  name: 'limit_order_place',
  description: 'Place a limit order (on-chain)',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    leverage: z.number().min(1).max(100),
    collateral: z.number().positive(),
    limitPrice: z.number().positive(),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { market, side, leverage, collateral, limitPrice } = params as {
      market: string; side: TradeSide; leverage: number; collateral: number; limitPrice: number;
    };

    if (context.simulationMode) {
      return {
        success: false,
        message: '  On-chain limit orders require live mode. Limit orders are placed on the Flash Trade protocol and require a real wallet.',
      };
    }

    const client = context.flashClient;
    if (!client.placeLimitOrder) {
      return { success: false, message: '  Limit orders are not supported by the current client.' };
    }

    try {
      const result = await client.placeLimitOrder(market, side, collateral, leverage, limitPrice);
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: [
          '',
          chalk.green('  Limit Order Placed (On-Chain)'),
          chalk.dim('  ─────────────────────────────'),
          `  Market:       ${result.market} ${result.side.toUpperCase()}`,
          `  Leverage:     ${leverage}x`,
          `  Collateral:   $${collateral.toFixed(2)}`,
          `  Size:         $${result.sizeUsd.toFixed(2)}`,
          `  Limit Price:  $${limitPrice.toFixed(2)}`,
          chalk.dim(`  TX: ${txLink}`),
          '',
          chalk.dim('  This order is on-chain and visible on flash.trade'),
          '',
        ].join('\n'),
      };
    } catch (err: unknown) {
      const errMsg = getErrorMessage(err);
      // Custom:2003 = ConstraintRaw on oracle account — needs Pyth Lazer price update
      if (errMsg.includes('2003') || errMsg.includes('ConstraintRaw') || errMsg.includes('InvalidArgument')) {
        return { success: false, message: [
          '',
          chalk.red('  Limit order failed: oracle constraint.'),
          '',
          chalk.dim('  Flash protocol requires a Pyth Lazer price update for limit orders.'),
          chalk.dim('  This integration is not yet available in the CLI.'),
          '',
          chalk.dim('  Workaround: use the Flash Trade website for limit orders,'),
          chalk.dim('  or use "open" for market orders (which work correctly).'),
          '',
        ].join('\n') };
      }
      return { success: false, message: `  Failed to place limit order: ${errMsg}` };
    }
  },
};

const limitOrderCancelTool: ToolDefinition = {
  name: 'limit_order_cancel',
  description: 'Cancel a limit order (on-chain)',
  parameters: z.object({
    orderId: z.string(),
    market: z.string().optional(),
    side: z.nativeEnum(TradeSide).optional(),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { orderId, market, side } = params as {
      orderId: string; market?: string; side?: TradeSide;
    };

    if (context.simulationMode) {
      return { success: false, message: '  On-chain limit orders require live mode.' };
    }

    const client = context.flashClient;
    if (!client.cancelLimitOrder || !client.getUserOrders) {
      return { success: false, message: '  Cancel limit orders not supported by the current client.' };
    }

    try {
      // Parse orderId — accept "order-1", "1", "#1", etc.
      const idNum = parseInt(orderId.replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(idNum) || idNum < 0) {
        return { success: false, message: `  Invalid order ID: ${orderId}` };
      }

      // If market/side not provided, find from orders
      let cancelMarket = market;
      let cancelSide = side;
      if (!cancelMarket || !cancelSide) {
        const orders = await client.getUserOrders();
        const limitOrders = orders.filter(o => o.type === 'limit');
        // Find by orderId across all markets
        const target = limitOrders.find(o => o.orderId === idNum);
        if (!target) {
          return { success: false, message: `  Limit order #${idNum} not found. Use "orders" to see active orders.` };
        }
        cancelMarket = target.market;
        cancelSide = target.side;
      }

      const result = await client.cancelLimitOrder(cancelMarket, cancelSide, idNum);
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: [
          '',
          chalk.green(`  Limit Order #${idNum} Cancelled`),
          chalk.dim(`  TX: ${txLink}`),
          '',
        ].join('\n'),
      };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to cancel limit order: ${getErrorMessage(err)}` };
    }
  },
};

const limitOrderEditTool: ToolDefinition = {
  name: 'limit_order_edit',
  description: 'Edit a limit order price (on-chain)',
  parameters: z.object({
    orderId: z.number().int().min(0),
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    limitPrice: z.number().positive().optional(),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { orderId, market, side, limitPrice } = params as {
      orderId: number; market: string; side: TradeSide; limitPrice?: number;
    };

    if (context.simulationMode) {
      return { success: false, message: '  On-chain limit orders require live mode.' };
    }

    if (!limitPrice) {
      return { success: false, message: '  New limit price is required.' };
    }

    const client = context.flashClient;
    if (!client.editLimitOrder) {
      return { success: false, message: '  Edit limit order not supported by the current client.' };
    }

    try {
      const result = await client.editLimitOrder(market, side, orderId, limitPrice);
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: [
          '',
          chalk.green(`  Limit Order #${orderId} Updated`),
          `  New Price: $${limitPrice.toFixed(2)}`,
          chalk.dim(`  TX: ${txLink}`),
          '',
        ].join('\n'),
      };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to edit limit order: ${getErrorMessage(err)}` };
    }
  },
};

const limitOrderListTool: ToolDefinition = {
  name: 'limit_order_list',
  description: 'List all active orders (on-chain)',
  parameters: z.object({}),
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.simulationMode) {
      return {
        success: true,
        message: [
          '',
          chalk.dim('  On-chain orders require live mode.'),
          chalk.dim('  Orders are placed on the Flash Trade protocol.'),
          '',
        ].join('\n'),
      };
    }

    const client = context.flashClient;
    if (!client.getUserOrders) {
      return { success: false, message: '  Order fetching not supported by the current client.' };
    }

    try {
      const orders = await client.getUserOrders();

      if (orders.length === 0) {
        return {
          success: true,
          message: [
            '',
            chalk.dim('  No active orders on-chain.'),
            chalk.dim('  Use "limit <long|short> <market> <lev>x $<collateral> @ $<price>" to place one.'),
            '',
          ].join('\n'),
        };
      }

      const lines = [
        '',
        `  ${chalk.bold('ON-CHAIN ORDERS')}`,
        chalk.dim(`  ${'─'.repeat(60)}`),
        '',
      ];

      // Separate by type
      const limitOrders = orders.filter(o => o.type === 'limit');
      const tpOrders = orders.filter(o => o.type === 'take_profit');
      const slOrders = orders.filter(o => o.type === 'stop_loss');

      if (limitOrders.length > 0) {
        lines.push(`  ${chalk.bold('Limit Orders')}`);
        for (const o of limitOrders) {
          lines.push(`    #${o.orderId}  ${o.market} ${o.side.toUpperCase()}  @ $${o.price.toFixed(2)}`);
        }
        lines.push('');
      }

      if (tpOrders.length > 0 || slOrders.length > 0) {
        lines.push(`  ${chalk.bold('Trigger Orders (TP/SL)')}`);
        for (const o of [...tpOrders, ...slOrders]) {
          const label = o.type === 'take_profit' ? chalk.green('TP') : chalk.red('SL');
          lines.push(`    #${o.orderId}  ${o.market} ${o.side.toUpperCase()}  ${label} @ $${o.price.toFixed(2)}`);
        }
        lines.push('');
      }

      lines.push(chalk.dim('  Orders are on-chain and visible on flash.trade'));
      lines.push('');

      return { success: true, message: lines.join('\n') };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to fetch orders: ${getErrorMessage(err)}` };
    }
  },
};

// ─── close_all ────────────────────────────────────────────────────────────────

export const flashCloseAll: ToolDefinition = {
  name: 'flash_close_all',
  description: 'Close all open positions sequentially',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    try {
      const positions = await context.flashClient.getPositions();
      if (positions.length === 0) {
        return { success: true, message: chalk.yellow('  No open positions to close.') };
      }

      const lines: string[] = [
        '',
        `  ${theme.accentBold('CLOSE ALL POSITIONS')}  ${theme.dim(`(${positions.length} position${positions.length > 1 ? 's' : ''})`)}`,
        '',
      ];

      let closed = 0;
      let totalPnl = 0;
      const errors: string[] = [];

      for (const pos of positions) {
        try {
          const result = await context.flashClient.closePosition(
            pos.market,
            pos.side as TradeSide,
          );
          closed++;
          const pnl = result.pnl ?? 0;
          totalPnl += pnl;
          lines.push(`  ${chalk.green('✓')} ${pos.market} ${colorSide(pos.side)} — PnL: ${colorPnl(pnl)}`);
        } catch (err: unknown) {
          errors.push(`${pos.market} ${pos.side}: ${getErrorMessage(err)}`);
          lines.push(`  ${chalk.red('✗')} ${pos.market} ${colorSide(pos.side)} — ${chalk.red(getErrorMessage(err))}`);
        }
      }

      lines.push('');
      lines.push(`  ${theme.dim('─'.repeat(40))}`);
      lines.push(`  Closed: ${chalk.bold(String(closed))}/${positions.length}  |  Total PnL: ${colorPnl(totalPnl)}`);
      if (errors.length > 0) {
        lines.push(`  ${chalk.red(`${errors.length} failed`)}`);
      }
      lines.push('');

      return { success: errors.length === 0, message: lines.join('\n') };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Failed to close all: ${getErrorMessage(err)}`) };
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
  protocolStatusTool,
  rpcStatusTool,
  rpcTestTool,
  txInspectTool,
  txDebugTool,
  tradeHistoryTool,
  systemAuditTool,
  txMetricsTool,
  setTpSlTool,
  removeTpSlTool,
  tpSlStatusTool,
  limitOrderPlaceTool,
  limitOrderCancelTool,
  limitOrderEditTool,
  limitOrderListTool,
  flashCloseAll,
];
