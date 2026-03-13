/**
 * MagicBlock Execution Client
 *
 * Sends pre-built, pre-signed transactions to a MagicBlock ephemeral rollup
 * RPC endpoint for low-latency execution with settlement on Solana mainnet.
 *
 * Design constraints:
 *   - Receives ONLY serialized transaction bytes (never rebuilds transactions)
 *   - Respects the same confirmation model as the standard pipeline
 *   - Stateless per call — no connection pooling or caching
 *   - Timeout-bounded — never blocks indefinitely
 */

import { Connection } from '@solana/web3.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** How long to wait for MagicBlock confirmation before giving up */
const MB_CONFIRM_TIMEOUT_MS = 30_000;

/** Poll interval during confirmation */
const MB_POLL_INTERVAL_MS = 1_000;

/** HTTP fetch timeout for MagicBlock RPC calls */
const MB_FETCH_TIMEOUT_MS = 15_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MagicBlockResult {
  signature: string;
  latencyMs: number;
  engine: 'magicblock';
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class MagicBlockClient {
  private readonly rpcUrl: string;
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;

    // Derive WebSocket endpoint from RPC URL
    const wsUrl = rpcUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:');

    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
      fetch: (url, options) =>
        fetch(url, {
          ...options,
          signal: AbortSignal.timeout(MB_FETCH_TIMEOUT_MS),
        }),
    });
  }

  /**
   * Send a pre-serialized, pre-signed transaction to MagicBlock RPC.
   *
   * The transaction bytes are produced by the existing Flash Terminal
   * pipeline (instruction validation → signing → serialization).
   * This method only handles network submission and confirmation.
   */
  async sendTransaction(txBytes: Buffer): Promise<MagicBlockResult> {
    const logger = getLogger();
    const start = Date.now();

    logger.info('MAGICBLOCK', `Sending transaction (${txBytes.length} bytes) to ${this.rpcUrl}`);

    // Submit to MagicBlock RPC
    const signature = await this.connection.sendRawTransaction(txBytes, {
      skipPreflight: true,
      maxRetries: 3,
    });

    logger.info('MAGICBLOCK', `Tx submitted: ${signature}`);

    // Poll for confirmation
    const confirmed = await this.waitForConfirmation(signature);
    const latencyMs = Date.now() - start;

    if (!confirmed) {
      throw new Error(
        `MagicBlock tx not confirmed within ${MB_CONFIRM_TIMEOUT_MS / 1000}s: ${signature}`,
      );
    }

    logger.info('MAGICBLOCK', `Tx confirmed: ${signature} (${latencyMs}ms)`);

    return {
      signature,
      latencyMs,
      engine: 'magicblock',
    };
  }

  /**
   * Poll for transaction confirmation on MagicBlock.
   * Returns true if confirmed, false if timed out.
   */
  private async waitForConfirmation(signature: string): Promise<boolean> {
    const logger = getLogger();
    const start = Date.now();

    while (Date.now() - start < MB_CONFIRM_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, MB_POLL_INTERVAL_MS));

      try {
        const { value } = await this.connection.getSignatureStatuses([signature]);
        const status = value?.[0];

        if (status?.err) {
          throw new Error(`MagicBlock tx failed on-chain: ${JSON.stringify(status.err)}`);
        }

        if (
          status?.confirmationStatus === 'confirmed' ||
          status?.confirmationStatus === 'finalized'
        ) {
          return true;
        }
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        // Re-throw on-chain failures
        if (msg.includes('failed on-chain')) throw err;
        // Log and continue polling on transient errors
        logger.debug('MAGICBLOCK', `Poll error (will retry): ${msg}`);
      }
    }

    return false;
  }

  /** Test connectivity to the MagicBlock RPC endpoint */
  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.connection.getSlot();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  get endpoint(): string {
    return this.rpcUrl;
  }
}
