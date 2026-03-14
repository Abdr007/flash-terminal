/**
 * Pool Live Data
 *
 * Fetches live pool metrics (TVL, APY, token prices) from fstats.io API.
 * Cached for 30 seconds to avoid excessive requests.
 */

import { getPoolRegistry, PoolInfo } from './pool-registry.js';

const FSTATS_BASE = 'https://fstats.io/api/v1';
const CACHE_TTL_MS = 30_000;

export interface PoolMetrics {
  poolId: string;
  tvl: number;
  apy7d: number;
  apr7d: number;
  flpPrice: number;
  sflpPrice: number;
  volume24h: number;
}

interface CachedMetrics {
  data: Map<string, PoolMetrics>;
  fetchedAt: number;
}

let _cache: CachedMetrics | null = null;

/** Fetch pool metrics from fstats.io. Returns cached data if fresh. */
export async function getPoolMetrics(): Promise<Map<string, PoolMetrics>> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.data;
  }

  const metrics = new Map<string, PoolMetrics>();

  try {
    const res = await fetch(`${FSTATS_BASE}/pool-stats`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json() as Array<{
        pool_name?: string;
        tvl?: number;
        apy_7d?: number;
        apr_7d?: number;
        flp_price?: number;
        sflp_price?: number;
        volume_24h?: number;
      }>;
      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item.pool_name) continue;
          metrics.set(item.pool_name, {
            poolId: item.pool_name,
            tvl: item.tvl ?? 0,
            apy7d: item.apy_7d ?? 0,
            apr7d: item.apr_7d ?? 0,
            flpPrice: item.flp_price ?? 0,
            sflpPrice: item.sflp_price ?? 0,
            volume24h: item.volume_24h ?? 0,
          });
        }
      }
    }
  } catch {
    // API unavailable — return empty or stale cache
    if (_cache) return _cache.data;
  }

  // If fstats didn't return data, try SDK fallback for prices
  if (metrics.size === 0) {
    const registry = getPoolRegistry();
    for (const pool of registry) {
      metrics.set(pool.poolId, {
        poolId: pool.poolId,
        tvl: 0,
        apy7d: 0,
        apr7d: 0,
        flpPrice: 0,
        sflpPrice: 0,
        volume24h: 0,
      });
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
