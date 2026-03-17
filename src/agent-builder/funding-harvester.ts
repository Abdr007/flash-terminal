/**
 * Funding Rate Harvester — The highest-alpha strategy.
 *
 * Research shows 71% of RL agent profits came from funding rate harvesting.
 * When funding is extreme + OI is skewed + price is stagnant → fade the crowd.
 *
 * Logic:
 * - High positive funding = longs paying shorts = bearish pressure → SHORT
 * - High negative funding = shorts paying longs = bullish pressure → LONG
 * - Combine with OI imbalance for confirmation
 * - Only enter when price is NOT trending (avoid fighting momentum)
 */

import type { Strategy, StrategyResult, Signal, MarketSnapshot } from './types.js';

// Funding rate thresholds (per 8h period)
const FUNDING_EXTREME_THRESHOLD = 0.0005; // 0.05% per 8h = ~22% APR
const FUNDING_STRONG_THRESHOLD = 0.0003;  // 0.03% per 8h = ~13% APR
const MAX_PRICE_CHANGE_PCT = 2.0;         // Only enter in relatively flat markets
const MIN_OI_SKEW = 0.6;                  // Require OI confirmation

export class FundingHarvester implements Strategy {
  readonly name = 'funding_harvester';

  evaluate(snapshot: MarketSnapshot, signals: Signal[]): StrategyResult {
    const base: StrategyResult = {
      strategy: this.name,
      shouldTrade: false,
      confidence: 0,
      signals,
      reasoning: '',
    };

    const fundingRate = snapshot.fundingRate;
    if (fundingRate === undefined || !Number.isFinite(fundingRate)) {
      return { ...base, reasoning: 'No funding rate data' };
    }

    const absFunding = Math.abs(fundingRate);

    // Need extreme or strong funding
    if (absFunding < FUNDING_STRONG_THRESHOLD) {
      return { ...base, reasoning: `Funding ${(fundingRate * 100).toFixed(4)}% not extreme enough` };
    }

    // Price must be relatively flat — don't fight trends
    if (Math.abs(snapshot.priceChange24h) > MAX_PRICE_CHANGE_PCT) {
      return { ...base, reasoning: `Price moving ${snapshot.priceChange24h.toFixed(1)}% — too trendy for funding harvest` };
    }

    // OI confirmation — check if crowd is on the expected side
    const totalOi = snapshot.longOi + snapshot.shortOi;
    if (totalOi > 0) {
      const longRatio = snapshot.longOi / totalOi;
      // For positive funding (longs paying): expect heavy longs
      if (fundingRate > 0 && longRatio < MIN_OI_SKEW) {
        return { ...base, reasoning: 'Positive funding but OI not skewed long — weak signal' };
      }
      // For negative funding (shorts paying): expect heavy shorts
      if (fundingRate < 0 && (1 - longRatio) < MIN_OI_SKEW) {
        return { ...base, reasoning: 'Negative funding but OI not skewed short — weak signal' };
      }
    }

    // Direction: opposite of funding direction (fade the payers)
    const side = fundingRate > 0 ? 'short' as const : 'long' as const;

    // Confidence scales with funding extremity
    const isExtreme = absFunding >= FUNDING_EXTREME_THRESHOLD;
    let confidence = isExtreme ? 0.85 : 0.65;

    // Boost from OI signal agreement
    const oiSignal = signals.find((s) => s.source === 'oi_imbalance');
    if (oiSignal && oiSignal.direction !== 'neutral') {
      if ((oiSignal.direction === 'bearish' && side === 'short') ||
          (oiSignal.direction === 'bullish' && side === 'long')) {
        confidence = Math.min(0.92, confidence + 0.1);
      }
    }

    // Conservative TP/SL — funding harvesting is a slow grind
    const tp = side === 'long'
      ? snapshot.price * 1.015  // 1.5% TP
      : snapshot.price * 0.985;
    const sl = side === 'long'
      ? snapshot.price * 0.99   // 1% SL (tight — we want to collect funding, not gamble)
      : snapshot.price * 1.01;

    const annualizedRate = (absFunding * 3 * 365 * 100).toFixed(0);

    return {
      ...base,
      shouldTrade: true,
      side,
      market: snapshot.market,
      confidence,
      reasoning: `${snapshot.market} funding harvest: ${side} to collect ${(absFunding * 100).toFixed(4)}%/8h (~${annualizedRate}% APR) — ${isExtreme ? 'EXTREME' : 'strong'} funding`,
      suggestedTp: Math.round(tp * 100) / 100,
      suggestedSl: Math.round(sl * 100) / 100,
      invalidation: 'Funding rate normalizes or price breaks out of range',
    };
  }
}
