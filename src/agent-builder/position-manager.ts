/**
 * Adaptive Position Manager — Professional-grade position lifecycle.
 *
 * Features:
 * 1. ATR-based trailing stops (moves with price, never backward)
 * 2. Scaled profit taking (1R, 2R, 3R partial closes)
 * 3. Kelly criterion position sizing
 * 4. Time-decay exit (close if flat after N ticks)
 * 5. Volatility-adjusted TP/SL
 *
 * Inspired by: Van Tharp R-multiple system, Kelly criterion,
 * Chandelier exit, professional futures desk risk management.
 */

import type { Position } from '../sdk/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ManagedPosition {
  /** Position data */
  position: Position;
  /** Initial risk (distance from entry to initial SL in USD) */
  initialRiskUsd: number;
  /** Current trailing stop price */
  trailingStop: number;
  /** Highest favorable price seen (for trailing stop) */
  peakPrice: number;
  /** R-multiple: current PnL / initial risk */
  rMultiple: number;
  /** Ticks since entry with < 0.5% move */
  flatTicks: number;
  /** Scale-out level reached (0=none, 1=1R, 2=2R, 3=3R) */
  scaleOutLevel: number;
  /** Entry timestamp */
  entryTime: number;
  /** Recommended action */
  action: 'hold' | 'close' | 'partial_close' | 'trailing_stop_hit' | 'time_decay_exit';
  /** Reason for action */
  reason: string;
  /** Percent to close (for partial) */
  closePercent?: number;
}

export interface PositionSizeResult {
  /** Collateral to use */
  collateral: number;
  /** Leverage to use */
  leverage: number;
  /** Position size in USD */
  sizeUsd: number;
  /** Risk per trade in USD */
  riskUsd: number;
  /** Risk as % of capital */
  riskPct: number;
  /** Method used */
  method: string;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface PositionManagerConfig {
  /** ATR multiplier for trailing stop (default: 2.0) */
  atrMultiplier: number;
  /** Scale out at these R-multiples (default: [1, 2, 3]) */
  scaleOutLevels: number[];
  /** Percent to close at each scale-out (default: [30, 30, 40]) */
  scaleOutPercents: number[];
  /** Max ticks flat before time-decay exit (default: 20 = ~5 min at 15s) */
  maxFlatTicks: number;
  /** Flat threshold — PnL change % considered "flat" (default: 0.5) */
  flatThresholdPct: number;
  /** Maximum risk per trade as % of capital (default: 0.02 = 2%) */
  maxRiskPct: number;
  /** Kelly fraction (default: 0.25 = quarter-Kelly for safety) */
  kellyFraction: number;
}

const DEFAULT_CONFIG: PositionManagerConfig = {
  atrMultiplier: 2.0,
  scaleOutLevels: [1, 2, 3],
  scaleOutPercents: [30, 30, 40],
  maxFlatTicks: 20,
  flatThresholdPct: 0.5,
  maxRiskPct: 0.02,
  kellyFraction: 0.25,
};

// ─── Position Manager ────────────────────────────────────────────────────────

export class PositionManager {
  private config: PositionManagerConfig;
  /** Tracked positions with trailing stop state */
  private managed: Map<string, ManagedPosition> = new Map();
  /** Price history for ATR computation */
  private priceHistory: Map<string, number[]> = new Map();
  private readonly maxPriceHistory = 30;
  /** Recent trade performance for Kelly computation */
  private recentWinRate = 0.5;
  private recentAvgWin = 0;
  private recentAvgLoss = 0;

  constructor(config?: Partial<PositionManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Position Sizing (Kelly Criterion) ─────────────────────────────

  /**
   * Calculate optimal position size using fractional Kelly criterion.
   *
   * Kelly formula: f* = (p * b - q) / b
   * Where: p = win probability, q = loss probability, b = win/loss ratio
   *
   * We use quarter-Kelly for safety (over-betting is worse than under-betting).
   */
  calculatePositionSize(
    capital: number,
    entryPrice: number,
    stopLossPrice: number,
    confidence: number,
    leverage: number,
  ): PositionSizeResult {
    const riskPerUnit = Math.abs(entryPrice - stopLossPrice) / entryPrice;

    if (riskPerUnit <= 0 || !Number.isFinite(riskPerUnit)) {
      // Fallback to fixed percentage
      const collateral = capital * this.config.maxRiskPct;
      return {
        collateral: Math.max(1, Math.floor(collateral * 100) / 100),
        leverage,
        sizeUsd: collateral * leverage,
        riskUsd: collateral * riskPerUnit,
        riskPct: this.config.maxRiskPct,
        method: 'fixed_pct',
      };
    }

    // Estimate win/loss ratio from recent performance or use confidence as proxy
    const winRate = this.recentWinRate > 0 ? this.recentWinRate : confidence;
    const lossRate = 1 - winRate;
    const avgWinLossRatio = this.recentAvgWin > 0 && this.recentAvgLoss > 0
      ? this.recentAvgWin / this.recentAvgLoss
      : 2.0; // Assume 2:1 R:R if no data

    // Kelly fraction: (p * b - q) / b
    const kellyFull = (winRate * avgWinLossRatio - lossRate) / avgWinLossRatio;
    const kellyAdjusted = Math.max(0, kellyFull * this.config.kellyFraction);

    // Risk amount = Kelly-sized fraction of capital
    const riskUsd = capital * Math.min(kellyAdjusted, this.config.maxRiskPct);
    const collateral = riskUsd / riskPerUnit / leverage;

    // Floor to reasonable minimum
    const finalCollateral = Math.max(1, Math.min(capital * 0.1, Math.floor(collateral * 100) / 100));

    return {
      collateral: finalCollateral,
      leverage,
      sizeUsd: finalCollateral * leverage,
      riskUsd,
      riskPct: capital > 0 ? riskUsd / capital : 0,
      method: 'kelly',
    };
  }

  // ─── Position Tracking & Trailing Stop ─────────────────────────────

  /**
   * Register a new position for tracking.
   */
  track(position: Position, initialStopLoss: number): void {
    const key = `${position.market}:${position.side}`;
    const entryPrice = position.entryPrice;
    const initialRisk = Math.abs(entryPrice - initialStopLoss);

    this.managed.set(key, {
      position,
      initialRiskUsd: initialRisk * (position.sizeUsd / entryPrice),
      trailingStop: initialStopLoss,
      peakPrice: entryPrice,
      rMultiple: 0,
      flatTicks: 0,
      scaleOutLevel: 0,
      entryTime: Date.now(),
      action: 'hold',
      reason: 'Position opened',
    });
  }

  /**
   * Update a tracked position with new price data.
   * Returns the management decision (hold, close, partial_close, etc.)
   */
  update(position: Position): ManagedPosition | null {
    const key = `${position.market}:${position.side}`;
    const managed = this.managed.get(key);
    if (!managed) return null;

    const currentPrice = position.markPrice ?? position.entryPrice;
    const isLong = position.side === 'long';
    const pnlPct = position.pnlPercent ?? 0;

    // Record price for ATR
    this.recordPrice(position.market, currentPrice);

    // Update peak price
    if (isLong && currentPrice > managed.peakPrice) {
      managed.peakPrice = currentPrice;
    } else if (!isLong && currentPrice < managed.peakPrice) {
      managed.peakPrice = currentPrice;
    }

    // Calculate R-multiple
    if (managed.initialRiskUsd > 0) {
      const currentPnl = position.pnl ?? 0;
      managed.rMultiple = currentPnl / managed.initialRiskUsd;
    }

    // Update trailing stop (ATR-based, never moves backward)
    const atr = this.computeATR(position.market);
    if (atr > 0) {
      const atrStop = this.config.atrMultiplier * atr;
      const newStop = isLong
        ? managed.peakPrice - atrStop
        : managed.peakPrice + atrStop;

      // Trailing stop only moves in favorable direction
      if (isLong && newStop > managed.trailingStop) {
        managed.trailingStop = newStop;
      } else if (!isLong && newStop < managed.trailingStop) {
        managed.trailingStop = newStop;
      }
    }

    // Check trailing stop hit
    if (isLong && currentPrice <= managed.trailingStop) {
      managed.action = 'trailing_stop_hit';
      managed.reason = `Trailing stop hit at $${managed.trailingStop.toFixed(2)} (peak: $${managed.peakPrice.toFixed(2)})`;
      return managed;
    }
    if (!isLong && currentPrice >= managed.trailingStop) {
      managed.action = 'trailing_stop_hit';
      managed.reason = `Trailing stop hit at $${managed.trailingStop.toFixed(2)} (peak: $${managed.peakPrice.toFixed(2)})`;
      return managed;
    }

    // Check scale-out levels (partial profit taking)
    for (let i = 0; i < this.config.scaleOutLevels.length; i++) {
      const rLevel = this.config.scaleOutLevels[i];
      if (managed.rMultiple >= rLevel && managed.scaleOutLevel <= i) {
        managed.scaleOutLevel = i + 1;
        managed.action = 'partial_close';
        managed.closePercent = this.config.scaleOutPercents[i];
        managed.reason = `Scale-out at ${rLevel}R (${managed.closePercent}%) — PnL: ${pnlPct.toFixed(1)}%`;
        return managed;
      }
    }

    // Check time decay (flat position)
    if (Math.abs(pnlPct) < this.config.flatThresholdPct) {
      managed.flatTicks++;
    } else {
      managed.flatTicks = 0;
    }

    if (managed.flatTicks >= this.config.maxFlatTicks) {
      managed.action = 'time_decay_exit';
      managed.reason = `Flat for ${managed.flatTicks} ticks — closing dead position`;
      return managed;
    }

    // Hard stop loss at -5%
    if (pnlPct < -5) {
      managed.action = 'close';
      managed.reason = `Hard stop loss at ${pnlPct.toFixed(1)}%`;
      return managed;
    }

    // Default: hold
    managed.action = 'hold';
    managed.reason = `R: ${managed.rMultiple.toFixed(2)} | Stop: $${managed.trailingStop.toFixed(2)} | Flat: ${managed.flatTicks}`;
    managed.position = position;
    return managed;
  }

  /**
   * Remove a position from tracking (after close).
   */
  untrack(market: string, side: string): void {
    this.managed.delete(`${market}:${side}`);
  }

  /**
   * Get all managed positions.
   */
  getManaged(): ManagedPosition[] {
    return Array.from(this.managed.values());
  }

  /**
   * Update performance stats for Kelly calculation.
   */
  updatePerformance(winRate: number, avgWin: number, avgLoss: number): void {
    this.recentWinRate = winRate;
    this.recentAvgWin = avgWin;
    this.recentAvgLoss = avgLoss;
  }

  // ─── ATR (Average True Range) ──────────────────────────────────────

  private recordPrice(market: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const history = this.priceHistory.get(market) ?? [];
    history.push(price);
    if (history.length > this.maxPriceHistory) history.shift();
    this.priceHistory.set(market, history);
  }

  /**
   * Compute ATR from price history.
   * True Range = max(high-low, |high-prevClose|, |low-prevClose|)
   * For tick data, we approximate using absolute price changes.
   */
  private computeATR(market: string): number {
    const prices = this.priceHistory.get(market);
    if (!prices || prices.length < 3) return 0;

    const ranges: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      ranges.push(Math.abs(prices[i] - prices[i - 1]));
    }

    return ranges.reduce((a, b) => a + b, 0) / ranges.length;
  }

  /** Reset all tracking state */
  reset(): void {
    this.managed.clear();
    this.priceHistory.clear();
  }
}
