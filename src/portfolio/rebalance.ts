import { Position, TradeSide } from '../types/index.js';
import { ALLOCATION_LIMITS } from './allocation-engine.js';

export interface RebalanceAction {
  type: 'reduce_collateral' | 'close_position' | 'info';
  market: string;
  side: TradeSide;
  reason: string;
  amount?: number;  // For reduce_collateral: how much to remove
}

export interface RebalanceResult {
  balanced: boolean;
  longPct: number;
  shortPct: number;
  directionalBias: string;
  actions: RebalanceAction[];
}

/**
 * Analyze portfolio balance and suggest rebalancing actions.
 *
 * Rules:
 * - If long exposure > 70% of total → suggest reducing longs or adding shorts
 * - If short exposure > 70% of total → suggest reducing shorts or adding longs
 * - If any single market > 40% concentration → suggest reducing that position
 * - Weakest position (worst PnL%) identified for potential closure
 *
 * This function is pure — it does NOT execute any trades.
 * Rebalance actions are informational suggestions only.
 */
export function analyzeRebalance(
  positions: Position[],
  totalCapital: number,
): RebalanceResult {
  if (positions.length === 0) {
    return {
      balanced: true,
      longPct: 0,
      shortPct: 0,
      directionalBias: 'none',
      actions: [],
    };
  }

  let longExposure = 0;
  let shortExposure = 0;
  const marketExposure = new Map<string, number>();

  for (const pos of positions) {
    if (pos.side === TradeSide.Long) {
      longExposure += pos.sizeUsd;
    } else {
      shortExposure += pos.sizeUsd;
    }
    const current = marketExposure.get(pos.market) ?? 0;
    marketExposure.set(pos.market, current + pos.sizeUsd);
  }

  const totalExposure = longExposure + shortExposure;
  const longPct = totalExposure > 0 ? (longExposure / totalExposure) * 100 : 0;
  const shortPct = totalExposure > 0 ? (shortExposure / totalExposure) * 100 : 0;

  const actions: RebalanceAction[] = [];
  let balanced = true;

  // 1. Directional imbalance check (> 70% in one direction)
  const IMBALANCE_THRESHOLD = 70;

  if (longPct > IMBALANCE_THRESHOLD) {
    balanced = false;
    // Find weakest long position (worst PnL%)
    const longs = positions
      .filter((p) => p.side === TradeSide.Long)
      .sort((a, b) => a.unrealizedPnlPercent - b.unrealizedPnlPercent);

    if (longs.length > 0) {
      const weakest = longs[0];
      actions.push({
        type: 'close_position',
        market: weakest.market,
        side: TradeSide.Long,
        reason: `Long-heavy (${longPct.toFixed(0)}%): close weakest long ${weakest.market} (PnL: ${weakest.unrealizedPnlPercent.toFixed(1)}%)`,
      });
    }
  }

  if (shortPct > IMBALANCE_THRESHOLD) {
    balanced = false;
    const shorts = positions
      .filter((p) => p.side === TradeSide.Short)
      .sort((a, b) => a.unrealizedPnlPercent - b.unrealizedPnlPercent);

    if (shorts.length > 0) {
      const weakest = shorts[0];
      actions.push({
        type: 'close_position',
        market: weakest.market,
        side: TradeSide.Short,
        reason: `Short-heavy (${shortPct.toFixed(0)}%): close weakest short ${weakest.market} (PnL: ${weakest.unrealizedPnlPercent.toFixed(1)}%)`,
      });
    }
  }

  // 2. Concentration check (any market > 40% of total exposure)
  const CONCENTRATION_THRESHOLD = 0.40;
  for (const [market, exposure] of marketExposure.entries()) {
    const pct = totalExposure > 0 ? exposure / totalExposure : 0;
    if (pct > CONCENTRATION_THRESHOLD) {
      balanced = false;
      // Find the position in this market with the smallest PnL
      const marketPositions = positions
        .filter((p) => p.market === market)
        .sort((a, b) => a.unrealizedPnlPercent - b.unrealizedPnlPercent);

      if (marketPositions.length > 0) {
        const target = marketPositions[0];
        const reductionTarget = exposure - totalExposure * ALLOCATION_LIMITS.MAX_MARKET_EXPOSURE;
        actions.push({
          type: 'reduce_collateral',
          market: target.market,
          side: target.side,
          amount: Math.round(Math.max(10, reductionTarget / target.leverage)),
          reason: `${market} concentration ${(pct * 100).toFixed(0)}%: reduce by ~$${Math.round(reductionTarget)}`,
        });
      }
    }
  }

  // 3. Directional bias label
  let directionalBias: string;
  if (longPct > 60) directionalBias = `${(longPct / (shortPct || 1)).toFixed(1)}:1 Long`;
  else if (shortPct > 60) directionalBias = `${(shortPct / (longPct || 1)).toFixed(1)}:1 Short`;
  else directionalBias = 'Balanced';

  return {
    balanced,
    longPct,
    shortPct,
    directionalBias,
    actions,
  };
}
