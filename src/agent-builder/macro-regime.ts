/**
 * Macro Regime Detector — Cross-asset market environment classification.
 *
 * Unlike per-market regime detection, this tracks the GLOBAL environment:
 *   - BTC trend (anchor asset for all crypto)
 *   - Total market volatility (average across tracked assets)
 *   - Cross-asset correlation spikes (risk-on / risk-off detection)
 *
 * Regimes:
 *   BULL: BTC trending up, moderate vol, crypto correlated upward
 *   BEAR: BTC trending down, rising vol, crypto correlated downward
 *   RISK_OFF: extreme vol, high correlation, flight to safety
 *   CHAOTIC: no clear direction, extreme divergence between assets
 *
 * Integration:
 *   - CHAOTIC → scale down size to 50%
 *   - RISK_OFF → block new trades entirely
 *   - BULL → favor trend-following strategies
 *   - BEAR → favor short-bias strategies, tighter stops
 */

import type { MarketSnapshot } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MacroRegime = 'BULL' | 'BEAR' | 'RISK_OFF' | 'CHAOTIC' | 'NEUTRAL';

export interface MacroDetection {
  regime: MacroRegime;
  confidence: number;
  btcTrend: 'up' | 'down' | 'flat';
  avgVolatility: number;
  correlationStrength: number;   // 0-1, how synchronized are assets
  /** Size multiplier: 0 = no trades, 0.5 = half size, 1.0 = full */
  sizeMultiplier: number;
  /** Whether new trades should be blocked */
  tradesBlocked: boolean;
  /** Suggested strategy bias */
  strategyBias: 'trend' | 'mean_revert' | 'defensive' | 'none';
}

// ─── Configuration ───────────────────────────────────────────────────────────

const VOL_EXTREME_THRESHOLD = 6; // 6% average absolute 24h change = extreme
const CORR_SPIKE_THRESHOLD = 0.7; // >70% of assets moving same direction = correlated
const REGIME_HYSTERESIS = 3;      // Ticks before switching macro regime

// ─── Macro Regime Detector ───────────────────────────────────────────────────

export class MacroRegimeDetector {
  /** BTC price history for trend detection */
  private btcPrices: number[] = [];
  /** Per-market 24h change history for vol/correlation */
  private marketChanges: Map<string, number[]> = new Map();
  /** Current regime + hysteresis */
  private currentRegime: MacroRegime = 'NEUTRAL';
  private pendingRegime: MacroRegime = 'NEUTRAL';
  private pendingTicks = 0;

  private static readonly MAX_HISTORY = 30;

  /**
   * Update macro regime with latest market snapshots.
   * Call once per tick with all available snapshots.
   */
  update(snapshots: MarketSnapshot[]): MacroDetection {
    // Track BTC price
    const btcSnap = snapshots.find((s) => s.market === 'BTC');
    if (btcSnap) {
      this.btcPrices.push(btcSnap.price);
      if (this.btcPrices.length > MacroRegimeDetector.MAX_HISTORY) this.btcPrices.shift();
    }

    // Track per-market 24h changes
    for (const snap of snapshots) {
      const changes = this.marketChanges.get(snap.market) ?? [];
      changes.push(snap.priceChange24h);
      if (changes.length > MacroRegimeDetector.MAX_HISTORY) changes.shift();
      this.marketChanges.set(snap.market, changes);
    }

    // Compute BTC trend
    const btcTrend = this.computeBtcTrend();

    // Compute average volatility across all markets
    const avgVol = this.computeAvgVolatility(snapshots);

    // Compute cross-asset correlation
    const corrStrength = this.computeCorrelation(snapshots);

    // Classify regime
    const rawRegime = this.classify(btcTrend, avgVol, corrStrength);

    // Apply hysteresis
    if (rawRegime !== this.currentRegime) {
      if (rawRegime === this.pendingRegime) {
        this.pendingTicks++;
        if (this.pendingTicks >= REGIME_HYSTERESIS) {
          this.currentRegime = rawRegime;
          this.pendingTicks = 0;
        }
      } else {
        this.pendingRegime = rawRegime;
        this.pendingTicks = 1;
      }
    } else {
      this.pendingTicks = 0;
    }

    return this.buildDetection(btcTrend, avgVol, corrStrength);
  }

  /** Get current macro regime without updating */
  getCurrent(): MacroDetection {
    return this.buildDetection(
      this.computeBtcTrend(),
      0,
      0,
    );
  }

  reset(): void {
    this.btcPrices = [];
    this.marketChanges.clear();
    this.currentRegime = 'NEUTRAL';
    this.pendingRegime = 'NEUTRAL';
    this.pendingTicks = 0;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private computeBtcTrend(): 'up' | 'down' | 'flat' {
    if (this.btcPrices.length < 5) return 'flat';
    const n = this.btcPrices.length;
    const recent = this.btcPrices.slice(-5);
    const older = this.btcPrices.slice(Math.max(0, n - 10), n - 5);
    if (older.length === 0) return 'flat';

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    const changePct = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;

    if (changePct > 1) return 'up';
    if (changePct < -1) return 'down';
    return 'flat';
  }

  private computeAvgVolatility(snapshots: MarketSnapshot[]): number {
    if (snapshots.length === 0) return 0;
    return snapshots.reduce((sum, s) => sum + Math.abs(s.priceChange24h), 0) / snapshots.length;
  }

  private computeCorrelation(snapshots: MarketSnapshot[]): number {
    if (snapshots.length < 3) return 0;
    // Count how many assets are moving in the same direction as BTC
    const btcSnap = snapshots.find((s) => s.market === 'BTC');
    if (!btcSnap) return 0;

    const btcDir = Math.sign(btcSnap.priceChange24h);
    if (btcDir === 0) return 0;

    const others = snapshots.filter((s) => s.market !== 'BTC');
    if (others.length === 0) return 0;

    const sameDirection = others.filter((s) => Math.sign(s.priceChange24h) === btcDir).length;
    return sameDirection / others.length; // 0-1
  }

  private classify(btcTrend: string, avgVol: number, corrStrength: number): MacroRegime {
    // RISK_OFF: extreme volatility + high correlation (everything dumping together)
    if (avgVol > VOL_EXTREME_THRESHOLD && corrStrength > CORR_SPIKE_THRESHOLD && btcTrend === 'down') {
      return 'RISK_OFF';
    }

    // CHAOTIC: high vol but LOW correlation (assets diverging randomly)
    if (avgVol > VOL_EXTREME_THRESHOLD && corrStrength < 0.3) {
      return 'CHAOTIC';
    }

    // BULL: BTC up, moderate-to-high correlation
    if (btcTrend === 'up' && corrStrength > 0.4) {
      return 'BULL';
    }

    // BEAR: BTC down, moderate-to-high correlation
    if (btcTrend === 'down' && corrStrength > 0.4) {
      return 'BEAR';
    }

    return 'NEUTRAL';
  }

  private buildDetection(btcTrend: 'up' | 'down' | 'flat', avgVol: number, corrStrength: number): MacroDetection {
    const regime = this.currentRegime;

    let sizeMultiplier = 1.0;
    let tradesBlocked = false;
    let strategyBias: MacroDetection['strategyBias'] = 'none';
    let confidence = 0.5;

    switch (regime) {
      case 'BULL':
        sizeMultiplier = 1.0;
        strategyBias = 'trend';
        confidence = 0.7;
        break;
      case 'BEAR':
        sizeMultiplier = 0.7;
        strategyBias = 'defensive';
        confidence = 0.7;
        break;
      case 'RISK_OFF':
        sizeMultiplier = 0;
        tradesBlocked = true;
        strategyBias = 'defensive';
        confidence = 0.8;
        break;
      case 'CHAOTIC':
        sizeMultiplier = 0.5;
        strategyBias = 'defensive';
        confidence = 0.6;
        break;
      case 'NEUTRAL':
        sizeMultiplier = 1.0;
        strategyBias = 'none';
        confidence = 0.4;
        break;
    }

    return {
      regime, confidence, btcTrend, avgVolatility: avgVol,
      correlationStrength: corrStrength, sizeMultiplier, tradesBlocked, strategyBias,
    };
  }
}
