import {
  StrategySignal,
  TradeSuggestion,
  TradeSide,
  AggregatedSignal,
  MarketData,
  VolumeData,
  OpenInterestData,
} from '../types/index.js';
import { computeMomentumSignal } from '../strategies/momentum.js';
import { computeMeanReversionSignal } from '../strategies/mean-reversion.js';
import { computeWhaleFollowSignal, WhaleActivity } from '../strategies/whale-follow.js';
import { RegimeWeights } from '../regime/regime-types.js';
import { getLogger } from '../utils/logger.js';

export interface AggregatorInput {
  markets: MarketData[];
  volume: VolumeData;
  openInterest: OpenInterestData;
  whaleRecentActivity: WhaleActivity[];
  whaleOpenPositions: WhaleActivity[];
  balance: number;
  targetMarket?: string;
  regimeWeights?: RegimeWeights;
}

/** Default static weights when no regime is provided. */
const DEFAULT_WEIGHTS: RegimeWeights = {
  momentum: 0.4,
  meanReversion: 0.4,
  whaleFollow: 0.2,
  leverageMultiplier: 1.0,
  collateralMultiplier: 1.0,
};

/**
 * Collect signals from all strategies, compute a unified confidence score,
 * and produce a deterministic trade suggestion without Claude.
 *
 * When `regimeWeights` is provided, strategy contributions are modulated
 * by the detected market regime instead of using equal weighting.
 */
export function aggregateSignals(
  market: MarketData,
  volume: VolumeData,
  openInterest: OpenInterestData,
  whaleRecentActivity: WhaleActivity[],
  whaleOpenPositions: WhaleActivity[],
  regimeWeights?: RegimeWeights,
): AggregatedSignal {
  const momentum = computeMomentumSignal({ market, volume });
  const meanReversion = computeMeanReversionSignal({ market, openInterest });
  const whaleFollow = computeWhaleFollowSignal({
    recentActivity: whaleRecentActivity,
    openPositions: whaleOpenPositions,
    targetMarket: market.symbol,
  });

  const signals: StrategySignal[] = [momentum, meanReversion, whaleFollow];
  const w = regimeWeights ?? DEFAULT_WEIGHTS;

  // Regime-weighted vote: each signal's confidence is scaled by its strategy weight
  // Guard against NaN/Infinity in weights — fall back to defaults
  let bullishScore = 0;
  let bearishScore = 0;

  const safeWeight = (v: number, fallback: number): number =>
    Number.isFinite(v) ? v : fallback;
  const strategyWeights = [
    safeWeight(w.momentum, 0.4),
    safeWeight(w.meanReversion, 0.4),
    safeWeight(w.whaleFollow, 0.2),
  ];

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const weight = strategyWeights[i];
    if (sig.signal === 'bullish') {
      bullishScore += sig.confidence * weight;
    } else if (sig.signal === 'bearish') {
      bearishScore += sig.confidence * weight;
    }
    // neutral signals contribute nothing
  }

  const totalWeight = bullishScore + bearishScore;

  // If all signals are neutral (no directional weight), return near-zero confidence.
  // Direction is meaningless here — confidence guarantees no trade is taken.
  if (totalWeight === 0) {
    return {
      market: market.symbol,
      direction: TradeSide.Long, // irrelevant — confidence 0.05 blocks any trade
      recommendedLeverage: 1.1,
      confidenceScore: 0.05,
      confidenceLabel: 'low',
      signalBreakdown: signals,
      source: 'strategy_engine',
    };
  }

  // When bullish and bearish are exactly equal, return low confidence instead of biasing Long
  const direction: TradeSide = bullishScore > bearishScore ? TradeSide.Long : bullishScore < bearishScore ? TradeSide.Short : TradeSide.Long;
  const rawConfidence = Math.max(bullishScore, bearishScore) / (bullishScore + bearishScore + 0.5);
  // Reduce confidence when signals conflict: close scores → low confidence
  const conflictPenalty = totalWeight > 0
    ? Math.abs(bullishScore - bearishScore) / totalWeight
    : 0;
  const confidenceScore = Math.min(0.9, rawConfidence * (0.5 + 0.5 * conflictPenalty));

  let confidenceLabel: 'high' | 'medium' | 'low';
  if (confidenceScore >= 0.65) confidenceLabel = 'high';
  else if (confidenceScore >= 0.4) confidenceLabel = 'medium';
  else confidenceLabel = 'low';

  // Conservative leverage based on confidence, adjusted by regime multiplier
  let recommendedLeverage: number;
  if (confidenceScore >= 0.65) recommendedLeverage = 3;
  else if (confidenceScore >= 0.4) recommendedLeverage = 2;
  else recommendedLeverage = 1.5;

  recommendedLeverage = Math.max(1.1, recommendedLeverage * w.leverageMultiplier);

  return {
    market: market.symbol,
    direction,
    recommendedLeverage,
    confidenceScore,
    confidenceLabel,
    signalBreakdown: signals,
    source: 'strategy_engine',
  };
}

/**
 * Generate a fallback TradeSuggestion from aggregated strategy signals.
 * Used when Claude API is unavailable.
 */
export function generateFallbackSuggestion(input: AggregatorInput): TradeSuggestion | null {
  const logger = getLogger();
  const { markets, volume, openInterest, whaleRecentActivity, whaleOpenPositions, balance, targetMarket, regimeWeights } = input;

  // Never suggest a trade with zero or negative balance
  if (balance <= 0) {
    logger.warn('AGGREGATOR', 'Balance is zero or negative — no suggestion');
    return null;
  }

  const relevantMarkets = targetMarket
    ? markets.filter((m) => m.symbol.toUpperCase() === targetMarket.toUpperCase())
    : markets.slice(0, 5);

  if (relevantMarkets.length === 0) {
    logger.warn('AGGREGATOR', 'No markets available for fallback suggestion');
    return null;
  }

  // Aggregate signals for each market and pick the highest confidence
  let bestAgg: AggregatedSignal | null = null;

  for (const m of relevantMarkets) {
    const agg = aggregateSignals(m, volume, openInterest, whaleRecentActivity, whaleOpenPositions, regimeWeights);
    if (!bestAgg || agg.confidenceScore > bestAgg.confidenceScore) {
      bestAgg = agg;
    }
  }

  if (!bestAgg || bestAgg.confidenceScore < 0.4) {
    logger.info('AGGREGATOR', 'Confidence too low for a suggestion');
    return null;
  }

  // Size collateral conservatively: 5% of balance, min $10, max $1000
  // Apply regime collateral multiplier (e.g. LOW_LIQUIDITY reduces by 50%)
  const collateralMult = regimeWeights?.collateralMultiplier ?? 1.0;
  const collateral = Math.min(1000, Math.max(10, Math.round(balance * 0.05 * collateralMult)));

  const signalSummary = bestAgg.signalBreakdown
    .map((s) => `${s.name}: ${s.signal}`)
    .join(', ');

  const risks: string[] = [
    'Strategy-based suggestion — no AI reasoning applied',
    'Market conditions may change rapidly',
  ];

  if (bestAgg.confidenceLabel === 'low') {
    risks.push('Low confidence — consider smaller position size');
  }

  return {
    market: bestAgg.market,
    side: bestAgg.direction,
    leverage: bestAgg.recommendedLeverage,
    collateral,
    reasoning: `Strategy Engine fallback: ${signalSummary}. Overall confidence: ${bestAgg.confidenceLabel} (${(bestAgg.confidenceScore * 100).toFixed(0)}%).`,
    confidence: bestAgg.confidenceScore,
    risks,
  };
}
