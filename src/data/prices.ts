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
};

// SECURITY: No hardcoded fallback prices. If CoinGecko fails, the market is
// excluded from analysis. Trading decisions must NEVER rely on stale prices.

const FETCH_TIMEOUT_MS = 8_000;

export class PriceService {
  private cache: Map<string, { data: TokenPrice; expiry: number }> = new Map();
  private cacheTtlMs = 15_000; // 15s cache

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

    // Log missing symbols — one summary line instead of per-market spam
    const missing = uncached.filter(sym => !priceMap.has(sym));
    if (missing.length > 0) {
      logger.warn('PRICE', `No live price for ${missing.length} market(s): ${missing.join(', ')} — excluded from analysis`);
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

      const data = await res.json() as Record<string, { usd?: number; usd_24h_change?: number }>;
      const results: TokenPrice[] = [];
      const now = Date.now();

      for (const [id, priceData] of Object.entries(data)) {
        const sym = idToSymbol.get(id);
        if (sym && priceData?.usd && priceData.usd > 0) {
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
