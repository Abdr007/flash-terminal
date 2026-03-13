/**
 * Address Lookup Table (ALT) Resolver
 *
 * Loads and caches Address Lookup Tables from the Flash SDK.
 * ALTs compress account references from 32 bytes to 1 byte,
 * critical for fitting multi-instruction transactions within
 * the 1232-byte limit.
 */

import type { AddressLookupTableAccount } from '@solana/web3.js';
import type { PoolConfig } from 'flash-sdk';
import { getLogger } from '../utils/logger.js';

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CachedALT {
  tables: AddressLookupTableAccount[];
  fetchedAt: number;
}

const altCache = new Map<string, CachedALT>();
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

/**
 * Resolve Address Lookup Tables for a pool.
 * Uses the SDK's built-in ALT loader with a TTL cache.
 *
 * @param perpClient  Flash SDK PerpetualsClient instance
 * @param poolConfig  Pool configuration
 * @returns           ALT accounts (empty array on failure — graceful degradation)
 */
export async function resolveALTs(
  perpClient: { getOrLoadAddressLookupTable: (poolConfig: PoolConfig) => Promise<{ addressLookupTables: AddressLookupTableAccount[] }> },
  poolConfig: PoolConfig,
): Promise<AddressLookupTableAccount[]> {
  const logger = getLogger();
  const cacheKey = poolConfig.poolName;

  // Check cache
  const cached = altCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.tables;
  }

  try {
    const { addressLookupTables } = await perpClient.getOrLoadAddressLookupTable(poolConfig);
    altCache.set(cacheKey, { tables: addressLookupTables, fetchedAt: Date.now() });
    logger.debug('ALT', `Loaded ${addressLookupTables.length} ALTs for ${cacheKey}`);
    return addressLookupTables;
  } catch (err: unknown) {
    logger.debug('ALT', `Failed to load ALTs for ${cacheKey}: ${err}`);
    // Graceful degradation — compile without ALTs
    return [];
  }
}

/** Clear the ALT cache (for testing or manual refresh). */
export function clearALTCache(): void {
  altCache.clear();
}
