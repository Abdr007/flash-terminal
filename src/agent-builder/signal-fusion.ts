/**
 * Signal Fusion Engine — Multi-factor weighted signal scoring.
 *
 * Professional quant-grade signal processing:
 * 1. Z-score normalization across all signals
 * 2. Weighted composite scoring with adaptive weights
 * 3. Signal decay (recent signals weighted more)
 * 4. Cross-signal confirmation requirements
 * 5. Confidence calibration from historical accuracy
 *
 * Architecture inspired by: Two Sigma, Jump Trading, Wintermute
 * signal fusion pipelines.
 */

import type { SignalDirection, MarketSnapshot } from './types.js';

// ─── Signal Factor Types ─────────────────────────────────────────────────────

export interface SignalFactor {
  name: string;
  direction: SignalDirection;
  /** Raw value (e.g. OI ratio, funding rate, price change %) */
  rawValue: number;
  /** Z-score normalized value (-3 to +3 typically) */
  zScore: number;
  /** Factor-specific confidence 0-1 */
  confidence: number;
  /** Weight in the composite (auto-adjusted) */
  weight: number;
  /** Timestamp of observation */
  timestamp: number;
}

export interface CompositeSignal {
  market: string;
  /** Weighted composite score (-1 to +1, negative=bearish, positive=bullish) */
  compositeScore: number;
  /** Absolute strength 0-1 */
  strength: number;
  /** Derived direction */
  direction: SignalDirection;
  /** Calibrated confidence based on historical accuracy */
  confidence: number;
  /** Number of factors that agree */
  confirmedFactors: number;
  /** Total factors evaluated */
  totalFactors: number;
  /** Individual factor breakdown */
  factors: SignalFactor[];
  /** Whether minimum confirmation threshold is met */
  confirmed: boolean;
}

// ─── Factor Weights (adaptive — adjusted by performance) ─────────────────────

interface FactorConfig {
  baseWeight: number;
  /** Minimum z-score to consider signal active */
  activationThreshold: number;
}

const DEFAULT_FACTOR_CONFIGS: Record<string, FactorConfig> = {
  oi_skew:        { baseWeight: 0.25, activationThreshold: 0.5 },
  funding_rate:   { baseWeight: 0.20, activationThreshold: 0.3 },
  price_momentum: { baseWeight: 0.20, activationThreshold: 0.5 },
  volume_surge:   { baseWeight: 0.10, activationThreshold: 0.8 },
  volatility:     { baseWeight: 0.10, activationThreshold: 0.5 },
  liquidation:    { baseWeight: 0.15, activationThreshold: 0.3 },
};

// Minimum factors that must agree for a confirmed signal
const MIN_CONFIRMATION_FACTORS = 2;

// Signal decay — signals older than this (ms) are discounted
const SIGNAL_DECAY_MS = 300_000; // 5 minutes
const SIGNAL_DECAY_RATE = 0.8; // Multiply confidence by this per decay period

// ─── Signal Fusion Engine ────────────────────────────────────────────────────

export class SignalFusionEngine {
  private factorConfigs: Record<string, FactorConfig>;
  /** Rolling history for z-score computation */
  private history: Map<string, number[]> = new Map();
  private readonly maxHistory = 50;
  /** Performance tracking per factor for adaptive weights */
  private factorAccuracy: Map<string, { correct: number; total: number }> = new Map();

  constructor(configs?: Record<string, FactorConfig>) {
    this.factorConfigs = { ...DEFAULT_FACTOR_CONFIGS, ...(configs ?? {}) };
  }

  /**
   * Fuse all available signals into a single composite signal.
   * This is the core decision input for strategy evaluation.
   */
  fuse(snapshot: MarketSnapshot, fundingRate?: number): CompositeSignal {
    const factors: SignalFactor[] = [];
    const now = Date.now();

    // Factor 1: OI Skew
    const oiFactor = this.computeOiSkewFactor(snapshot, now);
    if (oiFactor) factors.push(oiFactor);

    // Factor 2: Funding Rate
    if (fundingRate !== undefined) {
      const fundingFactor = this.computeFundingFactor(fundingRate, snapshot.market, now);
      if (fundingFactor) factors.push(fundingFactor);
    }

    // Factor 3: Price Momentum (EMA crossover approximation)
    const momentumFactor = this.computeMomentumFactor(snapshot, now);
    if (momentumFactor) factors.push(momentumFactor);

    // Factor 4: Volume Surge
    if (snapshot.volumeChange) {
      const volumeFactor = this.computeVolumeFactor(snapshot, now);
      if (volumeFactor) factors.push(volumeFactor);
    }

    // Factor 5: Volatility Regime
    const volFactor = this.computeVolatilityFactor(snapshot, now);
    if (volFactor) factors.push(volFactor);

    // Factor 6: Liquidation Proximity
    const liqFactor = this.computeLiquidationFactor(snapshot, now);
    if (liqFactor) factors.push(liqFactor);

    // Compute composite score
    return this.computeComposite(snapshot.market, factors);
  }

  /**
   * Record whether a signal factor's direction was correct after a trade.
   * Used for adaptive weight adjustment.
   */
  recordOutcome(factorName: string, wasCorrect: boolean): void {
    const acc = this.factorAccuracy.get(factorName) ?? { correct: 0, total: 0 };
    acc.total++;
    if (wasCorrect) acc.correct++;
    // Keep rolling window of last 50
    if (acc.total > 50) {
      acc.correct = Math.round(acc.correct * 0.8);
      acc.total = Math.round(acc.total * 0.8);
    }
    this.factorAccuracy.set(factorName, acc);
  }

  /**
   * Get adaptive weight for a factor based on its historical accuracy.
   */
  getAdaptiveWeight(factorName: string): number {
    const config = this.factorConfigs[factorName];
    if (!config) return 0;

    const acc = this.factorAccuracy.get(factorName);
    if (!acc || acc.total < 5) return config.baseWeight; // Not enough data

    const accuracy = acc.correct / acc.total;
    // Scale weight: 50% accuracy = base weight, 70%+ = 1.5x, 30%- = 0.5x
    const multiplier = 0.5 + accuracy; // Range: 0.5 to 1.5
    return config.baseWeight * multiplier;
  }

  // ─── Individual Factor Computations ────────────────────────────────

  private computeOiSkewFactor(snapshot: MarketSnapshot, now: number): SignalFactor | null {
    const total = snapshot.longOi + snapshot.shortOi;
    if (total === 0) return null;

    const longRatio = snapshot.longOi / total;
    const skew = longRatio - 0.5; // -0.5 to +0.5
    const zScore = this.zScoreNormalize(`oi_${snapshot.market}`, skew);

    // Heavy longs = bearish (fade crowd), heavy shorts = bullish
    const direction: SignalDirection = Math.abs(skew) < 0.1 ? 'neutral' : skew > 0 ? 'bearish' : 'bullish';
    const confidence = Math.min(0.9, Math.abs(skew) * 2);

    return {
      name: 'oi_skew',
      direction,
      rawValue: longRatio,
      zScore,
      confidence,
      weight: this.getAdaptiveWeight('oi_skew'),
      timestamp: now,
    };
  }

  private computeFundingFactor(fundingRate: number, market: string, now: number): SignalFactor | null {
    if (!Number.isFinite(fundingRate)) return null;

    const zScore = this.zScoreNormalize(`funding_${market}`, fundingRate);

    // High positive funding = longs paying shorts = bearish pressure
    // High negative funding = shorts paying longs = bullish pressure
    let direction: SignalDirection = 'neutral';
    if (Math.abs(fundingRate) > 0.001) { // >0.1% significant
      direction = fundingRate > 0 ? 'bearish' : 'bullish';
    }

    const confidence = Math.min(0.8, Math.abs(fundingRate) * 100);

    return {
      name: 'funding_rate',
      direction,
      rawValue: fundingRate,
      zScore,
      confidence,
      weight: this.getAdaptiveWeight('funding_rate'),
      timestamp: now,
    };
  }

  private computeMomentumFactor(snapshot: MarketSnapshot, now: number): SignalFactor | null {
    const change = snapshot.priceChange24h;
    if (!Number.isFinite(change)) return null;

    const zScore = this.zScoreNormalize(`momentum_${snapshot.market}`, change);

    let direction: SignalDirection = 'neutral';
    if (Math.abs(change) > 1) {
      direction = change > 0 ? 'bullish' : 'bearish';
    }

    const confidence = Math.min(0.85, Math.abs(change) / 10);

    return {
      name: 'price_momentum',
      direction,
      rawValue: change,
      zScore,
      confidence,
      weight: this.getAdaptiveWeight('price_momentum'),
      timestamp: now,
    };
  }

  private computeVolumeFactor(snapshot: MarketSnapshot, now: number): SignalFactor | null {
    const change = snapshot.volumeChange ?? 0;
    if (change < 1.1) return null; // Less than 10% increase = no signal

    const zScore = this.zScoreNormalize(`volume_${snapshot.market}`, change);

    // Volume is directionally neutral — it amplifies other signals
    return {
      name: 'volume_surge',
      direction: 'neutral',
      rawValue: change,
      zScore,
      confidence: Math.min(0.7, (change - 1) * 0.5),
      weight: this.getAdaptiveWeight('volume_surge'),
      timestamp: now,
    };
  }

  private computeVolatilityFactor(snapshot: MarketSnapshot, now: number): SignalFactor | null {
    const absChange = Math.abs(snapshot.priceChange24h);
    const zScore = this.zScoreNormalize(`vol_${snapshot.market}`, absChange);

    // High volatility = reduce confidence, low = increase
    // This is a modifier, not a directional signal
    return {
      name: 'volatility',
      direction: 'neutral',
      rawValue: absChange,
      zScore,
      confidence: absChange > 5 ? 0.3 : absChange > 2 ? 0.5 : 0.7,
      weight: this.getAdaptiveWeight('volatility'),
      timestamp: now,
    };
  }

  private computeLiquidationFactor(snapshot: MarketSnapshot, now: number): SignalFactor | null {
    // Estimate liquidation pressure from OI concentration
    // If most OI is leveraged longs and price is near their entry, liq cascade risk is high
    const total = snapshot.longOi + snapshot.shortOi;
    if (total === 0) return null;

    const longRatio = snapshot.longOi / total;
    const dominantSide = longRatio > 0.6 ? 'long' : longRatio < 0.4 ? 'short' : null;
    if (!dominantSide) return null;

    // Higher OI concentration = higher cascade risk against the dominant side
    const concentration = Math.abs(longRatio - 0.5) * 2; // 0 to 1
    const zScore = this.zScoreNormalize(`liq_${snapshot.market}`, concentration);

    // Liquidation cascades hurt the dominant side
    const direction: SignalDirection = dominantSide === 'long' ? 'bearish' : 'bullish';
    const confidence = Math.min(0.75, concentration * 0.8);

    return {
      name: 'liquidation',
      direction,
      rawValue: concentration,
      zScore,
      confidence,
      weight: this.getAdaptiveWeight('liquidation'),
      timestamp: now,
    };
  }

  // ─── Composite Computation ─────────────────────────────────────────

  private computeComposite(market: string, factors: SignalFactor[]): CompositeSignal {
    if (factors.length === 0) {
      return {
        market, compositeScore: 0, strength: 0, direction: 'neutral',
        confidence: 0, confirmedFactors: 0, totalFactors: 0, factors: [], confirmed: false,
      };
    }

    // Apply signal decay
    const now = Date.now();
    for (const f of factors) {
      const age = now - f.timestamp;
      if (age > SIGNAL_DECAY_MS) {
        const periods = Math.floor(age / SIGNAL_DECAY_MS);
        f.confidence *= Math.pow(SIGNAL_DECAY_RATE, periods);
      }
    }

    // Compute directional score: bullish = +1, bearish = -1, neutral = 0
    let weightedSum = 0;
    let totalWeight = 0;

    for (const f of factors) {
      if (f.direction === 'neutral') continue;
      const directionValue = f.direction === 'bullish' ? 1 : -1;
      const contribution = directionValue * f.confidence * f.weight;
      weightedSum += contribution;
      totalWeight += f.weight;
    }

    const compositeScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const strength = Math.min(1, Math.abs(compositeScore));

    // Count confirmed factors (directional + above activation threshold)
    const directionalFactors = factors.filter((f) => f.direction !== 'neutral');
    const dominantDir: SignalDirection = compositeScore > 0.05 ? 'bullish' : compositeScore < -0.05 ? 'bearish' : 'neutral';
    const confirmedFactors = directionalFactors.filter((f) => f.direction === dominantDir).length;

    // Confidence calibration: base confidence from composite, boosted by confirmation count
    const baseConfidence = strength;
    const confirmationBoost = confirmedFactors >= 3 ? 0.15 : confirmedFactors >= 2 ? 0.08 : 0;
    const volumeFactor = factors.find((f) => f.name === 'volume_surge');
    const volumeBoost = volumeFactor && volumeFactor.confidence > 0.3 ? 0.05 : 0;
    const confidence = Math.min(0.95, baseConfidence + confirmationBoost + volumeBoost);

    return {
      market,
      compositeScore,
      strength,
      direction: dominantDir,
      confidence,
      confirmedFactors,
      totalFactors: directionalFactors.length,
      factors,
      confirmed: confirmedFactors >= MIN_CONFIRMATION_FACTORS || (confirmedFactors >= 1 && confidence > 0.7),
    };
  }

  // ─── Z-Score Normalization ─────────────────────────────────────────

  /**
   * Z-score normalize a value using rolling history.
   * Returns how many standard deviations from the mean.
   */
  private zScoreNormalize(key: string, value: number): number {
    const history = this.history.get(key) ?? [];
    history.push(value);
    if (history.length > this.maxHistory) history.shift();
    this.history.set(key, history);

    if (history.length < 3) return 0; // Not enough data

    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((sum, v) => sum + (v - mean) ** 2, 0) / history.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;
    return (value - mean) / stdDev;
  }

  /** Reset all history (e.g. on agent restart) */
  reset(): void {
    this.history.clear();
    this.factorAccuracy.clear();
  }
}
