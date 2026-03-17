/**
 * Drawdown Manager — Anti-martingale position sizing with equity curve tracking.
 *
 * The mathematical truth: if you lose 20%, you need 25% gain to recover.
 * The solution: trade SMALLER during drawdowns, NORMAL at equity highs.
 *
 * Features:
 * 1. Equity curve peak tracking
 * 2. Anti-martingale sizing (reduce in drawdowns)
 * 3. Recovery mode (gradually increase as equity recovers)
 * 4. Dynamic leverage adjustment (inverse volatility scaling)
 * 5. Hard stop at max drawdown (circuit breaker)
 *
 * Inspired by: Professional CTAs, risk parity funds, Two Sigma's
 * adaptive risk allocation.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DrawdownState {
  /** Peak equity ever seen */
  peakEquity: number;
  /** Current equity */
  currentEquity: number;
  /** Current drawdown percentage (0 = at peak, 0.1 = 10% below peak) */
  drawdownPct: number;
  /** Maximum drawdown seen this session */
  maxDrawdownPct: number;
  /** Size multiplier (1.0 = normal, 0.5 = half, 0 = stopped) */
  sizeMultiplier: number;
  /** Leverage multiplier */
  leverageMultiplier: number;
  /** Whether trading is halted */
  halted: boolean;
  /** Reason for halt */
  haltReason?: string;
  /** Number of new equity highs this session */
  newHighs: number;
  /** Bars since last new high */
  barsSinceHigh: number;
}

export interface DrawdownConfig {
  /** Drawdown tiers: [drawdown%, sizeMultiplier] */
  tiers: Array<[number, number]>;
  /** Max drawdown before circuit breaker halts trading */
  maxDrawdownPct: number;
  /** Bars with no new high before reducing size further */
  staleHighBars: number;
  /** Base volatility for leverage scaling (e.g. 0.03 = 3% daily vol) */
  baseVolatility: number;
}

const DEFAULT_CONFIG: DrawdownConfig = {
  tiers: [
    [0.03, 0.85],  // 3% DD → 85% size
    [0.05, 0.70],  // 5% DD → 70% size
    [0.08, 0.50],  // 8% DD → 50% size
    [0.12, 0.30],  // 12% DD → 30% size
    [0.15, 0.15],  // 15% DD → 15% size
    [0.20, 0.00],  // 20% DD → STOP
  ],
  maxDrawdownPct: 0.20,
  staleHighBars: 30,
  baseVolatility: 0.03,
};

// ─── Drawdown Manager ────────────────────────────────────────────────────────

export class DrawdownManager {
  private config: DrawdownConfig;
  private peakEquity: number;
  private maxDrawdownSeen = 0;
  private newHighCount = 0;
  private barsSinceHigh = 0;
  private halted = false;
  private haltReason?: string;
  /** Recent daily returns for volatility estimation */
  private recentReturns: number[] = [];
  private lastEquity: number;

  constructor(initialEquity: number, config?: Partial<DrawdownConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.peakEquity = initialEquity;
    this.lastEquity = initialEquity;
  }

  /**
   * Update with new equity value. Call on every tick.
   * Returns the current drawdown state with sizing recommendations.
   */
  update(currentEquity: number): DrawdownState {
    // Track returns for volatility
    if (this.lastEquity > 0) {
      const ret = (currentEquity - this.lastEquity) / this.lastEquity;
      this.recentReturns.push(ret);
      if (this.recentReturns.length > 50) this.recentReturns.shift();
    }
    this.lastEquity = currentEquity;

    // Update peak
    if (currentEquity > this.peakEquity) {
      this.peakEquity = currentEquity;
      this.newHighCount++;
      this.barsSinceHigh = 0;
    } else {
      this.barsSinceHigh++;
    }

    // Calculate drawdown
    const drawdownPct = this.peakEquity > 0
      ? (this.peakEquity - currentEquity) / this.peakEquity
      : 0;

    this.maxDrawdownSeen = Math.max(this.maxDrawdownSeen, drawdownPct);

    // Circuit breaker
    if (drawdownPct >= this.config.maxDrawdownPct) {
      this.halted = true;
      this.haltReason = `Max drawdown ${(drawdownPct * 100).toFixed(1)}% reached (limit: ${(this.config.maxDrawdownPct * 100).toFixed(0)}%)`;
    }

    // Anti-martingale size multiplier
    const sizeMultiplier = this.halted ? 0 : this.computeSizeMultiplier(drawdownPct);

    // Leverage multiplier (inverse volatility)
    const leverageMultiplier = this.computeLeverageMultiplier();

    return {
      peakEquity: this.peakEquity,
      currentEquity,
      drawdownPct,
      maxDrawdownPct: this.maxDrawdownSeen,
      sizeMultiplier,
      leverageMultiplier,
      halted: this.halted,
      haltReason: this.haltReason,
      newHighs: this.newHighCount,
      barsSinceHigh: this.barsSinceHigh,
    };
  }

  /**
   * Compute size multiplier using anti-martingale tiers.
   * CRITICAL: Never increase size during drawdowns. Only at new equity highs.
   */
  private computeSizeMultiplier(drawdownPct: number): number {
    // Sort tiers by drawdown level
    const sortedTiers = [...this.config.tiers].sort((a, b) => a[0] - b[0]);

    let multiplier = 1.0;
    for (const [threshold, mult] of sortedTiers) {
      if (drawdownPct >= threshold) {
        multiplier = mult;
      }
    }

    // Additional reduction if no new high in a long time (stale)
    if (this.barsSinceHigh > this.config.staleHighBars && multiplier > 0.5) {
      multiplier *= 0.8; // 20% additional reduction
    }

    return Math.max(0, multiplier);
  }

  /**
   * Dynamic leverage: reduce when volatility is high, increase when low.
   * Keeps dollar-risk roughly constant across volatility regimes.
   */
  private computeLeverageMultiplier(): number {
    if (this.recentReturns.length < 5) return 1.0;

    const currentVol = this.estimateVolatility();
    if (currentVol <= 0 || !Number.isFinite(currentVol)) return 1.0;

    // Inverse volatility scaling: high vol → low leverage, low vol → high leverage
    const ratio = this.config.baseVolatility / currentVol;
    return Math.max(0.3, Math.min(1.5, ratio)); // Clamp 0.3x to 1.5x
  }

  /**
   * Estimate current volatility from recent returns.
   */
  private estimateVolatility(): number {
    if (this.recentReturns.length < 3) return this.config.baseVolatility;

    const mean = this.recentReturns.reduce((a, b) => a + b, 0) / this.recentReturns.length;
    const variance = this.recentReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / this.recentReturns.length;
    return Math.sqrt(variance);
  }

  /**
   * Can be called to manually resume after halt (requires human override).
   */
  resume(newPeakEquity?: number): void {
    this.halted = false;
    this.haltReason = undefined;
    if (newPeakEquity) {
      this.peakEquity = newPeakEquity;
    }
  }

  /** Get current state without updating */
  getState(): DrawdownState {
    return this.update(this.lastEquity);
  }

  /** Reset to initial state */
  reset(equity: number): void {
    this.peakEquity = equity;
    this.lastEquity = equity;
    this.maxDrawdownSeen = 0;
    this.newHighCount = 0;
    this.barsSinceHigh = 0;
    this.halted = false;
    this.haltReason = undefined;
    this.recentReturns = [];
  }
}
