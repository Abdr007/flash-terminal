'use strict';

/**
 * Performance Metrics tracker for trading agent latency measurement.
 * Lightweight, pre-allocated rolling window with percentile support.
 */

const WINDOW_SIZE = 1000;

const BUILT_IN_METRICS = [
  'tick',
  'decision',
  'execution',
  'signal_fusion',
  'market_fetch',
  'event_path',
] as const;

type _BuiltInMetric = (typeof BUILT_IN_METRICS)[number];

/** Thresholds in ms for missed-opportunity detection. */
const MISSED_OPPORTUNITY_THRESHOLDS: Record<string, number> = {
  tick: 2000,
  decision: 100,
  execution: 2000,
  signal_fusion: 100,
  market_fetch: 2000,
  event_path: 100,
};

const DEFAULT_THRESHOLD_MS = 2000;

interface MetricStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
  mean: number;
  missedOpportunities: number;
}

interface MetricBucket {
  /** Pre-allocated circular buffer for raw durations (ms). */
  samples: Float64Array;
  /** Current write index into the circular buffer. */
  writeIdx: number;
  /** Total number of samples ever recorded (used to know if buffer is full). */
  totalCount: number;
  /** Running sum of ALL samples (not just window). */
  sum: number;
  /** Running min of ALL samples. */
  min: number;
  /** Running max of ALL samples. */
  max: number;
  /** Count of samples that exceeded the missed-opportunity threshold. */
  missedCount: number;
  /** Threshold for this metric in ms. */
  threshold: number;
}

interface TimerHandle {
  name: string;
  startHr: [number, number];
}

let timerIdCounter = 0;

export class PerfMetrics {
  private readonly buckets: Map<string, MetricBucket> = new Map();
  private readonly activeTimers: Map<number, TimerHandle> = new Map();

  constructor() {
    // Pre-allocate buckets for all built-in metrics.
    for (const name of BUILT_IN_METRICS) {
      this.ensureBucket(name);
    }
  }

  // -------------------------------------------------------------------
  // Timer API
  // -------------------------------------------------------------------

  /** Start a named timer. Returns a numeric timer ID. */
  startTimer(name: string): number {
    const id = ++timerIdCounter;
    this.activeTimers.set(id, { name, startHr: process.hrtime() });
    return id;
  }

  /** End a previously started timer and record the duration. */
  endTimer(name: string, timerId: number): number {
    const handle = this.activeTimers.get(timerId);
    if (!handle) return -1;
    this.activeTimers.delete(timerId);

    const elapsed = process.hrtime(handle.startHr);
    const ms = elapsed[0] * 1e3 + elapsed[1] / 1e6;
    this.record(name, ms);
    return ms;
  }

  /**
   * Wrap an async (or sync) function, measure its wall-clock duration,
   * and record it under `name`. Returns the function's result.
   */
  async measure<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const start = process.hrtime();
    try {
      const result = await fn();
      return result;
    } finally {
      const elapsed = process.hrtime(start);
      const ms = elapsed[0] * 1e3 + elapsed[1] / 1e6;
      this.record(name, ms);
    }
  }

  // -------------------------------------------------------------------
  // Core recording
  // -------------------------------------------------------------------

  /** Record a raw duration (ms) for the given metric name. */
  record(name: string, durationMs: number): void {
    const bucket = this.ensureBucket(name);

    // Write into circular buffer (no allocation).
    bucket.samples[bucket.writeIdx] = durationMs;
    bucket.writeIdx = (bucket.writeIdx + 1) % WINDOW_SIZE;
    bucket.totalCount++;

    // Aggregate stats.
    bucket.sum += durationMs;
    if (durationMs < bucket.min) bucket.min = durationMs;
    if (durationMs > bucket.max) bucket.max = durationMs;

    if (durationMs > bucket.threshold) {
      bucket.missedCount++;
    }
  }

  // -------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------

  /** Get computed stats for a single metric. */
  getStats(name: string): MetricStats | null {
    const bucket = this.buckets.get(name);
    if (!bucket || bucket.totalCount === 0) return null;
    return this.computeStats(bucket);
  }

  /** Get a report object with stats for every tracked metric. */
  getReport(): Record<string, MetricStats> {
    const report: Record<string, MetricStats> = {};
    for (const [name, bucket] of this.buckets) {
      if (bucket.totalCount === 0) continue;
      report[name] = this.computeStats(bucket);
    }
    return report;
  }

  /** Human-readable table string of all metrics. */
  formatReport(): string {
    const report = this.getReport();
    const names = Object.keys(report);
    if (names.length === 0) return 'No metrics recorded.';

    const header =
      'Metric'.padEnd(16) +
      'Count'.padStart(8) +
      'Mean'.padStart(10) +
      'Min'.padStart(10) +
      'Max'.padStart(10) +
      'P50'.padStart(10) +
      'P90'.padStart(10) +
      'P99'.padStart(10) +
      'Missed'.padStart(8);

    const separator = '-'.repeat(header.length);

    const rows = names.map((name) => {
      const s = report[name];
      return (
        name.padEnd(16) +
        String(s.count).padStart(8) +
        fmtMs(s.mean).padStart(10) +
        fmtMs(s.min).padStart(10) +
        fmtMs(s.max).padStart(10) +
        fmtMs(s.p50).padStart(10) +
        fmtMs(s.p90).padStart(10) +
        fmtMs(s.p99).padStart(10) +
        String(s.missedOpportunities).padStart(8)
      );
    });

    return [header, separator, ...rows].join('\n');
  }

  /**
   * Total count of events where decision latency exceeded the
   * per-metric threshold (100ms for event-path metrics, 2s for ticks).
   */
  getMissedOpportunities(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) {
      total += bucket.missedCount;
    }
    return total;
  }

  /** Reset all metrics and active timers. */
  reset(): void {
    for (const bucket of this.buckets.values()) {
      bucket.samples.fill(0);
      bucket.writeIdx = 0;
      bucket.totalCount = 0;
      bucket.sum = 0;
      bucket.min = Infinity;
      bucket.max = -Infinity;
      bucket.missedCount = 0;
    }
    this.activeTimers.clear();
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private ensureBucket(name: string): MetricBucket {
    let bucket = this.buckets.get(name);
    if (bucket) return bucket;

    bucket = {
      samples: new Float64Array(WINDOW_SIZE),
      writeIdx: 0,
      totalCount: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      missedCount: 0,
      threshold: MISSED_OPPORTUNITY_THRESHOLDS[name] ?? DEFAULT_THRESHOLD_MS,
    };
    this.buckets.set(name, bucket);
    return bucket;
  }

  private computeStats(bucket: MetricBucket): MetricStats {
    const usedCount = Math.min(bucket.totalCount, WINDOW_SIZE);

    // Copy the active portion of the circular buffer and sort for percentiles.
    const sorted = new Float64Array(usedCount);
    if (bucket.totalCount <= WINDOW_SIZE) {
      sorted.set(bucket.samples.subarray(0, usedCount));
    } else {
      // Buffer has wrapped — stitch from writeIdx to end, then start to writeIdx.
      const tailLen = WINDOW_SIZE - bucket.writeIdx;
      sorted.set(bucket.samples.subarray(bucket.writeIdx, WINDOW_SIZE), 0);
      sorted.set(bucket.samples.subarray(0, bucket.writeIdx), tailLen);
    }
    sorted.sort();

    return {
      count: bucket.totalCount,
      sum: bucket.sum,
      min: bucket.min,
      max: bucket.max,
      mean: bucket.sum / bucket.totalCount,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      p99: percentile(sorted, 0.99),
      missedOpportunities: bucket.missedCount,
    };
  }
}

// -------------------------------------------------------------------
// Helpers (module-private)
// -------------------------------------------------------------------

/** Interpolated percentile from a sorted Float64Array. */
function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];

  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Format milliseconds for display. */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
