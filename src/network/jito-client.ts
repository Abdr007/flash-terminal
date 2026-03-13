/**
 * Jito Block Engine Client — MEV-Protected Bundle Submission
 *
 * Submits signed transactions to the Jito block engine for deterministic
 * ordering and faster validator inclusion. Bypasses gossip network entirely.
 *
 * Benefits:
 *   - Deterministic transaction ordering within blocks
 *   - Bypasses p2p gossip propagation delay
 *   - Bundle atomicity (all-or-nothing execution)
 *   - MEV protection (no sandwich attacks)
 *
 * Failover: Jito → standard RPC broadcast (caller handles fallback)
 *
 * Singleton: initJitoClient() / getJitoClient() / shutdownJitoClient()
 */

import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Jito block engine endpoints (mainnet) */
const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
];

/** HTTP timeout for Jito API calls */
const JITO_TIMEOUT_MS = 10_000;

/** Maximum bundle size (Jito supports up to 5 transactions per bundle) */
const MAX_BUNDLE_SIZE = 5;

/** Minimum Jito tip (lamports) — Jito requires a tip to prioritize the bundle */
const DEFAULT_TIP_LAMPORTS = 10_000; // 0.00001 SOL

/** Bundle status poll interval */
const BUNDLE_POLL_INTERVAL_MS = 2_000;

/** Maximum time to wait for bundle landing */
const BUNDLE_CONFIRM_TIMEOUT_MS = 30_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JitoBundleResult {
  /** Jito bundle ID (UUID) */
  bundleId: string;
  /** Whether the bundle was accepted by Jito */
  accepted: boolean;
  /** Landing status after polling */
  landed: boolean;
  /** Slot the bundle landed in (if confirmed) */
  landedSlot?: number;
  /** Total latency from submission to confirmation */
  latencyMs: number;
  /** Which Jito endpoint was used */
  endpoint: string;
}

export interface JitoClientMetrics {
  bundlesSent: number;
  bundlesAccepted: number;
  bundlesLanded: number;
  bundlesFailed: number;
  avgLatencyMs: number;
  activeEndpoint: string;
}

type BundleStatus = 'Invalid' | 'Pending' | 'Failed' | 'Landed';

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: JitoClient | null = null;

export function initJitoClient(config?: { endpoint?: string; tipLamports?: number }): JitoClient {
  if (_instance) {
    _instance.shutdown();
  }
  _instance = new JitoClient(config);
  return _instance;
}

export function getJitoClient(): JitoClient | null {
  return _instance;
}

export function shutdownJitoClient(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}

// ─── Jito Client ─────────────────────────────────────────────────────────────

export class JitoClient {
  private endpoint: string;
  private tipLamports: number;
  private isActive = true;

  // Metrics
  private _metrics: JitoClientMetrics;
  private latencies: number[] = [];

  constructor(config?: { endpoint?: string; tipLamports?: number }) {
    this.endpoint = config?.endpoint ?? JITO_ENDPOINTS[0];
    this.tipLamports = config?.tipLamports ?? DEFAULT_TIP_LAMPORTS;

    this._metrics = {
      bundlesSent: 0,
      bundlesAccepted: 0,
      bundlesLanded: 0,
      bundlesFailed: 0,
      avgLatencyMs: 0,
      activeEndpoint: this.endpoint,
    };

    getLogger().info('JITO', `Jito block engine client initialized (${this.endpoint})`);
  }

  // ─── Bundle Submission ──────────────────────────────────────────────────

  /**
   * Submit a single signed transaction as a Jito bundle.
   *
   * The transaction must already be signed and serialized.
   * Returns the bundle ID for tracking.
   */
  async sendBundle(txBytes: Buffer): Promise<JitoBundleResult> {
    return this.sendBundleMulti([txBytes]);
  }

  /**
   * Submit multiple signed transactions as a single atomic Jito bundle.
   *
   * All transactions execute atomically — all succeed or all fail.
   * Maximum 5 transactions per bundle.
   */
  async sendBundleMulti(txBytesArray: Buffer[]): Promise<JitoBundleResult> {
    const logger = getLogger();
    const start = Date.now();

    if (txBytesArray.length === 0) {
      throw new Error('Bundle must contain at least one transaction');
    }
    if (txBytesArray.length > MAX_BUNDLE_SIZE) {
      throw new Error(`Bundle exceeds maximum size (${txBytesArray.length} > ${MAX_BUNDLE_SIZE})`);
    }

    this._metrics.bundlesSent++;

    // Encode transactions as base58 strings for Jito API
    const { bs58 } = await this.getBase58();
    const encodedTxs = txBytesArray.map(tx => bs58.encode(tx));

    try {
      // Submit bundle to Jito block engine
      const bundleId = await this.submitToBlockEngine(encodedTxs);
      this._metrics.bundlesAccepted++;

      logger.info('JITO', `Bundle accepted: ${bundleId} (${txBytesArray.length} tx)`);

      // Poll for landing confirmation
      const landingResult = await this.waitForBundleLanding(bundleId);
      const latencyMs = Date.now() - start;

      this.recordLatency(latencyMs);

      if (landingResult.landed) {
        this._metrics.bundlesLanded++;
        logger.info('JITO', `Bundle landed: ${bundleId} (slot ${landingResult.slot}, ${latencyMs}ms)`);
      } else {
        this._metrics.bundlesFailed++;
        logger.warn('JITO', `Bundle not landed: ${bundleId} (${latencyMs}ms)`);
      }

      return {
        bundleId,
        accepted: true,
        landed: landingResult.landed,
        landedSlot: landingResult.slot,
        latencyMs,
        endpoint: this.endpoint,
      };
    } catch (err) {
      this._metrics.bundlesFailed++;
      const msg = getErrorMessage(err);
      logger.warn('JITO', `Bundle submission failed: ${msg}`);

      return {
        bundleId: '',
        accepted: false,
        landed: false,
        latencyMs: Date.now() - start,
        endpoint: this.endpoint,
      };
    }
  }

  // ─── Block Engine API ───────────────────────────────────────────────────

  private async submitToBlockEngine(encodedTxs: string[]): Promise<string> {
    const response = await fetch(`${this.endpoint}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [encodedTxs],
      }),
      signal: AbortSignal.timeout(JITO_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Jito API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as {
      result?: string;
      error?: { message: string; code: number };
    };

    if (result.error) {
      throw new Error(`Jito bundle rejected: ${result.error.message} (code ${result.error.code})`);
    }

    if (!result.result) {
      throw new Error('Jito API returned no bundle ID');
    }

    return result.result;
  }

  private async waitForBundleLanding(bundleId: string): Promise<{ landed: boolean; slot?: number }> {
    const start = Date.now();

    while (Date.now() - start < BUNDLE_CONFIRM_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, BUNDLE_POLL_INTERVAL_MS));

      try {
        const status = await this.getBundleStatus(bundleId);

        if (status.status === 'Landed') {
          return { landed: true, slot: status.slot };
        }
        if (status.status === 'Failed' || status.status === 'Invalid') {
          return { landed: false };
        }
        // 'Pending' — continue polling
      } catch {
        // Transient error — continue polling
      }
    }

    return { landed: false };
  }

  private async getBundleStatus(bundleId: string): Promise<{ status: BundleStatus; slot?: number }> {
    const response = await fetch(`${this.endpoint}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]],
      }),
      signal: AbortSignal.timeout(JITO_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Jito status API error: ${response.status}`);
    }

    const result = await response.json() as {
      result?: { value: Array<{ bundle_id: string; status: BundleStatus; slot?: number }> };
    };

    const entry = result.result?.value?.[0];
    if (!entry) {
      return { status: 'Pending' };
    }

    return { status: entry.status, slot: entry.slot };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private async getBase58(): Promise<{ bs58: { encode: (data: Buffer) => string } }> {
    // Dynamic import for ESM compatibility
    const bs58Module = await import('bs58');
    return { bs58: bs58Module.default };
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 50) this.latencies.shift();
    this._metrics.avgLatencyMs = Math.round(
      this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  get metrics(): JitoClientMetrics {
    return { ...this._metrics };
  }

  get isOperational(): boolean {
    return this.isActive;
  }

  /** Get Jito tip account addresses (for tip transactions) */
  async getTipAccounts(): Promise<string[]> {
    try {
      const response = await fetch(`${this.endpoint}/api/v1/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTipAccounts',
          params: [],
        }),
        signal: AbortSignal.timeout(JITO_TIMEOUT_MS),
      });

      const result = await response.json() as { result?: string[] };
      return result.result ?? [];
    } catch {
      return [];
    }
  }

  /** Rotate to next Jito endpoint on failure */
  rotateEndpoint(): void {
    const currentIdx = JITO_ENDPOINTS.indexOf(this.endpoint);
    const nextIdx = (currentIdx + 1) % JITO_ENDPOINTS.length;
    this.endpoint = JITO_ENDPOINTS[nextIdx];
    this._metrics.activeEndpoint = this.endpoint;
    getLogger().info('JITO', `Rotated to endpoint: ${this.endpoint}`);
  }

  // ─── Shutdown ───────────────────────────────────────────────────────────

  shutdown(): void {
    this.isActive = false;
    getLogger().info('JITO', 'Jito client shut down');
  }
}
