import { IFlashClient, Position, Portfolio } from '../types/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { safeNumber } from '../utils/safe-math.js';

// ─── Reconciliation Engine ──────────────────────────────────────────────────
//
// Ensures CLI state matches blockchain state. Fetches authoritative on-chain
// positions and rebuilds the local portfolio view. Runs on:
//   1. CLI startup (after client init)
//   2. Wallet connect/switch
//   3. After confirmed transactions
//   4. Periodic background sync (every 60s)

const RECONCILE_INTERVAL_MS = 60_000;

export interface ReconciliationResult {
  /** Whether reconciliation found discrepancies */
  hadDiscrepancy: boolean;
  /** Number of positions from blockchain */
  onChainCount: number;
  /** Positions that appeared on-chain but not in local state */
  added: string[];
  /** Positions that were in local state but not on-chain */
  removed: string[];
  /** Timestamp of reconciliation */
  timestamp: number;
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: StateReconciler | null = null;

export function initReconciler(client: IFlashClient): StateReconciler {
  if (_instance) {
    _instance.stop();
  }
  _instance = new StateReconciler(client);
  return _instance;
}

export function getReconciler(): StateReconciler | null {
  return _instance;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export class StateReconciler {
  private client: IFlashClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKnownPositions: Map<string, Position> = new Map();
  private lastReconcileAt = 0;
  private _running = false;
  /** Throttle: track when we last warned about zero-position RPC results */
  private lastZeroPosWarnAt = 0;
  private static readonly ZERO_POS_WARN_INTERVAL_MS = 300_000; // warn at most every 5 minutes

  constructor(client: IFlashClient) {
    this.client = client;
  }

  get running(): boolean {
    return this._running;
  }

  /** Update the client reference (e.g. after wallet reconnect) */
  setClient(client: IFlashClient): void {
    this.client = client;
    // Clear cached state — new wallet means new positions
    this.lastKnownPositions.clear();
  }

  /**
   * Start periodic background reconciliation.
   */
  startPeriodicSync(): void {
    if (this._running) return;
    this._running = true;
    this.timer = setInterval(() => {
      this.reconcile().catch((err) => {
        getLogger().debug('RECONCILER', `Periodic sync error: ${getErrorMessage(err)}`);
      });
    }, RECONCILE_INTERVAL_MS);
    // Don't let the reconciler keep Node alive after user exits
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stop periodic background reconciliation.
   */
  stop(): void {
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Perform a single reconciliation pass.
   *
   * Fetches authoritative blockchain positions via the client,
   * compares with the last known local state, and returns
   * what changed.
   */
  async reconcile(): Promise<ReconciliationResult> {
    const logger = getLogger();
    const now = Date.now();

    try {
      // Fetch authoritative state from blockchain
      const onChainPositions = await this.client.getPositions();
      const onChainMap = new Map<string, Position>();

      for (const pos of onChainPositions) {
        // Validate numeric integrity before accepting
        if (
          !Number.isFinite(pos.sizeUsd) || pos.sizeUsd <= 0 ||
          !Number.isFinite(pos.entryPrice) || pos.entryPrice <= 0 ||
          !Number.isFinite(pos.collateralUsd) || pos.collateralUsd <= 0
        ) {
          continue; // Skip corrupt positions
        }
        const key = `${pos.market}:${pos.side}`;
        onChainMap.set(key, pos);
      }

      // Guard against RPC returning empty results during transient failures.
      // If we had known positions and RPC suddenly returns zero, it's more
      // likely an RPC issue than all positions being liquidated simultaneously.
      // Log a warning and preserve local state rather than wiping it.
      if (onChainMap.size === 0 && this.lastKnownPositions.size > 0) {
        // Throttle this warning — it can fire every 60s during transient RPC issues
        const now2 = Date.now();
        if (now2 - this.lastZeroPosWarnAt >= StateReconciler.ZERO_POS_WARN_INTERVAL_MS) {
          this.lastZeroPosWarnAt = now2;
          logger.warn('RECONCILE', `RPC returned 0 positions but we had ${this.lastKnownPositions.size} — possible RPC failure, preserving local state`);
        }
        return {
          hadDiscrepancy: false,
          onChainCount: this.lastKnownPositions.size,
          added: [],
          removed: [],
          timestamp: now,
        };
      }

      // Compare with local state
      const added: string[] = [];
      const removed: string[] = [];

      // Positions on-chain but not locally tracked
      for (const key of onChainMap.keys()) {
        if (!this.lastKnownPositions.has(key)) {
          added.push(key);
        }
      }

      // Positions locally tracked but not on-chain (closed externally or liquidated)
      for (const key of this.lastKnownPositions.keys()) {
        if (!onChainMap.has(key)) {
          removed.push(key);
        }
      }

      const hadDiscrepancy = added.length > 0 || removed.length > 0;

      if (hadDiscrepancy) {
        logger.info('RECONCILE', `State discrepancy: +${added.length} -${removed.length} positions`);
        if (added.length > 0) {
          logger.info('RECONCILE', `New on-chain positions: ${added.join(', ')}`);
        }
        if (removed.length > 0) {
          logger.info('RECONCILE', `Removed positions: ${removed.join(', ')}`);
        }
      }

      // Update local state to match blockchain (blockchain is authoritative)
      this.lastKnownPositions = onChainMap;
      this.lastReconcileAt = now;

      return {
        hadDiscrepancy,
        onChainCount: onChainMap.size,
        added,
        removed,
        timestamp: now,
      };
    } catch (error: unknown) {
      logger.debug('RECONCILE', `Reconciliation failed: ${getErrorMessage(error)}`);
      return {
        hadDiscrepancy: false,
        onChainCount: this.lastKnownPositions.size,
        added: [],
        removed: [],
        timestamp: now,
      };
    }
  }

  /**
   * Verify a specific trade landed on-chain after confirmation.
   * Returns true if the position exists, false if missing.
   */
  async verifyTrade(market: string, side: string): Promise<boolean> {
    const logger = getLogger();
    try {
      const positions = await this.client.getPositions();
      const key = `${market.toUpperCase()}:${side}`;
      const found = positions.some(
        p => `${p.market.toUpperCase()}:${p.side}` === key
      );

      if (!found) {
        logger.warn('RECONCILE', `Trade verification failed: ${key} not found on-chain`);
      }

      // Refresh local state — apply same numeric integrity checks as reconcile()
      const posMap = new Map<string, Position>();
      for (const p of positions) {
        if (
          !Number.isFinite(p.sizeUsd) || p.sizeUsd <= 0 ||
          !Number.isFinite(p.entryPrice) || p.entryPrice <= 0 ||
          !Number.isFinite(p.collateralUsd) || p.collateralUsd <= 0
        ) {
          continue; // Skip corrupt positions
        }
        posMap.set(`${p.market}:${p.side}`, p);
      }
      this.lastKnownPositions = posMap;

      return found;
    } catch (error: unknown) {
      logger.debug('RECONCILE', `Trade verification error: ${getErrorMessage(error)}`);
      return false; // Assume failed if we can't verify
    }
  }

  /**
   * Get the last reconciliation timestamp.
   */
  get lastReconcileTime(): number {
    return this.lastReconcileAt;
  }

  /**
   * Get the current locally-known position count.
   */
  get knownPositionCount(): number {
    return this.lastKnownPositions.size;
  }
}
