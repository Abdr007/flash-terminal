/**
 * Signal Detector — Market signal analysis from SDK data.
 *
 * Analyzes:
 * - Trend direction (price momentum)
 * - Volume spikes
 * - Open interest imbalance
 * - Volatility changes
 *
 * Returns typed signals with confidence scores.
 */

import type { Signal, SignalDirection, MarketSnapshot } from './types.js';

// ─── Thresholds ──────────────────────────────────────────────────────────────

const TREND_THRESHOLD = 3; // % price change to consider trending
const STRONG_TREND_THRESHOLD = 7; // % for high-confidence trend
const VOLUME_SPIKE_THRESHOLD = 1.5; // volume change ratio for spike
const OI_IMBALANCE_THRESHOLD = 0.6; // ratio threshold (0.5 = balanced)
const STRONG_OI_THRESHOLD = 0.7; // high-confidence OI signal
const VOLATILITY_HIGH_THRESHOLD = 5; // % change considered high vol

// ─── Signal Detector ─────────────────────────────────────────────────────────

export class SignalDetector {
  /** History for volatility/momentum calculations */
  private priceHistory: Map<string, number[]> = new Map();
  private readonly maxHistory = 20;

  /**
   * Detect all signals from a market snapshot.
   * Returns array of signals — may be empty if market is quiet.
   */
  detect(snapshot: MarketSnapshot): Signal[] {
    const signals: Signal[] = [];

    // Record price for history
    this.recordPrice(snapshot.market, snapshot.price);

    // 1. Trend signal
    const trend = this.detectTrend(snapshot);
    if (trend) signals.push(trend);

    // 2. Volume signal
    const volume = this.detectVolume(snapshot);
    if (volume) signals.push(volume);

    // 3. OI imbalance signal
    const oi = this.detectOiImbalance(snapshot);
    if (oi) signals.push(oi);

    // 4. Volatility signal
    const vol = this.detectVolatility(snapshot);
    if (vol) signals.push(vol);

    return signals;
  }

  /**
   * Check if signals align — all non-neutral signals point the same direction.
   */
  areSignalsAligned(signals: Signal[]): { aligned: boolean; direction: SignalDirection; strength: number } {
    const directional = signals.filter((s) => s.direction !== 'neutral');

    if (directional.length === 0) {
      return { aligned: true, direction: 'neutral', strength: 0 };
    }

    const bullish = directional.filter((s) => s.direction === 'bullish');
    const bearish = directional.filter((s) => s.direction === 'bearish');

    if (bullish.length > 0 && bearish.length > 0) {
      // Conflicting signals
      return { aligned: false, direction: 'neutral', strength: 0 };
    }

    const direction: SignalDirection = bullish.length > 0 ? 'bullish' : 'bearish';
    const avgConfidence = directional.reduce((sum, s) => sum + s.confidence, 0) / directional.length;
    // Strength increases with more aligned signals
    const strength = Math.min(1, avgConfidence * (1 + (directional.length - 1) * 0.15));

    return { aligned: true, direction, strength };
  }

  // ─── Individual Signal Detectors ───────────────────────────────────

  private detectTrend(snapshot: MarketSnapshot): Signal | null {
    const change = Math.abs(snapshot.priceChange24h);

    if (change < TREND_THRESHOLD) return null;

    const isStrong = change >= STRONG_TREND_THRESHOLD;
    const direction: SignalDirection = snapshot.priceChange24h > 0 ? 'bullish' : 'bearish';
    const confidence = isStrong ? Math.min(0.9, 0.5 + change / 30) : Math.min(0.7, 0.3 + change / 20);

    return {
      source: 'trend',
      direction,
      confidence,
      reason: `${snapshot.market} ${direction} trend: ${snapshot.priceChange24h > 0 ? '+' : ''}${snapshot.priceChange24h.toFixed(1)}% 24h`,
      metadata: { priceChange24h: snapshot.priceChange24h, strong: isStrong },
    };
  }

  private detectVolume(snapshot: MarketSnapshot): Signal | null {
    if (!snapshot.volumeChange || !Number.isFinite(snapshot.volumeChange)) return null;

    const ratio = snapshot.volumeChange;
    if (ratio < VOLUME_SPIKE_THRESHOLD) return null;

    // Volume spike itself is neutral — it amplifies other signals
    // But extreme volume can suggest continuation
    const confidence = Math.min(0.8, 0.3 + (ratio - 1) * 0.2);

    return {
      source: 'volume',
      direction: 'neutral',
      confidence,
      reason: `${snapshot.market} volume spike: ${ratio.toFixed(1)}x normal`,
      metadata: { volumeChange: ratio, volume24h: snapshot.volume24h },
    };
  }

  private detectOiImbalance(snapshot: MarketSnapshot): Signal | null {
    const total = snapshot.longOi + snapshot.shortOi;
    if (total === 0) return null;

    const longRatio = snapshot.longOi / total;
    const imbalance = Math.abs(longRatio - 0.5);

    if (imbalance < OI_IMBALANCE_THRESHOLD - 0.5) return null;

    const isStrong = longRatio >= STRONG_OI_THRESHOLD || longRatio <= (1 - STRONG_OI_THRESHOLD);
    // Heavy longs → potential bearish (crowded trade), heavy shorts → potential bullish
    const direction: SignalDirection = longRatio > 0.5 ? 'bearish' : 'bullish';
    const confidence = isStrong ? Math.min(0.8, 0.4 + imbalance) : Math.min(0.6, 0.3 + imbalance * 0.8);

    return {
      source: 'oi_imbalance',
      direction,
      confidence,
      reason: `${snapshot.market} OI imbalance: ${(longRatio * 100).toFixed(0)}% long / ${((1 - longRatio) * 100).toFixed(0)}% short`,
      metadata: { longRatio, shortRatio: 1 - longRatio, oiRatio: snapshot.oiRatio },
    };
  }

  private detectVolatility(snapshot: MarketSnapshot): Signal | null {
    const history = this.priceHistory.get(snapshot.market);
    if (!history || history.length < 3) return null;

    // Calculate recent volatility from price history
    const returns: number[] = [];
    for (let i = 1; i < history.length; i++) {
      if (history[i - 1] > 0) {
        returns.push(Math.abs((history[i] - history[i - 1]) / history[i - 1]) * 100);
      }
    }
    if (returns.length === 0) return null;

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

    if (avgReturn < VOLATILITY_HIGH_THRESHOLD) return null;

    return {
      source: 'volatility',
      direction: 'neutral',
      confidence: Math.min(0.7, 0.3 + avgReturn / 20),
      reason: `${snapshot.market} high volatility: avg ${avgReturn.toFixed(1)}% moves`,
      metadata: { avgReturn, dataPoints: returns.length },
    };
  }

  // ─── Price History ─────────────────────────────────────────────────

  private recordPrice(market: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const history = this.priceHistory.get(market) ?? [];
    history.push(price);
    if (history.length > this.maxHistory) history.shift();
    this.priceHistory.set(market, history);
  }

  /** Clear price history (e.g. on agent restart) */
  reset(): void {
    this.priceHistory.clear();
  }
}
