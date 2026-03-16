/**
 * Centralized market alias resolution.
 *
 * ALL commands that accept a market name must call resolveMarket()
 * before performing any lookup. This ensures aliases like "crude oil",
 * "oil", "gold", "yen" etc. resolve consistently everywhere.
 *
 * The canonical market list comes from config/index.ts (POOL_MARKETS),
 * which is sourced from the Flash SDK pool configuration.
 */

import { getAllMarkets, getPoolForMarket } from '../config/index.js';
import { getLogger } from './logger.js';

// ─── Alias Dictionary ───────────────────────────────────────────────────────
// Maps lowercase alias → canonical UPPERCASE market symbol.
// Multi-word aliases use the space-collapsed form as key as well.

const MARKET_ALIASES: Record<string, string> = {
  // Full names
  jito: 'JTO',
  raydium: 'RAY',
  kamino: 'KMNO',
  metaplex: 'MET',
  solana: 'SOL',
  bitcoin: 'BTC',
  ethereum: 'ETH',
  ether: 'ETH',
  zcash: 'ZEC',
  // Commodities
  gold: 'XAU',
  silver: 'XAG',
  crude: 'CRUDEOIL',
  oil: 'CRUDEOIL',
  'crude oil': 'CRUDEOIL',
  crudeoil: 'CRUDEOIL',
  // Forex
  euro: 'EUR',
  pound: 'GBP',
  sterling: 'GBP',
  yen: 'USDJPY',
  yuan: 'USDCNH',
  // Memecoins / Community
  penguin: 'PENGU',
  pengu: 'PENGU',
  hyperliquid: 'HYPE',
  hype: 'HYPE',
  pumpfun: 'PUMP',
  pump: 'PUMP',
  fartcoin: 'FARTCOIN',
  ore: 'ORE',
  bonk: 'BONK',
  wif: 'WIF',
  // Binance
  binance: 'BNB',
  // Stocks (Ondo.1)
  nvidia: 'NVDA',
  tesla: 'TSLA',
  apple: 'AAPL',
  amazon: 'AMZN',
  palantir: 'PLTR',
  'sp500': 'SPY',
  's&p': 'SPY',
  's&p500': 'SPY',
  'sp 500': 'SPY',
};

/**
 * Resolve a user-provided market string to a canonical Flash Trade symbol.
 *
 * Resolution order:
 *   1. Exact match against canonical market list (case-insensitive)
 *   2. Exact alias match (preserves spaces for multi-word like "crude oil")
 *   3. Space-collapsed alias match ("crude oil" → "crudeoil")
 *   4. Fallback: uppercase with spaces removed
 *
 * @returns Canonical uppercase market symbol (e.g. "CRUDEOIL", "SOL")
 */
export function resolveMarket(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  const collapsed = upper.replace(/\s+/g, '');

  // Strip common suffixes: "-perp", "-perpetual", "perp", "perpetual"
  const stripped = lower
    .replace(/[-\s]?perp(?:etual)?$/i, '')
    .trim();
  if (stripped && stripped !== lower) {
    const resolved = resolveMarket(stripped);
    if (resolved && getAllMarkets().includes(resolved)) return resolved;
  }

  // 1. Direct match against canonical market list
  const allMarkets = getAllMarkets();
  if (allMarkets.includes(upper)) return upper;
  if (allMarkets.includes(collapsed)) return collapsed;

  // 2. Exact alias match (handles multi-word like "crude oil")
  if (MARKET_ALIASES[lower]) return MARKET_ALIASES[lower];

  // 3. Space-collapsed alias match
  const collapsedLower = lower.replace(/\s+/g, '');
  if (MARKET_ALIASES[collapsedLower]) return MARKET_ALIASES[collapsedLower];

  // 4. Fallback: return collapsed uppercase
  return collapsed;
}

/**
 * Resolve a market alias AND verify it exists in the protocol.
 * @returns The canonical symbol, or null if not a valid market.
 */
export function resolveAndValidateMarket(input: string): string | null {
  const resolved = resolveMarket(input);
  if (!resolved) {
    getLogger().debug('MARKET', `Market symbol rejected (empty): "${input}"`);
    return null;
  }
  if (!getPoolForMarket(resolved)) {
    getLogger().debug('MARKET', `Unknown market symbol rejected: "${input}" (resolved: "${resolved}")`);
    return null;
  }
  return resolved;
}

/**
 * Check if a resolved market symbol is valid (exists in protocol config).
 */
export function isValidMarket(symbol: string): boolean {
  return getPoolForMarket(symbol) !== null;
}

/**
 * Get all known aliases for display/documentation purposes.
 */
export function getMarketAliases(): ReadonlyMap<string, string> {
  return new Map(Object.entries(MARKET_ALIASES));
}

/**
 * Normalize asset aliases in a free-text string.
 * Replaces known alias words with their canonical lowercase symbol.
 * Used by the interpreter for pre-processing natural language input.
 *
 * IMPORTANT: This handles multi-word aliases ("crude oil" → "crudeoil")
 * by processing them BEFORE single-word aliases.
 */
export function normalizeAssetText(text: string): string {
  let result = text;

  // Process multi-word aliases first (longest match first)
  const multiWord = Object.entries(MARKET_ALIASES)
    .filter(([alias]) => alias.includes(' '))
    .sort((a, b) => b[0].length - a[0].length);

  for (const [alias, symbol] of multiWord) {
    result = result.replace(new RegExp(escapeRegex(alias), 'gi'), symbol.toLowerCase());
  }

  // Then single-word aliases
  for (const [alias, symbol] of Object.entries(MARKET_ALIASES)) {
    if (alias.includes(' ')) continue; // already handled
    result = result.replace(new RegExp(`\\b${escapeRegex(alias)}\\b`, 'gi'), symbol.toLowerCase());
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
