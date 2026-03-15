/**
 * Pool Live Data
 *
 * Fetches live pool metrics from multiple sources:
 * - fstats.io /pools — FLP/sFLP prices, total volume, total fees
 * - fstats.io /fees/daily — per-pool weekly fee revenue (primary APY source)
 * - fstats.io /volume/daily — per-pool 7D volume (fallback APY: volume × fee rate × LP share)
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

  // Step 2: Compute 7D LP fees per pool
  // fstats /fees/daily pool filter is broken (returns protocol-wide data for all pools).
  // Strategy: fetch protocol-wide 7D LP fees, then distribute by each pool's 7D volume share.
  const weeklyFeesByPool: Record<string, number> = {};
  try {
    // 2a: Fetch protocol-wide 7D LP fees
    let protocolWeeklyLpFees = 0;
    const feesRes = await fetch(`${FSTATS_BASE_URL}/fees/daily?days=7`, { signal: AbortSignal.timeout(5000) });
    if (feesRes.ok) {
      const feesJson = await feesRes.json() as { data?: Array<{ lp_share?: number }> } | Array<{ lp_share?: number }>;
      const feesDays = Array.isArray(feesJson) ? feesJson : feesJson.data ?? [];
      protocolWeeklyLpFees = feesDays.reduce((sum, d) => sum + (d.lp_share ?? 0), 0);
    }

    if (protocolWeeklyLpFees > 0) {
      // 2b: Fetch 7D volume per pool to determine each pool's share
      const poolVolumes: Record<string, number> = {};
      let totalWeeklyVolume = 0;

      await Promise.all(registry.map(async (pool) => {
        try {
          const res = await fetch(
            `${FSTATS_BASE_URL}/volume/daily?days=7&pool=${encodeURIComponent(pool.poolId)}`,
            { signal: AbortSignal.timeout(4000) },
          );
          if (!res.ok) return;
          const json = await res.json() as { data?: Array<{ volume_usd?: number }> } | Array<{ volume_usd?: number }>;
          const days = Array.isArray(json) ? json : json.data ?? [];
          const vol = days.reduce((sum, d) => sum + (d.volume_usd ?? 0), 0);
          if (vol > 0) {
            poolVolumes[pool.poolId] = vol;
            totalWeeklyVolume += vol;
          }
        } catch { /* non-critical */ }
      }));

      // 2c: Distribute protocol LP fees by volume share, adjusted for each pool's fee rate
      if (totalWeeklyVolume > 0) {
        // Weight by volume × pool fee rate (pools with higher fees earn more per dollar of volume)
        const weights: Record<string, number> = {};
        let totalWeight = 0;
        for (const pool of registry) {
          const vol = poolVolumes[pool.poolId] ?? 0;
          if (vol <= 0) continue;
          const prices = poolPrices[pool.poolId];
          const feeRate = (prices?.vol ?? 0) > 0 && (prices?.fees ?? 0) > 0
            ? (prices.fees / prices.vol)
            : 0.0007;
          const w = vol * feeRate;
          weights[pool.poolId] = w;
          totalWeight += w;
        }
        for (const pool of registry) {
          const w = weights[pool.poolId] ?? 0;
          if (w > 0 && totalWeight > 0) {
            weeklyFeesByPool[pool.poolId] = protocolWeeklyLpFees * (w / totalWeight);
          }
        }
        logger.debug('EARN', `Protocol 7D LP fees: $${protocolWeeklyLpFees.toFixed(0)}, distributed across ${Object.keys(poolVolumes).length} pools`);
      }
    }
  } catch { logger.debug('EARN', 'Fee distribution calculation failed'); }

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
