import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

export interface TokenPrice {
  symbol: string;
  price: number;
  priceChange24h: number;
  timestamp: number;
  isFallback: boolean;
}

// CoinGecko symbol → ID mapping
const COINGECKO_IDS: Record<string, string> = {
  SOL: 'solana',
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  ZEC: 'zcash',
  JTO: 'jito-governance-token',
  JUP: 'jupiter-exchange-solana',
  PYTH: 'pyth-network',
  RAY: 'raydium',
  BONK: 'bonk',
  WIF: 'dogwifcoin',
  PENGU: 'pudgy-penguins',
  ORE: 'ore',
  HYPE: 'hyperliquid',
  FARTCOIN: 'fartcoin',
  KMNO: 'kamino',
  MET: 'metaplex',
  PUMP: 'pump-fun',
};

// SECURITY: No hardcoded fallback prices. If CoinGecko fails, the market is
// excluded from analysis. Trading decisions must NEVER rely on stale prices.

const FETCH_TIMEOUT_MS = 8_000;
const MAX_PRICE_CACHE_ENTRIES = 100;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1MB max for price data

export class PriceService {
  private cache: Map<string, { data: TokenPrice; expiry: number }> = new Map();
  private cacheTtlMs = 15_000; // 15s cache
  private lastMissingWarnTime = 0;
  private static readonly MISSING_WARN_INTERVAL_MS = 60_000; // throttle: once per 60s

  /**
   * Fetch prices for the given symbols.
   * Strategy: CoinGecko API only. No fallback prices — missing markets are excluded.
   */
  async getPrices(symbols: string[]): Promise<Map<string, TokenPrice>> {
    const priceMap = new Map<string, TokenPrice>();
    const now = Date.now();
    const logger = getLogger();

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

    // Evict expired/excess entries before inserting new ones
    if (this.cache.size >= MAX_PRICE_CACHE_ENTRIES) {
      for (const [k, entry] of this.cache) {
        if (entry.expiry <= now) this.cache.delete(k);
      }
      if (this.cache.size >= MAX_PRICE_CACHE_ENTRIES) {
        const oldest = Array.from(this.cache.keys()).slice(0, 10);
        for (const k of oldest) this.cache.delete(k);
      }
    }

    // Try CoinGecko API
    try {
      logger.debug('PRICE', `Fetching prices for: ${uncached.join(', ')}`);
      const fetched = await this.fetchFromCoinGecko(uncached);
      for (const tp of fetched) {
        priceMap.set(tp.symbol, tp);
        this.cache.set(tp.symbol, { data: tp, expiry: now + this.cacheTtlMs });
      }
      logger.info('PRICE', `Fetched ${fetched.length} prices from CoinGecko`);
    } catch (error: unknown) {
      logger.warn('PRICE', `CoinGecko fetch failed: ${getErrorMessage(error)}`);
    }

    // Log missing symbols — throttled to avoid spam during continuous monitor refresh
    const missing = uncached.filter(sym => !priceMap.has(sym));
    if (missing.length > 0 && now - this.lastMissingWarnTime >= PriceService.MISSING_WARN_INTERVAL_MS) {
      logger.warn('PRICE', `No live price for ${missing.length} market(s): ${missing.join(', ')} — excluded from analysis`);
      this.lastMissingWarnTime = now;
    }

    return priceMap;
  }

  async getPrice(symbol: string): Promise<TokenPrice | null> {
    const prices = await this.getPrices([symbol]);
    return prices.get(symbol.toUpperCase()) ?? null;
  }

  private async fetchFromCoinGecko(symbols: string[]): Promise<TokenPrice[]> {
    // Map symbols to CoinGecko IDs
    const ids: string[] = [];
    const idToSymbol = new Map<string, string>();
    for (const sym of symbols) {
      const id = COINGECKO_IDS[sym];
      if (id) {
        ids.push(id);
        idToSymbol.set(id, sym);
      }
    }

    if (ids.length === 0) return [];

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`CoinGecko ${res.status}: ${res.statusText}`);
      }

      // Guard against oversized responses
      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        throw new Error(`CoinGecko response too large: ${contentLength} bytes`);
      }

      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error(`CoinGecko response body too large: ${text.length} bytes`);
      }

      const data = JSON.parse(text) as Record<string, { usd?: number; usd_24h_change?: number }>;
      const results: TokenPrice[] = [];
      const now = Date.now();

      for (const [id, priceData] of Object.entries(data)) {
        const sym = idToSymbol.get(id);
        if (sym && priceData?.usd && priceData.usd > 0) {
          // [M-9] Price deviation circuit breaker — reject >50% jumps from cached value
          const cached = this.cache.get(sym);
          if (cached && cached.data.price > 0) {
            const deviation = Math.abs(priceData.usd - cached.data.price) / cached.data.price;
            if (deviation > 0.5) {
              getLogger().warn('PRICE', `Rejecting suspicious price for ${sym}: $${priceData.usd} vs cached $${cached.data.price.toFixed(2)} (${(deviation * 100).toFixed(0)}% deviation)`);
              continue;
            }
          }
          results.push({
            symbol: sym,
            price: priceData.usd,
            priceChange24h: priceData.usd_24h_change ?? 0,
            timestamp: now,
            isFallback: false,
          });
        }
      }

      return results;
    } finally {
      clearTimeout(timeout);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
