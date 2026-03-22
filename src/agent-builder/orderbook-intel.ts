/**
 * Orderbook Intelligence Module
 *
 * Analyzes market microstructure signals derived from available data
 * (OI, price, volume) since we don't have direct orderbook access.
 * Provides imbalance detection, liquidity depth estimation, spread
 * estimation, wall detection, breakout detection, and entry quality
 * assessment.
 */

import type { MarketSnapshot as _MarketSnapshot } from './types.js'; // used for type reference in docs

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OrderbookAnalysis {
  /** -1 to +1 (negative = sell pressure, positive = buy pressure) */
  imbalance: number;
  /** Liquidity depth based on OI magnitude relative to recent average */
  liquidityDepth: 'thin' | 'normal' | 'deep';
  /** Estimated spread from price volatility (higher vol = wider spread) */
  spreadEstimate: number;
  /** Large OI concentration detected on one side */
  wallDetected: 'buy' | 'sell' | 'none';
  /** Price compression + OI buildup = potential breakout */
  breakoutZone: boolean;
  /** Composite entry quality assessment */
  entryQuality: 'excellent' | 'good' | 'poor' | 'avoid';
  /** Human-readable explanation */
  reason: string;
}

export interface AvoidanceResult {
  avoid: boolean;
  reason: string;
}

// ─── Internal Buffer Entry ───────────────────────────────────────────────────

interface BufferEntry {
  price: number;
  longOi: number;
  shortOi: number;
  volume: number;
  timestamp: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_BUFFER_SIZE = 20;
const MAX_MARKETS = 50;
const WALL_THRESHOLD = 0.65;
const BREAKOUT_PRICE_RANGE_PCT = 0.003; // 0.3%
const BREAKOUT_LOOKBACK = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safe(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

// ─── OrderbookIntel ──────────────────────────────────────────────────────────

export class OrderbookIntel {
  private buffers: Map<string, BufferEntry[]> = new Map();

  // ── Record ───────────────────────────────────────────────────────────────

  /**
   * Record a market state observation into the circular buffer.
   */
  record(
    market: string,
    price: number,
    longOi: number,
    shortOi: number,
    volume: number,
  ): void {
    if (!market) return;

    const p = safe(price);
    const lo = safe(longOi);
    const so = safe(shortOi);
    const v = safe(volume);

    if (p <= 0) return; // invalid price

    // Enforce max markets limit
    if (!this.buffers.has(market) && this.buffers.size >= MAX_MARKETS) {
      return;
    }

    let buf = this.buffers.get(market);
    if (!buf) {
      buf = [];
      this.buffers.set(market, buf);
    }

    const entry: BufferEntry = {
      price: p,
      longOi: lo,
      shortOi: so,
      volume: v,
      timestamp: Date.now(),
    };

    // Circular buffer: push and trim from front
    buf.push(entry);
    if (buf.length > MAX_BUFFER_SIZE) {
      buf.shift();
    }
  }

  // ── Analyze ──────────────────────────────────────────────────────────────

  /**
   * Produce a full microstructure analysis for the given market.
   * Returns null if insufficient data.
   */
  analyze(market: string): OrderbookAnalysis | null {
    const buf = this.buffers.get(market);
    if (!buf || buf.length < 2) return null;

    const latest = buf[buf.length - 1];

    const imbalance = this.calcImbalance(latest.longOi, latest.shortOi);
    const liquidityDepth = this.calcLiquidityDepth(buf);
    const spreadEstimate = this.calcSpreadEstimate(buf);
    const wallDetected = this.detectWall(latest.longOi, latest.shortOi);
    const breakoutZone = this.detectBreakout(buf);
    const entryQuality = this.assessEntryQuality(
      imbalance,
      liquidityDepth,
      spreadEstimate,
      wallDetected,
      breakoutZone,
    );
    const reason = this.buildReason(
      imbalance,
      liquidityDepth,
      spreadEstimate,
      wallDetected,
      breakoutZone,
      entryQuality,
    );

    return {
      imbalance,
      liquidityDepth,
      spreadEstimate,
      wallDetected,
      breakoutZone,
      entryQuality,
      reason,
    };
  }

  // ── shouldAvoidEntry ─────────────────────────────────────────────────────

  /**
   * Determine whether to avoid entering a position on the given market/side.
   */
  shouldAvoidEntry(market: string, side: 'long' | 'short'): AvoidanceResult {
    const analysis = this.analyze(market);
    if (!analysis) {
      return { avoid: false, reason: 'Insufficient data for orderbook analysis' };
    }

    // Avoid if entering into a strong wall on the opposite side
    if (side === 'long' && analysis.wallDetected === 'sell') {
      return {
        avoid: true,
        reason: 'Heavy sell-side OI wall detected — longs face strong resistance',
      };
    }
    if (side === 'short' && analysis.wallDetected === 'buy') {
      return {
        avoid: true,
        reason: 'Heavy buy-side OI wall detected — shorts face strong support',
      };
    }

    // Avoid if liquidity is thin and spread is wide
    if (analysis.liquidityDepth === 'thin' && analysis.spreadEstimate > 0.005) {
      return {
        avoid: true,
        reason: 'Thin liquidity with wide estimated spread — high slippage risk',
      };
    }

    return { avoid: false, reason: 'No adverse microstructure signals detected' };
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  /**
   * Clear all recorded data.
   */
  reset(): void {
    this.buffers.clear();
  }

  // ── Private: Imbalance ───────────────────────────────────────────────────

  /**
   * Compute OI imbalance as deviation from 0.5 ratio.
   * Returns -1 to +1 (positive = buy/long pressure, negative = sell/short pressure).
   */
  private calcImbalance(longOi: number, shortOi: number): number {
    const total = safe(longOi) + safe(shortOi);
    if (total <= 0) return 0;

    // longRatio ranges 0 to 1; 0.5 is balanced
    const longRatio = safe(longOi) / total;
    // Map to -1..+1: longRatio 0 -> -1, 0.5 -> 0, 1 -> +1
    const imbalance = (longRatio - 0.5) * 2;

    return Math.max(-1, Math.min(1, safe(imbalance)));
  }

  // ── Private: Liquidity Depth ─────────────────────────────────────────────

  /**
   * Assess liquidity depth by comparing current total OI to recent average.
   * Deep = >2x average, thin = <0.5x average.
   */
  private calcLiquidityDepth(buf: BufferEntry[]): 'thin' | 'normal' | 'deep' {
    if (buf.length < 2) return 'normal';

    const latest = buf[buf.length - 1];
    const currentOi = safe(latest.longOi) + safe(latest.shortOi);

    let sumOi = 0;
    let count = 0;
    for (let i = 0; i < buf.length - 1; i++) {
      const oi = safe(buf[i].longOi) + safe(buf[i].shortOi);
      if (oi > 0) {
        sumOi += oi;
        count++;
      }
    }

    if (count === 0 || sumOi <= 0) return 'normal';

    const avgOi = sumOi / count;
    const ratio = currentOi / avgOi;

    if (!Number.isFinite(ratio)) return 'normal';
    if (ratio > 2) return 'deep';
    if (ratio < 0.5) return 'thin';
    return 'normal';
  }

  // ── Private: Spread Estimate ─────────────────────────────────────────────

  /**
   * Estimate spread from recent price volatility.
   * Higher price swings imply wider effective spread.
   * Returns spread as a fraction (e.g. 0.001 = 0.1%).
   */
  private calcSpreadEstimate(buf: BufferEntry[]): number {
    if (buf.length < 3) return 0;

    // Compute average absolute return over recent entries
    let sumAbsReturn = 0;
    let count = 0;
    for (let i = 1; i < buf.length; i++) {
      const prev = safe(buf[i - 1].price);
      const curr = safe(buf[i].price);
      if (prev > 0 && curr > 0) {
        sumAbsReturn += Math.abs((curr - prev) / prev);
        count++;
      }
    }

    if (count === 0) return 0;

    const avgAbsReturn = sumAbsReturn / count;
    // Spread estimate: volatility-based heuristic
    // Typical spread ~= 1.5x average absolute return (empirical)
    const spread = safe(avgAbsReturn * 1.5);

    return Math.max(0, spread);
  }

  // ── Private: Wall Detection ──────────────────────────────────────────────

  /**
   * Detect if OI is heavily concentrated on one side (>65% threshold).
   */
  private detectWall(longOi: number, shortOi: number): 'buy' | 'sell' | 'none' {
    const total = safe(longOi) + safe(shortOi);
    if (total <= 0) return 'none';

    const longRatio = safe(longOi) / total;
    if (!Number.isFinite(longRatio)) return 'none';

    if (longRatio >= WALL_THRESHOLD) return 'buy';
    if (longRatio <= 1 - WALL_THRESHOLD) return 'sell';
    return 'none';
  }

  // ── Private: Breakout Detection ──────────────────────────────────────────

  /**
   * Detect breakout conditions: price range compression + rising OI.
   * Last N prices within 0.3% range AND OI trending upward = breakout zone.
   */
  private detectBreakout(buf: BufferEntry[]): boolean {
    const lookback = Math.min(BREAKOUT_LOOKBACK, buf.length);
    if (lookback < 3) return false;

    const recent = buf.slice(-lookback);

    // Check price compression
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const entry of recent) {
      const p = safe(entry.price);
      if (p <= 0) continue;
      if (p < minPrice) minPrice = p;
      if (p > maxPrice) maxPrice = p;
    }

    if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice <= 0) {
      return false;
    }

    const priceRange = (maxPrice - minPrice) / minPrice;
    if (!Number.isFinite(priceRange)) return false;

    const compressed = priceRange <= BREAKOUT_PRICE_RANGE_PCT;

    // Check OI buildup: compare first half avg vs second half avg
    const half = Math.floor(recent.length / 2);
    if (half < 1) return false;

    let firstHalfOi = 0;
    let secondHalfOi = 0;
    for (let i = 0; i < half; i++) {
      firstHalfOi += safe(recent[i].longOi) + safe(recent[i].shortOi);
    }
    for (let i = half; i < recent.length; i++) {
      secondHalfOi += safe(recent[i].longOi) + safe(recent[i].shortOi);
    }

    const firstAvg = firstHalfOi / half;
    const secondAvg = secondHalfOi / (recent.length - half);

    if (!Number.isFinite(firstAvg) || !Number.isFinite(secondAvg) || firstAvg <= 0) {
      return false;
    }

    const oiRising = secondAvg > firstAvg * 1.05; // OI up at least 5%

    return compressed && oiRising;
  }

  // ── Private: Entry Quality ───────────────────────────────────────────────

  /**
   * Composite entry quality assessment from all signals.
   */
  private assessEntryQuality(
    imbalance: number,
    liquidityDepth: 'thin' | 'normal' | 'deep',
    spreadEstimate: number,
    wallDetected: 'buy' | 'sell' | 'none',
    breakoutZone: boolean,
  ): 'excellent' | 'good' | 'poor' | 'avoid' {
    const absImbalance = Math.abs(safe(imbalance));
    const narrowSpread = safe(spreadEstimate) < 0.002; // <0.2%

    // Avoid: strong wall + thin liquidity
    if (wallDetected !== 'none' && liquidityDepth === 'thin') {
      return 'avoid';
    }

    // Excellent: favorable imbalance + deep liquidity + narrow spread + breakout
    if (
      absImbalance > 0.1 &&
      liquidityDepth === 'deep' &&
      narrowSpread &&
      breakoutZone
    ) {
      return 'excellent';
    }

    // Poor: thin liquidity OR unfavorable high imbalance
    if (liquidityDepth === 'thin') {
      return 'poor';
    }
    if (absImbalance > 0.6) {
      // Extreme imbalance — crowded trade risk
      return 'poor';
    }

    // Good: normal or deep liquidity with moderate or favorable imbalance
    if (
      (liquidityDepth === 'normal' || liquidityDepth === 'deep') &&
      absImbalance <= 0.6
    ) {
      return 'good';
    }

    return 'poor';
  }

  // ── Private: Reason Builder ──────────────────────────────────────────────

  private buildReason(
    imbalance: number,
    liquidityDepth: 'thin' | 'normal' | 'deep',
    spreadEstimate: number,
    wallDetected: 'buy' | 'sell' | 'none',
    breakoutZone: boolean,
    entryQuality: 'excellent' | 'good' | 'poor' | 'avoid',
  ): string {
    const parts: string[] = [];

    // Imbalance
    const absImb = Math.abs(safe(imbalance));
    if (absImb > 0.3) {
      const dir = imbalance > 0 ? 'buy' : 'sell';
      parts.push(`Strong ${dir} pressure (imbalance: ${imbalance.toFixed(2)})`);
    } else if (absImb > 0.1) {
      const dir = imbalance > 0 ? 'buy' : 'sell';
      parts.push(`Moderate ${dir} lean (imbalance: ${imbalance.toFixed(2)})`);
    } else {
      parts.push('Balanced OI');
    }

    // Liquidity
    parts.push(`${liquidityDepth} liquidity`);

    // Spread
    const spreadBps = safe(spreadEstimate) * 10000;
    parts.push(`est. spread: ${spreadBps.toFixed(1)}bps`);

    // Wall
    if (wallDetected !== 'none') {
      parts.push(`${wallDetected}-side wall detected`);
    }

    // Breakout
    if (breakoutZone) {
      parts.push('breakout zone (compressed price + rising OI)');
    }

    // Quality summary
    parts.push(`Entry quality: ${entryQuality}`);

    return parts.join('; ');
  }
}
