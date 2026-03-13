import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Signer,
  ComputeBudgetProgram,
  VersionedTransaction,
  MessageV0,
  LAMPORTS_PER_SOL,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  PerpetualsClient,
  PoolConfig,
  CustodyAccount,
  PositionAccount,
  Side,
  Privilege,
  Token,
  uiDecimalsToNative,
  BN_ZERO,
  OraclePrice,
  ContractOraclePrice,
  OrderAccount,
} from 'flash-sdk';
import type { LimitOrder as SdkLimitOrder, TriggerOrder as SdkTriggerOrder } from 'flash-sdk';
import {
  Position,
  TradeSide,
  FlashConfig,
  MarketData,
  Portfolio,
  IFlashClient,
  OpenPositionResult,
  ClosePositionResult,
  CollateralResult,
  DryRunPreview,
  PlaceLimitOrderResult,
  PlaceTriggerOrderResult,
  CancelOrderResult,
  OnChainOrder,
  getLeverageLimits,
} from '../types/index.js';
import { PythHttpClient, getPythProgramKeyForCluster, PriceData } from '@pythnetwork/client';
import { getPoolForMarket, isTradeablePool, POOL_NAMES, getMaxLeverage } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage, withRetry } from '../utils/retry.js';
import type { WalletManager } from '../wallet/walletManager.js';
import { getRpcManagerInstance } from '../network/rpc-manager.js';
import { getUltraTxEngine, initUltraTxEngine } from '../core/ultra-tx-engine.js';
import { getEngineRouter } from '../execution/engine-router.js';
import { createBatch, appendToBatch, isBatchWithinLimit, batchSummary, type SdkResult } from '../transaction/instruction-aggregator.js';
import { resolveALTs, verifyALTAccountOverlap, logMessageALTDiagnostics } from '../transaction/alt-resolver.js';
import { ensureATAs } from '../transaction/ata-resolver.js';

// ─── Pyth Price Service ──────────────────────────────────────────────────────

interface LiveTokenPrice {
  price: OraclePrice;
  emaPrice: OraclePrice;
  uiPrice: number;
  timestamp: number;
}

const MAX_PYTH_CACHE_ENTRIES = 50;

class PythPriceService {
  private pythClient: PythHttpClient;
  private cache: Map<string, { data: LiveTokenPrice; expiry: number }> = new Map();
  private cacheTtlMs = 5_000;

  constructor(pythnetUrl: string) {
    // Validate Pythnet URL: must be HTTPS (or localhost for dev)
    try {
      const parsed = new URL(pythnetUrl);
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
        throw new Error(`Pythnet URL must use HTTPS: ${pythnetUrl}`);
      }
      if (parsed.username || parsed.password) {
        throw new Error('Pythnet URL must not contain embedded credentials');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Pythnet')) throw e;
      throw new Error(`Invalid Pythnet URL: ${pythnetUrl}`);
    }
    const conn = new Connection(pythnetUrl);
    this.pythClient = new PythHttpClient(conn, getPythProgramKeyForCluster('pythnet'));
  }

  async getPrices(tokens: { symbol: string; pythTicker: string }[]): Promise<Map<string, LiveTokenPrice>> {
    const priceMap = new Map<string, LiveTokenPrice>();
    const now = Date.now();
    const logger = getLogger();
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

    // Evict expired entries if cache is too large
    if (this.cache.size >= MAX_PYTH_CACHE_ENTRIES) {
      for (const [k, entry] of this.cache) {
        if (entry.expiry <= now) this.cache.delete(k);
      }
      if (this.cache.size >= MAX_PYTH_CACHE_ENTRIES) {
        const oldest = Array.from(this.cache.keys()).slice(0, 10);
        for (const k of oldest) this.cache.delete(k);
      }
    }

    const pythData = await withRetry(() => this.pythClient.getData(), 'pyth-prices', { maxAttempts: 2 });

    for (const token of uncached) {
      const priceData: PriceData | undefined = pythData.productPrice.get(token.pythTicker);
      if (!priceData) {
        logger.info('PRICE', `No Pyth data for ${token.symbol} (${token.pythTicker})`);
        continue;
      }

      const priceComponent = priceData.aggregate.priceComponent;
      const emaPriceComponent = priceData.emaPrice.valueComponent;
      // confidence from Pyth can be a float — convert to integer at the oracle's exponent scale
      const rawConfidence = priceData.confidence ?? 0;
      const confidenceInt = typeof rawConfidence === 'number'
        ? Math.round(rawConfidence * Math.pow(10, Math.abs(priceData.exponent)))
        : rawConfidence;
      const rawEmaConfidence = priceData.emaConfidence?.valueComponent ?? 0;

      const price = new OraclePrice({
        price: new BN(priceComponent.toString()),
        exponent: new BN(priceData.exponent.toString()),
        confidence: new BN(confidenceInt.toString()),
        timestamp: new BN(priceData.timestamp.toString()),
      });

      const emaPrice = new OraclePrice({
        price: new BN(emaPriceComponent.toString()),
        exponent: new BN(priceData.exponent.toString()),
        confidence: new BN(rawEmaConfidence.toString()),
        timestamp: new BN(priceData.timestamp.toString()),
      });

      const uiPrice = priceData.aggregate.price ?? 0;
      // Reject zero or negative prices from oracle — prevents trades at invalid prices
      if (!Number.isFinite(uiPrice) || uiPrice <= 0) {
        logger.info('PRICE', `Invalid oracle price for ${token.symbol}: ${uiPrice} — skipping`);
        continue;
      }

      // [H-1] Oracle staleness check — reject prices older than 30 seconds
      const oracleTimestamp = priceData.timestamp ? Number(priceData.timestamp) * 1000 : 0;
      const priceAgeMs = now - oracleTimestamp;
      const MAX_ORACLE_AGE_MS = 30_000;
      if (oracleTimestamp > 0 && priceAgeMs > MAX_ORACLE_AGE_MS) {
        logger.warn('PRICE', `Oracle price for ${token.symbol} is ${Math.round(priceAgeMs / 1000)}s stale — skipping`);
        continue;
      }

      // [H-2] Confidence interval check — reject wide-spread prices (>2% uncertainty)
      const absPrice = Math.abs(priceData.aggregate.price || 1);
      const confidenceRatio = (priceData.confidence ?? 0) / absPrice;
      const MAX_CONFIDENCE_RATIO = 0.02;
      if (confidenceRatio > MAX_CONFIDENCE_RATIO) {
        logger.warn('PRICE', `Oracle confidence for ${token.symbol} too wide: ${(confidenceRatio * 100).toFixed(1)}% — skipping`);
        continue;
      }

      const tokenPrice: LiveTokenPrice = {
        price,
        emaPrice,
        uiPrice,
        timestamp: oracleTimestamp || now,
      };

      priceMap.set(token.symbol, tokenPrice);
      this.cache.set(token.symbol, { data: tokenPrice, expiry: now + this.cacheTtlMs });
    }

    return priceMap;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSdkSide(side: TradeSide): typeof Side.Long | typeof Side.Short {
  return side === TradeSide.Long ? Side.Long : Side.Short;
}

// Minimum SOL balance required to cover transaction fees
const MIN_SOL_FOR_FEES = 0.01;

// Flash perpetual pools use USDC as the default collateral token
const DEFAULT_COLLATERAL_TOKEN = 'USDC';

// Well-known USDC mint on Solana mainnet
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/**
 * Scrub sensitive data (API keys, private keys) from strings before logging.
 */
function scrubSensitive(msg: string): string {
  // Mask anything that looks like an API key or base58 private key in query params
  return msg.replace(/api[_-]?key=[^&\s]+/gi, 'api_key=***');
}

/**
 * Map raw Solana program error codes to human-readable messages.
 * Flash Trade uses Anchor-style Custom error codes. Known codes:
 *   3012 — Market closed / oracle stale (virtual markets outside trading hours)
 */
function mapProgramError(rawError: string): string {
  if (rawError.includes('Custom(3012)') || rawError.includes('"Custom":3012')) {
    return [
      'Trade rejected by Flash protocol.',
      '',
      '  Possible reasons:',
      '  • Market is currently closed (virtual markets follow real-world trading sessions)',
      '  • Oracle price is stale or unavailable',
      '  • Insufficient pool liquidity',
      '  • Position below minimum size',
      '',
      '  If this is a commodity or FX market, try again during trading hours.',
    ].join('\n');
  }
  // Extract custom error code for other program errors
  const customMatch = rawError.match(/Custom\(?(\d+)\)?/i);
  if (customMatch) {
    return `Trade rejected by Flash protocol (error ${customMatch[1]}). The transaction did not execute.`;
  }
  // Fallback: include raw error for debugging
  const logger = getLogger();
  logger.warn('TX', `Program rejection (raw): ${scrubSensitive(rawError)}`);
  return `Transaction rejected by program: ${rawError.slice(0, 200)}`;
}

/**
 * Check if an error message indicates a network-level failure (not a program error).
 * Network errors are candidates for RPC failover; program errors are not.
 */
function isNetworkError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('timeout') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('network request failed') ||
    lower.includes('socket hang up') ||
    lower.includes('429') ||
    lower.includes('503') ||
    lower.includes('502');
}

// ─── Program ID Whitelist ──────────────────────────────────────────────────
//
// Only transactions interacting with these known programs are allowed.
// Any instruction targeting an unknown program ID is rejected before signing.

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111';
const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp18C'; // Flash event CPI

// Flash Trade program IDs are loaded dynamically from PoolConfig.
// [M-4] Base set of allowed system programs — immutable.
// Flash-specific IDs are added per-client instance via frozenAllowedProgramIds.
const BASE_ALLOWED_PROGRAM_IDS = Object.freeze(new Set<string>([
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  SYSVAR_RENT,
  SYSVAR_CLOCK,
  SYSVAR_INSTRUCTIONS,
  MEMO_PROGRAM,
  EVENT_AUTHORITY,
]));

// Active program whitelist — updated by FlashClient constructor and getPoolConfigForMarket().
// Starts with base system programs; Flash-specific IDs added per pool.
// Only one FlashClient instance exists at a time; the reference is safe.
let ALLOWED_PROGRAM_IDS: ReadonlySet<string> = BASE_ALLOWED_PROGRAM_IDS;

/**
 * Validate that every instruction in a transaction targets an approved program.
 * Throws if any instruction uses an unknown program ID.
 */
function validateInstructionPrograms(instructions: TransactionInstruction[], context: string): void {
  for (let i = 0; i < instructions.length; i++) {
    const progId = instructions[i].programId.toBase58();
    if (!ALLOWED_PROGRAM_IDS.has(progId)) {
      throw new Error(
        `Transaction rejected: instruction ${i} targets unknown program ${progId} (${context}). ` +
        `Only approved Flash Trade and Solana system programs are allowed.`
      );
    }
  }
}

// ─── FlashClient ─────────────────────────────────────────────────────────────

export class FlashClient implements IFlashClient {
  private connection: Connection;
  private wallet: Keypair;
  private provider: AnchorProvider;
  private perpClient: PerpetualsClient;
  private poolConfig: PoolConfig;
  private priceService: PythPriceService;
  private config: FlashConfig;
  private walletMgr: WalletManager;
  private cachedSolBalance = 0;

  /** [M-4] Instance-level allowed program IDs */
  private allowedPrograms: Set<string>;

  /** Per-market mutex to prevent concurrent transactions on the same market/side */
  private activeTrades = new Set<string>();

  /** Recent trade cache — prevents duplicate submissions within a short window */
  private recentTrades = new Map<string, number>(); // tradeKey -> timestamp
  private static readonly TRADE_CACHE_TTL_MS = 120_000;

  /** Pre-cached blockhash — refreshed every 5s to avoid blocking on getLatestBlockhash during trade */
  private cachedBlockhash: { blockhash: string; lastValidBlockHeight: number; fetchedAt: number } | null = null;
  private blockhashTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BLOCKHASH_REFRESH_MS = 5_000;
  private static readonly BLOCKHASH_MAX_AGE_MS = 10_000;

  constructor(connection: Connection, walletManager: WalletManager, config: FlashConfig) {
    this.config = config;
    this.connection = connection;
    this.walletMgr = walletManager;

    const keypair = walletManager.getKeypair();
    if (!keypair) {
      throw new Error('No wallet connected. Use "wallet connect <path>" or ensure ~/.config/solana/id.json exists.');
    }
    this.wallet = keypair;

    const walletAdapter = new Wallet(this.wallet);
    this.provider = new AnchorProvider(this.connection, walletAdapter, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });

    try {
      this.poolConfig = PoolConfig.fromIdsByName(config.defaultPool, config.network);
    } catch {
      throw new Error(
        `Unknown pool: ${config.defaultPool}. ` +
        `Valid pools: Crypto.1, Virtual.1, Governance.1, Community.1, Community.2, Trump.1, Ore.1`
      );
    }

    // Match prioritizationFee with config to avoid conflict with manual CU instructions
    this.perpClient = new PerpetualsClient(
      this.provider,
      this.poolConfig.programId,
      this.poolConfig.perpComposibilityProgramId,
      this.poolConfig.fbNftRewardProgramId,
      this.poolConfig.rewardDistributionProgram.programId,
      { prioritizationFee: config.computeUnitPrice }
    );

    // [M-4] Build allowed program set from pool config
    // Not frozen: getPoolConfigForMarket() adds IDs when cross-pool trades occur
    const instanceAllowed = new Set<string>(BASE_ALLOWED_PROGRAM_IDS);
    instanceAllowed.add(this.poolConfig.programId.toBase58());
    if (this.poolConfig.perpComposibilityProgramId) {
      instanceAllowed.add(this.poolConfig.perpComposibilityProgramId.toBase58());
    }
    if (this.poolConfig.fbNftRewardProgramId) {
      instanceAllowed.add(this.poolConfig.fbNftRewardProgramId.toBase58());
    }
    if (this.poolConfig.rewardDistributionProgram?.programId) {
      instanceAllowed.add(this.poolConfig.rewardDistributionProgram.programId.toBase58());
    }
    this.allowedPrograms = instanceAllowed;
    // Update module-level reference for validateInstructionPrograms
    ALLOWED_PROGRAM_IDS = instanceAllowed;

    this.priceService = new PythPriceService(config.pythnetUrl);

    // Initialize ultra-low latency execution engine (handles its own blockhash refresh at 2s)
    initUltraTxEngine(this.connection, this.wallet, {
      computeUnitPrice: config.computeUnitPrice,
      computeUnitLimit: config.computeUnitLimit,
      dynamicPriorityFee: true,
      multiBroadcast: true,
      wsConfirmation: true,
    });

    // Start legacy blockhash pre-cache only if engine init failed
    // (engine handles its own refresh; running both wastes RPC quota)
    if (!getUltraTxEngine()) {
      this.startBlockhashRefresh();
    }
  }

  /**
   * Start background blockhash refresh (every 5s).
   * Ensures sendTx() can use a recent blockhash without a blocking RPC call.
   */
  private startBlockhashRefresh(): void {
    // Initial fetch (non-blocking — sendTx will fetch on-demand if cache is empty)
    this.refreshBlockhash().catch(() => {});
    this.blockhashTimer = setInterval(() => {
      this.refreshBlockhash().catch(() => {});
    }, FlashClient.BLOCKHASH_REFRESH_MS);
    this.blockhashTimer.unref();
  }

  private async refreshBlockhash(): Promise<void> {
    try {
      const result = await this.connection.getLatestBlockhash('confirmed');
      this.cachedBlockhash = {
        blockhash: result.blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight,
        fetchedAt: Date.now(),
      };
    } catch {
      // Non-critical — sendTx will fetch on-demand if cache is stale
    }
  }

  /**
   * Get a recent blockhash — uses pre-cached value if fresh, otherwise fetches on-demand.
   * Returns the blockhash and the age of the cache entry (for timeout adjustment).
   */
  private async getBlockhash(conn: Connection): Promise<{ blockhash: string; lastValidBlockHeight: number; fetchLatencyMs: number }> {
    const cached = this.cachedBlockhash;
    if (cached && (Date.now() - cached.fetchedAt) < FlashClient.BLOCKHASH_MAX_AGE_MS) {
      return { blockhash: cached.blockhash, lastValidBlockHeight: cached.lastValidBlockHeight, fetchLatencyMs: 0 };
    }
    // Cache miss or stale — fetch on-demand
    const start = Date.now();
    const result = await conn.getLatestBlockhash('confirmed');
    const fetchLatencyMs = Date.now() - start;
    this.cachedBlockhash = { blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight, fetchedAt: Date.now() };
    return { blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight, fetchLatencyMs };
  }

  /** Stop background blockhash refresh (called on shutdown) */
  stopBlockhashRefresh(): void {
    if (this.blockhashTimer) {
      clearInterval(this.blockhashTimer);
      this.blockhashTimer = null;
    }
    // Shut down ultra-tx engine
    const txEngine = getUltraTxEngine();
    if (txEngine) txEngine.shutdown();
  }

  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  /**
   * Replace the active RPC connection (called by RpcManager on failover).
   * Safe to call mid-session — in-flight sendTx() calls capture their own
   * local `conn` reference at the start of each attempt, so swapping
   * this.connection here does not disrupt confirmation polling.
   * The new connection takes effect on the next attempt or next trade.
   *
   * Builds the new provider and perpClient BEFORE swapping references —
   * this ensures concurrent reads of this.perpClient never see a partially
   * constructed state (e.g. new connection but old provider).
   */
  replaceConnection(connection: Connection): void {
    // Build replacements BEFORE swapping — prevents mid-trade reads from
    // seeing inconsistent state (new connection + old perpClient)
    const walletAdapter = new Wallet(this.wallet);
    const newProvider = new AnchorProvider(connection, walletAdapter, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    const newPerpClient = new PerpetualsClient(
      newProvider,
      this.poolConfig.programId,
      this.poolConfig.perpComposibilityProgramId,
      this.poolConfig.fbNftRewardProgramId,
      this.poolConfig.rewardDistributionProgram.programId,
      { prioritizationFee: this.config.computeUnitPrice }
    );
    // Swap all references together — minimizes the window where concurrent
    // reads could see mismatched connection/provider/perpClient
    this.connection = connection;
    this.provider = newProvider;
    this.perpClient = newPerpClient;
    // Propagate connection change to ultra-tx engine and wallet manager
    const txEngine = getUltraTxEngine();
    if (txEngine) txEngine.updateConnection(connection);
    this.walletMgr.setConnection(connection);
    getLogger().info('CLIENT', 'Connection replaced (RPC failover)');
  }

  // ─── Pre-Trade Validation ─────────────────────────────────────────────────

  private async ensureSufficientSol(): Promise<void> {
    const lamports = await withRetry(
      () => this.connection.getBalance(this.wallet.publicKey),
      'sol-balance-check',
      { maxAttempts: 2 },
    );
    this.cachedSolBalance = lamports / LAMPORTS_PER_SOL;
    if (this.cachedSolBalance < MIN_SOL_FOR_FEES) {
      throw new Error(
        `Insufficient SOL for transaction fees. Balance: ${this.cachedSolBalance.toFixed(4)} SOL. ` +
        `Minimum required: ${MIN_SOL_FOR_FEES} SOL.`
      );
    }
  }

  private validateLeverage(market: string, leverage: number): void {
    const limits = getLeverageLimits(market);
    if (leverage < limits.min) {
      throw new Error(`Minimum leverage for ${market}: ${limits.min}x`);
    }
    if (leverage > limits.max) {
      throw new Error(`Maximum leverage for ${market}: ${limits.max}x`);
    }
  }

  // ─── Pool Management ──────────────────────────────────────────────────────

  private getPoolConfigForMarket(market: string): PoolConfig {
    const poolName = getPoolForMarket(market);
    if (!poolName) throw new Error(`Unknown market: ${market}`);
    // Check if pool is tradeable (SDK supports it)
    if (!isTradeablePool(poolName)) {
      throw new Error(`${market} (${poolName}) is not yet available for trading. The pool exists in the protocol config but the SDK doesn't support it yet. Check for flash-sdk updates.`);
    }
    if (poolName !== this.poolConfig.poolName) {
      const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
      // Register this pool's program IDs in the instance whitelist
      this.allowedPrograms.add(pc.programId.toBase58());
      if (pc.perpComposibilityProgramId) this.allowedPrograms.add(pc.perpComposibilityProgramId.toBase58());
      if (pc.fbNftRewardProgramId) this.allowedPrograms.add(pc.fbNftRewardProgramId.toBase58());
      if (pc.rewardDistributionProgram?.programId) this.allowedPrograms.add(pc.rewardDistributionProgram.programId.toBase58());
      ALLOWED_PROGRAM_IDS = this.allowedPrograms;
      return pc;
    }
    return this.poolConfig;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async getPriceMap(poolConfig: PoolConfig): Promise<Map<string, LiveTokenPrice>> {
    const tokens = (poolConfig.tokens as Array<{ symbol: string; pythTicker: string }>).map((t) => ({
      symbol: t.symbol,
      pythTicker: t.pythTicker,
    }));
    return this.priceService.getPrices(tokens);
  }

  private findToken(poolConfig: PoolConfig, symbol: string) {
    const tokens = poolConfig.tokens as Array<{ symbol: string; mintKey: PublicKey; decimals: number; pythTicker: string }>;
    const token = tokens.find((t) => t.symbol === symbol);
    if (!token) throw new Error(`Token ${symbol} not found in pool`);
    return token;
  }

  /**
   * Resolve a token symbol from its mint address within the pool.
   * Used to determine a position's actual collateral token.
   */
  private resolveTokenSymbol(poolConfig: PoolConfig, mint: PublicKey): string {
    const tokens = poolConfig.tokens as Array<{ symbol: string; mintKey: PublicKey }>;
    const token = tokens.find((t) => t.mintKey.equals(mint));
    if (!token) throw new Error(`Token with mint ${mint.toBase58()} not found in pool`);
    return token.symbol;
  }

  private findCustody(poolConfig: PoolConfig, symbol: string) {
    const custodies = poolConfig.custodies as Array<{ symbol: string; custodyAccount: PublicKey }>;
    const custody = custodies.find((c) => c.symbol === symbol);
    if (!custody) throw new Error(`Custody for ${symbol} not found`);
    return custody;
  }

  private async findUserPosition(
    poolConfig: PoolConfig,
    market: string,
    side: TradeSide
  ): Promise<{
    position: { pubkey: PublicKey; market: PublicKey };
    marketConfig: { marketAccount: PublicKey; targetMint: PublicKey; collateralMint: PublicKey; side: typeof Side.Long | typeof Side.Short };
  }> {
    const sdkSide = toSdkSide(side);
    const positions = await this.perpClient.getUserPositions(this.wallet.publicKey, poolConfig);
    const token = this.findToken(poolConfig, market);
    const markets = poolConfig.markets as unknown as Array<{
      marketAccount: PublicKey; targetMint: PublicKey; collateralMint: PublicKey; side: typeof Side.Long | typeof Side.Short;
    }>;

    const marketConfig = markets.find(
      (m) => m.targetMint.equals(token.mintKey) && m.side === sdkSide
    );
    if (!marketConfig) throw new Error(`Market config for ${market} ${side} not found`);

    const position = (positions as Array<{ pubkey: PublicKey; market: PublicKey }>).find(
      (p) => p.market.equals(marketConfig.marketAccount)
    );
    if (!position) throw new Error(`No open ${side} position on ${market}`);

    return { position, marketConfig };
  }

  /**
   * Check if a signature is already confirmed on-chain.
   * Used to prevent false failure reports when simulation disagrees with actual state.
   */
  private async isSignatureConfirmed(signature: string): Promise<boolean> {
    try {
      const { value } = await this.connection.getSignatureStatuses([signature]);
      const status = value?.[0];
      if (status?.err) return false;
      return status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
    } catch {
      return false;
    }
  }

  /**
   * Send a transaction with up to 3 attempts.
   * Each attempt gets a fresh blockhash and re-signs via the SDK.
   * Program errors (from simulation) are thrown immediately without retrying.
   * Before each retry, checks if the previous attempt's tx landed late
   * to prevent duplicate collateral operations.
   */
  private async sendTx(
    instructions: TransactionInstruction[],
    additionalSigners: Signer[],
    poolConfig: PoolConfig,
    addressLookupTableAccounts?: AddressLookupTableAccount[],
  ): Promise<string> {
    const logger = getLogger();

    // Pre-signing safety: verify keypair is still valid (not zeroed/disconnected)
    if (!this.walletMgr.verifyKeypairIntegrity()) {
      throw new Error('Wallet keypair is invalid or disconnected. Reconnect your wallet before signing.');
    }

    // ── Instruction Validation ──
    // Validate ALL instructions target approved programs BEFORE any signing attempt.
    // This is the critical security gate — if any instruction targets an unknown program,
    // the transaction is rejected immediately.
    validateInstructionPrograms(instructions, 'sendTx');

    // Freeze the instruction array to prevent mutation after validation.
    // Any attempt to push/splice instructions after this point will throw.
    const validatedInstructions = Object.freeze([...instructions]);

    // ── Resolve ALTs if not provided ──
    // Flash SDK requires ALTs for all transactions (compresses account refs 32→1 byte).
    // Auto-resolve from pool config when caller doesn't provide them.
    let altAccounts = addressLookupTableAccounts;
    if (!altAccounts) {
      try {
        altAccounts = await resolveALTs(this.perpClient, poolConfig);
      } catch {
        altAccounts = [];
      }
    }

    // ── ALT diagnostics (first attempt only, debug level) ──
    if (altAccounts.length > 0) {
      const overlap = verifyALTAccountOverlap(instructions, altAccounts);
      if (overlap.compressible > 0) {
        logger.debug('ALT', `TX accounts: ${overlap.totalAccounts}, compressible via ALT: ${overlap.compressible} (${(overlap.compressionRatio * 100).toFixed(0)}%)`);
      } else {
        logger.debug('ALT', `TX has ${overlap.totalAccounts} accounts but 0 overlap with ALT — tables will have no effect`);
      }
    }

    // ── Route through Ultra-TX Engine when available ──
    const txEngine = getUltraTxEngine();
    if (txEngine) {
      const result = await txEngine.submitTransaction(
        [...validatedInstructions],
        additionalSigners,
        altAccounts,
      );
      logger.info('CLIENT', `Ultra-TX: ${result.signature} (${result.metrics.totalLatencyMs}ms, ${result.metrics.confirmedViaWs ? 'WS' : 'HTTP'}, ${result.broadcastEndpoints} endpoints)`);
      // Reset session idle timer on successful trade
      this.walletMgr.resetIdleTimer();
      // Invalidate balance cache — balances changed after trade
      this.walletMgr.clearBalanceCache();
      return result.signature;
    }

    const maxAttempts = 3;
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice });

    let lastError = '';
    let lastSignature = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Capture connection at start of attempt — use this reference for the ENTIRE
      // attempt (send + confirm loop). If a background failover swaps this.connection
      // mid-poll, the captured reference keeps polling the RPC that actually received
      // the transaction, preventing false timeouts and duplicate submissions.
      const conn = this.connection;

      // Before retrying, check if the PREVIOUS attempt's tx landed late.
      // This prevents duplicate collateral additions/removals where the program
      // has no built-in dedup (unlike openPosition which rejects duplicates).
      if (attempt > 1 && lastSignature) {
        try {
          const confirmed = await this.isSignatureConfirmed(lastSignature);
          if (confirmed) {
            process.stdout.write('                              \r');
            logger.info('CLIENT', `Previous tx confirmed (late detection before retry): ${lastSignature}`);
            return lastSignature;
          }
        } catch {
          // Best-effort — proceed with retry if check fails
        }
      }

      if (attempt === 1) {
        process.stdout.write('  Sending transaction...   \r');
      } else {
        process.stdout.write(`  Retry ${attempt}/${maxAttempts} (fresh blockhash)...\r`);
        logger.info('CLIENT', `Retry attempt ${attempt}/${maxAttempts}`);
      }

      try {
        // Use pre-cached blockhash when available (0ms latency vs ~200-500ms RPC call).
        // On retries, always fetch fresh to avoid using a near-expiry blockhash.
        const { blockhash, fetchLatencyMs: bhLatency } = attempt === 1
          ? await this.getBlockhash(conn)
          : await (async () => {
              const start = Date.now();
              const result = await conn.getLatestBlockhash('confirmed');
              return { blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight, fetchLatencyMs: Date.now() - start };
            })();
        if (bhLatency > 10_000) {
          logger.info('CLIENT', `Blockhash fetch took ${(bhLatency / 1000).toFixed(1)}s — confirmation window reduced`);
        }
        // [L-10] Reduce confirmation timeout when blockhash fetch was slow to avoid expiry
        const timeoutMs = 45_000;
        const effectiveTimeoutMs = bhLatency > 5_000
          ? Math.max(timeoutMs - bhLatency, 20_000)
          : timeoutMs;
        const allIxs = [cuLimitIx, cuPriceIx, ...validatedInstructions];
        const message = MessageV0.compile({
          payerKey: this.wallet.publicKey,
          instructions: allIxs,
          recentBlockhash: blockhash,
          addressLookupTableAccounts: altAccounts ?? [],
        });

        // Log ALT compilation result on first attempt
        if (attempt === 1) {
          logMessageALTDiagnostics(message, 'sendTx');
        }

        const vtx = new VersionedTransaction(message);
        vtx.sign([this.wallet, ...additionalSigners]);

        // Pre-send simulation on first attempt to catch program errors early.
        // Subsequent retries skip simulation since the blockhash changes.
        if (attempt === 1) {
          try {
            const simResult = await conn.simulateTransaction(vtx, {
              sigVerify: false,
              replaceRecentBlockhash: true,
            });
            if (simResult.value.err) {
              const simErr = JSON.stringify(simResult.value.err);
              // Program errors (InstructionError) are terminal — don't retry
              if (simErr.includes('InstructionError') || simErr.includes('Custom')) {
                throw new Error(mapProgramError(simErr));
              }
              logger.info('CLIENT', `Pre-send simulation warning: ${simErr}`);
            }
          } catch (simError: unknown) {
            const simMsg = getErrorMessage(simError);
            // Re-throw program errors (from mapProgramError) and simulation failures
            if (simMsg.includes('simulation failed') || simMsg.includes('Trade rejected') || simMsg.includes('Transaction rejected')) throw simError;
            // Non-critical simulation failures (RPC timeout etc) — proceed with send
            logger.debug('CLIENT', `Pre-send simulation skipped: ${scrubSensitive(simMsg)}`);
          }
        }

        const txBytes = Buffer.from(vtx.serialize());

        // ── Route through execution engine (MagicBlock or RPC) ──
        // The engine router handles send + confirm for MagicBlock, with
        // automatic fallback to RPC on failure. For standard RPC mode,
        // it delegates directly to the rpcSend callback below.
        const engineRouter = getEngineRouter();
        if (engineRouter && engineRouter.engine === 'magicblock') {
          try {
            const engineResult = await engineRouter.executeTransaction(
              txBytes,
              async (bytes) => {
                const sig = await conn.sendRawTransaction(bytes, { skipPreflight: true, maxRetries: 3 });
                return sig;
              },
            );
            lastSignature = engineResult.signature;
            if (engineResult.fallback) {
              logger.info('CLIENT', `MagicBlock fallback → RPC: ${engineResult.signature}`);
              // Fall through to standard RPC confirmation loop below
            } else {
              logger.info('CLIENT', `MagicBlock confirmed: ${engineResult.signature} (${engineResult.latencyMs}ms)`);
              process.stdout.write('                              \r');
              this.walletMgr.resetIdleTimer();
              this.walletMgr.clearBalanceCache();
              return engineResult.signature;
            }
          } catch (engineErr: unknown) {
            const engineMsg = getErrorMessage(engineErr);
            if (engineMsg.includes('failed on-chain')) {
              process.stdout.write('                              \r');
              throw engineErr;
            }
            logger.warn('CLIENT', `Engine router error: ${engineMsg} — using standard RPC`);
            // Fall through to standard RPC path
          }
        }

        const signatureStr = lastSignature || await conn.sendRawTransaction(txBytes, {
          skipPreflight: true,
          maxRetries: 3,
        });
        lastSignature = signatureStr;
        logger.info('CLIENT', `Tx sent: ${signatureStr} (${txBytes.length} bytes, attempt ${attempt})`);

        // Poll for confirmation with periodic resends
        // Uses the same `conn` that sent the transaction — never switches mid-poll.
        process.stdout.write('  Awaiting confirmation... \r');
        const start = Date.now();
        const pollTimeoutMs = effectiveTimeoutMs;
        for (let i = 0; Date.now() - start < pollTimeoutMs; i++) {
          await new Promise(r => setTimeout(r, 2_000));
          const { value } = await conn.getSignatureStatuses([signatureStr]);
          const status = value?.[0];
          if (status?.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
          }
          if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            process.stdout.write('                              \r');
            logger.info('CLIENT', `Tx confirmed: ${signatureStr}`);
            // [H-3] Reset session idle timer on successful trade
            this.walletMgr.resetIdleTimer();
            // Invalidate balance cache — balances changed after trade
            this.walletMgr.clearBalanceCache();
            return signatureStr;
          }
          // Resend every other poll to improve delivery
          if (i % 2 === 0) {
            conn.sendRawTransaction(txBytes, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
          }
        }

        // Before declaring timeout, do one final status check using the SAME
        // connection that sent the tx. The tx may have landed between the last
        // poll and now. This prevents duplicate submissions.
        try {
          const { value: finalValue } = await conn.getSignatureStatuses([signatureStr]);
          const finalStatus = finalValue?.[0];
          if (finalStatus && !finalStatus.err &&
              (finalStatus.confirmationStatus === 'confirmed' || finalStatus.confirmationStatus === 'finalized')) {
            process.stdout.write('                              \r');
            logger.info('CLIENT', `Tx confirmed (late detection): ${signatureStr}`);
            this.walletMgr.clearBalanceCache();
            return signatureStr;
          }
        } catch {
          // Final check is best-effort — if it fails we proceed to retry
        }

        lastError = `Not confirmed within ${timeoutMs / 1000}s`;
        logger.warn('CLIENT', `Attempt ${attempt} timed out — ${lastError}`);
      } catch (e: unknown) {
        const eMsg = getErrorMessage(e);
        if (eMsg.includes('failed on-chain')) {
          process.stdout.write('                              \r');
          throw e;
        }
        lastError = eMsg;
        logger.warn('CLIENT', `Attempt ${attempt} failed: ${scrubSensitive(eMsg)}`);

        // On network-level failures, attempt RPC failover before next retry.
        // Uses force=true to bypass cooldown — explicit trade failures warrant
        // immediate failover regardless of the background monitor's cooldown.
        if (attempt < maxAttempts && isNetworkError(eMsg)) {
          const rpcMgr = getRpcManagerInstance();
          if (rpcMgr && rpcMgr.fallbackCount > 0) {
            logger.info('CLIENT', 'Network error detected — attempting RPC failover before retry');
            rpcMgr.recordResult(false);
            const didFailover = await rpcMgr.failover(true);
            if (didFailover) {
              // replaceConnection is called via the onConnectionChange callback.
              // Next iteration captures the new this.connection via `const conn = this.connection`.
              logger.info('CLIENT', `Switched to ${rpcMgr.activeEndpoint.label} — retrying`);
            }
          }
        }
      }
    }

    process.stdout.write('                              \r');
    throw new Error(
      `Transaction failed after ${maxAttempts} attempts.\n` +
      `  Last error: ${lastError}\n` +
      (lastSignature ? `  Last signature: ${lastSignature}\n  Check https://solscan.io/tx/${lastSignature}` : '')
    );
  }


  // ─── Trade Mutex ──────────────────────────────────────────────────────────

  private acquireTradeLock(market: string, side: TradeSide): void {
    const key = `${market}:${side}`;
    if (this.activeTrades.has(key)) {
      throw new Error(`A ${side} trade on ${market} is already in progress. Wait for it to complete.`);
    }
    this.activeTrades.add(key);
  }

  private releaseTradeLock(market: string, side: TradeSide): void {
    this.activeTrades.delete(`${market}:${side}`);
  }

  // ─── Recent Trade Cache ──────────────────────────────────────────────────

  /**
   * Build a cache key for a trade operation.
   */
  private tradeCacheKey(action: string, market: string, side: TradeSide, amount?: number): string {
    return `${action}:${market}:${side}${amount !== undefined ? `:${amount}` : ''}`;
  }

  /**
   * Check if an identical trade was recently submitted. Prevents accidental
   * duplicate commands when the user re-sends after a timeout that actually landed.
   * Evicts expired entries on each check.
   */
  private checkRecentTrade(key: string): void {
    const now = Date.now();
    // Evict expired entries
    for (const [k, ts] of this.recentTrades) {
      if (now - ts > FlashClient.TRADE_CACHE_TTL_MS) {
        this.recentTrades.delete(k);
      }
    }
    const lastTime = this.recentTrades.get(key);
    if (lastTime && now - lastTime < FlashClient.TRADE_CACHE_TTL_MS) {
      const ago = Math.ceil((now - lastTime) / 1000);
      throw new Error(
        `Duplicate trade detected — the same trade was submitted ${ago}s ago.\n` +
        `  Wait ${Math.ceil((FlashClient.TRADE_CACHE_TTL_MS - (now - lastTime)) / 1000)}s or check "positions" to verify.`
      );
    }
  }

  /**
   * Record a successful trade in the cache.
   */
  private recordRecentTrade(key: string): void {
    this.recentTrades.set(key, Date.now());
  }

  // ─── Open Position ────────────────────────────────────────────────────────

  async openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string
  ): Promise<OpenPositionResult> {
    const logger = getLogger();

    // Pre-trade validation (synchronous checks before locking)
    this.validateLeverage(market, leverage);
    const sideStr = side === TradeSide.Long ? 'long' : 'short';
    if (collateralAmount < 10) {
      throw new Error(
        `Minimum collateral is $10 (got $${collateralAmount}).\n` +
        `  Try: open ${leverage}x ${sideStr} ${market} $10`
      );
    }

    // Duplicate trade cache check (synchronous)
    const cacheKey = this.tradeCacheKey('open', market, side, collateralAmount);
    this.checkRecentTrade(cacheKey);

    // Acquire trade lock BEFORE any async operations to prevent interleaving
    this.acquireTradeLock(market, side);
    try {
      // ── Parallel pre-trade validation ──
      // Run SOL fee check and USDC balance check concurrently.
      // These are independent RPC calls that previously ran sequentially (~600-1500ms total).
      const poolConfig = this.getPoolConfigForMarket(market);
      const inputSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
      const sdkSide = toSdkSide(side);

      const [, , priceMap] = await Promise.all([
        // 1. SOL fee check
        this.ensureSufficientSol(),

        // 2. USDC balance check
        (async () => {
          // USDC balance check
          if (inputSymbol === 'USDC') {
            try {
              const balances = await this.walletMgr.getTokenBalances();
              const usdcBalance = balances.tokens.find(t => t.symbol === 'USDC')?.amount ?? 0;
              if (usdcBalance < collateralAmount) {
                throw new Error(
                  `Insufficient USDC collateral.\n` +
                  `  Required: $${collateralAmount.toFixed(2)}\n` +
                  `  Available: $${usdcBalance.toFixed(2)}\n` +
                  `  Deposit USDC to trade on Flash Trade.`
                );
              }
            } catch (e: unknown) {
              const eMsg = getErrorMessage(e);
              if (eMsg.includes('Insufficient USDC')) throw e;
              logger.info('CLIENT', `USDC balance check skipped (RPC error): ${scrubSensitive(eMsg)}`);
            }
          }

          // Note: no duplicate position check — Flash Trade protocol allows
          // increasing position size by opening additional same-side trades.
          // The protocol merges them into a single position with recalculated
          // weighted entry price.
        })(),

        // 3. Price map fetch (runs concurrently with validation checks)
        this.getPriceMap(poolConfig),
      ]);

      const targetToken = this.findToken(poolConfig, market);
      const collateralSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
      const inputToken = this.findToken(poolConfig, collateralSymbol);

      logger.info('TRADE', 'Trade Request', {
        market, side, collateralToken: inputToken.symbol,
        collateralAmount, leverage, size: collateralAmount * leverage,
      });
      const targetPrice = priceMap.get(targetToken.symbol);
      const inputPrice = priceMap.get(inputToken.symbol);
      if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}. Try again later.`);
      if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}. Try again later.`);

      const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
        true, new BN(this.config.defaultSlippageBps), targetPrice.price, sdkSide
      );

      const collateralNative = uiDecimalsToNative(collateralAmount.toString(), inputToken.decimals);
      const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
      const outputCustody = this.findCustody(poolConfig, targetToken.symbol);

      const custodyAccounts = await withRetry(
        () => this.perpClient.program.account.custody.fetchMultiple([
          inputCustody.custodyAccount, outputCustody.custodyAccount,
        ]),
        'custody-fetch',
        { maxAttempts: 2 },
      );

      if (!custodyAccounts[0] || !custodyAccounts[1]) {
        throw new Error('Failed to fetch custody accounts from chain');
      }

      const sizeAmount = this.perpClient.getSizeAmountFromLeverageAndCollateral(
        collateralNative, leverage.toString(), targetToken as unknown as Token, inputToken as unknown as Token, sdkSide,
        targetPrice.price, targetPrice.emaPrice,
        CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
        inputPrice.price, inputPrice.emaPrice,
        CustodyAccount.from(inputCustody.custodyAccount, custodyAccounts[0]),
        BN_ZERO
      );

      // ── Determine the correct collateral token for this market+side ──
      // The on-chain market PDA is derived from (targetCustody, collateralCustody, side).
      // For non-virtual tokens (JUP, JTO, RAY, HYPE): long collateral = self, short collateral = USDC
      // For virtual tokens (PYTH, KMNO, MET): long collateral = JUP, short collateral = USDC
      // We MUST look this up from poolConfig.markets rather than assuming collateral = target.
      const poolMarkets = poolConfig.markets as unknown as Array<{
        targetMint: PublicKey; collateralMint: PublicKey;
        side: typeof Side.Long | typeof Side.Short;
      }>;
      const matchedMarket = poolMarkets.find(
        m => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide
      );
      let marketCollateralSymbol: string;
      if (matchedMarket) {
        marketCollateralSymbol = this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint);
      } else {
        // Fallback: assume collateral = target (works for standard markets)
        logger.info('TRADE', `No market config found for ${market}/${sideStr}, assuming collateral = target`);
        marketCollateralSymbol = targetToken.symbol;
      }

      logger.debug('TRADE', `Instruction routing: market=${market} side=${sideStr} ` +
        `inputToken=${inputToken.symbol} marketCollateral=${marketCollateralSymbol}`);

      // ── Check if a position already exists → use increaseSize instead of openPosition ──
      // Flash Trade protocol rejects openPosition when a same-market same-side position exists.
      // In that case, use increaseSize to merge into the existing position.
      let existingPositionPubkey: PublicKey | null = null;
      try {
        const { position } = await this.findUserPosition(poolConfig, market, side);
        existingPositionPubkey = position.pubkey;
        logger.info('TRADE', `Existing ${sideStr} position found on ${market} — will increaseSize`);
      } catch {
        // No existing position — will open new
      }

      let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };
      if (existingPositionPubkey) {
        // Increase existing position size
        logger.debug('TRADE', `Using increaseSize(${targetToken.symbol}, ${marketCollateralSymbol}, ${existingPositionPubkey.toBase58()})`);
        result = await this.perpClient.increaseSize(
          targetToken.symbol, marketCollateralSymbol, existingPositionPubkey,
          sdkSide, poolConfig, priceAfterSlippage, sizeAmount, Privilege.None
        );
      } else if (inputToken.symbol === marketCollateralSymbol) {
        // User's input token matches the market's collateral custody → direct open
        logger.debug('TRADE', `Using openPosition(${targetToken.symbol}, ${marketCollateralSymbol})`);
        result = await this.perpClient.openPosition(
          targetToken.symbol, marketCollateralSymbol, priceAfterSlippage,
          collateralNative, sizeAmount, sdkSide, poolConfig, Privilege.None
        );
      } else {
        // User's input token differs from market collateral → swap first
        logger.debug('TRADE', `Using swapAndOpen(${targetToken.symbol}, ${marketCollateralSymbol}, ${inputToken.symbol})`);
        result = await this.perpClient.swapAndOpen(
          targetToken.symbol, marketCollateralSymbol, inputToken.symbol,
          collateralNative, priceAfterSlippage, sizeAmount, sdkSide,
          poolConfig, Privilege.None
        );
      }

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);
      this.recordRecentTrade(cacheKey);

      // Compute SDK-exact liquidation price for the return value
      let openLiqPrice = 0;
      try {
        const targetCustodyAcct = CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]);
        const openSizeUsd = targetPrice.price.getAssetAmountUsd(sizeAmount, targetToken.decimals);
        const openCollateralUsd = inputPrice.price.getAssetAmountUsd(collateralNative, inputToken.decimals);
        const liqResult = this.perpClient.getLiquidationPriceWithOrder(
          openCollateralUsd, sizeAmount, openSizeUsd, targetToken.decimals,
          targetPrice.price, sdkSide, targetCustodyAcct,
        );
        const liqUi = parseFloat(liqResult.toUiPrice(8));
        if (Number.isFinite(liqUi) && liqUi > 0) openLiqPrice = liqUi;

        // ── Protocol divergence check ──
        // Compare CLI formula against SDK result to detect math drift.
        // Reuses existing data — no extra RPC calls.
        if (openLiqPrice > 0) {
          try {
            const { computeSimulationLiquidationPrice, checkLiquidationDivergence } =
              await import('../utils/protocol-liq.js');
            const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
            const feeRates = await getProtocolFeeRates(market, this.perpClient);
            const sizeUsd = collateralAmount * leverage;
            const cliLiq = computeSimulationLiquidationPrice(
              targetPrice.uiPrice, sizeUsd, collateralAmount, side,
              feeRates.maintenanceMarginRate, feeRates.closeFeeRate,
            );
            if (cliLiq > 0) {
              await checkLiquidationDivergence(
                cliLiq, this.perpClient,
                targetPrice.price, BN_ZERO, sdkSide,
                targetCustodyAcct, null, market,
              );
            }
          } catch (divErr: unknown) {
            const divMsg = getErrorMessage(divErr);
            if (divMsg.includes('Protocol divergence exceeds')) throw divErr;
            logger.debug('DIVERGENCE', `Check skipped: ${divMsg}`);
          }
        }
      } catch (liqErr: unknown) {
        const liqMsg = getErrorMessage(liqErr);
        if (liqMsg.includes('Protocol divergence exceeds')) throw liqErr;
        // Non-critical: liquidation price is display-only
      }

      logger.trade('OPEN', {
        market, side, collateral: collateralAmount, leverage,
        price: targetPrice.uiPrice, tx: txSignature,
      });

      return {
        txSignature,
        entryPrice: targetPrice.uiPrice,
        liquidationPrice: openLiqPrice,
        sizeUsd: collateralAmount * leverage,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  // ─── Close Position ───────────────────────────────────────────────────────

  async closePosition(
    market: string, side: TradeSide, receiveToken?: string,
    closePercent?: number, closeAmount?: number
  ): Promise<ClosePositionResult> {
    const logger = getLogger();

    const cacheKey = this.tradeCacheKey('close', market, side);
    this.checkRecentTrade(cacheKey);

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const sdkSide = toSdkSide(side);
      const sideStr = side === TradeSide.Long ? 'long' : 'short';

      const targetToken = this.findToken(poolConfig, market);
      const receivingToken = receiveToken
        ? this.findToken(poolConfig, receiveToken)
        : this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);

      // Parallel: SOL check + price fetch
      const [, priceMap] = await Promise.all([
        this.ensureSufficientSol(),
        this.getPriceMap(poolConfig),
      ]);
      const targetPrice = priceMap.get(targetToken.symbol);
      if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}. Try again later.`);

      const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
        false, new BN(this.config.defaultSlippageBps), targetPrice.price, sdkSide
      );

      // ── Determine the correct collateral token for this market+side ──
      const poolMarkets = poolConfig.markets as unknown as Array<{
        targetMint: PublicKey; collateralMint: PublicKey;
        side: typeof Side.Long | typeof Side.Short;
      }>;
      const matchedMarket = poolMarkets.find(
        m => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide
      );
      let marketCollateralSymbol: string;
      if (matchedMarket) {
        marketCollateralSymbol = this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint);
      } else {
        logger.info('TRADE', `No market config found for ${market}/${sideStr}, assuming collateral = target`);
        marketCollateralSymbol = targetToken.symbol;
      }

      // ── Determine if this is a partial or full close ──
      const isPartial = (closePercent !== undefined && closePercent < 100) ||
                        (closeAmount !== undefined);

      // Fetch position data for PnL computation and partial close sizing
      let positionSizeUsd = 0;
      let pnl = 0;
      const existingPositions = await this.getPositions();
      const pos = existingPositions.find(
        p => p.market?.toUpperCase() === market.toUpperCase() && p.side === side
      );
      if (pos && pos.entryPrice > 0 && pos.sizeUsd > 0) {
        positionSizeUsd = pos.sizeUsd;
        const priceDelta = targetPrice.uiPrice - pos.entryPrice;
        const pnlMult = side === TradeSide.Long ? 1 : -1;
        pnl = (priceDelta / pos.entryPrice) * pos.sizeUsd * pnlMult;
        if (!Number.isFinite(pnl)) pnl = 0;
      }

      // Compute the USD amount to close and validate
      let closeSizeUsd = positionSizeUsd; // default: full close
      if (closePercent !== undefined && closePercent < 100) {
        closeSizeUsd = positionSizeUsd * (closePercent / 100);
      } else if (closeAmount !== undefined) {
        if (closeAmount > positionSizeUsd) {
          throw new Error(`Close amount $${closeAmount.toFixed(2)} exceeds position size $${positionSizeUsd.toFixed(2)}`);
        }
        closeSizeUsd = closeAmount;
      }

      // If remaining size would be negligibly small (< $0.50), close entirely
      const remainingAfterClose = positionSizeUsd - closeSizeUsd;
      const shouldFullClose = !isPartial || remainingAfterClose < 0.50 || closeSizeUsd >= positionSizeUsd;

      // Scale PnL proportionally for partial close
      if (isPartial && !shouldFullClose && positionSizeUsd > 0) {
        pnl = pnl * (closeSizeUsd / positionSizeUsd);
        if (!Number.isFinite(pnl)) pnl = 0;
      }

      logger.debug('TRADE', `Close routing: market=${market} side=${sideStr} ` +
        `partial=${isPartial} fullClose=${shouldFullClose} closeSizeUsd=${closeSizeUsd.toFixed(2)} ` +
        `receiveToken=${receivingToken.symbol} marketCollateral=${marketCollateralSymbol}`);

      let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };

      if (shouldFullClose) {
        // ── Full close ──
        if (receivingToken.symbol === marketCollateralSymbol) {
          logger.debug('TRADE', `Using closePosition(${targetToken.symbol}, ${marketCollateralSymbol})`);
          result = await this.perpClient.closePosition(
            targetToken.symbol, marketCollateralSymbol, priceAfterSlippage,
            sdkSide, poolConfig, Privilege.None
          );
        } else {
          logger.debug('TRADE', `Using closeAndSwap(${targetToken.symbol}, ${receivingToken.symbol}, ${marketCollateralSymbol})`);
          result = await this.perpClient.closeAndSwap(
            targetToken.symbol, receivingToken.symbol, marketCollateralSymbol,
            priceAfterSlippage, sdkSide, poolConfig, Privilege.None
          );
        }
      } else {
        // ── Partial close via decreaseSize ──
        const { position } = await this.findUserPosition(poolConfig, market, side);
        const positionData = await this.perpClient.program.account.position.fetch(position.pubkey);
        const posData = positionData as unknown as { sizeAmount: BN };
        if (!posData.sizeAmount || posData.sizeAmount.isZero()) {
          throw new Error(`No open ${side} position on ${market} to partially close`);
        }

        // Compute sizeDelta in native token units proportional to closePercent/closeAmount
        let sizeDelta: BN;
        if (closePercent !== undefined) {
          // Scale native sizeAmount by percentage
          sizeDelta = posData.sizeAmount.mul(new BN(Math.round(closePercent * 100))).div(new BN(10000));
        } else {
          // Scale native sizeAmount by USD ratio
          const ratio = closeSizeUsd / positionSizeUsd;
          sizeDelta = posData.sizeAmount.mul(new BN(Math.round(ratio * 10000))).div(new BN(10000));
        }

        if (sizeDelta.isZero()) {
          throw new Error('Computed close size is too small');
        }

        logger.debug('TRADE', `Using decreaseSize(${targetToken.symbol}, ${marketCollateralSymbol}, sizeDelta=${sizeDelta.toString()})`);
        result = await this.perpClient.decreaseSize(
          targetToken.symbol, marketCollateralSymbol, sdkSide,
          position.pubkey, poolConfig, priceAfterSlippage,
          sizeDelta, Privilege.None
        );
      }

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);
      this.recordRecentTrade(cacheKey);

      const closeAction = shouldFullClose ? 'CLOSE' : 'PARTIAL_CLOSE';
      logger.trade(closeAction, {
        market, side, price: targetPrice.uiPrice, pnl,
        closeSizeUsd: shouldFullClose ? positionSizeUsd : closeSizeUsd,
        tx: txSignature,
      });

      return {
        txSignature,
        exitPrice: targetPrice.uiPrice,
        pnl,
        isPartial: isPartial && !shouldFullClose,
        closedSizeUsd: shouldFullClose ? positionSizeUsd : closeSizeUsd,
        remainingSizeUsd: shouldFullClose ? 0 : remainingAfterClose,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  // ─── Collateral Management ────────────────────────────────────────────────

  async addCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    const cacheKey = this.tradeCacheKey('add', market, side, amount);
    this.checkRecentTrade(cacheKey);

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      // Parallel: SOL check + position lookup
      const [, { position, marketConfig }] = await Promise.all([
        this.ensureSufficientSol(),
        this.findUserPosition(poolConfig, market, side),
      ]);

      // Resolve position's actual collateral token from its collateralMint
      const collateralSymbol = this.resolveTokenSymbol(poolConfig, marketConfig.collateralMint);
      const inputToken = this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);
      const amountNative = uiDecimalsToNative(amount.toString(), inputToken.decimals);

      let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };

      if (inputToken.symbol === collateralSymbol) {
        // Input matches position collateral — direct addCollateral
        result = await this.perpClient.addCollateral(
          amountNative, market, collateralSymbol, toSdkSide(side), position.pubkey, poolConfig
        );
      } else {
        // Position collateral differs from input (e.g. position uses SOL, input is USDC)
        // Use swapAndAddCollateral to swap input into position's collateral token
        result = await this.perpClient.swapAndAddCollateral(
          market, inputToken.symbol, collateralSymbol, amountNative,
          toSdkSide(side), position.pubkey, poolConfig
        );
      }

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);
      this.recordRecentTrade(cacheKey);
      getLogger().trade('ADD_COLLATERAL', { market, side, amount, collateralSymbol, tx: txSignature });
      return { txSignature };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  async removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    const cacheKey = this.tradeCacheKey('remove', market, side, amount);
    this.checkRecentTrade(cacheKey);

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      // Parallel: SOL check + position lookup
      const [, { position, marketConfig }] = await Promise.all([
        this.ensureSufficientSol(),
        this.findUserPosition(poolConfig, market, side),
      ]);

      // Resolve position's actual collateral token from its collateralMint
      const collateralSymbol = this.resolveTokenSymbol(poolConfig, marketConfig.collateralMint);
      const outputToken = this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);
      // removeCollateral uses USD amount (collateralDeltaUsd), so always 6 decimals
      const amountNative = uiDecimalsToNative(amount.toString(), 6);

      let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };

      if (outputToken.symbol === collateralSymbol) {
        // Position collateral matches desired output — direct removeCollateral
        result = await this.perpClient.removeCollateral(
          amountNative, market, collateralSymbol, toSdkSide(side), position.pubkey, poolConfig
        );
      } else {
        // Position collateral differs from desired output (e.g. collateral is SOL, want USDC)
        // Use removeCollateralAndSwap to withdraw and swap to output token
        result = await this.perpClient.removeCollateralAndSwap(
          market, collateralSymbol, outputToken.symbol, amountNative,
          toSdkSide(side), poolConfig
        );
      }

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);
      this.recordRecentTrade(cacheKey);
      getLogger().trade('REMOVE_COLLATERAL', { market, side, amount, collateralSymbol, tx: txSignature });
      return { txSignature };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  // ─── Dry Run / Transaction Preview ─────────────────────────────────────

  /**
   * Build a transaction preview without signing or sending.
   * Compiles the transaction, runs Solana simulation, and returns details.
   * SAFETY: No signing or sending occurs. The transaction is compiled and simulated only.
   */
  async previewOpenPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<DryRunPreview> {
    const logger = getLogger();

    this.validateLeverage(market, leverage);
    if (collateralAmount < 10) {
      throw new Error(`Minimum collateral is $10 (got $${collateralAmount}).`);
    }

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const targetToken = this.findToken(poolConfig, market);
    const collateralSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
    const inputToken = this.findToken(poolConfig, collateralSymbol);

    const priceMap = await this.getPriceMap(poolConfig);
    const targetPrice = priceMap.get(targetToken.symbol);
    const inputPrice = priceMap.get(inputToken.symbol);
    if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}.`);
    if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}.`);

    const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
      true, new BN(this.config.defaultSlippageBps), targetPrice.price, sdkSide,
    );

    const collateralNative = uiDecimalsToNative(collateralAmount.toString(), inputToken.decimals);
    const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
    const outputCustody = this.findCustody(poolConfig, targetToken.symbol);

    const custodyAccounts = await withRetry(
      () => this.perpClient.program.account.custody.fetchMultiple([
        inputCustody.custodyAccount, outputCustody.custodyAccount,
      ]),
      'custody-fetch-preview',
      { maxAttempts: 2 },
    );

    if (!custodyAccounts[0] || !custodyAccounts[1]) {
      throw new Error('Failed to fetch custody accounts from chain');
    }

    const sizeAmount = this.perpClient.getSizeAmountFromLeverageAndCollateral(
      collateralNative, leverage.toString(), targetToken as unknown as Token, inputToken as unknown as Token, sdkSide,
      targetPrice.price, targetPrice.emaPrice,
      CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
      inputPrice.price, inputPrice.emaPrice,
      CustodyAccount.from(inputCustody.custodyAccount, custodyAccounts[0]),
      BN_ZERO,
    );

    // ── Determine the correct collateral token for this market+side ──
    const poolMarkets = poolConfig.markets as unknown as Array<{
      targetMint: PublicKey; collateralMint: PublicKey;
      side: typeof Side.Long | typeof Side.Short;
    }>;
    const matchedMarket = poolMarkets.find(
      m => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide
    );
    const marketCollateralSymbol = matchedMarket
      ? this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint)
      : targetToken.symbol;

    let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };
    if (inputToken.symbol === marketCollateralSymbol) {
      result = await this.perpClient.openPosition(
        targetToken.symbol, marketCollateralSymbol, priceAfterSlippage,
        collateralNative, sizeAmount, sdkSide, poolConfig, Privilege.None,
      );
    } else {
      result = await this.perpClient.swapAndOpen(
        targetToken.symbol, marketCollateralSymbol, inputToken.symbol,
        collateralNative, priceAfterSlippage, sizeAmount, sdkSide,
        poolConfig, Privilege.None,
      );
    }

    // Validate instructions target approved programs (even in preview)
    validateInstructionPrograms(result.instructions, 'dryrun');

    // Build the transaction WITHOUT signing
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice });
    const allIxs = [cuLimitIx, cuPriceIx, ...result.instructions];

    // Resolve ALTs for accurate size preview
    let previewALTs: AddressLookupTableAccount[] = [];
    try {
      previewALTs = await resolveALTs(this.perpClient, poolConfig);
    } catch { /* non-critical for preview */ }

    const { blockhash } = await this.getBlockhash(this.connection);
    const message = MessageV0.compile({
      payerKey: this.wallet.publicKey,
      instructions: allIxs,
      recentBlockhash: blockhash,
      addressLookupTableAccounts: previewALTs,
    });
    const vtx = new VersionedTransaction(message);
    // DO NOT sign — this is a preview only
    const txBytes = Buffer.from(vtx.serialize());

    // Collect unique accounts from all instructions
    const accountSet = new Set<string>();
    for (const ix of allIxs) {
      accountSet.add(ix.programId.toBase58());
      for (const key of ix.keys) {
        accountSet.add(key.pubkey.toBase58());
      }
    }

    // Liquidation price — use SDK's exact protocol math
    const targetCustodyAcct = CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]);
    const sizeUsd = targetPrice.price.getAssetAmountUsd(sizeAmount, targetToken.decimals);
    const collateralUsd = inputPrice.price.getAssetAmountUsd(collateralNative, inputToken.decimals);
    let liqPrice = 0;
    try {
      const liqOraclePrice = this.perpClient.getLiquidationPriceWithOrder(
        collateralUsd, sizeAmount, sizeUsd, targetToken.decimals,
        targetPrice.price, sdkSide, targetCustodyAcct,
      );
      liqPrice = parseFloat(liqOraclePrice.toUiPrice(8));
      if (!Number.isFinite(liqPrice) || liqPrice < 0) liqPrice = 0;
    } catch {
      // Fallback: SDK call failed, use 0 rather than approximate
      liqPrice = 0;
    }

    const preview: DryRunPreview = {
      market,
      side,
      collateral: collateralAmount,
      leverage,
      positionSize: collateralAmount * leverage,
      entryPrice: targetPrice.uiPrice,
      liquidationPrice: liqPrice,
      estimatedFee: (() => {
        try {
          const RATE_POWER = 1_000_000_000;
          const openFeeBps = parseFloat(targetCustodyAcct.fees.openPosition.toString()) / RATE_POWER;
          return collateralAmount * leverage * openFeeBps;
        } catch {
          return 0; // SDK fee unavailable
        }
      })(),
      programId: poolConfig.programId.toBase58(),
      accountCount: accountSet.size,
      instructionCount: allIxs.length,
      estimatedComputeUnits: this.config.computeUnitLimit,
      transactionSize: txBytes.length,
    };

    // Run Solana simulation (RPC simulateTransaction)
    try {
      // Sign for simulation only (required by simulateTransaction)
      const simVtx = new VersionedTransaction(message);
      simVtx.sign([this.wallet, ...result.additionalSigners]);

      const simResult = await this.connection.simulateTransaction(simVtx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });

      preview.simulationSuccess = !simResult.value.err;
      preview.simulationLogs = simResult.value.logs ?? [];
      preview.simulationUnitsConsumed = simResult.value.unitsConsumed ?? 0;
      if (simResult.value.err) {
        preview.simulationError = JSON.stringify(simResult.value.err);
      }
    } catch (e: unknown) {
      preview.simulationSuccess = false;
      preview.simulationError = getErrorMessage(e);
      logger.debug('DRYRUN', `Simulation failed: ${getErrorMessage(e)}`);
    }

    logger.info('DRYRUN', `Preview built for ${market} ${side} ${leverage}x $${collateralAmount}`);
    return preview;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    // Query ALL tradeable pools in parallel — not just the default pool.
    // Users may have positions across Crypto.1, Governance.1, Virtual.1, etc.
    const seen = new Set<string>();
    const uniquePools = POOL_NAMES.filter(name => {
      if (seen.has(name) || !isTradeablePool(name)) return false;
      seen.add(name);
      return true;
    });

    const results = await Promise.allSettled(
      uniquePools.map(async (poolName) => {
        const positions: Position[] = [];
        await this.getPositionsForPool(poolName, positions);
        return positions;
      })
    );

    const allPositions: Position[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allPositions.push(...result.value);
      }
    }
    return allPositions;
  }

  private async getPositionsForPool(poolName: string, positions: Position[]): Promise<void> {
    const poolConfig = poolName === this.poolConfig.poolName
      ? this.poolConfig
      : PoolConfig.fromIdsByName(poolName, this.config.network);

    const rawPositions = await this.perpClient.getUserPositions(this.wallet.publicKey, poolConfig);
    if (rawPositions.length === 0) return;

    const priceMap = await this.getPriceMap(poolConfig);
    const markets = poolConfig.markets as unknown as Array<{
      marketAccount: PublicKey; targetMint: PublicKey; collateralMint: PublicKey;
      side: typeof Side.Long | typeof Side.Short;
    }>;
    const tokens = poolConfig.tokens as Array<{ symbol: string; mintKey: PublicKey; decimals: number }>;
    const custodies = poolConfig.custodies as Array<{ custodyAccount: PublicKey; symbol: string }>;

    // Batch-fetch all custody accounts for SDK liquidation math
    const custodyKeys = custodies.map(c => c.custodyAccount);
    let custodyAccountMap = new Map<string, CustodyAccount>();
    try {
      const custodyData = await this.perpClient.program.account.custody.fetchMultiple(custodyKeys);
      for (let i = 0; i < custodies.length; i++) {
        const cd = custodyData[i];
        if (cd) {
          custodyAccountMap.set(
            custodies[i].symbol,
            CustodyAccount.from(custodyKeys[i], cd as Parameters<typeof CustodyAccount.from>[1]),
          );
        }
      }
    } catch {
      getLogger().debug('CLIENT', `Custody fetch for ${poolName} failed, liq prices may be unavailable`);
    }

    for (const raw of rawPositions as unknown as Array<{
      pubkey: PublicKey; market: PublicKey;
      entryPrice?: { price: BN; exponent: number } | BN; sizeUsd?: BN; collateralUsd?: BN; openTime?: BN;
      unsettledFeesUsd?: BN; sizeAmount?: BN;
      sizeDecimals?: number; collateralDecimals?: number;
    }>) {
      try {
        const marketConfig = markets.find((m) => m.marketAccount.equals(raw.market));
        if (!marketConfig) continue;

        const targetToken = tokens.find((t) => t.mintKey.equals(marketConfig.targetMint));
        if (!targetToken) continue;

        const tokenPrice = priceMap.get(targetToken.symbol);
        if (!tokenPrice) continue;

        // Entry price is a ContractOraclePrice { price: BN, exponent: number }
        const rawEntryField = raw.entryPrice;
        let parsedEntry = 0;
        if (rawEntryField && typeof rawEntryField === 'object' && 'price' in rawEntryField && 'exponent' in rawEntryField) {
          parsedEntry = parseFloat(rawEntryField.price.toString()) * Math.pow(10, rawEntryField.exponent);
        } else if (rawEntryField && BN.isBN(rawEntryField)) {
          const oracleExp = Number(tokenPrice.price.exponent.toString());
          parsedEntry = parseFloat(rawEntryField.toString()) * Math.pow(10, oracleExp);
        }

        // USD values in Flash Trade always use 6 decimal precision (USD_DECIMALS),
        // NOT the token's native decimals (sizeDecimals/collateralDecimals are TOKEN decimals).
        const USD_DECIMALS = 6;
        const parsedSize = raw.sizeUsd ? parseFloat(raw.sizeUsd.toString()) / Math.pow(10, USD_DECIMALS) : 0;
        const parsedCollateral = raw.collateralUsd ? parseFloat(raw.collateralUsd.toString()) / Math.pow(10, USD_DECIMALS) : 0;
        const parsedCurrentPrice = tokenPrice.uiPrice;

        // NaN/Infinity guard
        const entryPrice = Number.isFinite(parsedEntry) ? parsedEntry : 0;
        const sizeUsd = Number.isFinite(parsedSize) ? parsedSize : 0;
        const collateralUsd = Number.isFinite(parsedCollateral) ? parsedCollateral : 0;
        const currentPrice = Number.isFinite(parsedCurrentPrice) ? parsedCurrentPrice : 0;

        if (entryPrice <= 0 || sizeUsd <= 0 || collateralUsd <= 0) {
          getLogger().warn('CLIENT', `Skipping position with invalid values: entry=${entryPrice} size=${sizeUsd} collateral=${collateralUsd}`);
          continue;
        }

        const rawLeverage = sizeUsd / collateralUsd;
        const leverage = Number.isFinite(rawLeverage) ? rawLeverage : 0;
        const side = marketConfig.side === Side.Long ? TradeSide.Long : TradeSide.Short;
        const priceDelta = currentPrice - entryPrice;
        const pnlMult = side === TradeSide.Long ? 1 : -1;
        const unrealizedPnl = (priceDelta / entryPrice) * sizeUsd * pnlMult;
        const safeUnrealizedPnl = Number.isFinite(unrealizedPnl) ? unrealizedPnl : 0;

        // SDK liquidation price — uses the same math as the Flash Trade protocol
        let liquidationPrice = 0;
        const targetCustodyAcct = custodyAccountMap.get(targetToken.symbol);
        if (targetCustodyAcct && raw.entryPrice && typeof raw.entryPrice === 'object' && 'price' in raw.entryPrice && 'exponent' in raw.entryPrice) {
          try {
            const entryOraclePrice = OraclePrice.from({
              price: raw.entryPrice.price,
              exponent: new BN(raw.entryPrice.exponent),
              confidence: BN_ZERO,
              timestamp: BN_ZERO,
            });
            const unsettledFees = raw.unsettledFeesUsd ?? BN_ZERO;
            // Cast raw decoded position data to PositionAccount for SDK liquidation math
            const posAcct = PositionAccount.from(raw.pubkey, raw as unknown as ConstructorParameters<typeof PositionAccount>[1]);
            const liqOraclePrice = this.perpClient.getLiquidationPriceContractHelper(
              entryOraclePrice, unsettledFees, marketConfig.side, targetCustodyAcct, posAcct,
            );
            const liqUi = parseFloat(liqOraclePrice.toUiPrice(8));
            if (Number.isFinite(liqUi) && liqUi > 0) {
              liquidationPrice = liqUi;
            }
          } catch {
            // Fall back to 0 if SDK calculation fails
          }
        }

        // Accumulated fees from protocol (unsettledFeesUsd is in USD with 6 decimals)
        const rawFees = raw.unsettledFeesUsd
          ? parseFloat(raw.unsettledFeesUsd.toString()) / Math.pow(10, USD_DECIMALS)
          : 0;
        const totalFees = Number.isFinite(rawFees) ? rawFees : 0;

        const rawPnlPct = collateralUsd > 0 ? (safeUnrealizedPnl / collateralUsd) * 100 : 0;

        positions.push({
          pubkey: raw.pubkey.toBase58(),
          market: targetToken.symbol,
          side,
          entryPrice,
          currentPrice,
          markPrice: currentPrice,
          sizeUsd,
          collateralUsd,
          leverage,
          unrealizedPnl: safeUnrealizedPnl,
          unrealizedPnlPercent: Number.isFinite(rawPnlPct) ? rawPnlPct : 0,
          liquidationPrice,
          openFee: 0,
          totalFees,
          fundingRate: 0, // Flash Trade uses lock fees (included in unsettledFeesUsd), not periodic funding rates
          timestamp: raw.openTime ? Number(raw.openTime.toString()) : Date.now() / 1000,
        });
      } catch (error: unknown) {
        getLogger().warn('CLIENT', `Failed to parse position: ${getErrorMessage(error)}`);
      }
    }

  }

  async getMarketData(market?: string): Promise<MarketData[]> {
    // If a specific market is requested and it's not in the default pool, find its pool
    const poolConfigs: PoolConfig[] = [];
    if (market) {
      const poolName = getPoolForMarket(market);
      if (poolName && isTradeablePool(poolName)) {
        poolConfigs.push(
          poolName === this.poolConfig.poolName
            ? this.poolConfig
            : PoolConfig.fromIdsByName(poolName, this.config.network)
        );
      } else {
        // Fallback to default pool
        poolConfigs.push(this.poolConfig);
      }
    } else {
      // No filter — query all tradeable pools in parallel
      const seen = new Set<string>();
      for (const name of POOL_NAMES) {
        if (seen.has(name) || !isTradeablePool(name)) continue;
        seen.add(name);
        try {
          poolConfigs.push(
            name === this.poolConfig.poolName
              ? this.poolConfig
              : PoolConfig.fromIdsByName(name, this.config.network)
          );
        } catch { /* skip unloadable pools */ }
      }
    }

    const results: MarketData[] = [];
    const seenSymbols = new Set<string>();

    await Promise.all(poolConfigs.map(async (pc) => {
      try {
        const priceMap = await this.getPriceMap(pc);
        const tokens = pc.tokens as Array<{ symbol: string }>;

        for (const token of tokens) {
          if (market && token.symbol !== market) continue;
          if (seenSymbols.has(token.symbol)) continue;
          if (!priceMap.has(token.symbol)) continue;

          seenSymbols.add(token.symbol);
          const tp = priceMap.get(token.symbol)!;
          results.push({
            symbol: token.symbol,
            price: tp.uiPrice,
            priceChange24h: 0,
            openInterestLong: 0,
            openInterestShort: 0,
            maxLeverage: getMaxLeverage(token.symbol, false),
            fundingRate: 0, // Flash Trade uses lock fees, not periodic funding rates
          });
        }
      } catch { /* skip pools with price fetch failures */ }
    }));

    return results;
  }

  async getPortfolio(): Promise<Portfolio> {
    const [solBalance, usdcBalance, positions] = await withRetry(
      () => Promise.all([
        this.connection.getBalance(this.wallet.publicKey),
        this.getUsdcBalance(),
        this.getPositions(),
      ]),
      'portfolio-fetch',
      { maxAttempts: 2 },
    );

    const solBal = solBalance / LAMPORTS_PER_SOL;
    this.cachedSolBalance = solBal;

    return {
      walletAddress: this.wallet.publicKey.toBase58(),
      balance: solBal,
      balanceLabel: `SOL: ${solBal.toFixed(4)} | USDC: ${usdcBalance.toFixed(2)}`,
      totalCollateralUsd: positions.reduce((s, p) => s + p.collateralUsd, 0),
      totalUnrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
      totalRealizedPnl: 0,
      totalFees: positions.reduce((s, p) => s + p.totalFees, 0),
      positions,
      totalPositionValue: positions.reduce((s, p) => s + p.sizeUsd, 0),
      usdcBalance,
    };
  }

  private async getUsdcBalance(): Promise<number> {
    try {
      const accounts = await withRetry(
        () => this.connection.getParsedTokenAccountsByOwner(
          this.wallet.publicKey,
          { mint: USDC_MINT }
        ),
        'usdc-balance',
        { maxAttempts: 2 },
      );
      if (accounts.value.length === 0) return 0;
      const info = accounts.value[0].account.data.parsed?.info;
      return info?.tokenAmount?.uiAmount ?? 0;
    } catch (error: unknown) {
      getLogger().warn('CLIENT', `USDC balance fetch failed: ${getErrorMessage(error)}`);
      return 0;
    }
  }

  getBalance(): number {
    return this.cachedSolBalance;
  }

  // ─── On-Chain Order Methods ──────────────────────────────────────────────

  /**
   * Convert a UI price to ContractOraclePrice { price: BN, exponent: number }.
   * Flash protocol uses exponent = -9, price = floor(uiPrice * 10^9).
   */
  private toContractOraclePrice(uiPrice: number): ContractOraclePrice {
    const exponent = -9;
    const price = new BN(Math.floor(uiPrice * 1e9));
    return { price, exponent };
  }

  /** Zero price for optional TP/SL fields */
  private zeroContractPrice(): ContractOraclePrice {
    return { price: BN_ZERO, exponent: -9 };
  }

  /**
   * Resolve the market's collateral symbol and receiveSymbol from poolConfig.markets.
   * For longs, collateral is often the target token itself (SOL, BTC) or a base token (JUP for virtual).
   * For shorts, collateral is USDC.
   * receiveSymbol = USDC for shorts or the market's collateral for longs.
   */
  private resolveOrderTokens(poolConfig: PoolConfig, market: string, sdkSide: typeof Side.Long | typeof Side.Short) {
    const targetToken = this.findToken(poolConfig, market);
    const poolMarkets = poolConfig.markets as unknown as Array<{
      targetMint: PublicKey; collateralMint: PublicKey;
      side: typeof Side.Long | typeof Side.Short;
    }>;
    const matchedMarket = poolMarkets.find(
      m => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide
    );
    let collateralSymbol: string;
    if (matchedMarket) {
      collateralSymbol = this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint);
    } else {
      collateralSymbol = targetToken.symbol;
    }
    return { targetSymbol: targetToken.symbol, collateralSymbol, targetToken };
  }

  async placeLimitOrder(
    market: string,
    side: TradeSide,
    collateral: number,
    leverage: number,
    limitPrice: number,
    stopLoss?: number,
    takeProfit?: number,
  ): Promise<PlaceLimitOrderResult> {
    const logger = getLogger();
    this.validateLeverage(market, leverage);

    if (collateral < 10) {
      throw new Error(`Minimum collateral is $10 (got $${collateral})`);
    }

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const sdkSide = toSdkSide(side);
      const { targetSymbol, collateralSymbol, targetToken } = this.resolveOrderTokens(poolConfig, market, sdkSide);

      // Reserve symbol = what user deposits as collateral for the order
      const reserveSymbol = DEFAULT_COLLATERAL_TOKEN;
      const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;

      // Get price map and custody for size calculation
      const priceMap = await this.getPriceMap(poolConfig);
      const inputToken = this.findToken(poolConfig, reserveSymbol);
      const targetPrice = priceMap.get(targetSymbol);
      const inputPrice = priceMap.get(inputToken.symbol);
      if (!targetPrice) throw new Error(`Oracle unavailable for ${targetSymbol}`);
      if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}`);

      const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
      const outputCustody = this.findCustody(poolConfig, targetSymbol);
      const custodyAccounts = await withRetry(
        () => this.perpClient.program.account.custody.fetchMultiple([
          inputCustody.custodyAccount, outputCustody.custodyAccount,
        ]),
        'custody-fetch', { maxAttempts: 2 },
      );
      if (!custodyAccounts[0] || !custodyAccounts[1]) {
        throw new Error('Failed to fetch custody accounts from chain');
      }

      const collateralNative = uiDecimalsToNative(collateral.toString(), inputToken.decimals);
      const sizeAmount = this.perpClient.getSizeAmountFromLeverageAndCollateral(
        collateralNative, leverage.toString(), targetToken as unknown as Token, inputToken as unknown as Token, sdkSide,
        targetPrice.price, targetPrice.emaPrice,
        CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
        inputPrice.price, inputPrice.emaPrice,
        CustodyAccount.from(inputCustody.custodyAccount, custodyAccounts[0]),
        BN_ZERO
      );

      const limitPriceContract = this.toContractOraclePrice(limitPrice);
      const slPrice = stopLoss ? this.toContractOraclePrice(stopLoss) : this.zeroContractPrice();
      const tpPrice = takeProfit ? this.toContractOraclePrice(takeProfit) : this.zeroContractPrice();

      const result = await this.perpClient.placeLimitOrder(
        targetSymbol, collateralSymbol, reserveSymbol, receiveSymbol,
        sdkSide, limitPriceContract, collateralNative, sizeAmount,
        slPrice, tpPrice, poolConfig
      );

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

      logger.trade('LIMIT_ORDER', {
        market, side, collateral, leverage, limitPrice, tx: txSignature,
      });

      return {
        txSignature,
        market: market.toUpperCase(),
        side,
        limitPrice,
        collateral,
        leverage,
        sizeUsd: collateral * leverage,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  async placeTriggerOrder(
    market: string,
    side: TradeSide,
    triggerPrice: number,
    isStopLoss: boolean,
  ): Promise<PlaceTriggerOrderResult> {
    const logger = getLogger();

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const sdkSide = toSdkSide(side);
      const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);
      const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;

      // Get the existing position to determine size
      const { position } = await this.findUserPosition(poolConfig, market, side);
      const positionData = await this.perpClient.program.account.position.fetch(position.pubkey);
      const posData = positionData as unknown as { sizeAmount: BN };
      if (!posData.sizeAmount || posData.sizeAmount.isZero()) {
        throw new Error(`No open ${side} position on ${market} to set ${isStopLoss ? 'stop-loss' : 'take-profit'} on`);
      }

      const triggerPriceContract = this.toContractOraclePrice(triggerPrice);

      const result = await this.perpClient.placeTriggerOrder(
        targetSymbol, collateralSymbol, receiveSymbol,
        sdkSide, triggerPriceContract, posData.sizeAmount,
        isStopLoss, poolConfig
      );

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

      logger.trade(isStopLoss ? 'SET_SL' : 'SET_TP', {
        market, side, triggerPrice, tx: txSignature,
      });

      return {
        txSignature,
        market: market.toUpperCase(),
        side,
        triggerPrice,
        isStopLoss,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  /**
   * Build trigger order instructions WITHOUT sending a transaction.
   * Used by openPositionAtomic() to batch open + TP/SL into one tx.
   */
  private async buildTriggerOrderInstructions(
    market: string,
    side: TradeSide,
    triggerPrice: number,
    isStopLoss: boolean,
    sizeAmount: BN,
    poolConfig: PoolConfig,
  ): Promise<SdkResult> {
    const sdkSide = toSdkSide(side);
    const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);
    const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;
    const triggerPriceContract = this.toContractOraclePrice(triggerPrice);

    return this.perpClient.placeTriggerOrder(
      targetSymbol, collateralSymbol, receiveSymbol,
      sdkSide, triggerPriceContract, sizeAmount,
      isStopLoss, poolConfig,
    );
  }

  /**
   * Open a position with optional TP/SL in a SINGLE atomic transaction.
   * All instructions (open + take-profit + stop-loss) are batched together,
   * producing one Solscan transaction entry.
   *
   * Falls back to sequential transactions if the batch exceeds size limits.
   */
  async openPositionAtomic(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
    takeProfit?: number,
    stopLoss?: number,
  ): Promise<OpenPositionResult & { triggerOrdersIncluded?: boolean }> {
    const logger = getLogger();
    const hasTriggers = takeProfit !== undefined || stopLoss !== undefined;

    // If no TP/SL, delegate to standard openPosition
    if (!hasTriggers) {
      return this.openPosition(market, side, collateralAmount, leverage, collateralToken);
    }

    // Pre-trade validation
    this.validateLeverage(market, leverage);
    const sideStr = side === TradeSide.Long ? 'long' : 'short';
    if (collateralAmount < 10) {
      throw new Error(
        `Minimum collateral is $10 (got $${collateralAmount}).\n` +
        `  Try: open ${leverage}x ${sideStr} ${market} $10`
      );
    }

    const cacheKey = this.tradeCacheKey('open', market, side, collateralAmount);
    this.checkRecentTrade(cacheKey);

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const inputSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
      const sdkSide = toSdkSide(side);

      const [, , priceMap] = await Promise.all([
        this.ensureSufficientSol(),
        (async () => {
          if (inputSymbol === 'USDC') {
            try {
              const balances = await this.walletMgr.getTokenBalances();
              const usdcBalance = balances.tokens.find(t => t.symbol === 'USDC')?.amount ?? 0;
              if (usdcBalance < collateralAmount) {
                throw new Error(
                  `Insufficient USDC collateral.\n` +
                  `  Required: $${collateralAmount.toFixed(2)}\n` +
                  `  Available: $${usdcBalance.toFixed(2)}\n` +
                  `  Deposit USDC to trade on Flash Trade.`
                );
              }
            } catch (e: unknown) {
              const eMsg = getErrorMessage(e);
              if (eMsg.includes('Insufficient USDC')) throw e;
              logger.info('CLIENT', `USDC balance check skipped: ${scrubSensitive(eMsg)}`);
            }
          }
        })(),
        this.getPriceMap(poolConfig),
      ]);

      const targetToken = this.findToken(poolConfig, market);
      const collateralSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
      const inputToken = this.findToken(poolConfig, collateralSymbol);

      const targetPrice = priceMap.get(targetToken.symbol);
      const inputPrice = priceMap.get(inputToken.symbol);
      if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}. Try again later.`);
      if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}. Try again later.`);

      const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
        true, new BN(this.config.defaultSlippageBps), targetPrice.price, sdkSide,
      );

      const collateralNative = uiDecimalsToNative(collateralAmount.toString(), inputToken.decimals);
      const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
      const outputCustody = this.findCustody(poolConfig, targetToken.symbol);

      const custodyAccounts = await withRetry(
        () => this.perpClient.program.account.custody.fetchMultiple([
          inputCustody.custodyAccount, outputCustody.custodyAccount,
        ]),
        'custody-fetch',
        { maxAttempts: 2 },
      );
      if (!custodyAccounts[0] || !custodyAccounts[1]) {
        throw new Error('Failed to fetch custody accounts from chain');
      }

      const sizeAmount = this.perpClient.getSizeAmountFromLeverageAndCollateral(
        collateralNative, leverage.toString(), targetToken as unknown as Token, inputToken as unknown as Token, sdkSide,
        targetPrice.price, targetPrice.emaPrice,
        CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
        inputPrice.price, inputPrice.emaPrice,
        CustodyAccount.from(inputCustody.custodyAccount, custodyAccounts[0]),
        BN_ZERO,
      );

      // Resolve market collateral
      const poolMarkets = poolConfig.markets as unknown as Array<{
        targetMint: PublicKey; collateralMint: PublicKey;
        side: typeof Side.Long | typeof Side.Short;
      }>;
      const matchedMarket = poolMarkets.find(
        m => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide,
      );
      const marketCollateralSymbol = matchedMarket
        ? this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint)
        : targetToken.symbol;

      // Check for existing position
      let existingPositionPubkey: PublicKey | null = null;
      try {
        const { position } = await this.findUserPosition(poolConfig, market, side);
        existingPositionPubkey = position.pubkey;
      } catch {
        // No existing position
      }

      // ── Build open position instructions ──
      let openResult: SdkResult;
      if (existingPositionPubkey) {
        openResult = await this.perpClient.increaseSize(
          targetToken.symbol, marketCollateralSymbol, existingPositionPubkey,
          sdkSide, poolConfig, priceAfterSlippage, sizeAmount, Privilege.None,
        );
      } else if (inputToken.symbol === marketCollateralSymbol) {
        openResult = await this.perpClient.openPosition(
          targetToken.symbol, marketCollateralSymbol, priceAfterSlippage,
          collateralNative, sizeAmount, sdkSide, poolConfig, Privilege.None,
        );
      } else {
        openResult = await this.perpClient.swapAndOpen(
          targetToken.symbol, marketCollateralSymbol, inputToken.symbol,
          collateralNative, priceAfterSlippage, sizeAmount, sdkSide,
          poolConfig, Privilege.None,
        );
      }

      // ── Build trigger order instructions ──
      let tpResult: SdkResult | null = null;
      let slResult: SdkResult | null = null;

      if (takeProfit !== undefined && !existingPositionPubkey) {
        try {
          tpResult = await this.buildTriggerOrderInstructions(
            market, side, takeProfit, false, sizeAmount, poolConfig,
          );
        } catch (err: unknown) {
          logger.info('CLIENT', `Failed to build TP instructions: ${getErrorMessage(err)}`);
        }
      }

      if (stopLoss !== undefined && !existingPositionPubkey) {
        try {
          slResult = await this.buildTriggerOrderInstructions(
            market, side, stopLoss, true, sizeAmount, poolConfig,
          );
        } catch (err: unknown) {
          logger.info('CLIENT', `Failed to build SL instructions: ${getErrorMessage(err)}`);
        }
      }

      // ── Aggregate instructions ──
      const batch = createBatch();
      appendToBatch(batch, openResult, 'open');
      if (tpResult) appendToBatch(batch, tpResult, 'tp');
      if (slResult) appendToBatch(batch, slResult, 'sl');

      // ── Resolve ALTs for size optimization ──
      let altAccounts: AddressLookupTableAccount[] = [];
      try {
        altAccounts = await resolveALTs(this.perpClient, poolConfig);
      } catch {
        // Continue without ALTs
      }

      // ── Resolve ATAs for trigger orders ──
      if (tpResult || slResult) {
        try {
          const receiveToken = this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);
          const ataIxs = await ensureATAs(
            this.connection,
            this.wallet.publicKey,
            [receiveToken.mintKey],
          );
          if (ataIxs.length > 0) {
            // Prepend ATA creation instructions
            batch.instructions.unshift(...ataIxs);
          }
        } catch {
          // Non-critical — ATAs likely exist
        }
      }

      // ── Check if batch fits in one transaction ──
      let triggerOrdersIncluded = false;
      let txSignature: string;

      if ((tpResult || slResult) && isBatchWithinLimit(batch, this.wallet.publicKey, altAccounts)) {
        // Atomic: all instructions in one transaction
        logger.info('TRADE', `Atomic tx: ${batchSummary(batch)}`);
        txSignature = await this.sendTx(batch.instructions, batch.additionalSigners, poolConfig, altAccounts);
        triggerOrdersIncluded = true;
      } else if (tpResult || slResult) {
        // Fallback: open first, then TP/SL separately
        logger.info('TRADE', `Batch too large — splitting open + TP/SL into separate txs`);
        txSignature = await this.sendTx(openResult.instructions, openResult.additionalSigners, poolConfig, altAccounts);

        // Send TP/SL as separate transaction(s) after open confirms
        if (tpResult) {
          try {
            await this.sendTx(tpResult.instructions, tpResult.additionalSigners, poolConfig, altAccounts);
          } catch { /* TP is non-critical */ }
        }
        if (slResult) {
          try {
            await this.sendTx(slResult.instructions, slResult.additionalSigners, poolConfig, altAccounts);
          } catch { /* SL is non-critical */ }
        }
      } else {
        // Just the open position
        txSignature = await this.sendTx(openResult.instructions, openResult.additionalSigners, poolConfig, altAccounts);
      }

      this.recordRecentTrade(cacheKey);

      // Compute liquidation price
      let openLiqPrice = 0;
      try {
        const targetCustodyAcct = CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]);
        const openSizeUsd = targetPrice.price.getAssetAmountUsd(sizeAmount, targetToken.decimals);
        const openCollateralUsd = inputPrice.price.getAssetAmountUsd(collateralNative, inputToken.decimals);
        const liqResult = this.perpClient.getLiquidationPriceWithOrder(
          openCollateralUsd, sizeAmount, openSizeUsd, targetToken.decimals,
          targetPrice.price, sdkSide, CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
        );
        const liqUi = parseFloat(liqResult.toUiPrice(8));
        if (Number.isFinite(liqUi) && liqUi > 0) openLiqPrice = liqUi;
      } catch {
        // Non-critical
      }

      const entryPrice = targetPrice.price.toUiPrice(8);

      return {
        txSignature,
        entryPrice: parseFloat(entryPrice),
        liquidationPrice: openLiqPrice,
        sizeUsd: collateralAmount * leverage,
        triggerOrdersIncluded,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  async cancelTriggerOrder(
    market: string,
    side: TradeSide,
    orderId: number,
    isStopLoss: boolean,
  ): Promise<CancelOrderResult> {
    const logger = getLogger();

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);

    const result = await this.perpClient.cancelTriggerOrder(
      targetSymbol, collateralSymbol, sdkSide, orderId, isStopLoss, poolConfig
    );

    const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    logger.trade(isStopLoss ? 'CANCEL_SL' : 'CANCEL_TP', {
      market, side, orderId, tx: txSignature,
    });

    return { txSignature };
  }

  async cancelAllTriggerOrders(
    market: string,
    side: TradeSide,
  ): Promise<CancelOrderResult> {
    const logger = getLogger();

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);

    const result = await this.perpClient.cancelAllTriggerOrders(
      targetSymbol, collateralSymbol, sdkSide, poolConfig
    );

    const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    logger.trade('CANCEL_ALL_TRIGGERS', { market, side, tx: txSignature });

    return { txSignature };
  }

  async cancelLimitOrder(
    market: string,
    side: TradeSide,
    orderId: number,
  ): Promise<CancelOrderResult> {
    const logger = getLogger();

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);
    const reserveSymbol = DEFAULT_COLLATERAL_TOKEN;
    const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;

    // Use editLimitOrder with zero size to cancel (or use program.methods directly)
    // The SDK doesn't expose cancelLimitOrder directly, but the Anchor program does.
    // We'll use the program.methods approach since CancelLimitOrderParams exists.
    try {
      const targetToken = this.findToken(poolConfig, market);
      const collateralToken = this.findToken(poolConfig, collateralSymbol);
      const reserveToken = this.findToken(poolConfig, reserveSymbol);
      const receiveToken = this.findToken(poolConfig, receiveSymbol);

      // Edit with zero size effectively cancels
      const result = await this.perpClient.editLimitOrder(
        targetToken.symbol, collateralToken.symbol, reserveToken.symbol, receiveToken.symbol,
        sdkSide, orderId, this.zeroContractPrice(), BN_ZERO,
        this.zeroContractPrice(), this.zeroContractPrice(),
        poolConfig
      );

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);
      logger.trade('CANCEL_LIMIT', { market, side, orderId, tx: txSignature });
      return { txSignature };
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      logger.warn('CLIENT', `cancelLimitOrder via editLimitOrder failed: ${msg}`);
      throw new Error(`Failed to cancel limit order #${orderId}: ${msg}`);
    }
  }

  async editLimitOrder(
    market: string,
    side: TradeSide,
    orderId: number,
    newLimitPrice: number,
  ): Promise<CancelOrderResult> {
    const logger = getLogger();

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);
    const reserveSymbol = DEFAULT_COLLATERAL_TOKEN;
    const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;

    // Fetch current order to preserve size and TP/SL
    const orders = await this.perpClient.getUserOrderAccounts(this.wallet.publicKey, poolConfig);
    const targetToken = this.findToken(poolConfig, market);
    const matchedOrder = orders.find(o => {
      const poolMarkets = poolConfig.markets as unknown as Array<{
        marketAccount: PublicKey; targetMint: PublicKey; side: typeof Side.Long | typeof Side.Short;
      }>;
      const marketConfig = poolMarkets.find(m => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide);
      return marketConfig && o.market.equals(marketConfig.marketAccount);
    });
    if (!matchedOrder) throw new Error(`No order account found for ${market} ${side}`);
    if (orderId >= matchedOrder.limitOrders.length) {
      throw new Error(`Limit order #${orderId} not found (${matchedOrder.limitOrders.length} orders exist)`);
    }
    const existingOrder = matchedOrder.limitOrders[orderId];

    const result = await this.perpClient.editLimitOrder(
      targetSymbol, collateralSymbol, reserveSymbol, receiveSymbol,
      sdkSide, orderId, this.toContractOraclePrice(newLimitPrice),
      existingOrder.sizeAmount,
      existingOrder.stopLossPrice, existingOrder.takeProfitPrice,
      poolConfig
    );

    const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    logger.trade('EDIT_LIMIT', { market, side, orderId, newLimitPrice, tx: txSignature });

    return { txSignature };
  }

  async getUserOrders(): Promise<OnChainOrder[]> {
    const logger = getLogger();
    const result: OnChainOrder[] = [];

    // Iterate all pools to find orders
    for (const poolName of POOL_NAMES) {
      if (!isTradeablePool(poolName)) continue;
      try {
        const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
        const orderAccounts = await this.perpClient.getUserOrderAccounts(this.wallet.publicKey, pc);

        for (const oa of orderAccounts) {
          if (!oa.isActive) continue;

          // Resolve market symbol from the market account
          const poolMarkets = pc.markets as unknown as Array<{
            marketAccount: PublicKey; targetMint: PublicKey;
            side: typeof Side.Long | typeof Side.Short;
          }>;
          const matchedMarket = poolMarkets.find(m => m.marketAccount.equals(oa.market));
          if (!matchedMarket) continue;

          const tokens = pc.tokens as Array<{ symbol: string; mintKey: PublicKey }>;
          const targetToken = tokens.find(t => t.mintKey.equals(matchedMarket.targetMint));
          if (!targetToken) continue;

          const marketSymbol = targetToken.symbol;
          const sideVal = matchedMarket.side === Side.Long ? TradeSide.Long : TradeSide.Short;

          // Limit orders
          for (let i = 0; i < oa.limitOrders.length; i++) {
            const lo = oa.limitOrders[i];
            if (lo.reserveAmount.isZero() && lo.sizeAmount.isZero()) continue;
            const price = this.contractPriceToUi(lo.limitPrice);
            if (price <= 0) continue;
            result.push({
              market: marketSymbol,
              side: sideVal,
              type: 'limit',
              orderId: i,
              price,
            });
          }

          // Take profit orders
          for (let i = 0; i < oa.takeProfitOrders.length; i++) {
            const tp = oa.takeProfitOrders[i];
            if (tp.triggerSize.isZero()) continue;
            const price = this.contractPriceToUi(tp.triggerPrice);
            if (price <= 0) continue;
            result.push({
              market: marketSymbol,
              side: sideVal,
              type: 'take_profit',
              orderId: i,
              price,
            });
          }

          // Stop loss orders
          for (let i = 0; i < oa.stopLossOrders.length; i++) {
            const sl = oa.stopLossOrders[i];
            if (sl.triggerSize.isZero()) continue;
            const price = this.contractPriceToUi(sl.triggerPrice);
            if (price <= 0) continue;
            result.push({
              market: marketSymbol,
              side: sideVal,
              type: 'stop_loss',
              orderId: i,
              price,
            });
          }
        }
      } catch (err: unknown) {
        logger.debug('CLIENT', `Order fetch for pool ${poolName} failed: ${getErrorMessage(err)}`);
      }
    }

    return result;
  }

  private contractPriceToUi(cp: ContractOraclePrice): number {
    if (!cp || cp.price.isZero()) return 0;
    const price = cp.price.toNumber() * Math.pow(10, cp.exponent);
    return Number.isFinite(price) ? price : 0;
  }

  // ─── Swap ──────────────────────────────────────────────────────────────────

  /**
   * Find a pool config that contains a given token symbol.
   * Falls back to the default pool. Unlike getPoolConfigForMarket() which looks
   * up perp markets, this searches pool token lists for swap/earn operations.
   */
  private getPoolConfigForToken(tokenSymbol: string): PoolConfig {
    // First check default pool
    const tokens = this.poolConfig.tokens as Array<{ symbol: string }>;
    if (tokens.some(t => t.symbol === tokenSymbol)) {
      return this.poolConfig;
    }
    // Try all known pools
    for (const poolName of POOL_NAMES) {
      if (!isTradeablePool(poolName)) continue;
      try {
        const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
        const poolTokens = pc.tokens as Array<{ symbol: string }>;
        if (poolTokens.some(t => t.symbol === tokenSymbol)) {
          return pc;
        }
      } catch {
        // Pool not loadable
      }
    }
    throw new Error(`Token ${tokenSymbol} not found in any pool`);
  }

  async swap(
    inputToken: string,
    outputToken: string,
    amountIn: number,
    minAmountOut?: number,
  ) {
    const logger = getLogger();
    // Find a pool containing both tokens — try input token's pool first
    const poolConfig = this.getPoolConfigForToken(inputToken);

    const inToken = this.findToken(poolConfig, inputToken);
    const outToken = this.findToken(poolConfig, outputToken);

    const nativeAmountIn = uiDecimalsToNative(amountIn.toString(), inToken.decimals);
    const minOut = minAmountOut
      ? uiDecimalsToNative(minAmountOut.toString(), outToken.decimals)
      : BN_ZERO; // 0 = accept any amount (slippage handled by pool)

    logger.info('CLIENT', `Swap ${amountIn} ${inputToken} → ${outputToken}`);

    const result = await this.perpClient.swap(
      inToken.symbol,
      outToken.symbol,
      nativeAmountIn,
      minOut,
      poolConfig,
    );

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      inputToken,
      outputToken,
      amountIn,
      amountOut: amountIn, // exact output not known until confirmed
      price: 1, // placeholder — actual rate comes from on-chain
    };
  }

  // ─── Earn (LP & Staking) ───────────────────────────────────────────────────

  /**
   * Resolve a PoolConfig by pool name. Falls back to default pool if not specified.
   */
  private resolvePoolConfig(poolName?: string): PoolConfig {
    if (!poolName) return this.poolConfig;
    if (poolName === this.poolConfig.poolName) return this.poolConfig;
    if (!isTradeablePool(poolName)) {
      throw new Error(`Pool "${poolName}" is not available. Use "earn status" to see available pools.`);
    }
    const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
    // Register program IDs
    this.allowedPrograms.add(pc.programId.toBase58());
    if (pc.perpComposibilityProgramId) this.allowedPrograms.add(pc.perpComposibilityProgramId.toBase58());
    if (pc.fbNftRewardProgramId) this.allowedPrograms.add(pc.fbNftRewardProgramId.toBase58());
    if (pc.rewardDistributionProgram?.programId) this.allowedPrograms.add(pc.rewardDistributionProgram.programId.toBase58());
    ALLOWED_PROGRAM_IDS = this.allowedPrograms;
    return pc;
  }

  async addLiquidity(tokenSymbol: string, amountUsd: number, pool?: string) {
    const logger = getLogger();
    const poolConfig = pool ? this.resolvePoolConfig(pool) : this.getPoolConfigForToken(tokenSymbol);
    const token = this.findToken(poolConfig, tokenSymbol);

    const nativeAmount = uiDecimalsToNative(amountUsd.toString(), token.decimals);
    const flpSymbol = (poolConfig as any).compoundingLpTokenSymbol || 'FLP';

    logger.info('CLIENT', `Add liquidity: ${amountUsd} ${tokenSymbol} → ${poolConfig.poolName} (${flpSymbol})`);

    const rewardTokenMint = poolConfig.compoundingTokenMint;
    const result = await this.perpClient.addCompoundingLiquidity(
      nativeAmount,
      BN_ZERO, // minCompoundingAmountOut — accept any LP tokens
      token.symbol,
      rewardTokenMint,
      poolConfig,
    );

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      action: 'add_liquidity',
      amount: amountUsd,
      token: tokenSymbol,
      message: `Added ${amountUsd} ${tokenSymbol} liquidity to ${poolConfig.poolName} → ${flpSymbol}`,
    };
  }

  async removeLiquidity(tokenSymbol: string, percent: number, pool?: string) {
    const logger = getLogger();
    const poolConfig = pool ? this.resolvePoolConfig(pool) : this.getPoolConfigForToken(tokenSymbol);
    const token = this.findToken(poolConfig, tokenSymbol);
    const flpSymbol = (poolConfig as any).compoundingLpTokenSymbol || 'FLP';

    logger.info('CLIENT', `Remove liquidity: ${percent}% from ${poolConfig.poolName} (${flpSymbol})`);

    const rewardTokenMint = poolConfig.compoundingTokenMint;
    const result = await this.perpClient.removeCompoundingLiquidity(
      BN_ZERO, // compoundingAmountIn
      BN_ZERO, // minAmountOut
      token.symbol,
      rewardTokenMint,
      poolConfig,
    );

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      action: 'remove_liquidity',
      token: tokenSymbol,
      message: `Removed ${percent}% of ${flpSymbol} from ${poolConfig.poolName} → ${tokenSymbol}`,
    };
  }

  async stakeFLP(amountUsd: number, pool?: string) {
    const logger = getLogger();
    const poolConfig = this.resolvePoolConfig(pool);
    const flpSymbol = (poolConfig as any).compoundingLpTokenSymbol || 'FLP';
    const sflpSymbol = (poolConfig as any).stakedLpTokenSymbol || 'sFLP';

    const nativeAmount = uiDecimalsToNative(amountUsd.toString(), poolConfig.lpDecimals);

    logger.info('CLIENT', `Stake ${flpSymbol}: $${amountUsd} → ${sflpSymbol} (${poolConfig.poolName})`);

    const owner = this.wallet.publicKey;
    const result = await this.perpClient.depositStake(
      owner,
      owner,
      nativeAmount,
      poolConfig,
    );

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      action: 'stake',
      amount: amountUsd,
      message: `Staked $${amountUsd} ${flpSymbol} → ${sflpSymbol} (${poolConfig.poolName})`,
    };
  }

  async unstakeFLP(percent: number, pool?: string) {
    const logger = getLogger();
    const poolConfig = this.resolvePoolConfig(pool);
    const sflpSymbol = (poolConfig as any).stakedLpTokenSymbol || 'sFLP';

    logger.info('CLIENT', `Unstake ${sflpSymbol}: ${percent}% (${poolConfig.poolName})`);

    const result = await this.perpClient.unstakeInstant(
      'USDC',
      BN_ZERO,
      poolConfig,
    );

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      action: 'unstake',
      message: `Unstaked ${percent}% of ${sflpSymbol} (${poolConfig.poolName})`,
    };
  }

  async claimRewards(pool?: string) {
    const logger = getLogger();
    const poolConfig = this.resolvePoolConfig(pool);

    logger.info('CLIENT', `Claim rewards from ${poolConfig.poolName}`);

    const result = await this.perpClient.collectStakeFees(
      'USDC',
      poolConfig,
    );

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      action: 'claim_rewards',
      message: `Claimed staking rewards from ${poolConfig.poolName}`,
    };
  }
}
