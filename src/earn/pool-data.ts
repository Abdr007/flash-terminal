/**
 * Pool Live Data
 *
 * Fetches live pool metrics from multiple sources:
 * - fstats.io /pools — FLP/sFLP prices, volume, fees
 * - fstats.io /fees/daily — per-pool weekly fee revenue
 * - Solana RPC — FLP/sFLP token supply for TVL calculation
 *
 * APY = (7D LP fees / TVL) * 52 * 100 (annualized)
 * TVL = (FLP supply * FLP price) + (sFLP supply * sFLP price)
 */

import { Connection } from '@solana/web3.js';
import { getPoolRegistry } from './pool-registry.js';
import { FSTATS_BASE_URL } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

const CACHE_TTL_MS = 10_000;

export interface PoolMetrics {
  poolId: string;
  tvl: number;
  apy7d: number;
  apr7d: number;
  flpPrice: number;
  sflpPrice: number;
  totalVolume: number;
  totalFees: number;
  totalTrades: number;
  feeShareLp: number;
  weeklyLpFees: number;
}

interface CachedMetrics {
  data: Map<string, PoolMetrics>;
  fetchedAt: number;
}

let _cache: CachedMetrics | null = null;
let _rpcConnection: Connection | null = null;

/** Set the RPC connection for on-chain queries. */
export function setPoolDataConnection(conn: Connection): void {
  _rpcConnection = conn;
}

/** Fetch pool metrics with TVL and APY. */
export async function getPoolMetrics(): Promise<Map<string, PoolMetrics>> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.data;
  }

  const logger = getLogger();
  const metrics = new Map<string, PoolMetrics>();
  const registry = getPoolRegistry();

  // Step 1: Fetch pool prices from fstats /pools
  const poolPrices: Record<string, { flp: number; sflp: number; vol: number; fees: number; trades: number; lpShare: number }> = {};
  try {
    const res = await fetch(`${FSTATS_BASE_URL}/pools`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const json = await res.json() as { pools?: Array<{ name?: string; lp_price_compounding?: number; lp_price_regular?: number; total_volume_usd?: number; total_fees_usd?: number; total_trades?: number; fee_split?: { lp?: number } }> };
      if (json.pools) {
        for (const p of json.pools) {
          if (!p.name || p.name.startsWith('Remora')) continue;
          poolPrices[p.name] = {
            flp: p.lp_price_compounding ?? 0,
            sflp: p.lp_price_regular ?? 0,
            vol: p.total_volume_usd ?? 0,
            fees: p.total_fees_usd ?? 0,
            trades: p.total_trades ?? 0,
            lpShare: p.fee_split?.lp ?? 70,
          };
        }
      }
    }
  } catch { logger.debug('EARN', 'fstats /pools unavailable'); }

  // Step 2: Fetch 7D per-pool fees from fstats /fees/daily
  const weeklyFeesByPool: Record<string, number> = {};
  for (const pool of registry) {
    try {
      const res = await fetch(`${FSTATS_BASE_URL}/fees/daily?days=7&pool=${encodeURIComponent(pool.poolId)}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json() as Array<{ lp_share?: number }>;
        if (Array.isArray(data)) {
          weeklyFeesByPool[pool.poolId] = data.reduce((sum, d) => sum + (d.lp_share ?? 0), 0);
        }
      }
    } catch { /* non-critical */ }
  }

  // Step 3: Fetch token supplies from RPC for TVL
  const conn = _rpcConnection;
  for (const pool of registry) {
    const prices = poolPrices[pool.poolId];
    const flpPrice = prices?.flp ?? 0;
    const sflpPrice = prices?.sflp ?? 0;

    let tvl = 0;
    if (conn && flpPrice > 0) {
      try {
        const [flpSupply, sflpSupply] = await Promise.all([
          conn.getTokenSupply(pool.flpMint).then(s => s.value.uiAmount ?? 0).catch(() => 0),
          conn.getTokenSupply(pool.sflpMint).then(s => s.value.uiAmount ?? 0).catch(() => 0),
        ]);
        tvl = (flpSupply * flpPrice) + (sflpSupply * sflpPrice);
      } catch { /* non-critical */ }
    }

    // APY = (weeklyLpFees / TVL) * 52 * 100
    const weeklyFees = weeklyFeesByPool[pool.poolId] ?? 0;
    const apy7d = tvl > 0 && weeklyFees > 0 ? (weeklyFees / tvl) * 52 * 100 : 0;
    // APR ≈ APY for staked (sFLP gets fees directly, not compounded)
    const apr7d = apy7d; // Close approximation

    metrics.set(pool.poolId, {
      poolId: pool.poolId,
      tvl,
      apy7d: Math.round(apy7d * 100) / 100,
      apr7d: Math.round(apr7d * 100) / 100,
      flpPrice,
      sflpPrice,
      totalVolume: prices?.vol ?? 0,
      totalFees: prices?.fees ?? 0,
      totalTrades: prices?.trades ?? 0,
      feeShareLp: prices?.lpShare ?? pool.feeShare * 100,
      weeklyLpFees: weeklyFees,
    });
  }

  _cache = { data: metrics, fetchedAt: Date.now() };
  return metrics;
}

export async function getPoolMetric(poolId: string): Promise<PoolMetrics | null> {
  const all = await getPoolMetrics();
  return all.get(poolId) ?? null;
}

export function clearPoolMetricsCache(): void {
  _cache = null;
}
