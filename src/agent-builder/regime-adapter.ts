/**
 * Regime-Adaptive Strategy Parameters — Auto-adjust everything by market regime.
 *
 * The core insight: a strategy that works in a trend KILLS you in a range.
 * Professional systems detect the regime and adapt parameters automatically.
 *
 * Regimes detected:
 * - TRENDING_UP / TRENDING_DOWN: Wide stops, trail, full size, momentum strategies
 * - RANGING: Tight stops, mean-revert, reduced size
 * - HIGH_VOLATILITY: Very wide stops, minimal size, only extreme signals
 * - COMPRESSION: No entries until breakout confirmed
 *
 * Inspired by: AQR's regime-switching models, Man Group's adaptive systems.
 */

// ─── Regime Types ────────────────────────────────────────────────────────────

export type RegimeType = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY' | 'COMPRESSION';

export interface RegimeDetection {
  regime: RegimeType;
  confidence: number;
  /** Trend strength 0-1 (ADX-like) */
  trendStrength: number;
  /** Volatility ratio vs average (>1 = expanding, <1 = contracting) */
  volatilityRatio: number;
  /** Hurst exponent estimate (>0.5 = trending, <0.5 = mean-reverting) */
  hurstEstimate: number;
  /** How many ticks in current regime */
  regimeDuration: number;
  /** Probability of regime transition */
  transitionProbability: number;
}

export interface RegimeParams {
  /** ATR multiplier for stops */
  stopAtrMultiplier: number;
  /** Take profit R-multiple target */
  takeProfitR: number;
  /** Position size multiplier (1.0 = normal) */
  sizeMultiplier: number;
  /** Max concurrent positions */
  maxPositions: number;
  /** Whether to trail stops */
  trailStops: boolean;
  /** Whether mean-reversion strategies are allowed */
  meanReversionAllowed: boolean;
  /** Whether momentum/breakout strategies are allowed */
  momentumAllowed: boolean;
  /** Minimum signal confidence to trade */
  minConfidence: number;
  /** Maximum leverage in this regime */
  maxLeverage: number;
  /** Exact strategy names allowed in this regime */
  allowedStrategies: string[];
}

// ─── Regime Parameter Maps ───────────────────────────────────────────────────

const REGIME_PARAMS: Record<RegimeType, RegimeParams> = {
  TRENDING_UP: {
    stopAtrMultiplier: 3.0,
    takeProfitR: 4.0,
    sizeMultiplier: 1.0,
    maxPositions: 3,
    trailStops: true,
    meanReversionAllowed: false,
    momentumAllowed: true,
    minConfidence: 0.4,
    maxLeverage: 5,
    allowedStrategies: ['trend_continuation', 'breakout'],
  },
  TRENDING_DOWN: {
    stopAtrMultiplier: 3.0,
    takeProfitR: 4.0,
    sizeMultiplier: 1.0,
    maxPositions: 3,
    trailStops: true,
    meanReversionAllowed: false,
    momentumAllowed: true,
    minConfidence: 0.4,
    maxLeverage: 5,
    allowedStrategies: ['trend_continuation', 'breakout'],
  },
  RANGING: {
    stopAtrMultiplier: 1.5,
    takeProfitR: 1.5,
    sizeMultiplier: 0.7,
    maxPositions: 2,
    trailStops: false,
    meanReversionAllowed: true,
    momentumAllowed: false,
    minConfidence: 0.5,
    maxLeverage: 3,
    allowedStrategies: ['mean_reversion', 'funding_harvester', 'oi_skew'],
  },
  HIGH_VOLATILITY: {
    stopAtrMultiplier: 4.0,
    takeProfitR: 2.0,
    sizeMultiplier: 0.3,
    maxPositions: 1,
    trailStops: true,
    meanReversionAllowed: false,
    momentumAllowed: true,
    minConfidence: 0.7,
    maxLeverage: 2,
    allowedStrategies: ['breakout'],
  },
  COMPRESSION: {
    stopAtrMultiplier: 2.0,
    takeProfitR: 5.0,
    sizeMultiplier: 0.5,
    maxPositions: 1,
    trailStops: true,
    meanReversionAllowed: false,
    momentumAllowed: true,
    minConfidence: 0.6,
    maxLeverage: 3,
    allowedStrategies: ['breakout'],
  },
};

// ─── Regime Adapter ──────────────────────────────────────────────────────────

export class RegimeAdapter {
  /** Price history per market for regime detection */
  private priceHistory: Map<string, number[]> = new Map();
  private volatilityHistory: Map<string, number[]> = new Map();
  private currentRegimes: Map<string, { regime: RegimeType; duration: number }> = new Map();
  private readonly maxHistory = 60;

  /**
   * Detect the current market regime from price history.
   */
  detectRegime(market: string, price: number, priceChange24h: number): RegimeDetection {
    this.recordPrice(market, price);

    const prices = this.priceHistory.get(market) ?? [];
    const trendStrength = this.computeTrendStrength(prices);
    const volatilityRatio = this.computeVolatilityRatio(market, prices);
    const hurstEstimate = this.estimateHurst(prices);

    // Classify regime
    let regime: RegimeType;
    let confidence: number;

    const absChange = Math.abs(priceChange24h);

    if (volatilityRatio > 1.8 || absChange > 8) {
      regime = 'HIGH_VOLATILITY';
      confidence = Math.min(0.9, (volatilityRatio - 1) / 2);
    } else if (volatilityRatio < 0.5 && absChange < 1) {
      regime = 'COMPRESSION';
      confidence = Math.min(0.8, 1 - volatilityRatio);
    } else if (trendStrength > 0.4 && hurstEstimate > 0.55) {
      regime = priceChange24h > 0 ? 'TRENDING_UP' : 'TRENDING_DOWN';
      confidence = Math.min(0.85, trendStrength);
    } else {
      regime = 'RANGING';
      confidence = Math.min(0.7, 1 - trendStrength);
    }

    // Track regime duration
    const current = this.currentRegimes.get(market);
    let duration = 1;
    if (current && current.regime === regime) {
      duration = current.duration + 1;
    }
    this.currentRegimes.set(market, { regime, duration });

    // Transition probability: higher when regime is young or changing
    const transitionProbability = duration < 5 ? 0.4 : duration < 15 ? 0.2 : 0.1;

    return {
      regime,
      confidence,
      trendStrength,
      volatilityRatio,
      hurstEstimate,
      regimeDuration: duration,
      transitionProbability,
    };
  }

  /**
   * Get strategy parameters adapted to the current regime.
   */
  getParams(regime: RegimeType): RegimeParams {
    return REGIME_PARAMS[regime];
  }

  /**
   * Check if a specific strategy name is allowed in the current regime.
   * Strict alignment: only strategies in the allowedStrategies list pass.
   */
  isStrategyAllowed(regime: RegimeType, strategyName: string): boolean {
    const params = REGIME_PARAMS[regime];
    return params.allowedStrategies.includes(strategyName);
  }

  /**
   * Filter a list of strategy names to only those allowed in the regime.
   */
  filterStrategies(regime: RegimeType, strategyNames: string[]): string[] {
    const allowed = REGIME_PARAMS[regime].allowedStrategies;
    return strategyNames.filter((s) => allowed.includes(s));
  }

  /**
   * Check if price is near range extremes (for RANGING regime).
   * Returns true if price is in top/bottom 20% of recent range.
   * In ranging markets, only enter near extremes for mean-reversion.
   */
  isNearRangeExtreme(market: string, price: number): boolean {
    const prices = this.priceHistory.get(market);
    if (!prices || prices.length < 10) return true; // Not enough data, allow

    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const range = high - low;
    if (range <= 0) return false; // Flat

    const positionInRange = (price - low) / range; // 0 = bottom, 1 = top
    // Near extreme = bottom 20% or top 20%
    return positionInRange <= 0.20 || positionInRange >= 0.80;
  }

  // ─── Internal Computations ─────────────────────────────────────────

  private recordPrice(market: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const history = this.priceHistory.get(market) ?? [];
    history.push(price);
    if (history.length > this.maxHistory) history.shift();
    this.priceHistory.set(market, history);
  }

  /**
   * Trend strength: ratio of net directional move to total distance traveled.
   * Similar to efficiency ratio / fractal dimension.
   * 1.0 = perfect trend, 0.0 = pure noise.
   */
  private computeTrendStrength(prices: number[]): number {
    if (prices.length < 5) return 0;

    const netMove = Math.abs(prices[prices.length - 1] - prices[0]);
    let totalDistance = 0;
    for (let i = 1; i < prices.length; i++) {
      totalDistance += Math.abs(prices[i] - prices[i - 1]);
    }

    if (totalDistance === 0) return 0;
    return netMove / totalDistance; // 0 to 1
  }

  /**
   * Volatility ratio: current volatility vs rolling average volatility.
   * >1 = expanding, <1 = contracting.
   */
  private computeVolatilityRatio(market: string, prices: number[]): number {
    if (prices.length < 5) return 1.0;

    // Current volatility: recent 5 bars
    const recent = prices.slice(-5);
    const recentReturns = recent.slice(1).map((p, i) => Math.abs((p - recent[i]) / recent[i]));
    const currentVol = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;

    // Record for history
    const volHist = this.volatilityHistory.get(market) ?? [];
    volHist.push(currentVol);
    if (volHist.length > 30) volHist.shift();
    this.volatilityHistory.set(market, volHist);

    // Average volatility
    const avgVol = volHist.reduce((a, b) => a + b, 0) / volHist.length;
    if (avgVol === 0) return 1.0;

    return currentVol / avgVol;
  }

  /**
   * Simplified Hurst exponent estimation using rescaled range.
   * H > 0.5 = trending (persistent), H < 0.5 = mean-reverting (anti-persistent).
   */
  private estimateHurst(prices: number[]): number {
    if (prices.length < 20) return 0.5; // Neutral assumption

    const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
    const n = returns.length;

    // Rescaled range for full series
    const mean = returns.reduce((a, b) => a + b, 0) / n;
    const deviations = returns.map((r) => r - mean);

    // Cumulative deviation
    const cumDev: number[] = [];
    let sum = 0;
    for (const d of deviations) {
      sum += d;
      cumDev.push(sum);
    }

    const R = Math.max(...cumDev) - Math.min(...cumDev);
    const stdDev = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n);

    if (stdDev === 0 || R === 0) return 0.5;

    const RS = R / stdDev;
    // Hurst ≈ log(R/S) / log(n)
    const H = Math.log(RS) / Math.log(n);

    return Math.max(0, Math.min(1, H));
  }

  /** Reset all state */
  reset(): void {
    this.priceHistory.clear();
    this.volatilityHistory.clear();
    this.currentRegimes.clear();
  }
}
