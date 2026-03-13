/**
 * Execution Engine Router
 *
 * Routes serialized transactions to the configured execution engine:
 *   - "rpc"        → standard Solana RPC (existing pipeline)
 *   - "magicblock" → MagicBlock ephemeral rollup RPC
 *
 * This module sits AFTER all safety checks (signing guard, circuit breaker,
 * instruction validation, program whitelist). It only handles the network
 * submission of already-signed, already-validated transaction bytes.
 *
 * Design constraints:
 *   - Never modifies, rebuilds, or re-signs transactions
 *   - Automatic fallback from MagicBlock → RPC on failure
 *   - Singleton lifecycle — init once, use everywhere
 */

import { MagicBlockClient, type MagicBlockResult } from './magicblock-client.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ExecutionEngine = 'rpc' | 'magicblock';

export interface EngineRouterConfig {
  engine: ExecutionEngine;
  magicblockRpcUrl?: string;
}

export interface ExecutionResult {
  signature: string;
  engine: ExecutionEngine;
  latencyMs: number;
  /** True if this was a fallback from MagicBlock → RPC */
  fallback: boolean;
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let routerInstance: EngineRouter | null = null;

export function initEngineRouter(config: EngineRouterConfig): EngineRouter {
  routerInstance = new EngineRouter(config);
  return routerInstance;
}

export function getEngineRouter(): EngineRouter | null {
  return routerInstance;
}

// ─── Router ─────────────────────────────────────────────────────────────────

export class EngineRouter {
  readonly engine: ExecutionEngine;
  private magicblockClient: MagicBlockClient | null = null;

  constructor(config: EngineRouterConfig) {
    this.engine = config.engine;

    if (config.engine === 'magicblock') {
      if (!config.magicblockRpcUrl) {
        throw new Error(
          'MagicBlock engine requires MAGICBLOCK_RPC_URL. ' +
          'Set the environment variable or pass --magicblock-rpc <url>.',
        );
      }
      this.magicblockClient = new MagicBlockClient(config.magicblockRpcUrl);
    }
  }

  /**
   * Route a pre-signed, serialized transaction to the configured engine.
   *
   * @param txBytes  Serialized transaction bytes (from VersionedTransaction.serialize())
   * @param rpcSend  Standard RPC submission function (fallback path)
   * @returns        Execution result with signature, engine used, and latency
   *
   * The `rpcSend` callback is the caller's existing RPC submission logic.
   * This keeps the router decoupled from Connection management.
   */
  async executeTransaction(
    txBytes: Buffer,
    rpcSend: (bytes: Buffer) => Promise<string>,
  ): Promise<ExecutionResult> {
    const logger = getLogger();

    if (this.engine === 'magicblock' && this.magicblockClient) {
      try {
        const result = await this.magicblockClient.sendTransaction(txBytes);
        return {
          signature: result.signature,
          engine: 'magicblock',
          latencyMs: result.latencyMs,
          fallback: false,
        };
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        // On-chain failures should NOT fallback — the tx was processed and failed
        if (msg.includes('failed on-chain')) {
          throw err;
        }
        logger.warn('ENGINE', `MagicBlock execution failed: ${msg} — falling back to RPC`);
        // Fall through to RPC
      }
    }

    // Standard RPC path (default or fallback)
    const start = Date.now();
    const signature = await rpcSend(txBytes);
    return {
      signature,
      engine: 'rpc',
      latencyMs: Date.now() - start,
      fallback: this.engine === 'magicblock',
    };
  }

  /** Check if MagicBlock engine is active and reachable */
  async ping(): Promise<{ engine: ExecutionEngine; ok: boolean; latencyMs: number }> {
    if (this.engine === 'magicblock' && this.magicblockClient) {
      const result = await this.magicblockClient.ping();
      return { engine: 'magicblock', ...result };
    }
    return { engine: 'rpc', ok: true, latencyMs: 0 };
  }

  /** Get display label for the current engine */
  get label(): string {
    return this.engine === 'magicblock' ? 'MagicBlock' : 'RPC';
  }

  /** Get MagicBlock endpoint URL (if configured) */
  get magicblockEndpoint(): string | null {
    return this.magicblockClient?.endpoint ?? null;
  }
}
