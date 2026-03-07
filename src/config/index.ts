import dotenv from 'dotenv';
import { FlashConfig, VALID_NETWORKS, Network } from '../types/index.js';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

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
  try {
    const parsed = new URL(url);
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
      console.error(`  WARNING: RPC URL should use HTTPS: ${url}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error('RPC URL must not contain embedded credentials — use headers instead');
    }
  } catch (e) {
    if (e instanceof Error && (e.message.includes('credentials') || e.message.includes('HTTPS'))) throw e;
    // If URL is unparseable, let it fail later at connection time
  }
  return url;
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
    computeUnitPrice: parseIntSafe(process.env.COMPUTE_UNIT_PRICE, 500000),
    logFile: process.env.LOG_FILE || null,
    // Signing guard limits (0 = unlimited / use market defaults)
    maxCollateralPerTrade: parseIntSafe(process.env.MAX_COLLATERAL_PER_TRADE, 0),
    maxPositionSize: parseIntSafe(process.env.MAX_POSITION_SIZE, 0),
    maxLeverage: parseIntSafe(process.env.MAX_LEVERAGE, 0),
    maxTradesPerMinute: parseIntSafe(process.env.MAX_TRADES_PER_MINUTE, 10),
    minDelayBetweenTradesMs: parseIntSafe(process.env.MIN_DELAY_BETWEEN_TRADES_MS, 3000),
  };
}

// Flash program constants
export const FLASH_PROGRAM_ID = 'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn';
export const FLASH_COMPOSABILITY_PROGRAM_ID = 'FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm';
export const FLASH_REWARD_PROGRAM_ID = 'FARNT7LL119pmy9vSkN9q1ApZESPaKHuuX5Acz1oBoME';

// fstats.io API
export const FSTATS_BASE_URL = 'https://fstats.io/api/v1';

// Available pools
export const POOL_NAMES = [
  'Crypto.1',
  'Virtual.1',
  'Governance.1',
  'Community.1',
  'Community.2',
  'Trump.1',
  'Ore.1',
  'Remora.1',
] as const;

// Market symbols per pool
export const POOL_MARKETS: Record<string, string[]> = {
  'Crypto.1': ['SOL', 'BTC', 'ETH', 'ZEC', 'BNB'],
  'Virtual.1': ['XAG', 'XAU', 'CRUDEOIL', 'EUR', 'GBP', 'USDJPY', 'USDCNH'],
  'Governance.1': ['JTO', 'JUP', 'PYTH', 'RAY', 'HYPE', 'MET', 'KMNO'],
  'Community.1': ['PUMP', 'BONK', 'PENGU'],
  'Community.2': ['WIF'],
  'Trump.1': ['FARTCOIN'],
  'Ore.1': ['ORE'],
  'Remora.1': ['TSLAr', 'MSTRr', 'CRCLr', 'NVDAr', 'SPYr'],
};

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
