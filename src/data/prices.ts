import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

export interface TokenPrice {
  symbol: string;
  price: number;
  priceChange24h: number;
  timestamp: number;
  isFallback: boolean;
}

// Pyth Hermes feed IDs (hex) — source: hermes.pyth.network/v2/price_feeds
// Single source of truth for all Flash Trade market prices.
const PYTH_FEED_IDS: Record<string, string> = {
  // Crypto
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  BNB: '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
  ZEC: '0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24',
  JTO: '0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2',
  JUP: '0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
  PYTH: '0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff',
  RAY: '0x91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a',
  BONK: '0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
  WIF: '0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
  PENGU: '0xbed3097008b9b5e3c93bec20be79cb43986b85a996475589351a21e67bae9b61',
  ORE: '0x142b804c658e14ff60886783e46e5a51bdf398b4871d9d8f7c28aa1585cad504',
  HYPE: '0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b',
  FARTCOIN: '0x58cd29ef0e714c5affc44f269b2c1899a52da4169d7acc147b9da692e6953608',
  KMNO: '0xb17e5bc5de742a8a378b54c9c75442b7d51e30ada63f28d9bd28d3c0e26511a0',
  MET: '0x0292e0f405bcd4a496d34e48307f6787349ad2bcd8505c3d3a9f77d81a67a682',
  PUMP: '0x7a01fca212788bba7c5bf8c9efd576a8a722f070d2c17596ff7bb609b8d5c3b9',
  // Commodities
  XAU: '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
  XAG: '0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e',
  CRUDEOIL: '0x925ca92ff005ae943c158e3563f59698ce7e75c5a8c8dd43303a0a154887b3e6',
  // Forex
  EUR: '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b',
  GBP: '0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1',
  USDJPY: '0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52',
  USDCNH: '0xeef52e09c878ad41f6a81803e3640fe04dceea727de894edd4ea117e2e332e66',
  // US Equities
  SPY: '0x5374a7d76a45ae2443cef351d10482b7bcc6ef5a928e75030d63b5fb3abe7cb5',
  NVDA: '0x61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6',
  TSLA: '0x42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a',
  AAPL: '0x5a207c4aa0114baecf852fcd9db9beb8ec715f2db48caa525dbd878fd416fb09',
  AMD: '0x7178689d88cdd76574b64438fc57f4e57efaf0bf5f9593ee19c10e46a3c5b5cf',
  AMZN: '0x82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f',
  PLTR: '0x3a4c922ec7e8cd86a6fa4005827e723a134a16f4ffe836eac91e7820c61f75a1',
};

// Non-crypto markets — cannot get 24h change from DexScreener
const NON_CRYPTO_MARKETS = new Set([
  'XAU', 'XAG', 'CRUDEOIL', 'EUR', 'GBP', 'USDJPY', 'USDCNH',
  'SPY', 'NVDA', 'TSLA', 'AAPL', 'AMD', 'AMZN', 'PLTR',
]);

const FETCH_TIMEOUT_MS = 8_000;
const MAX_PRICE_CACHE_ENTRIES = 100;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1MB max

// 24h price history: record price snapshots, compute real 24h change from Pyth data.
const HISTORY_INTERVAL_MS = 5 * 60_000; // record every 5 minutes
const HISTORY_WINDOW_MS = 24 * 60 * 60_000; // 24 hours
const MAX_HISTORY_PER_SYMBOL = 300; // ~25h at 5min intervals
const DISK_SAVE_INTERVAL_MS = 5 * 60_000; // persist to disk every 5 minutes
const HISTORY_FILE = join(homedir(), '.flash', 'price-history.json');
const MAX_HISTORY_FILE_BYTES = 2 * 1024 * 1024; // 2MB max file size

interface PythParsedPrice {
  id: string;
  price: { price: string; expo: number; publish_time: number };
  ema_price: { price: string; expo: number };
}

interface PriceSnapshot {
  price: number;
  timestamp: number;
}

// Disk format: { version, lastSaved, symbols: { SYM: [{ price, timestamp }, ...] } }
interface HistoryFile {
  version: 1;
  lastSaved: number;
  symbols: Record<string, PriceSnapshot[]>;
}

// Module-level shared state — all PriceService instances share the same history.
// This ensures history accumulates regardless of which instance records/reads it,
// and any instance can flush to disk on shutdown.
const _sharedHistory: Map<string, PriceSnapshot[]> = new Map();
let _lastHistoryRecord = 0;
let _lastDiskSave = 0;
let _historyLoaded = false;

/** Check if a market is non-crypto (commodities, forex, equities) — no DexScreener data available. */
export function isNonCryptoMarket(symbol: string): boolean {
  return NON_CRYPTO_MARKETS.has(symbol.toUpperCase());
}

/** Get the Pyth feed ID for a market symbol (for diagnostics). */
export function getPythFeedId(symbol: string): string | null {
  return PYTH_FEED_IDS[symbol.toUpperCase()] ?? null;
}

export class PriceService {
  private cache: Map<string, { data: TokenPrice; expiry: number }> = new Map();
  private cacheTtlMs = 5_000; // 5s cache — Pyth is free, no rate limiting concern
  private lastMissingWarnTime = 0;
  private static readonly MISSING_WARN_INTERVAL_MS = 60_000;

  async getPrices(symbols: string[]): Promise<Map<string, TokenPrice>> {
    const priceMap = new Map<string, TokenPrice>();
    const now = Date.now();
    const logger = getLogger();

    // Load persisted history on first call (shared across all instances)
    if (!_historyLoaded) {
      this.loadHistoryFromDisk();
      _historyLoaded = true;
    }

    // Check cache first
    const uncached: string[] = [];
    for (const sym of symbols) {
      const upper = sym.toUpperCase();
      const cached = this.cache.get(upper);
      if (cached && cached.expiry > now) {
        priceMap.set(upper, cached.data);
      } else {
        uncached.push(upper);
      }
    }

    if (uncached.length === 0) return priceMap;

    // Evict expired entries if cache is full
    if (this.cache.size >= MAX_PRICE_CACHE_ENTRIES) {
      const expired = Array.from(this.cache.entries())
        .filter(([, entry]) => entry.expiry <= now);
      const toDelete = expired.slice(0, Math.max(10, expired.length - MAX_PRICE_CACHE_ENTRIES / 2));
      for (const [k] of toDelete) this.cache.delete(k);
    }

    // Fetch from Pyth Hermes
    try {
      logger.debug('PRICE', `Fetching prices from Pyth Hermes for: ${uncached.join(', ')}`);
      const fetched = await this.fetchFromPyth(uncached);
      for (const tp of fetched) {
        priceMap.set(tp.symbol, tp);
        this.cache.set(tp.symbol, { data: tp, expiry: now + this.cacheTtlMs });
      }
      logger.info('PRICE', `Fetched ${fetched.length} prices from Pyth Hermes`);
    } catch (error: unknown) {
      logger.warn('PRICE', `Pyth Hermes fetch failed: ${getErrorMessage(error)}`);
    }

    // Record price history for 24h change computation
    this.recordPriceHistory(priceMap, now);

    // Stale cache fallback for missing symbols
    const missing = uncached.filter(sym => !priceMap.has(sym));
    if (missing.length > 0) {
      for (const sym of missing) {
        const stale = this.cache.get(sym);
        if (stale) {
          priceMap.set(sym, stale.data);
        }
      }

      const trulyMissing = missing.filter(sym => !priceMap.has(sym));
      if (trulyMissing.length > 0 && now - this.lastMissingWarnTime >= PriceService.MISSING_WARN_INTERVAL_MS) {
        logger.warn('PRICE', `No live price for ${trulyMissing.length} market(s): ${trulyMissing.join(', ')} — excluded from analysis`);
        this.lastMissingWarnTime = now;
      }
    }

    return priceMap;
  }

  async getPrice(symbol: string): Promise<TokenPrice | null> {
    const prices = await this.getPrices([symbol]);
    return prices.get(symbol.toUpperCase()) ?? null;
  }

  private async fetchFromPyth(symbols: string[]): Promise<TokenPrice[]> {
    const feedIds: string[] = [];
    const idToSymbol = new Map<string, string>();
    for (const sym of symbols) {
      const feedId = PYTH_FEED_IDS[sym];
      if (feedId) {
        feedIds.push(feedId);
        idToSymbol.set(feedId.slice(2), sym);
      }
    }

    if (feedIds.length === 0) return [];

    const params = feedIds.map(id => `ids[]=${id}`).join('&');
    const url = `https://hermes.pyth.network/v2/updates/price/latest?${params}&parsed=true`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Pyth Hermes ${res.status}: ${res.statusText}`);
      }

      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        throw new Error(`Pyth response too large: ${contentLength} bytes`);
      }

      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error(`Pyth response body too large: ${text.length} bytes`);
      }

      const data = JSON.parse(text) as { parsed?: PythParsedPrice[] };
      const results: TokenPrice[] = [];
      const now = Date.now();

      for (const entry of data.parsed ?? []) {
        const sym = idToSymbol.get(entry.id);
        if (!sym) continue;

        const price = parseInt(entry.price.price, 10) * Math.pow(10, entry.price.expo);
        if (!Number.isFinite(price) || price <= 0) continue;

        // Price deviation circuit breaker — reject >50% jumps from cached value
        const cached = this.cache.get(sym);
        if (cached && cached.data.price > 0) {
          const deviation = Math.abs(price - cached.data.price) / cached.data.price;
          if (deviation > 0.5) {
            getLogger().warn('PRICE', `Rejecting suspicious price for ${sym}: $${price} vs cached $${cached.data.price.toFixed(2)} (${(deviation * 100).toFixed(0)}% deviation)`);
            continue;
          }
        }

        const priceChange24h = this.compute24hChange(sym, price);

        results.push({
          symbol: sym,
          price,
          priceChange24h,
          timestamp: now,
          isFallback: false,
        });
      }

      return results;
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordPriceHistory(prices: Map<string, TokenPrice>, now: number): void {
    // Only record every HISTORY_INTERVAL_MS to keep memory bounded
    if (now - _lastHistoryRecord < HISTORY_INTERVAL_MS) return;
    _lastHistoryRecord = now;

    for (const [sym, tp] of prices) {
      if (!Number.isFinite(tp.price) || tp.price <= 0) continue;

      let history = _sharedHistory.get(sym);
      if (!history) {
        history = [];
        _sharedHistory.set(sym, history);
      }

      history.push({ price: tp.price, timestamp: now });

      // Evict old entries beyond 24h window + trim to max size
      while (history.length > 0 && history[0].timestamp < now - HISTORY_WINDOW_MS) {
        history.shift();
      }
      if (history.length > MAX_HISTORY_PER_SYMBOL) {
        history.splice(0, history.length - MAX_HISTORY_PER_SYMBOL);
      }
    }

    // Bound total symbols tracked in history
    if (_sharedHistory.size > MAX_PRICE_CACHE_ENTRIES) {
      const keys = Array.from(_sharedHistory.keys());
      for (let i = 0; i < keys.length - MAX_PRICE_CACHE_ENTRIES; i++) {
        _sharedHistory.delete(keys[i]);
      }
    }

    // Persist to disk periodically
    if (now - _lastDiskSave >= DISK_SAVE_INTERVAL_MS) {
      this.saveHistoryToDisk();
      _lastDiskSave = now;
    }
  }

  private compute24hChange(symbol: string, currentPrice: number): number {
    const history = _sharedHistory.get(symbol);

    // Check if we have sufficient local history (at least 1 hour of data)
    if (history && history.length >= 2) {
      const oldestTimestamp = history[0].timestamp;
      const historyAgeMs = Date.now() - oldestTimestamp;

      // Only use local history if we have at least 1 hour of data
      if (historyAgeMs >= 60 * 60_000) {
        const target = Date.now() - HISTORY_WINDOW_MS;
        let closest = history[0];
        for (const snap of history) {
          if (Math.abs(snap.timestamp - target) < Math.abs(closest.timestamp - target)) {
            closest = snap;
          }
        }

        if (closest.price > 0 && Number.isFinite(closest.price)) {
          const change = ((currentPrice - closest.price) / closest.price) * 100;
          if (Number.isFinite(change)) return change;
        }
      }
    }

    // Fallback: use DexScreener cached 24h change (bootstraps on fresh start)
    const dexChange = _dexScreenerCache.get(symbol);
    if (dexChange && Date.now() - dexChange.fetchedAt < DEXSCREENER_CACHE_TTL_MS) {
      return dexChange.change;
    }

    // Non-crypto markets have no DexScreener data — return NaN so callers can show "N/A"
    if (NON_CRYPTO_MARKETS.has(symbol)) {
      return NaN;
    }

    // Trigger async DexScreener fetch (non-blocking, results available next cycle)
    if (DEXSCREENER_TOKEN_ADDRESSES[symbol]) {
      this.triggerDexScreenerFetch();
    }

    // No data available yet — return NaN (callers should show "N/A" not "+0.00%")
    return NaN;
  }

  // ─── Disk Persistence ──────────────────────────────────────────────────────

  private loadHistoryFromDisk(): void {
    try {
      if (!existsSync(HISTORY_FILE)) return;

      const raw = readFileSync(HISTORY_FILE, 'utf-8');
      if (raw.length > MAX_HISTORY_FILE_BYTES) {
        getLogger().warn('PRICE', `Price history file too large (${raw.length} bytes), starting fresh`);
        return;
      }

      const data = JSON.parse(raw) as HistoryFile;
      if (data.version !== 1 || !data.symbols) return;

      const now = Date.now();
      let loaded = 0;

      for (const [sym, snapshots] of Object.entries(data.symbols)) {
        if (!Array.isArray(snapshots)) continue;

        // Only keep snapshots within the 24h window
        const valid = snapshots.filter(
          (s): s is PriceSnapshot =>
            typeof s.price === 'number' &&
            typeof s.timestamp === 'number' &&
            Number.isFinite(s.price) &&
            s.price > 0 &&
            s.timestamp > now - HISTORY_WINDOW_MS
        );

        if (valid.length > 0) {
          // Sort by timestamp ascending
          valid.sort((a, b) => a.timestamp - b.timestamp);
          // Trim to max
          if (valid.length > MAX_HISTORY_PER_SYMBOL) {
            valid.splice(0, valid.length - MAX_HISTORY_PER_SYMBOL);
          }
          _sharedHistory.set(sym.toUpperCase(), valid);
          loaded++;
        }
      }

      if (loaded > 0) {
        getLogger().info('PRICE', `Loaded 24h price history for ${loaded} markets from disk`);
      }
    } catch (error: unknown) {
      getLogger().debug('PRICE', `Failed to load price history: ${getErrorMessage(error)}`);
    }
  }

  private saveHistoryToDisk(): void {
    try {
      const dir = join(homedir(), '.flash');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const symbols: Record<string, PriceSnapshot[]> = {};
      for (const [sym, snapshots] of _sharedHistory) {
        if (snapshots.length > 0) {
          symbols[sym] = snapshots;
        }
      }

      const data: HistoryFile = {
        version: 1,
        lastSaved: Date.now(),
        symbols,
      };

      const json = JSON.stringify(data);

      // Safety: don't write if too large
      if (json.length > MAX_HISTORY_FILE_BYTES) {
        getLogger().warn('PRICE', `Price history too large to save (${json.length} bytes), trimming`);
        // Keep only the most recent half of entries per symbol
        for (const snaps of Object.values(symbols)) {
          if (snaps.length > MAX_HISTORY_PER_SYMBOL / 2) {
            snaps.splice(0, snaps.length - Math.floor(MAX_HISTORY_PER_SYMBOL / 2));
          }
        }
        const trimmed = JSON.stringify({ ...data, symbols });
        writeFileSync(HISTORY_FILE, trimmed, { mode: 0o600 });
      } else {
        writeFileSync(HISTORY_FILE, json, { mode: 0o600 });
      }

      getLogger().debug('PRICE', `Saved price history for ${Object.keys(symbols).length} markets to disk`);
    } catch (error: unknown) {
      getLogger().debug('PRICE', `Failed to save price history: ${getErrorMessage(error)}`);
    }
  }

  /** Save history to disk immediately (call on shutdown). */
  flushHistory(): void {
    this.saveHistoryToDisk();
  }

  clearCache(): void {
    this.cache.clear();
    _sharedHistory.clear();
    _lastHistoryRecord = 0;
    _lastDiskSave = 0;
  }

  // ─── DexScreener 24h Change Bootstrap ────────────────────────────────────
  // Used only when local price history is insufficient (<1h of data).
  // Non-blocking: triggers async fetch, results available on next price cycle.

  private triggerDexScreenerFetch(): void {
    if (_dexScreenerFetchInFlight || Date.now() - _dexScreenerLastFetch < DEXSCREENER_MIN_INTERVAL_MS) {
      return;
    }
    _dexScreenerFetchInFlight = true;
    this.fetchDexScreener24h().catch(() => {}).finally(() => {
      _dexScreenerFetchInFlight = false;
    });
  }

  private async fetchDexScreener24h(): Promise<void> {
    const logger = getLogger();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    try {
      // DexScreener search endpoint — returns pairs with 24h change
      // Fetch top crypto symbols that Flash Trade supports
      const symbols = Object.keys(DEXSCREENER_TOKEN_ADDRESSES);
      let fetched = 0;

      for (const sym of symbols) {
        const addr = DEXSCREENER_TOKEN_ADDRESSES[sym];
        if (!addr) continue;

        // Check if we already have a fresh cache entry
        const existing = _dexScreenerCache.get(sym);
        if (existing && Date.now() - existing.fetchedAt < DEXSCREENER_CACHE_TTL_MS) continue;

        try {
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          });

          if (!res.ok) continue;

          const text = await res.text();
          if (text.length > MAX_RESPONSE_BYTES) continue;

          const data = JSON.parse(text) as { pairs?: Array<{ priceChange?: { h24?: number } }> };
          const topPair = data.pairs?.[0];
          const change = topPair?.priceChange?.h24;

          if (typeof change === 'number' && Number.isFinite(change)) {
            _dexScreenerCache.set(sym, { change, fetchedAt: Date.now() });
            fetched++;
          }

          // Bound cache size
          if (_dexScreenerCache.size > 50) {
            const oldest = _dexScreenerCache.keys().next().value;
            if (oldest) _dexScreenerCache.delete(oldest);
          }
        } catch {
          // Per-symbol fetch failure is non-critical
        }
      }

      _dexScreenerLastFetch = Date.now();
      if (fetched > 0) {
        logger.debug('PRICE', `DexScreener: bootstrapped 24h change for ${fetched} markets`);
      }
    } catch (error: unknown) {
      logger.debug('PRICE', `DexScreener fetch failed: ${getErrorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── DexScreener Module State ──────────────────────────────────────────────
// Shared across all PriceService instances, bounded at 50 entries with 5min TTL.

const DEXSCREENER_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const DEXSCREENER_MIN_INTERVAL_MS = 60_000;   // max 1 fetch batch per minute
let _dexScreenerFetchInFlight = false;
let _dexScreenerLastFetch = 0;
const _dexScreenerCache = new Map<string, { change: number; fetchedAt: number }>();

// Solana token mint addresses for DexScreener lookup
const DEXSCREENER_TOKEN_ADDRESSES: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  PENGU: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
  HYPE: 'HYPExVFoRdKxAFRoMSkTC5PBRJK4TZjPZBpGpydrWu3C',
  FARTCOIN: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
  KMNO: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS',
  PUMP: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  ORE: 'oreV2w6Bqtzn4BSLBeF5VHxBDB9FAbTw5jknCByYMPu',
  BNB: 'Cfuzmm9K7AXJBwBaDs5j8t7RY5THp2Vm7bLS4JVMviJM',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
};
