import dotenv from 'dotenv';
import { FlashConfig, VALID_NETWORKS, Network, injectLeverageFn } from '../types/index.js';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';

// Load .env from multiple locations (first match wins):
// 1. Current working directory (local dev)
// 2. ~/.flash/.env (user config for global install)
// 3. Package install directory (bundled fallback)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPaths = [
  resolve(process.cwd(), '.env'),
  resolve(homedir(), '.flash', '.env'),
  resolve(__dirname, '..', '.env'),
];
const envFile = envPaths.find((p) => existsSync(p));
dotenv.config({ path: envFile });

function resolveHome(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return resolve(homedir(), filepath.slice(2));
  }
  if (filepath === '~') {
    return homedir();
  }
  return resolve(filepath);
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseNetwork(value: string | undefined): Network {
  if (value && (VALID_NETWORKS as readonly string[]).includes(value)) {
    return value as Network;
  }
  return 'mainnet-beta';
}

function validateRpcUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // If URL is unparseable, let it fail later at connection time
    return url;
  }

  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new Error(`RPC URL must use HTTPS (got ${parsed.protocol}). Only localhost/127.0.0.1 may use HTTP.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('RPC URL must not contain embedded credentials — use headers instead');
  }

  // Block internal/metadata IP ranges (SSRF protection)
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // Strip IPv6 brackets
  if (!isLocal) {
    // IPv4 private ranges
    if (
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host === '0.0.0.0' ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      throw new Error(`RPC URL points to a private/internal IP (${host}). This is not allowed.`);
    }
    // IPv6 private/internal ranges
    if (
      host === '::1' ||
      host.startsWith('fc') || host.startsWith('fd') ||  // unique-local (fc00::/7)
      host.startsWith('fe80') ||                          // link-local (fe80::/10)
      host.startsWith('::ffff:')                          // IPv4-mapped IPv6 (check mapped addr)
    ) {
      throw new Error(`RPC URL points to a private/internal IP (${host}). This is not allowed.`);
    }
    // IPv4-mapped IPv6 with dotted notation (e.g., ::ffff:169.254.169.254)
    const v4Mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4Mapped) {
      const ipv4 = v4Mapped[1];
      if (ipv4.startsWith('169.254.') || ipv4.startsWith('10.') || ipv4.startsWith('192.168.') ||
          ipv4 === '0.0.0.0' || /^172\.(1[6-9]|2\d|3[01])\./.test(ipv4)) {
        throw new Error(`RPC URL points to a private/internal IP (${host}). This is not allowed.`);
      }
    }
  }

  return url;
}

function parseExecutionEngine(value?: string): 'rpc' | 'magicblock' {
  if (!value) return 'rpc';
  const lower = value.toLowerCase().trim();
  if (lower === 'magicblock') return 'magicblock';
  return 'rpc';
}

export function loadConfig(): FlashConfig {
  const backupRpcUrls: string[] = [];
  if (process.env.BACKUP_RPC_1) backupRpcUrls.push(validateRpcUrl(process.env.BACKUP_RPC_1));
  if (process.env.BACKUP_RPC_2) backupRpcUrls.push(validateRpcUrl(process.env.BACKUP_RPC_2));

  return {
    rpcUrl: validateRpcUrl(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'),
    backupRpcUrls,
    pythnetUrl: process.env.PYTHNET_URL || 'https://pythnet.rpcpool.com',
    walletPath: resolveHome(process.env.WALLET_PATH || '~/.config/solana/id.json'),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    groqApiKey: process.env.GROQ_API_KEY || '',
    defaultPool: process.env.DEFAULT_POOL || 'Crypto.1',
    network: parseNetwork(process.env.NETWORK),
    simulationMode: (process.env.SIMULATION_MODE ?? 'true').toLowerCase() !== 'false',
    defaultSlippageBps: parseIntSafe(process.env.DEFAULT_SLIPPAGE_BPS, 150),
    computeUnitLimit: parseIntSafe(process.env.COMPUTE_UNIT_LIMIT, 600000),
    computeUnitPrice: parseIntSafe(process.env.COMPUTE_UNIT_PRICE, 100000),
    logFile: process.env.LOG_FILE || null,
    // Signing guard limits (0 = unlimited / use market defaults)
    maxCollateralPerTrade: parseIntSafe(process.env.MAX_COLLATERAL_PER_TRADE, 0),
    maxPositionSize: parseIntSafe(process.env.MAX_POSITION_SIZE, 0),
    maxLeverage: parseIntSafe(process.env.MAX_LEVERAGE, 0),
    maxTradesPerMinute: parseIntSafe(process.env.MAX_TRADES_PER_MINUTE, 10),
    minDelayBetweenTradesMs: parseIntSafe(process.env.MIN_DELAY_BETWEEN_TRADES_MS, 3000),
    executionEngine: parseExecutionEngine(process.env.EXECUTION_ENGINE),
    magicblockRpcUrl: process.env.MAGICBLOCK_RPC_URL || undefined,
  };
}

// Flash program constants
export const FLASH_PROGRAM_ID = 'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn';
export const FLASH_COMPOSABILITY_PROGRAM_ID = 'FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm';
export const FLASH_REWARD_PROGRAM_ID = 'FARNT7LL119pmy9vSkN9q1ApZESPaKHuuX5Acz1oBoME';

// fstats.io API
export const FSTATS_BASE_URL = 'https://fstats.io/api/v1';

// ─── Pool & Market Discovery (loaded from Flash SDK PoolConfig) ───────────────
// Reads pools and markets directly from the SDK's PoolConfig.json.
// New pools/markets added by Flash Trade are picked up on `npm update flash-sdk`.

const SKIP_TOKENS = new Set(['USDC', 'USDT', 'WSOL', 'XAUT', 'JITOSOL']);
const SKIP_POOL_PREFIXES = ['devnet.', 'Remora.'];

interface SdkPoolData {
  pools: Array<{
    poolName: string;
    tokens: Array<{ symbol: string; mintKey: string }>;
    markets: Array<{ targetMint: string; maxLev: number; degenMinLev: number; degenMaxLev: number }>;
  }>;
}

function discoverPoolsFromSdk(): { names: string[]; markets: Record<string, string[]> } {
  try {
    const require = createRequire(import.meta.url);
    const configPath = require.resolve('flash-sdk/dist/PoolConfig.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as SdkPoolData;

    const names: string[] = [];
    const markets: Record<string, string[]> = {};

    const seen = new Set<string>();
    for (const pool of raw.pools) {
      if (SKIP_POOL_PREFIXES.some(p => pool.poolName.startsWith(p))) continue;
      if (seen.has(pool.poolName)) continue; // Deduplicate (SDK JSON has duplicates)
      seen.add(pool.poolName);
      const syms = (pool.tokens || [])
        .map(t => t.symbol.toUpperCase())
        .filter(s => !SKIP_TOKENS.has(s));
      if (syms.length === 0) continue;
      names.push(pool.poolName);
      markets[pool.poolName] = syms;
    }

    if (names.length > 0) return { names, markets };
  } catch {
    // SDK file unreadable — fall through to hardcoded fallback
  }

  // Hardcoded fallback (last known good state)
  return {
    names: ['Crypto.1', 'Virtual.1', 'Governance.1', 'Community.1', 'Community.2', 'Trump.1', 'Ore.1', 'Ondo.1'],
    markets: {
      'Crypto.1': ['SOL', 'BTC', 'ETH', 'ZEC', 'BNB'],
      'Virtual.1': ['XAG', 'XAU', 'CRUDEOIL', 'EUR', 'GBP', 'USDJPY', 'USDCNH'],
      'Governance.1': ['JTO', 'JUP', 'PYTH', 'RAY', 'HYPE', 'MET', 'KMNO'],
      'Community.1': ['PUMP', 'BONK', 'PENGU'],
      'Community.2': ['WIF'],
      'Trump.1': ['FARTCOIN'],
      'Ore.1': ['ORE'],
      'Ondo.1': ['SPY', 'NVDA', 'TSLA', 'AAPL', 'AMD', 'AMZN', 'PLTR'],
    },
  };
}

const _poolData = discoverPoolsFromSdk();

// Validate which pools are actually tradeable (PoolConfig.fromIdsByName works)
const _tradeablePools = new Set<string>();
for (const name of _poolData.names) {
  try {
    PoolConfig.fromIdsByName(name, 'mainnet-beta');
    _tradeablePools.add(name);
  } catch {
    // Pool exists in JSON but SDK can't load it yet — mark as view-only
  }
}

export const POOL_NAMES: string[] = _poolData.names;
export const POOL_MARKETS: Record<string, string[]> = _poolData.markets;

/** Check if a pool is tradeable (SDK can load it). View-only pools show in markets list but can't trade. */
export function isTradeablePool(poolName: string): boolean {
  return _tradeablePools.has(poolName);
}

export function getPoolForMarket(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
    if (markets.some((m) => m.toUpperCase() === upper)) {
      return pool;
    }
  }
  return null;
}

export function getAllMarkets(): string[] {
  return Object.values(POOL_MARKETS).flat().map((m) => m.toUpperCase());
}

// ─── Per-Market Leverage Limits (loaded dynamically from Flash SDK PoolConfig) ─
// Reads leverage directly from the SDK so limits stay in sync with protocol updates.
// Just run `npm update flash-sdk` to pick up new leverage changes — no code edits needed.

import { PoolConfig } from 'flash-sdk';

interface MarketLeverage {
  maxLev: number;
  degenMaxLev: number;
  degenMinLev: number;
}

/** Lazily-built cache of per-market leverage from SDK PoolConfig. */
let _sdkLeverageCache: Record<string, MarketLeverage> | null = null;

function loadSdkLeverage(): Record<string, MarketLeverage> {
  if (_sdkLeverageCache) return _sdkLeverageCache;

  const cache: Record<string, MarketLeverage> = {};

  // Read directly from SDK's PoolConfig.json — covers ALL pools including those
  // not yet registered in PoolConfig.fromIdsByName (e.g. newly added pools)
  try {
    const require = createRequire(import.meta.url);
    const configPath = require.resolve('flash-sdk/dist/PoolConfig.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as SdkPoolData;

    for (const pool of raw.pools) {
      if (SKIP_POOL_PREFIXES.some(p => pool.poolName.startsWith(p))) continue;
      for (const m of pool.markets) {
        const token = (pool.tokens || []).find(t => t.mintKey === m.targetMint);
        if (!token) continue;
        const sym = token.symbol.toUpperCase();
        if (SKIP_TOKENS.has(sym)) continue;
        const existing = cache[sym];
        if (existing) {
          existing.maxLev = Math.max(existing.maxLev, m.maxLev);
          existing.degenMaxLev = Math.max(existing.degenMaxLev, m.degenMaxLev);
          existing.degenMinLev = Math.min(existing.degenMinLev, m.degenMinLev);
        } else {
          cache[sym] = {
            maxLev: m.maxLev,
            degenMaxLev: m.degenMaxLev,
            degenMinLev: m.degenMinLev,
          };
        }
      }
    }
  } catch {
    // JSON read failed — fall back to PoolConfig.fromIdsByName for registered pools
    for (const poolName of POOL_NAMES) {
      try {
        const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
        const markets = pc.markets as unknown as Array<{
          targetMint: { toBase58(): string };
          maxLev: number; degenMinLev: number; degenMaxLev: number;
        }>;
        const tokens = pc.tokens as unknown as Array<{
          symbol: string; mintKey: { toBase58(): string };
        }>;
        for (const m of markets) {
          const targetMintStr = m.targetMint.toBase58();
          const token = tokens.find(t => t.mintKey.toBase58() === targetMintStr);
          if (!token) continue;
          const sym = token.symbol.toUpperCase();
          if (SKIP_TOKENS.has(sym)) continue;
          const existing = cache[sym];
          if (existing) {
            existing.maxLev = Math.max(existing.maxLev, m.maxLev);
            existing.degenMaxLev = Math.max(existing.degenMaxLev, m.degenMaxLev);
            existing.degenMinLev = Math.min(existing.degenMinLev, m.degenMinLev);
          } else {
            cache[sym] = { maxLev: m.maxLev, degenMaxLev: m.degenMaxLev, degenMinLev: m.degenMinLev };
          }
        }
      } catch {
        // Pool not available — skip
      }
    }
  }

  _sdkLeverageCache = cache;
  return cache;
}

/** Force refresh leverage cache (e.g. after SDK update). */
export function refreshLeverageCache(): void {
  _sdkLeverageCache = null;
}

/** Get the max allowed leverage for a market. Returns degenMaxLev if degen mode is on. */
export function getMaxLeverage(market: string, degenMode = false): number {
  const upper = market.toUpperCase();
  const lev = loadSdkLeverage()[upper];
  if (!lev) return 100; // safe default for unknown markets
  return degenMode ? lev.degenMaxLev : lev.maxLev;
}

/** Get the minimum leverage to enter degen mode for a market (125x for SOL/BTC/ETH). */
export function getDegenMinLeverage(market: string): number {
  const lev = loadSdkLeverage()[market.toUpperCase()];
  return lev?.degenMinLev ?? 1;
}

/** Check if a market supports degen mode (degenMaxLev > maxLev). */
export function hasDegenMode(market: string): boolean {
  const lev = loadSdkLeverage()[market.toUpperCase()];
  return lev ? lev.degenMaxLev > lev.maxLev : false;
}

/** Get all leverage data for display purposes. */
export function getAllLeverage(): Record<string, MarketLeverage> {
  return { ...loadSdkLeverage() };
}

// Inject SDK-based leverage into types module (avoids circular import)
injectLeverageFn(getMaxLeverage);
