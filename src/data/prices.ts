import { Connection } from '@solana/web3.js';
import { OraclePrice } from 'flash-sdk';
import { BN } from '@coral-xyz/anchor';
import { PythHttpClient, getPythProgramKeyForCluster, PriceData } from '@pythnetwork/client';
import { getLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

export interface TokenPrice {
  price: OraclePrice;
  emaPrice: OraclePrice;
  uiPrice: number;
  timestamp: number;
}

const MAX_PRICE_AGE_MS = 30_000; // 30s staleness threshold

export class PriceService {
  private pythClient: PythHttpClient;
  private cache: Map<string, { data: TokenPrice; expiry: number }> = new Map();
  private cacheTtlMs = 5_000;

  constructor(pythnetUrl: string) {
    const connection = new Connection(pythnetUrl);
    this.pythClient = new PythHttpClient(connection, getPythProgramKeyForCluster('pythnet'));
  }

  async getPrices(tokens: { symbol: string; pythTicker: string }[]): Promise<Map<string, TokenPrice>> {
    const priceMap = new Map<string, TokenPrice>();
    const now = Date.now();
    const logger = getLogger();

    // Check cache
    const uncached: typeof tokens = [];
    for (const token of tokens) {
      const cached = this.cache.get(token.symbol);
      if (cached && cached.expiry > now) {
        priceMap.set(token.symbol, cached.data);
      } else {
        uncached.push(token);
      }
    }

    if (uncached.length === 0) return priceMap;

    // Fetch from Pyth with retry
    const pythData = await withRetry(
      () => this.pythClient.getData(),
      'pyth-prices',
      { maxAttempts: 2 }
    );

    for (const token of uncached) {
      const priceData: PriceData | undefined = pythData.productPrice.get(token.pythTicker);
      if (!priceData) {
        logger.warn('PRICE', `No Pyth data for ${token.symbol} (${token.pythTicker})`);
        continue;
      }

      // Check staleness
      const priceTimestamp = priceData.timestamp
        ? Number(priceData.timestamp) * 1000
        : now;
      const age = now - priceTimestamp;
      if (age > MAX_PRICE_AGE_MS) {
        logger.warn('PRICE', `Stale price for ${token.symbol}: ${(age / 1000).toFixed(0)}s old`);
      }

      const priceComponent = priceData.aggregate.priceComponent;
      const emaPriceComponent = priceData.emaPrice.valueComponent;
      const confidence = priceData.confidence ?? 0;
      const emaConfidence = priceData.emaConfidence?.valueComponent ?? 0;

      const price = new OraclePrice({
        price: new BN(priceComponent.toString()),
        exponent: new BN(priceData.exponent),
        confidence: new BN(confidence.toString()),
        timestamp: new BN(priceData.timestamp.toString()),
      });

      const emaPrice = new OraclePrice({
        price: new BN(emaPriceComponent.toString()),
        exponent: new BN(priceData.exponent),
        confidence: new BN(emaConfidence.toString()),
        timestamp: new BN(priceData.timestamp.toString()),
      });

      const tokenPrice: TokenPrice = {
        price,
        emaPrice,
        uiPrice: priceData.aggregate.price ?? 0,
        timestamp: priceTimestamp,
      };

      priceMap.set(token.symbol, tokenPrice);
      this.cache.set(token.symbol, { data: tokenPrice, expiry: now + this.cacheTtlMs });
    }

    return priceMap;
  }

  async getPrice(symbol: string, pythTicker: string): Promise<TokenPrice | null> {
    const prices = await this.getPrices([{ symbol, pythTicker }]);
    return prices.get(symbol) ?? null;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
