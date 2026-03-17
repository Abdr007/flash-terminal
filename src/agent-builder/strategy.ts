/**
 * Strategy Engine — Rule-based trading strategies.
 *
 * Each strategy defines:
 * - Entry conditions
 * - Invalidation conditions
 * - Exit logic (TP/SL suggestions)
 *
 * Strategies are composable — the agent picks the highest-confidence result.
 */

import type { Strategy, StrategyResult, Signal, MarketSnapshot } from './types.js';

// ─── Trend Continuation Strategy ─────────────────────────────────────────────

/**
 * Enters in the direction of an established trend when confirmed by volume/OI.
 *
 * Entry: Rising price + increasing OI + aligned signals
 * Invalidation: Trend reverses or signals conflict
 * Exit: TP at 2-3x risk, SL at 1x risk below entry
 */
export class TrendContinuation implements Strategy {
  readonly name = 'trend_continuation';

  private readonly minTrendChange = 1.5; // % minimum 24h change
  private readonly minConfidence = 0.4;

  evaluate(snapshot: MarketSnapshot, signals: Signal[]): StrategyResult {
    const base: StrategyResult = {
      strategy: this.name,
      shouldTrade: false,
      confidence: 0,
      signals,
      reasoning: '',
    };

    // Need a trend signal
    const trendSignal = signals.find((s) => s.source === 'trend');
    if (!trendSignal || trendSignal.direction === 'neutral') {
      return { ...base, reasoning: 'No trend detected' };
    }

    // Check minimum price movement
    if (Math.abs(snapshot.priceChange24h) < this.minTrendChange) {
      return { ...base, reasoning: `Price change ${snapshot.priceChange24h.toFixed(1)}% below threshold` };
    }

    // Check for conflicting signals (bearish OI in bullish trend = crowded)
    const oiSignal = signals.find((s) => s.source === 'oi_imbalance');
    if (oiSignal && oiSignal.direction !== 'neutral' && oiSignal.direction !== trendSignal.direction) {
      return { ...base, reasoning: 'OI imbalance conflicts with trend direction — crowded trade' };
    }

    // Volume confirmation (optional but boosts confidence)
    const volumeSignal = signals.find((s) => s.source === 'volume');
    const volumeBoost = volumeSignal ? volumeSignal.confidence * 0.15 : 0;

    const confidence = Math.min(0.9, trendSignal.confidence + volumeBoost);
    if (confidence < this.minConfidence) {
      return { ...base, reasoning: `Confidence ${(confidence * 100).toFixed(0)}% below threshold`, confidence };
    }

    const side = trendSignal.direction === 'bullish' ? 'long' as const : 'short' as const;
    const riskPct = Math.abs(snapshot.priceChange24h) * 0.3; // SL at ~30% of recent move
    const rewardPct = riskPct * 2.5; // 2.5:1 R:R

    const tp = side === 'long'
      ? snapshot.price * (1 + rewardPct / 100)
      : snapshot.price * (1 - rewardPct / 100);
    const sl = side === 'long'
      ? snapshot.price * (1 - riskPct / 100)
      : snapshot.price * (1 + riskPct / 100);

    return {
      ...base,
      shouldTrade: true,
      side,
      market: snapshot.market,
      confidence,
      reasoning: `${snapshot.market} ${trendSignal.direction} trend (${snapshot.priceChange24h > 0 ? '+' : ''}${snapshot.priceChange24h.toFixed(1)}%)${volumeSignal ? ' with volume confirmation' : ''}`,
      suggestedTp: Math.round(tp * 100) / 100,
      suggestedSl: Math.round(sl * 100) / 100,
      invalidation: `Trend reversal below ${sl.toFixed(2)} (long) or above ${tp.toFixed(2)} (short)`,
    };
  }
}

// ─── Breakout Strategy ───────────────────────────────────────────────────────

/**
 * Detects consolidation breakouts confirmed by volume spike.
 *
 * Entry: Low volatility + sudden volume spike + directional move
 * Invalidation: Price returns to consolidation range
 * Exit: TP at breakout target, SL at mid-range
 */
export class BreakoutStrategy implements Strategy {
  readonly name = 'breakout';

  evaluate(snapshot: MarketSnapshot, signals: Signal[]): StrategyResult {
    const base: StrategyResult = {
      strategy: this.name,
      shouldTrade: false,
      confidence: 0,
      signals,
      reasoning: '',
    };

    // Need volume spike as confirmation
    const volumeSignal = signals.find((s) => s.source === 'volume');
    if (!volumeSignal || volumeSignal.confidence < 0.4) {
      return { ...base, reasoning: 'No volume spike for breakout confirmation' };
    }

    // Need a directional move (trend)
    const trendSignal = signals.find((s) => s.source === 'trend');
    if (!trendSignal || trendSignal.direction === 'neutral') {
      return { ...base, reasoning: 'No directional move detected' };
    }

    // Breakout is stronger when volatility was low before the move
    const volSignal = signals.find((s) => s.source === 'volatility');
    const wasConsolidating = !volSignal; // No volatility signal = was quiet
    const consolidationBoost = wasConsolidating ? 0.1 : 0;

    const confidence = Math.min(0.85, (trendSignal.confidence + volumeSignal.confidence) / 2 + consolidationBoost);

    if (confidence < 0.5) {
      return { ...base, reasoning: 'Breakout signals too weak', confidence };
    }

    const side = trendSignal.direction === 'bullish' ? 'long' as const : 'short' as const;
    const movePct = Math.abs(snapshot.priceChange24h);
    const tp = side === 'long'
      ? snapshot.price * (1 + movePct / 100)
      : snapshot.price * (1 - movePct / 100);
    const sl = side === 'long'
      ? snapshot.price * (1 - movePct * 0.4 / 100)
      : snapshot.price * (1 + movePct * 0.4 / 100);

    return {
      ...base,
      shouldTrade: true,
      side,
      market: snapshot.market,
      confidence,
      reasoning: `${snapshot.market} breakout ${trendSignal.direction}: ${movePct.toFixed(1)}% move with ${((volumeSignal.metadata?.volumeChange as number) ?? 0).toFixed(1)}x volume`,
      suggestedTp: Math.round(tp * 100) / 100,
      suggestedSl: Math.round(sl * 100) / 100,
      invalidation: `Price returns inside pre-breakout range`,
    };
  }
}

// ─── Mean Reversion Strategy ─────────────────────────────────────────────────

/**
 * Fades extreme moves when volume is declining.
 *
 * Entry: Large move (>5%) + declining volume + OI imbalance
 * Invalidation: Move continues with increasing volume
 * Exit: TP at mean (50% reversion), tight SL
 */
export class MeanReversionStrategy implements Strategy {
  readonly name = 'mean_reversion';

  private readonly extremeMoveThreshold = 3; // % 24h change

  evaluate(snapshot: MarketSnapshot, signals: Signal[]): StrategyResult {
    const base: StrategyResult = {
      strategy: this.name,
      shouldTrade: false,
      confidence: 0,
      signals,
      reasoning: '',
    };

    // Need an extreme move
    if (Math.abs(snapshot.priceChange24h) < this.extremeMoveThreshold) {
      return { ...base, reasoning: `Price change ${snapshot.priceChange24h.toFixed(1)}% not extreme enough` };
    }

    // Volume should NOT be spiking (declining = exhaustion)
    const volumeSignal = signals.find((s) => s.source === 'volume');
    if (volumeSignal && volumeSignal.confidence > 0.5) {
      return { ...base, reasoning: 'Volume still rising — move not exhausted, skip mean reversion' };
    }

    // OI imbalance confirms crowded positioning
    const oiSignal = signals.find((s) => s.source === 'oi_imbalance');
    const oiBoost = oiSignal && oiSignal.direction !== 'neutral' ? oiSignal.confidence * 0.15 : 0;

    // Trade AGAINST the move
    const side = snapshot.priceChange24h > 0 ? 'short' as const : 'long' as const;
    const confidence = Math.min(0.75, 0.35 + Math.abs(snapshot.priceChange24h) / 30 + oiBoost);

    if (confidence < 0.45) {
      return { ...base, reasoning: 'Mean reversion confidence too low', confidence };
    }

    // TP at 50% reversion, tight SL
    const movePct = Math.abs(snapshot.priceChange24h);
    const revertPct = movePct * 0.5;
    const slPct = movePct * 0.3;

    const tp = side === 'long'
      ? snapshot.price * (1 + revertPct / 100)
      : snapshot.price * (1 - revertPct / 100);
    const sl = side === 'long'
      ? snapshot.price * (1 - slPct / 100)
      : snapshot.price * (1 + slPct / 100);

    return {
      ...base,
      shouldTrade: true,
      side,
      market: snapshot.market,
      confidence,
      reasoning: `${snapshot.market} mean reversion: extreme ${snapshot.priceChange24h > 0 ? '+' : ''}${snapshot.priceChange24h.toFixed(1)}% move${!volumeSignal ? ' with declining volume' : ''}`,
      suggestedTp: Math.round(tp * 100) / 100,
      suggestedSl: Math.round(sl * 100) / 100,
      invalidation: `Move continues beyond ${(movePct * 1.3).toFixed(1)}% with increasing volume`,
    };
  }
}

// ─── OI Skew Strategy ────────────────────────────────────────────────────────

/**
 * Trades against crowded OI positioning.
 *
 * Entry: Strong OI imbalance (>65% one side) — fade the crowd
 * Invalidation: OI rebalances to <60%
 * Exit: TP at 2% move in favor, SL at 1.5% against
 */
export class OiSkewStrategy implements Strategy {
  readonly name = 'oi_skew';

  evaluate(snapshot: MarketSnapshot, signals: Signal[]): StrategyResult {
    const base: StrategyResult = {
      strategy: this.name,
      shouldTrade: false,
      confidence: 0,
      signals,
      reasoning: '',
    };

    // Need an OI imbalance signal
    const oiSignal = signals.find((s) => s.source === 'oi_imbalance');
    if (!oiSignal || oiSignal.direction === 'neutral') {
      return { ...base, reasoning: 'No OI imbalance detected' };
    }

    // Need minimum confidence from the OI signal
    if (oiSignal.confidence < 0.5) {
      return { ...base, reasoning: `OI signal confidence ${(oiSignal.confidence * 100).toFixed(0)}% too low` };
    }

    // If trend signal exists and AGREES with OI signal, boost confidence
    // If trend CONFLICTS (e.g. price going up but OI says bearish), reduce
    const trendSignal = signals.find((s) => s.source === 'trend');
    let trendBoost = 0;
    if (trendSignal && trendSignal.direction !== 'neutral') {
      if (trendSignal.direction === oiSignal.direction) {
        trendBoost = 0.1; // Trend confirms the skew thesis
      } else {
        trendBoost = -0.15; // Trend opposes — less confident
      }
    }

    const confidence = Math.min(0.85, oiSignal.confidence + trendBoost);
    if (confidence < 0.45) {
      return { ...base, reasoning: 'OI skew confidence too low after trend adjustment', confidence };
    }

    // Trade direction comes from OI signal (already set to fade the crowd)
    const side = oiSignal.direction === 'bullish' ? 'long' as const : 'short' as const;

    // Conservative TP/SL for skew trades
    const tp = side === 'long'
      ? snapshot.price * 1.02
      : snapshot.price * 0.98;
    const sl = side === 'long'
      ? snapshot.price * 0.985
      : snapshot.price * 1.015;

    const longPct = (snapshot.oiRatio * 100).toFixed(0);

    return {
      ...base,
      shouldTrade: true,
      side,
      market: snapshot.market,
      confidence,
      reasoning: `${snapshot.market} OI skew: ${longPct}% long — fading crowded ${side === 'short' ? 'longs' : 'shorts'}`,
      suggestedTp: Math.round(tp * 100) / 100,
      suggestedSl: Math.round(sl * 100) / 100,
      invalidation: `OI rebalances below 60% skew`,
    };
  }
}

// ─── Strategy Selector ───────────────────────────────────────────────────────

/**
 * Evaluate all strategies and return the best result.
 * If no strategy produces a trade signal, returns null.
 */
export function selectBestStrategy(
  strategies: Strategy[],
  snapshot: MarketSnapshot,
  signals: Signal[],
): StrategyResult | null {
  let best: StrategyResult | null = null;

  for (const strategy of strategies) {
    const result = strategy.evaluate(snapshot, signals);
    if (result.shouldTrade && result.confidence > (best?.confidence ?? 0)) {
      best = result;
    }
  }

  return best;
}
