/**
 * Portfolio Intelligence — Prevent correlated trades and concentration risk.
 *
 * Rules:
 * 1. No 2 positions on same direction in correlated assets
 * 2. Max exposure per sector/group
 * 3. Track total directional exposure
 */

import type { Position } from '../sdk/types.js';
import { getMarketGroup, getAllGroups } from '../markets/index.js';

// ─── Asset Groups (correlated assets) ────────────────────────────────────────
// Loaded dynamically from Market Registry (SDK source of truth).
// New markets are auto-classified into groups based on type/pool.

function getGroup(market: string): string {
  return getMarketGroup(market);
}

/** Get all group definitions (for display/diagnostics). */
export function getGroups(): Record<string, string[]> {
  return getAllGroups();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PortfolioCheck {
  allowed: boolean;
  reason: string;
  totalLongExposure: number;
  totalShortExposure: number;
  netExposure: number;
  groupExposure: Record<string, number>;
}

// ─── Portfolio Intelligence ──────────────────────────────────────────────────

export class PortfolioIntel {
  /** Max positions in same asset group */
  private readonly maxPerGroup: number;
  /** Max directional exposure as % of capital */
  private readonly maxDirectionalPct: number;

  constructor(maxPerGroup = 1, maxDirectionalPct = 0.20) {
    this.maxPerGroup = maxPerGroup;
    this.maxDirectionalPct = maxDirectionalPct;
  }

  /**
   * Check if a new trade would create dangerous portfolio concentration.
   */
  check(
    positions: Position[],
    newMarket: string,
    newSide: 'long' | 'short',
    newSizeUsd: number,
    capital: number,
  ): PortfolioCheck {
    // Calculate current exposure
    let totalLong = 0;
    let totalShort = 0;
    const groupCount: Record<string, { count: number; exposure: number }> = {};

    for (const pos of positions) {
      const size = pos.sizeUsd ?? 0;
      if (pos.side === 'long') totalLong += size;
      else totalShort += size;

      const group = getGroup(pos.market);
      if (!groupCount[group]) groupCount[group] = { count: 0, exposure: 0 };
      groupCount[group].count++;
      groupCount[group].exposure += size;
    }

    // Add proposed trade
    const newGroup = getGroup(newMarket);
    if (newSide === 'long') totalLong += newSizeUsd;
    else totalShort += newSizeUsd;

    if (!groupCount[newGroup]) groupCount[newGroup] = { count: 0, exposure: 0 };

    const netExposure = totalLong - totalShort;
    const totalExposure = totalLong + totalShort;
    const groupExposure: Record<string, number> = {};
    for (const [g, data] of Object.entries(groupCount)) {
      groupExposure[g] = capital > 0 ? data.exposure / capital : 0;
    }

    // Check 1: Group concentration — no more than N positions in same group
    if (groupCount[newGroup].count >= this.maxPerGroup) {
      return {
        allowed: false,
        reason: `Group '${newGroup}' already has ${groupCount[newGroup].count} position(s) (max ${this.maxPerGroup})`,
        totalLongExposure: totalLong, totalShortExposure: totalShort, netExposure, groupExposure,
      };
    }

    // Check 2: Correlated direction — don't short SOL if already short BTC (both major crypto)
    const sameGroupPositions = positions.filter((p) => getGroup(p.market) === newGroup);
    const sameDirectionInGroup = sameGroupPositions.some((p) => p.side === newSide);
    if (sameDirectionInGroup && newGroup !== 'standalone' && newGroup !== 'unknown') {
      return {
        allowed: false,
        reason: `Already ${newSide} in '${newGroup}' group — correlated risk`,
        totalLongExposure: totalLong, totalShortExposure: totalShort, netExposure, groupExposure,
      };
    }

    // Check 3: Total directional exposure
    const maxExposure = capital * this.maxDirectionalPct;
    if (totalExposure > maxExposure) {
      return {
        allowed: false,
        reason: `Total exposure $${totalExposure.toFixed(0)} exceeds ${(this.maxDirectionalPct * 100).toFixed(0)}% cap ($${maxExposure.toFixed(0)})`,
        totalLongExposure: totalLong, totalShortExposure: totalShort, netExposure, groupExposure,
      };
    }

    return {
      allowed: true,
      reason: 'Portfolio check passed',
      totalLongExposure: totalLong, totalShortExposure: totalShort, netExposure, groupExposure,
    };
  }
}
