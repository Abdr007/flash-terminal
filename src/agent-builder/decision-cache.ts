/**
 * Decision Cache Layer
 *
 * Per-market cache for decision components (signals, regime, indicators,
 * opportunity scores, EV checks). LRU eviction, configurable TTL,
 * cache-through pattern, and delta detection for fast-path reuse.
 *
 * Hot path — no external dependencies, no async, minimal allocations.
 */

import type { MarketSnapshot } from './types.js';

// ─── Cache Key Types ─────────────────────────────────────────────────────────

export type DecisionCacheKey =
  | 'signal'
  | 'regime'
  | 'indicators'
  | 'opportunityScore'
  | 'evCheck';

// ─── Cache Entry ─────────────────────────────────────────────────────────────

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

// ─── Delta Snapshot (lightweight fingerprint for change detection) ────────────

interface DeltaFingerprint {
  price: number;
  longOi: number;
  shortOi: number;
  oiRatio: number;
  volume24h: number;
  fundingRate: number | undefined;
  timestamp: number;
}

// ─── Cache Stats ─────────────────────────────────────────────────────────────

export interface DecisionCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  entries: number;
  hitRate: number;
  missRate: number;
}

// ─── Default TTLs (ms) ──────────────────────────────────────────────────────

const DEFAULT_TTL: Record<DecisionCacheKey, number> = {
  signal: 10_000,
  regime: 30_000,
  indicators: 15_000,
  opportunityScore: 10_000,
  evCheck: 20_000,
};

const MAX_ENTRIES_PER_KEY = 200;

// ─── LRU Map ─────────────────────────────────────────────────────────────────
// Thin wrapper over Map that maintains insertion order for LRU eviction.
// Map iteration order in JS is insertion order; we delete-and-reinsert on access.

class LRUMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;
  private _evictions = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, value: V): void {
    // If key exists, delete first to refresh order
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict least recently used (first key)
      const first = this.map.keys().next().value as K;
      this.map.delete(first);
      this._evictions++;
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  get evictions(): number {
    return this._evictions;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  deleteByPrefix(prefix: string): void {
    const toDelete: K[] = [];
    for (const key of this.map.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.map.delete(key);
    }
  }
}

// ─── Decision Cache ──────────────────────────────────────────────────────────

export class DecisionCache {
  private readonly stores = new Map<DecisionCacheKey, LRUMap<string, CacheEntry>>();
  private readonly deltaFingerprints = new Map<string, DeltaFingerprint>();
  private hits = 0;
  private misses = 0;

  constructor() {
    const keys: DecisionCacheKey[] = ['signal', 'regime', 'indicators', 'opportunityScore', 'evCheck'];
    for (const key of keys) {
      this.stores.set(key, new LRUMap<string, CacheEntry>(MAX_ENTRIES_PER_KEY));
    }
  }

  // ─── Core API ────────────────────────────────────────────────────────

  /**
   * Get a cached value. Returns null if expired or missing.
   */
  get<T = unknown>(market: string, key: DecisionCacheKey): T | null {
    const store = this.stores.get(key);
    if (!store) {
      this.misses++;
      return null;
    }

    const entry = store.get(market);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      store.delete(market);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value as T;
  }

  /**
   * Store a value with optional custom TTL.
   */
  set<T = unknown>(market: string, key: DecisionCacheKey, value: T, ttlMs?: number): void {
    const store = this.stores.get(key);
    if (!store) return;

    const now = Date.now();
    const ttl = ttlMs ?? DEFAULT_TTL[key];
    store.set(market, {
      value,
      expiresAt: now + ttl,
      createdAt: now,
    });
  }

  /**
   * Cache-through: return cached value if valid, otherwise compute, cache, and return.
   */
  getOrCompute<T>(
    market: string,
    key: DecisionCacheKey,
    computeFn: () => T,
    ttlMs?: number,
  ): T {
    const cached = this.get<T>(market, key);
    if (cached !== null) return cached;

    const value = computeFn();
    this.set(market, key, value, ttlMs);
    return value;
  }

  /**
   * Invalidate cached entries.
   * - No args: invalidate everything
   * - market only: invalidate all keys for that market
   * - market + key: invalidate specific entry
   * - key only (market undefined): invalidate that key type for all markets
   */
  invalidate(market?: string, key?: DecisionCacheKey): void {
    if (!market && !key) {
      // Clear all
      for (const store of this.stores.values()) {
        store.clear();
      }
      this.deltaFingerprints.clear();
      return;
    }

    if (market && key) {
      // Specific entry
      const store = this.stores.get(key);
      if (store) store.delete(market);
      return;
    }

    if (market && !key) {
      // All keys for this market
      for (const store of this.stores.values()) {
        store.delete(market);
      }
      this.deltaFingerprints.delete(market);
      return;
    }

    if (!market && key) {
      // All markets for this key
      const store = this.stores.get(key);
      if (store) store.clear();
    }
  }

  // ─── Stats ───────────────────────────────────────────────────────────

  /**
   * Return cache performance statistics.
   */
  getStats(): DecisionCacheStats {
    const total = this.hits + this.misses;
    let entries = 0;
    let evictions = 0;
    for (const store of this.stores.values()) {
      entries += store.size;
      evictions += store.evictions;
    }
    return {
      hits: this.hits,
      misses: this.misses,
      evictions,
      entries,
      hitRate: total > 0 ? this.hits / total : 0,
      missRate: total > 0 ? this.misses / total : 0,
    };
  }

  // ─── Delta Detection ─────────────────────────────────────────────────

  /**
   * Returns true if only the price changed since last snapshot (no regime or OI shift).
   * Enables fast-path reuse of regime/indicators/EV when only price ticked.
   *
   * Thresholds:
   *  - OI ratio shift: < 2%
   *  - Volume change: < 5%
   *  - Funding rate: unchanged
   *
   * First call for a market always returns false (no prior fingerprint).
   */
  isDelta(market: string, snapshot: MarketSnapshot): boolean {
    const prev = this.deltaFingerprints.get(market);

    const current: DeltaFingerprint = {
      price: snapshot.price,
      longOi: snapshot.longOi,
      shortOi: snapshot.shortOi,
      oiRatio: snapshot.oiRatio,
      volume24h: snapshot.volume24h,
      fundingRate: snapshot.fundingRate,
      timestamp: snapshot.timestamp,
    };

    // Always update fingerprint
    this.deltaFingerprints.set(market, current);

    if (!prev) return false;

    // Price must have changed (otherwise nothing changed at all)
    if (prev.price === current.price) return false;

    // Check if structural fields are stable
    const oiRatioShift = prev.oiRatio > 0
      ? Math.abs(current.oiRatio - prev.oiRatio) / prev.oiRatio
      : Math.abs(current.oiRatio - prev.oiRatio);

    if (oiRatioShift >= 0.02) return false;

    const volumeShift = prev.volume24h > 0
      ? Math.abs(current.volume24h - prev.volume24h) / prev.volume24h
      : Math.abs(current.volume24h - prev.volume24h);

    if (volumeShift >= 0.05) return false;

    if (prev.fundingRate !== current.fundingRate) return false;

    return true;
  }

  /**
   * Reset all state including stats and fingerprints.
   */
  reset(): void {
    this.invalidate();
    this.hits = 0;
    this.misses = 0;
  }
}
