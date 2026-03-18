/**
 * Dynamic Position Sizer — Adaptive capital allocation.
 *
 * positionSize = baseSize × confidence × performanceFactor × riskFactor
 *
 * Rules:
 * - Max 3% per trade
 * - Min 0.5%
 * - Reduce after 2 consecutive losses
 * - Increase slowly after consistent wins
 * - Scale by signal confidence
 */

import type { DrawdownState } from './drawdown-manager.js';
import type { JournalStats } from './types.js';

export interface SizingResult {
  /** Collateral amount in USD */
  collateral: number;
  /** Size as % of capital */
  sizePct: number;
  /** Breakdown of multipliers */
  breakdown: {
    basePct: number;
    confidenceMultiplier: number;
    performanceMultiplier: number;
    riskMultiplier: number;
    regimeMultiplier: number;
  };
}

export class DynamicSizer {
  private readonly basePct: number;
  private readonly minPct: number;
  private readonly maxPct: number;

  constructor(basePct = 0.02, minPct = 0.005, maxPct = 0.03) {
    this.basePct = basePct;
    this.minPct = minPct;
    this.maxPct = maxPct;
  }

  /**
   * Calculate position size using the full adaptive formula:
   * size = capital × basePct × confidence × performance × risk × regime
   */
  calculate(
    capital: number,
    confidence: number,
    stats: JournalStats,
    drawdownState: DrawdownState,
    regimeSizeMultiplier: number,
    consecutiveLosses: number,
  ): SizingResult {
    // 1. Confidence multiplier (0.5 to 1.5)
    // Higher confidence → larger size, low confidence → smaller
    const confidenceMultiplier = 0.5 + confidence; // conf=0.5→1.0, conf=0.9→1.4

    // 2. Performance multiplier (based on recent win rate)
    let performanceMultiplier = 1.0;
    if (stats.totalTrades >= 5) {
      if (stats.winRate >= 0.6) {
        performanceMultiplier = 1.15; // Winning — slight increase
      } else if (stats.winRate >= 0.45) {
        performanceMultiplier = 1.0;  // Neutral
      } else if (stats.winRate >= 0.3) {
        performanceMultiplier = 0.7;  // Underperforming — reduce
      } else {
        performanceMultiplier = 0.4;  // Badly losing — minimal size
      }
    }

    // 3. Risk multiplier (consecutive losses + drawdown)
    let riskMultiplier = drawdownState.sizeMultiplier; // From drawdown manager
    if (consecutiveLosses >= 3) {
      riskMultiplier *= 0.3; // Severe reduction after 3 losses
    } else if (consecutiveLosses >= 2) {
      riskMultiplier *= 0.6; // Moderate reduction after 2 losses
    }

    // 4. Regime multiplier (from regime adapter)
    const regimeMultiplier = regimeSizeMultiplier;

    // Calculate final size percentage (with numeric safety)
    const rawPct = this.basePct * confidenceMultiplier * performanceMultiplier * riskMultiplier * regimeMultiplier;
    const clampedPct = Number.isFinite(rawPct) ? Math.max(this.minPct, Math.min(this.maxPct, rawPct)) : this.minPct;

    const rawCollateral = capital * clampedPct;
    const collateral = Number.isFinite(rawCollateral) ? Math.max(1, Math.floor(rawCollateral * 100) / 100) : 1;

    return {
      collateral,
      sizePct: clampedPct,
      breakdown: {
        basePct: this.basePct,
        confidenceMultiplier,
        performanceMultiplier,
        riskMultiplier,
        regimeMultiplier,
      },
    };
  }
}
