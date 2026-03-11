/**
 * Maintenance — Background housekeeping for long-running terminal sessions.
 *
 * Consolidates periodic tasks:
 *   - Cache sweep (every 5 minutes)
 *   - Memory monitoring (every 5 minutes)
 *   - Oracle freshness check (every 10 seconds)
 *
 * All timers use .unref() so they don't prevent Node from exiting.
 * Each tick is wrapped in try/catch — maintenance never crashes the terminal.
 */

import { getLogger } from '../utils/logger.js';

const CACHE_SWEEP_INTERVAL_MS = 5 * 60_000;    // 5 minutes
const MEMORY_CHECK_INTERVAL_MS = 5 * 60_000;   // 5 minutes
const ORACLE_CHECK_INTERVAL_MS = 10_000;        // 10 seconds
const RSS_WARNING_THRESHOLD = 1024 * 1024 * 1024;       // 1 GB
const RSS_CRITICAL_THRESHOLD = 1.5 * 1024 * 1024 * 1024; // 1.5 GB

export interface MaintenanceHandle {
  stop(): void;
}

export function startMaintenance(): MaintenanceHandle {
  const logger = getLogger();
  const timers: ReturnType<typeof setInterval>[] = [];

  // ── Cache Sweep (every 5 min) ──────────────────────────────────────────
  const cacheSweepTimer = setInterval(() => {
    try {
      // Sweep protocol fee cache
      try {
        sweepFeeCacheSync();
      } catch { /* non-critical */ }

      logger.debug('MAINTENANCE', 'Cache sweep completed');
    } catch {
      // Maintenance must never crash
    }
  }, CACHE_SWEEP_INTERVAL_MS);
  cacheSweepTimer.unref();
  timers.push(cacheSweepTimer);

  // ── Memory Monitoring (every 5 min) ────────────────────────────────────
  const memoryTimer = setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const rssMB = Math.round(mem.rss / (1024 * 1024));
      const heapMB = Math.round(mem.heapUsed / (1024 * 1024));

      if (mem.rss > RSS_CRITICAL_THRESHOLD) {
        logger.warn('MEMORY', `RSS ${rssMB}MB exceeds critical threshold — consider restarting`);
        // Hint GC if available (Node started with --expose-gc)
        if (typeof global.gc === 'function') {
          global.gc();
          logger.info('MEMORY', 'Manual GC triggered');
        }
      } else if (mem.rss > RSS_WARNING_THRESHOLD) {
        logger.warn('MEMORY', `RSS ${rssMB}MB exceeds warning threshold (heap: ${heapMB}MB)`);
      } else {
        logger.debug('MEMORY', `RSS ${rssMB}MB, heap ${heapMB}MB`);
      }
    } catch {
      // Maintenance must never crash
    }
  }, MEMORY_CHECK_INTERVAL_MS);
  memoryTimer.unref();
  timers.push(memoryTimer);

  // ── Oracle Freshness (every 10s) ──────────────────────────────────────
  let lastOracleOk = true;
  const oracleTimer = setInterval(async () => {
    try {
      const { PriceService } = await import('../data/prices.js');
      const svc = new PriceService();
      const sol = await svc.getPrice('SOL');
      if (sol) {
        const ageMs = Date.now() - sol.timestamp;
        if (ageMs > 30_000) {
          if (lastOracleOk) {
            logger.warn('ORACLE', `SOL price is ${Math.round(ageMs / 1000)}s stale`);
            lastOracleOk = false;
          }
        } else {
          if (!lastOracleOk) {
            logger.info('ORACLE', 'Oracle freshness recovered');
          }
          lastOracleOk = true;
        }
      }
    } catch {
      // Oracle check is best-effort
    }
  }, ORACLE_CHECK_INTERVAL_MS);
  oracleTimer.unref();
  timers.push(oracleTimer);

  logger.info('MAINTENANCE', 'Background maintenance started (cache sweep: 5m, memory: 5m, oracle: 10s)');

  return {
    stop() {
      for (const t of timers) {
        clearInterval(t);
      }
      timers.length = 0;
      logger.info('MAINTENANCE', 'Background maintenance stopped');
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Sweep expired entries from the protocol fee cache (sync, no imports needed). */
function sweepFeeCacheSync(): void {
  // Dynamic import to avoid circular deps
  import('../utils/protocol-fees.js').then(mod => {
    if (typeof mod.sweepExpiredCache === 'function') {
      mod.sweepExpiredCache();
    }
  }).catch(() => {});
}
