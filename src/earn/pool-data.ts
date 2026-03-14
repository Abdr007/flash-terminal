/**
 * Pool Live Data
 *
 * Fetches live pool metrics from fstats.io API.
 * Uses the /pools endpoint which returns FLP/sFLP prices and fee data.
 *
 * TVL and APY are not directly available from fstats — the Flash UI
 * computes these from on-chain pool accounts. We fetch what's available
 * and display "data unavailable" for metrics we can't source live.
 */

import { getPoolRegistry } from './pool-registry.js';
import { FSTATS_BASE_URL } from '../config/index.js';

const CACHE_TTL_MS = 10_000; // 10s — short-lived to avoid stale data

export interface PoolMetrics {
  poolId: string;
  tvl: number;
  apy7d: number;
  apr7d: number;
  flpPrice: number;
  sflpPrice: number;
  volume24h: number;
  totalVolume: number;
  totalFees: number;
  totalTrades: number;
  feeShareLp: number;
}

interface CachedMetrics {
  data: Map<string, PoolMetrics>;
  fetchedAt: number;
}

let _cache: CachedMetrics | null = null;

/** Fetch pool metrics from fstats.io /pools endpoint. */
export async function getPoolMetrics(): Promise<Map<string, PoolMetrics>> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.data;
  }

  const metrics = new Map<string, PoolMetrics>();

  try {
    const res = await fetch(`${FSTATS_BASE_URL}/pools`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = await res.json() as {
        pools?: Array<{
          name: string;
          fee_split?: { lp?: number };
          total_trades?: number;
          total_volume_usd?: number;
          total_fees_usd?: number;
          pool_pnl_usd?: number;
          pool_revenue_usd?: number;
          lp_price_regular?: number;
          lp_price_compounding?: number;
        }>;
      };

      if (json.pools && Array.isArray(json.pools)) {
        for (const pool of json.pools) {
          if (!pool.name) continue;
          // Skip Remora (internal/devnet pool)
          if (pool.name.startsWith('Remora')) continue;

          metrics.set(pool.name, {
            poolId: pool.name,
            tvl: 0, // Not available from fstats — would need on-chain AUM query
            apy7d: 0, // Not available from fstats — would need historical fee data
            apr7d: 0,
            flpPrice: pool.lp_price_compounding ?? 0,
            sflpPrice: pool.lp_price_regular ?? 0,
            volume24h: 0,
            totalVolume: pool.total_volume_usd ?? 0,
            totalFees: pool.total_fees_usd ?? 0,
            totalTrades: pool.total_trades ?? 0,
            feeShareLp: pool.fee_split?.lp ?? 70,
          });
        }
      }
    }
  } catch {
    if (_cache) return _cache.data;
  }

  // Fill in any registered pools that fstats didn't return
  if (metrics.size > 0) {
    const registry = getPoolRegistry();
    for (const pool of registry) {
      if (!metrics.has(pool.poolId)) {
        metrics.set(pool.poolId, {
          poolId: pool.poolId,
          tvl: 0, apy7d: 0, apr7d: 0,
          flpPrice: 0, sflpPrice: 0, volume24h: 0,
          totalVolume: 0, totalFees: 0, totalTrades: 0,
          feeShareLp: pool.feeShare * 100,
        });
      }
    }
  }

  _cache = { data: metrics, fetchedAt: Date.now() };
  return metrics;
}

/** Get metrics for a specific pool. */
export async function getPoolMetric(poolId: string): Promise<PoolMetrics | null> {
  const all = await getPoolMetrics();
  return all.get(poolId) ?? null;
}

/** Clear the metrics cache. */
export function clearPoolMetricsCache(): void {
  _cache = null;
}
