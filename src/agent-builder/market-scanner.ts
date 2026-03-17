/**
 * Market Scanner — Scan all markets, rank by opportunity, trade only the best.
 *
 * Instead of monitoring a fixed list, scan everything and pick the top N.
 * Rankings based on: signal strength, volume, volatility, OI skew.
 *
 * This is how professional desks work — they don't trade 3 markets,
 * they scan 50 and pick the 2-3 with the strongest edge.
 */

import type { MarketSnapshot } from './types.js';
import type { CompositeSignal } from './signal-fusion.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MarketRanking {
  market: string;
  /** Overall opportunity score 0-1 */
  score: number;
  /** Signal strength from fusion engine */
  signalStrength: number;
  /** Direction of the opportunity */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Volume relative to baseline */
  volumeScore: number;
  /** OI imbalance score */
  oiScore: number;
  /** Volatility score (moderate = good, extreme = bad) */
  volatilityScore: number;
  /** Funding rate opportunity score */
  fundingScore: number;
  /** Reason this market ranked here */
  reason: string;
}

// ─── Market Scanner ──────────────────────────────────────────────────────────

export class MarketScanner {
  /** How many top markets to return */
  private readonly topN: number;
  /** Minimum score to be considered tradeable */
  private readonly minScore: number;

  constructor(topN = 3, minScore = 0.3) {
    this.topN = topN;
    this.minScore = minScore;
  }

  /**
   * Rank markets by trading opportunity.
   * Returns top N markets sorted by opportunity score.
   */
  rank(
    snapshots: MarketSnapshot[],
    composites: Map<string, CompositeSignal>,
  ): MarketRanking[] {
    const rankings: MarketRanking[] = [];

    for (const snapshot of snapshots) {
      const composite = composites.get(snapshot.market);
      const ranking = this.scoreMarket(snapshot, composite);
      rankings.push(ranking);
    }

    // Sort by score descending, return top N
    return rankings
      .filter((r) => r.score >= this.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topN);
  }

  /**
   * Score a single market for trading opportunity.
   */
  private scoreMarket(snapshot: MarketSnapshot, composite?: CompositeSignal): MarketRanking {
    // Signal strength from fusion (0-1)
    const signalStrength = composite ? composite.confidence : 0;
    const direction = composite?.direction ?? 'neutral';

    // OI imbalance score (higher skew = more opportunity)
    const totalOi = snapshot.longOi + snapshot.shortOi;
    const oiScore = totalOi > 0
      ? Math.abs(snapshot.longOi / totalOi - 0.5) * 2 // 0 to 1
      : 0;

    // Volatility score — moderate is ideal, extreme is dangerous
    const absChange = Math.abs(snapshot.priceChange24h);
    let volatilityScore: number;
    if (absChange >= 1 && absChange <= 5) {
      volatilityScore = 0.8; // Sweet spot
    } else if (absChange > 5 && absChange <= 10) {
      volatilityScore = 0.5; // Elevated but tradeable
    } else if (absChange > 10) {
      volatilityScore = 0.2; // Too volatile
    } else {
      volatilityScore = 0.4; // Too flat for momentum
    }

    // Funding rate opportunity
    let fundingScore = 0;
    if (snapshot.fundingRate !== undefined && Number.isFinite(snapshot.fundingRate)) {
      const absFunding = Math.abs(snapshot.fundingRate);
      if (absFunding > 0.0005) fundingScore = 0.9;       // Extreme
      else if (absFunding > 0.0003) fundingScore = 0.6;   // Strong
      else if (absFunding > 0.0001) fundingScore = 0.3;   // Moderate
    }

    // Volume score — prefer markets with real volume
    const volumeScore = snapshot.volume24h > 1_000_000 ? 0.8
      : snapshot.volume24h > 100_000 ? 0.5
      : snapshot.volume24h > 10_000 ? 0.3
      : 0.1;

    // Composite opportunity score
    const score = (
      signalStrength * 0.35 +
      oiScore * 0.25 +
      fundingScore * 0.20 +
      volatilityScore * 0.10 +
      volumeScore * 0.10
    );

    // Build reason string
    const reasons: string[] = [];
    if (signalStrength > 0.4) reasons.push(`signal=${(signalStrength * 100).toFixed(0)}%`);
    if (oiScore > 0.3) reasons.push(`OI_skew=${(oiScore * 100).toFixed(0)}%`);
    if (fundingScore > 0.3) reasons.push(`funding=${(fundingScore * 100).toFixed(0)}%`);
    if (volatilityScore > 0.5) reasons.push(`vol=good`);

    return {
      market: snapshot.market,
      score,
      signalStrength,
      direction: direction === 'neutral' ? 'neutral' : direction,
      volumeScore,
      oiScore,
      volatilityScore,
      fundingScore,
      reason: reasons.length > 0 ? reasons.join(', ') : 'weak signals',
    };
  }
}
