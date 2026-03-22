// ── Execution Feedback Loop ─────────────────────────────────────────
// Records every trade's execution quality and builds rolling per-market
// statistics. Zero external dependencies, fully self-contained.
// ────────────────────────────────────────────────────────────────────

// ── Helpers ─────────────────────────────────────────────────────────

function safe(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

// ── Types ───────────────────────────────────────────────────────────

export interface ExecutionRecord {
  market: string;
  side: string;
  timestamp: number;
  // Pre-trade expectations
  expectedPrice: number;
  expectedSizeUsd: number;
  // Post-trade actuals
  actualPrice: number;
  actualSizeUsd: number;
  // Derived
  slippagePct: number;
  slippageBps: number;
  timeToFillMs: number;
  fillSuccess: boolean;
  error?: string;
}

export interface MarketExecutionStats {
  market: string;
  totalTrades: number;
  successRate: number;
  avgSlippageBps: number;
  p50SlippageBps: number;
  p90SlippageBps: number;
  avgTimeToFillMs: number;
  p90TimeToFillMs: number;
  recentTrend: 'improving' | 'stable' | 'degrading';
  lastTradeAt: number;
}

export interface GlobalExecutionStats {
  totalTrades: number;
  totalFills: number;
  totalFailures: number;
  successRate: number;
  avgSlippageBps: number;
  p50SlippageBps: number;
  p90SlippageBps: number;
  p99SlippageBps: number;
  avgTimeToFillMs: number;
  p50TimeToFillMs: number;
  p90TimeToFillMs: number;
  missedFills: number;
  totalSlippageCostUsd: number;
}

// ── Circular Buffer ─────────────────────────────────────────────────

class CircularBuffer<T> {
  private buf: (T | null)[];
  private head = 0;
  private _size = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array<T | null>(capacity).fill(null);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  /** Return items in insertion order (oldest first). */
  toArray(): T[] {
    const out: T[] = [];
    if (this._size === 0) return out;
    const start = this._size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this._size; i++) {
      const idx = (start + i) % this.capacity;
      const v = this.buf[idx];
      if (v !== null) out.push(v);
    }
    return out;
  }

  /** Return the last N items in insertion order (oldest first among the N). */
  last(n: number): T[] {
    const all = this.toArray();
    if (n >= all.length) return all;
    return all.slice(all.length - n);
  }

  get size(): number {
    return this._size;
  }

  clear(): void {
    this.buf.fill(null);
    this.head = 0;
    this._size = 0;
  }
}

// ── Constants ───────────────────────────────────────────────────────

const MARKET_BUFFER_SIZE = 100;
const GLOBAL_BUFFER_SIZE = 500;
const MAX_MARKETS = 50;
const TREND_RECENT = 5;
const TREND_WINDOW = 20;
const DEGRADED_P90_SLIPPAGE_BPS = 30;
const DEGRADED_SUCCESS_RATE = 0.80;

// ── ExecutionFeedback ───────────────────────────────────────────────

export class ExecutionFeedback {
  private marketBuffers: Map<string, CircularBuffer<ExecutionRecord>> = new Map();
  private globalBuffer: CircularBuffer<ExecutionRecord>;

  constructor() {
    this.globalBuffer = new CircularBuffer<ExecutionRecord>(GLOBAL_BUFFER_SIZE);
  }

  // ── Record helpers ──────────────────────────────────────────────

  recordOpen(
    market: string,
    side: string,
    expectedPrice: number,
    expectedSizeUsd: number,
    actualPrice: number,
    actualSizeUsd: number,
    timeToFillMs: number,
    success: boolean,
    error?: string,
  ): ExecutionRecord {
    const record = this.buildRecord(
      market, side, expectedPrice, expectedSizeUsd,
      actualPrice, actualSizeUsd, timeToFillMs, success, error,
    );
    this.store(record);
    return record;
  }

  recordClose(
    market: string,
    side: string,
    expectedPrice: number,
    actualPrice: number,
    timeToFillMs: number,
    success: boolean,
    error?: string,
  ): ExecutionRecord {
    // For closes, size is not as relevant — record 0 for both
    const record = this.buildRecord(
      market, side, expectedPrice, 0,
      actualPrice, 0, timeToFillMs, success, error,
    );
    this.store(record);
    return record;
  }

  // ── Queries ─────────────────────────────────────────────────────

  getMarketStats(market: string): MarketExecutionStats | null {
    const buf = this.marketBuffers.get(market);
    if (!buf || buf.size === 0) return null;

    const records = buf.toArray();
    const successes = records.filter(r => r.fillSuccess);
    const slippages = successes.map(r => r.slippageBps);
    const sortedSlip = [...slippages].sort((a, b) => a - b);
    const fillTimes = successes.map(r => r.timeToFillMs);
    const sortedTimes = [...fillTimes].sort((a, b) => a - b);

    return {
      market,
      totalTrades: records.length,
      successRate: safe(successes.length / records.length),
      avgSlippageBps: safe(slippages.reduce((s, v) => s + v, 0) / (slippages.length || 1)),
      p50SlippageBps: percentile(sortedSlip, 50),
      p90SlippageBps: percentile(sortedSlip, 90),
      avgTimeToFillMs: safe(fillTimes.reduce((s, v) => s + v, 0) / (fillTimes.length || 1)),
      p90TimeToFillMs: percentile(sortedTimes, 90),
      recentTrend: this.getSlippageTrend(market),
      lastTradeAt: records[records.length - 1].timestamp,
    };
  }

  getGlobalStats(): GlobalExecutionStats {
    const records = this.globalBuffer.toArray();
    if (records.length === 0) {
      return {
        totalTrades: 0, totalFills: 0, totalFailures: 0,
        successRate: 0, avgSlippageBps: 0, p50SlippageBps: 0,
        p90SlippageBps: 0, p99SlippageBps: 0, avgTimeToFillMs: 0,
        p50TimeToFillMs: 0, p90TimeToFillMs: 0, missedFills: 0,
        totalSlippageCostUsd: 0,
      };
    }

    const successes = records.filter(r => r.fillSuccess);
    const failures = records.filter(r => !r.fillSuccess);
    const slippages = successes.map(r => r.slippageBps);
    const sortedSlip = [...slippages].sort((a, b) => a - b);
    const fillTimes = successes.map(r => r.timeToFillMs);
    const sortedTimes = [...fillTimes].sort((a, b) => a - b);

    let totalSlippageCostUsd = 0;
    for (const r of successes) {
      const cost = safe(Math.abs(r.slippagePct) / 100 * r.actualSizeUsd);
      totalSlippageCostUsd += cost;
    }

    return {
      totalTrades: records.length,
      totalFills: successes.length,
      totalFailures: failures.length,
      successRate: safe(successes.length / records.length),
      avgSlippageBps: safe(slippages.reduce((s, v) => s + v, 0) / (slippages.length || 1)),
      p50SlippageBps: percentile(sortedSlip, 50),
      p90SlippageBps: percentile(sortedSlip, 90),
      p99SlippageBps: percentile(sortedSlip, 99),
      avgTimeToFillMs: safe(fillTimes.reduce((s, v) => s + v, 0) / (fillTimes.length || 1)),
      p50TimeToFillMs: percentile(sortedTimes, 50),
      p90TimeToFillMs: percentile(sortedTimes, 90),
      missedFills: failures.length,
      totalSlippageCostUsd: safe(totalSlippageCostUsd),
    };
  }

  getRecentSlippage(market: string, count = 10): number[] {
    const buf = this.marketBuffers.get(market);
    if (!buf) return [];
    return buf.last(count)
      .filter(r => r.fillSuccess)
      .map(r => r.slippageBps);
  }

  getSlippageTrend(market: string): 'improving' | 'stable' | 'degrading' {
    const buf = this.marketBuffers.get(market);
    if (!buf || buf.size < TREND_RECENT) return 'stable';

    const recent = buf.last(TREND_RECENT)
      .filter(r => r.fillSuccess)
      .map(r => r.slippageBps);
    const window = buf.last(TREND_WINDOW)
      .filter(r => r.fillSuccess)
      .map(r => r.slippageBps);

    if (recent.length === 0 || window.length === 0) return 'stable';

    const recentAvg = safe(recent.reduce((s, v) => s + v, 0) / recent.length);
    const windowAvg = safe(window.reduce((s, v) => s + v, 0) / window.length);

    if (windowAvg === 0) return 'stable';
    const changePct = safe((recentAvg - windowAvg) / Math.abs(windowAvg) * 100);

    // >20% worse → degrading, >20% better → improving
    if (changePct > 20) return 'degrading';
    if (changePct < -20) return 'improving';
    return 'stable';
  }

  isMarketDegraded(market: string): boolean {
    const stats = this.getMarketStats(market);
    if (!stats) return false;
    return stats.p90SlippageBps > DEGRADED_P90_SLIPPAGE_BPS
        || stats.successRate < DEGRADED_SUCCESS_RATE;
  }

  /**
   * Returns a suggested size multiplier (0.5 – 1.0) based on recent slippage.
   * Higher slippage → smaller multiplier to reduce execution cost.
   */
  getSlippageAdjustment(market: string): number {
    const stats = this.getMarketStats(market);
    if (!stats) return 1.0;

    const avgBps = stats.avgSlippageBps;

    // 0-5 bps  → 1.0  (no adjustment)
    // 5-15 bps → 0.9
    // 15-30 bps → 0.75
    // 30+ bps  → 0.5
    if (avgBps <= 5) return 1.0;
    if (avgBps <= 15) return 0.9;
    if (avgBps <= 30) return 0.75;
    return 0.5;
  }

  getAllMarketStats(): Map<string, MarketExecutionStats> {
    const result = new Map<string, MarketExecutionStats>();
    for (const market of this.marketBuffers.keys()) {
      const stats = this.getMarketStats(market);
      if (stats) result.set(market, stats);
    }
    return result;
  }

  reset(): void {
    for (const buf of this.marketBuffers.values()) {
      buf.clear();
    }
    this.marketBuffers.clear();
    this.globalBuffer.clear();
  }

  // ── Internal ────────────────────────────────────────────────────

  private buildRecord(
    market: string,
    side: string,
    expectedPrice: number,
    expectedSizeUsd: number,
    actualPrice: number,
    actualSizeUsd: number,
    timeToFillMs: number,
    fillSuccess: boolean,
    error?: string,
  ): ExecutionRecord {
    const ep = safe(expectedPrice);
    const ap = safe(actualPrice);
    const es = safe(expectedSizeUsd);
    const as_ = safe(actualSizeUsd);
    const ttf = safe(timeToFillMs);

    // Slippage: positive always means "worse than expected"
    // Longs: paid more than expected → (actual - expected) / expected
    // Shorts: received less than expected → (expected - actual) / expected
    let slippagePct = 0;
    if (ep > 0) {
      const isLong = side.toLowerCase() === 'long';
      if (isLong) {
        slippagePct = safe(((ap - ep) / ep) * 100);
      } else {
        slippagePct = safe(((ep - ap) / ep) * 100);
      }
    }

    const slippageBps = safe(slippagePct * 100);

    return {
      market,
      side,
      timestamp: Date.now(),
      expectedPrice: ep,
      expectedSizeUsd: es,
      actualPrice: ap,
      actualSizeUsd: as_,
      slippagePct,
      slippageBps,
      timeToFillMs: ttf,
      fillSuccess,
      error,
    };
  }

  private store(record: ExecutionRecord): void {
    // Global buffer
    this.globalBuffer.push(record);

    // Per-market buffer
    let buf = this.marketBuffers.get(record.market);
    if (!buf) {
      // Enforce market cap
      if (this.marketBuffers.size >= MAX_MARKETS) {
        // Evict the market with the oldest last trade
        let oldestMarket: string | null = null;
        let oldestTime = Infinity;
        for (const [m, b] of this.marketBuffers) {
          const items = b.toArray();
          if (items.length === 0) {
            oldestMarket = m;
            break;
          }
          const lastTs = items[items.length - 1].timestamp;
          if (lastTs < oldestTime) {
            oldestTime = lastTs;
            oldestMarket = m;
          }
        }
        if (oldestMarket) {
          this.marketBuffers.delete(oldestMarket);
        }
      }
      buf = new CircularBuffer<ExecutionRecord>(MARKET_BUFFER_SIZE);
      this.marketBuffers.set(record.market, buf);
    }
    buf.push(record);
  }
}
