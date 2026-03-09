/**
 * Protocol Fee & Margin Utilities
 *
 * Provides fee rate and maintenance margin resolution from CustodyAccount via Flash SDK.
 * All fee and margin calculations in the CLI (preview, simulation, execution)
 * must use this module for consistency.
 *
 * Data sources:
 *   Fees:              CustodyAccount.fees.openPosition / RATE_POWER
 *   MaintenanceMargin: CustodyAccount.pricing.maintenanceMargin / BPS_POWER
 * Fallback: Flash SDK constants (only if on-chain fetch fails)
 *
 * Cache invalidation: slot-based — entries expire when Solana slot advances
 * beyond the slot at cache time + SLOT_STALE_THRESHOLD.
 */

const RATE_POWER = 1_000_000_000; // Flash SDK RATE_DECIMALS = 9
const BPS_POWER = 10_000;         // Flash SDK BPS_DECIMALS = 4

export interface ProtocolFeeRates {
  openFeeRate: number;            // e.g. 0.0008 = 0.08%
  closeFeeRate: number;           // e.g. 0.0008 = 0.08%
  maintenanceMarginRate: number;  // e.g. 0.01 = 1% (from custodyAcct.pricing.maintenanceMargin)
  source: 'on-chain' | 'sdk-default';
}

// Cache: market -> { rates, cachedAtSlot }
interface CacheEntry {
  rates: ProtocolFeeRates;
  cachedAtSlot: number;
}
const feeCache = new Map<string, CacheEntry>();

/** Cache is stale after slot advances this many slots beyond cached slot.
 *  ~150 slots ≈ 60s at Solana's ~400ms slot time. */
const SLOT_STALE_THRESHOLD = 150;
/** Fallback TTL: if we can't get current slot, expire after 60s */
const FALLBACK_TTL_MS = 60_000;
/** Track last known slot + timestamp for fallback expiry */
let lastKnownSlot = 0;
let lastSlotFetchTime = 0;

/**
 * Get the current Solana slot for cache invalidation.
 * Uses RpcManager if available, otherwise returns 0 (triggers time-based fallback).
 */
async function getCurrentSlot(): Promise<number> {
  try {
    const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
    const mgr = getRpcManagerInstance();
    if (mgr) {
      const slot = await mgr.connection.getSlot('confirmed');
      if (Number.isFinite(slot) && slot > 0) {
        lastKnownSlot = slot;
        lastSlotFetchTime = Date.now();
        return slot;
      }
    }
  } catch {
    // Slot fetch failed — use fallback
  }
  return 0;
}

/**
 * Check if a cache entry is still fresh.
 * Primary: slot-based (stale after SLOT_STALE_THRESHOLD slots).
 * Fallback: time-based (60s TTL) when slot unavailable.
 */
function isCacheFresh(entry: CacheEntry, currentSlot: number): boolean {
  if (currentSlot > 0 && entry.cachedAtSlot > 0) {
    return (currentSlot - entry.cachedAtSlot) < SLOT_STALE_THRESHOLD;
  }
  // Fallback: time-based using last slot fetch time
  if (lastSlotFetchTime > 0) {
    return (Date.now() - lastSlotFetchTime) < FALLBACK_TTL_MS;
  }
  // No slot info at all — treat as stale
  return false;
}

/**
 * Fetch fee rates and maintenance margin from CustodyAccount via Flash SDK.
 * Uses perpClient.program.account.custody.fetch() for on-chain data.
 *
 * Cache invalidation: slot-based (entries expire ~60s after cached slot).
 *
 * @param market - Market symbol (e.g. 'SOL')
 * @param perpClient - Flash SDK PerpetualsClient (or null for default)
 * @returns ProtocolFeeRates with source annotation
 */
export async function getProtocolFeeRates(
  market: string,
  perpClient: unknown | null,
): Promise<ProtocolFeeRates> {
  const upper = market.toUpperCase();

  // Check cache with slot-based invalidation
  const cached = feeCache.get(upper);
  if (cached) {
    const currentSlot = await getCurrentSlot();
    if (isCacheFresh(cached, currentSlot)) {
      return cached.rates;
    }
  }

  // Attempt on-chain fetch
  if (perpClient) {
    try {
      const { PoolConfig } = await import('flash-sdk');
      const { getPoolForMarket } = await import('../config/index.js');
      const poolName = getPoolForMarket(upper);
      if (poolName) {
        const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
        const custodies = pc.custodies as Array<{ custodyAccount: any; symbol: string }>;
        const custody = custodies.find(c => c.symbol.toUpperCase() === upper);
        if (custody) {
          const client = perpClient as any;
          const custodyAcct = await client.program.account.custody.fetch(custody.custodyAccount);
          const openFeeRaw = parseFloat(custodyAcct.fees.openPosition.toString());
          const closeFeeRaw = parseFloat(custodyAcct.fees.closePosition.toString());
          const maintenanceMarginRaw = parseFloat(custodyAcct.pricing.maintenanceMargin.toString());

          if (Number.isFinite(openFeeRaw) && openFeeRaw > 0 &&
              Number.isFinite(closeFeeRaw) && closeFeeRaw > 0) {
            const rates: ProtocolFeeRates = {
              openFeeRate: openFeeRaw / RATE_POWER,
              closeFeeRate: closeFeeRaw / RATE_POWER,
              maintenanceMarginRate: (Number.isFinite(maintenanceMarginRaw) && maintenanceMarginRaw > 0)
                ? maintenanceMarginRaw / BPS_POWER
                : 0.01, // default 1% (100 BPS / 10000)
              source: 'on-chain',
            };

            const cacheSlot = lastKnownSlot > 0 ? lastKnownSlot : 0;
            feeCache.set(upper, { rates, cachedAtSlot: cacheSlot });

            // Bound cache size
            if (feeCache.size > 50) {
              const oldest = feeCache.keys().next().value;
              if (oldest) feeCache.delete(oldest);
            }

            return rates;
          }
        }
      }
    } catch {
      // Fall through to SDK default
    }
  }

  // SDK default: 0.08% fee (8 BPS), 1% maintenance margin (100 BPS)
  const defaultRates: ProtocolFeeRates = {
    openFeeRate: 0.0008,
    closeFeeRate: 0.0008,
    maintenanceMarginRate: 0.01,
    source: 'sdk-default',
  };
  return defaultRates;
}

/**
 * Calculate fee in USD for a given position size and fee rate.
 */
export function calcFeeUsd(sizeUsd: number, feeRate: number): number {
  if (!Number.isFinite(sizeUsd) || !Number.isFinite(feeRate) || sizeUsd <= 0 || feeRate <= 0) {
    return 0;
  }
  return sizeUsd * feeRate;
}

/** RATE_POWER and BPS_POWER exported for direct CustodyAccount parsing */
export { RATE_POWER, BPS_POWER };
