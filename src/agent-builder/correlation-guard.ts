/**
 * Correlation Guard V2 — Prevent hidden leverage from correlated positions.
 *
 * V1: static cluster definitions (well-known correlations)
 * V2: rolling price correlation engine for dynamic detection
 *
 * Rules:
 * 1. Max 1 position per cluster per direction
 * 2. Size reduction if ANY correlated exposure exists
 * 3. Total cluster exposure capped as % of capital
 * 4. V2: Dynamic correlation — if rolling corr > 0.7 → treat as same cluster
 */

import type { Position } from '../sdk/types.js';
import { getMarketCluster, getAllClusters } from '../markets/index.js';

// ─── Correlation Clusters ───────────────────────────────────────────────────
// Loaded dynamically from Market Registry (SDK source of truth).
// New markets are auto-assigned to appropriate clusters based on type/pool.

function getCluster(market: string): string {
  return getMarketCluster(market);
}

/** Get all cluster definitions (for display/diagnostics). */
export function getClusters(): Record<string, string[]> {
  return getAllClusters();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CorrelationCheck {
  allowed: boolean;
  reason: string;
  /** Size multiplier (1.0 = full, 0.5-0.8 = reduced due to correlation) */
  sizeMultiplier: number;
  cluster: string;
  clusterPositionCount: number;
  clusterExposureUsd: number;
}

// ─── Correlation Guard ──────────────────────────────────────────────────────

export class CorrelationGuard {
  /** Max positions per cluster per direction */
  private readonly maxPerClusterPerDirection: number;
  /** Max total positions per cluster (any direction) */
  private readonly maxPerCluster: number;
  /** Max cluster exposure as fraction of capital */
  private readonly maxClusterExposurePct: number;

  /** V2: Rolling price returns per market for dynamic correlation */
  private priceReturns: Map<string, number[]> = new Map();
  /** V2: Cached pairwise correlations (refreshed every N ticks) */
  private corrCache: Map<string, number> = new Map();
  private corrCacheAge = 0;
  private static readonly CORR_WINDOW = 20;      // rolling window for correlation
  private static readonly CORR_THRESHOLD = 0.70;  // above this → treat as same cluster
  private static readonly CORR_REFRESH_TICKS = 5;
  private static readonly MAX_RETURNS = 30;

  constructor(
    maxPerClusterPerDirection = 1,
    maxPerCluster = 2,
    maxClusterExposurePct = 0.15,
  ) {
    this.maxPerClusterPerDirection = maxPerClusterPerDirection;
    this.maxPerCluster = maxPerCluster;
    this.maxClusterExposurePct = maxClusterExposurePct;
  }

  /**
   * V2: Record a price return for dynamic correlation tracking.
   * Call once per tick per market with the current price.
   */
  recordPrice(market: string, price: number): void {
    const key = market.toUpperCase();
    // Store raw prices; compute returns on demand when correlation is requested
    const prices = this.priceReturns.get(key) ?? [];
    prices.push(price);
    if (prices.length > CorrelationGuard.MAX_RETURNS) prices.shift();
    this.priceReturns.set(key, prices);
    this.corrCacheAge++;
  }

  /**
   * V2: Get rolling Pearson correlation between two markets.
   * Returns 0 if insufficient data.
   */
  getCorrelation(marketA: string, marketB: string): number {
    const cacheKey = [marketA, marketB].sort().join(':');

    // Use cache if fresh
    if (this.corrCacheAge < CorrelationGuard.CORR_REFRESH_TICKS) {
      const cached = this.corrCache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    const pricesA = this.priceReturns.get(marketA.toUpperCase());
    const pricesB = this.priceReturns.get(marketB.toUpperCase());
    if (!pricesA || !pricesB || pricesA.length < 5 || pricesB.length < 5) return 0;

    // Compute returns from prices
    const n = Math.min(pricesA.length, pricesB.length, CorrelationGuard.CORR_WINDOW + 1);
    const returnsA: number[] = [];
    const returnsB: number[] = [];
    for (let i = pricesA.length - n + 1; i < pricesA.length; i++) {
      if (pricesA[i - 1] > 0) returnsA.push((pricesA[i] - pricesA[i - 1]) / pricesA[i - 1]);
    }
    for (let i = pricesB.length - n + 1; i < pricesB.length; i++) {
      if (pricesB[i - 1] > 0) returnsB.push((pricesB[i] - pricesB[i - 1]) / pricesB[i - 1]);
    }

    const len = Math.min(returnsA.length, returnsB.length);
    if (len < 4) return 0;

    const corr = pearsonCorrelation(returnsA.slice(-len), returnsB.slice(-len));
    this.corrCache.set(cacheKey, corr);
    if (this.corrCacheAge >= CorrelationGuard.CORR_REFRESH_TICKS) {
      this.corrCacheAge = 0;
    }
    return corr;
  }

  /**
   * V2: Check if two markets are dynamically correlated (above threshold).
   */
  isDynamicallyCorrelated(marketA: string, marketB: string): boolean {
    return Math.abs(this.getCorrelation(marketA, marketB)) >= CorrelationGuard.CORR_THRESHOLD;
  }

  /**
   * Check if a new trade would violate correlation constraints.
   */
  check(
    positions: Position[],
    newMarket: string,
    newSide: 'long' | 'short',
    newSizeUsd: number,
    capital: number,
  ): CorrelationCheck {
    const newCluster = getCluster(newMarket);

    // Standalone assets always pass
    if (newCluster.startsWith('standalone_')) {
      return {
        allowed: true,
        reason: 'Standalone asset — no correlation constraints',
        sizeMultiplier: 1.0,
        cluster: newCluster,
        clusterPositionCount: 0,
        clusterExposureUsd: 0,
      };
    }

    // Find existing positions in the same cluster
    const clusterPositions = positions.filter(p => getCluster(p.market) === newCluster);
    const sameDirectionCount = clusterPositions.filter(p => p.side === newSide).length;
    const clusterExposure = clusterPositions.reduce((sum, p) => sum + (p.sizeUsd ?? 0), 0);

    // Rule 1: Max positions per cluster per direction
    if (sameDirectionCount >= this.maxPerClusterPerDirection) {
      return {
        allowed: false,
        reason: `Already ${sameDirectionCount} ${newSide} position(s) in '${newCluster}' cluster (max ${this.maxPerClusterPerDirection})`,
        sizeMultiplier: 0,
        cluster: newCluster,
        clusterPositionCount: clusterPositions.length,
        clusterExposureUsd: clusterExposure,
      };
    }

    // Rule 2: Max total positions per cluster
    if (clusterPositions.length >= this.maxPerCluster) {
      return {
        allowed: false,
        reason: `Cluster '${newCluster}' already has ${clusterPositions.length} positions (max ${this.maxPerCluster})`,
        sizeMultiplier: 0,
        cluster: newCluster,
        clusterPositionCount: clusterPositions.length,
        clusterExposureUsd: clusterExposure,
      };
    }

    // Rule 3: Cluster exposure cap
    const maxExposure = capital * this.maxClusterExposurePct;
    if (capital > 0 && clusterExposure + newSizeUsd > maxExposure) {
      return {
        allowed: false,
        reason: `Cluster '${newCluster}' exposure $${(clusterExposure + newSizeUsd).toFixed(0)} would exceed ${(this.maxClusterExposurePct * 100).toFixed(0)}% cap ($${maxExposure.toFixed(0)})`,
        sizeMultiplier: 0,
        cluster: newCluster,
        clusterPositionCount: clusterPositions.length,
        clusterExposureUsd: clusterExposure,
      };
    }

    // V2: also check dynamic correlation with existing positions outside the static cluster
    let dynamicCorrelatedCount = 0;
    for (const pos of positions) {
      if (getCluster(pos.market) === newCluster) continue; // Already counted in static cluster
      if (this.isDynamicallyCorrelated(newMarket, pos.market)) {
        dynamicCorrelatedCount++;
      }
    }

    // Size reduction: static cluster + dynamic correlation
    const totalCorrelated = clusterPositions.length + dynamicCorrelatedCount;
    let sizeMultiplier = 1.0;
    if (totalCorrelated > 0) {
      // Reduce by 30% for each correlated position (static or dynamic)
      sizeMultiplier = Math.max(0.3, 1.0 - totalCorrelated * 0.3);
    }

    const reason = totalCorrelated > 0
      ? `Correlated exposure: ${clusterPositions.length} cluster + ${dynamicCorrelatedCount} dynamic — size ${(sizeMultiplier * 100).toFixed(0)}%`
      : 'No correlated exposure';

    return {
      allowed: true,
      reason,
      sizeMultiplier,
      cluster: newCluster,
      clusterPositionCount: clusterPositions.length,
      clusterExposureUsd: clusterExposure,
    };
  }

  /**
   * Get cluster info for a market.
   */
  getClusterInfo(market: string): { cluster: string; members: string[] } {
    const cluster = getCluster(market);
    const allClusters = getAllClusters();
    const members = allClusters[cluster] ?? [market.toUpperCase()];
    return { cluster, members };
  }
}

// ─── Pearson Correlation Helper ──────────────────────────────────────────────

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  const r = numerator / denominator;
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : 0;
}
