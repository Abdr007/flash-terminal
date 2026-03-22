// ── Missed Opportunity Learner ───────────────────────────────────────
// Analyzes why trading opportunities were missed and recommends
// parameter adjustments to improve capture rate without increasing risk.
// Zero external dependencies. Bounded storage (200 events, 20 filters).
// ─────────────────────────────────────────────────────────────────────

export interface MissedOpportunity {
  market: string;
  side: string;
  detectionTime: number;
  executionTime?: number;
  signalPrice: number;
  peakPrice: number;
  peakPnlPct: number;
  missReason:
    | 'latency'
    | 'filter_rejected'
    | 'queue_full'
    | 'risk_blocked'
    | 'cooldown'
    | 'no_capital';
  filterName?: string;
  latencyMs?: number;
  score?: number;
}

export interface CapturedOpportunity {
  market: string;
  side: string;
  detectionTime: number;
  executionTime: number;
  entryPrice: number;
  pnl: number;
  latencyMs: number;
  score?: number;
}

export interface LearnerRecommendation {
  type:
    | 'adjust_threshold'
    | 'adjust_cache_ttl'
    | 'adjust_event_sensitivity'
    | 'relax_filter'
    | 'tighten_filter'
    | 'no_change';
  target: string;
  currentValue: number;
  suggestedValue: number;
  confidence: number;
  reason: string;
  expectedImpact: string;
}

interface FilterStats {
  correctRejects: number;   // rejected trade that would have lost
  incorrectRejects: number; // rejected trade that would have won
}

interface EventRecord {
  type: 'miss' | 'capture';
  timestamp: number;
  data: MissedOpportunity | CapturedOpportunity;
}

interface RecommendationRecord {
  recommendation: LearnerRecommendation;
  timestamp: number;
  captureRateBefore: number;
  captureRateAfter?: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const MAX_EVENTS = 200;
const MAX_FILTERS = 20;
const MIN_EVENTS_FOR_RECOMMENDATION = 20;

// Confidence scaling breakpoints
const CONFIDENCE_TIERS: [number, number][] = [
  [200, 0.95],
  [100, 0.8],
  [50, 0.6],
  [20, 0.3],
];

// ─── Helpers ─────────────────────────────────────────────────────────

function safe(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function safeDivide(num: number, den: number, fallback = 0): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return fallback;
  const result = num / den;
  return Number.isFinite(result) ? result : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return safe(sorted[Math.max(0, Math.min(idx, sorted.length - 1))]);
}

function confidenceForSize(n: number): number {
  for (const [threshold, conf] of CONFIDENCE_TIERS) {
    if (n >= threshold) return conf;
  }
  return 0.1;
}

// ─── OpportunityLearner ─────────────────────────────────────────────

export class OpportunityLearner {
  private events: EventRecord[] = [];
  private filterStats: Map<string, FilterStats> = new Map();
  private recommendationHistory: RecommendationRecord[] = [];

  constructor() {
    // Nothing to initialise beyond defaults
  }

  // ── Record a missed opportunity ──────────────────────────────────

  recordMiss(miss: MissedOpportunity): void {
    if (!miss || typeof miss.market !== 'string') return;

    const record: EventRecord = {
      type: 'miss',
      timestamp: Date.now(),
      data: { ...miss },
    };

    this.pushEvent(record);

    // Track per-filter accuracy
    if (miss.missReason === 'filter_rejected' && miss.filterName) {
      this.updateFilterStats(miss.filterName, miss.peakPnlPct);
    }
  }

  // ── Record a successful capture ──────────────────────────────────

  recordCapture(
    market: string,
    side: string,
    detectionTime: number,
    executionTime: number,
    entryPrice: number,
    pnl: number,
    score?: number,
  ): void {
    if (typeof market !== 'string') return;

    const latencyMs = safe(executionTime - detectionTime);

    const capture: CapturedOpportunity = {
      market,
      side,
      detectionTime: safe(detectionTime),
      executionTime: safe(executionTime),
      entryPrice: safe(entryPrice),
      pnl: safe(pnl),
      latencyMs: Math.max(0, latencyMs),
      score,
    };

    const record: EventRecord = {
      type: 'capture',
      timestamp: Date.now(),
      data: capture,
    };

    this.pushEvent(record);
  }

  // ── Analyze patterns and recommend adjustments ───────────────────

  analyze(): LearnerRecommendation[] {
    if (this.events.length < MIN_EVENTS_FOR_RECOMMENDATION) {
      return [{
        type: 'no_change',
        target: 'all',
        currentValue: 0,
        suggestedValue: 0,
        confidence: 0,
        reason: `Insufficient data: ${this.events.length}/${MIN_EVENTS_FOR_RECOMMENDATION} events recorded`,
        expectedImpact: 'none',
      }];
    }

    const recommendations: LearnerRecommendation[] = [];
    const misses = this.getMisses();
    const captures = this.getCaptures();
    const total = misses.length + captures.length;
    const confidence = confidenceForSize(total);

    // 1. Latency analysis — if >30% of misses had latencyMs > 500
    const latencyMisses = misses.filter(
      (m) => m.missReason === 'latency' && Number.isFinite(m.latencyMs!) && m.latencyMs! > 500,
    );
    const latencyMissRate = safeDivide(latencyMisses.length, misses.length);
    if (latencyMissRate > 0.3) {
      const avgLatency = this.getLatencyDistribution().avgMs;
      const suggestedTtl = Math.max(100, Math.round(avgLatency * 0.5));
      recommendations.push({
        type: 'adjust_cache_ttl',
        target: 'cache_ttl_ms',
        currentValue: Math.round(avgLatency),
        suggestedValue: suggestedTtl,
        confidence,
        reason: `${(latencyMissRate * 100).toFixed(0)}% of missed trades had latency >500ms`,
        expectedImpact: `reduce latency-caused misses by ~${Math.round(latencyMissRate * 50)}%`,
      });
    }

    // 2. Filter accuracy — if a filter rejects >60% of eventually-profitable trades
    for (const [filterName, stats] of this.filterStats.entries()) {
      const totalFiltered = stats.correctRejects + stats.incorrectRejects;
      if (totalFiltered < 5) continue;
      const incorrectRate = safeDivide(stats.incorrectRejects, totalFiltered);
      if (incorrectRate > 0.6) {
        recommendations.push({
          type: 'relax_filter',
          target: filterName,
          currentValue: 1,
          suggestedValue: 0.7,
          confidence: confidenceForSize(totalFiltered),
          reason: `Filter "${filterName}" incorrectly rejected ${(incorrectRate * 100).toFixed(0)}% of profitable trades`,
          expectedImpact: `capture ${stats.incorrectRejects} more profitable moves`,
        });
      } else if (incorrectRate < 0.15 && totalFiltered >= 10) {
        // Filter is very accurate, could tighten for less noise
        recommendations.push({
          type: 'tighten_filter',
          target: filterName,
          currentValue: 1,
          suggestedValue: 1.2,
          confidence: confidenceForSize(totalFiltered) * 0.6,
          reason: `Filter "${filterName}" has ${((1 - incorrectRate) * 100).toFixed(0)}% accuracy — could be tighter`,
          expectedImpact: 'reduce false signals without losing profitable trades',
        });
      }
    }

    // 3. Event sensitivity — if >40% of misses were from sensitivity
    const sensitivityMisses = misses.filter(
      (m) => m.missReason === 'filter_rejected' || m.missReason === 'cooldown',
    );
    const sensitivityMissRate = safeDivide(sensitivityMisses.length, misses.length);
    if (sensitivityMissRate > 0.4) {
      const profitableSensitivityMisses = sensitivityMisses.filter((m) => m.peakPnlPct > 0);
      const profitableRate = safeDivide(profitableSensitivityMisses.length, sensitivityMisses.length);
      if (profitableRate > 0.4) {
        recommendations.push({
          type: 'adjust_event_sensitivity',
          target: 'event_sensitivity_threshold',
          currentValue: 1.0,
          suggestedValue: 0.7,
          confidence,
          reason: `${(sensitivityMissRate * 100).toFixed(0)}% of misses from sensitivity filters, ${(profitableRate * 100).toFixed(0)}% were profitable`,
          expectedImpact: `capture ~${profitableSensitivityMisses.length} more profitable moves`,
        });
      }
    }

    // 4. Score threshold — if most captures happen at score 40-60
    const capturesWithScore = captures.filter(
      (c) => Number.isFinite(c.score!) && c.score! > 0,
    );
    if (capturesWithScore.length >= 10) {
      const lowScoreCaptures = capturesWithScore.filter(
        (c) => c.score! >= 40 && c.score! <= 60,
      );
      const lowScoreRate = safeDivide(lowScoreCaptures.length, capturesWithScore.length);
      if (lowScoreRate > 0.4) {
        const profitableLowScore = lowScoreCaptures.filter((c) => c.pnl > 0);
        const profitableRate = safeDivide(profitableLowScore.length, lowScoreCaptures.length);
        if (profitableRate > 0.5) {
          recommendations.push({
            type: 'adjust_threshold',
            target: 'min_opportunity_score',
            currentValue: 60,
            suggestedValue: 40,
            confidence: confidenceForSize(capturesWithScore.length),
            reason: `${(lowScoreRate * 100).toFixed(0)}% of captures at score 40-60, ${(profitableRate * 100).toFixed(0)}% profitable`,
            expectedImpact: `capture 15-25% more profitable moves by lowering score threshold`,
          });
        }
      }
    }

    // 5. Aggressive latency mode — if >50% of latency misses would have been caught
    const latencyMissesAll = misses.filter(
      (m) => m.missReason === 'latency' && Number.isFinite(m.latencyMs!),
    );
    if (latencyMissesAll.length >= 5) {
      const catchableWithAggressive = latencyMissesAll.filter(
        (m) => m.latencyMs! > 200 && m.latencyMs! < 2000 && m.peakPnlPct > 0.5,
      );
      const catchableRate = safeDivide(catchableWithAggressive.length, latencyMissesAll.length);
      if (catchableRate > 0.5) {
        const avgMissedPnl = safeDivide(
          catchableWithAggressive.reduce((s, m) => s + safe(m.peakPnlPct), 0),
          catchableWithAggressive.length,
        );
        recommendations.push({
          type: 'adjust_cache_ttl',
          target: 'latency_mode',
          currentValue: 0,
          suggestedValue: 1,
          confidence,
          reason: `Aggressive latency mode would catch ${(catchableRate * 100).toFixed(0)}% of latency misses (avg ${avgMissedPnl.toFixed(2)}% PnL)`,
          expectedImpact: `capture ${catchableWithAggressive.length} more trades worth ~${avgMissedPnl.toFixed(1)}% avg PnL`,
        });
      }
    }

    // Record recommendations for tracking accuracy
    const currentCaptureRate = this.getMissRate().captureRate;
    for (const rec of recommendations) {
      this.recommendationHistory.push({
        recommendation: rec,
        timestamp: Date.now(),
        captureRateBefore: currentCaptureRate,
      });
    }
    // Bound recommendation history
    if (this.recommendationHistory.length > 100) {
      this.recommendationHistory = this.recommendationHistory.slice(-100);
    }

    if (recommendations.length === 0) {
      recommendations.push({
        type: 'no_change',
        target: 'all',
        currentValue: 0,
        suggestedValue: 0,
        confidence,
        reason: 'No actionable patterns detected in current data',
        expectedImpact: 'none',
      });
    }

    return recommendations;
  }

  // ── Per-filter accuracy ──────────────────────────────────────────

  getFilterAccuracy(filterName: string): {
    correctRejects: number;
    incorrectRejects: number;
    accuracy: number;
  } {
    const stats = this.filterStats.get(filterName);
    if (!stats) {
      return { correctRejects: 0, incorrectRejects: 0, accuracy: 0 };
    }
    const total = stats.correctRejects + stats.incorrectRejects;
    const accuracy = safeDivide(stats.correctRejects, total);
    return {
      correctRejects: stats.correctRejects,
      incorrectRejects: stats.incorrectRejects,
      accuracy,
    };
  }

  // ── Latency percentiles ──────────────────────────────────────────

  getLatencyDistribution(): {
    p50: number;
    p90: number;
    p99: number;
    avgMs: number;
  } {
    const latencies: number[] = [];

    for (const ev of this.events) {
      if (ev.type === 'capture') {
        const cap = ev.data as CapturedOpportunity;
        if (Number.isFinite(cap.latencyMs) && cap.latencyMs >= 0) {
          latencies.push(cap.latencyMs);
        }
      } else {
        const miss = ev.data as MissedOpportunity;
        if (Number.isFinite(miss.latencyMs!) && miss.latencyMs! >= 0) {
          latencies.push(miss.latencyMs!);
        }
      }
    }

    if (latencies.length === 0) {
      return { p50: 0, p90: 0, p99: 0, avgMs: 0 };
    }

    latencies.sort((a, b) => a - b);

    const sum = latencies.reduce((s, v) => s + v, 0);
    const avgMs = safeDivide(sum, latencies.length);

    return {
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p99: percentile(latencies, 99),
      avgMs: Math.round(avgMs),
    };
  }

  // ── Miss rate summary ────────────────────────────────────────────

  getMissRate(): {
    total: number;
    missed: number;
    captured: number;
    captureRate: number;
  } {
    const missed = this.events.filter((e) => e.type === 'miss').length;
    const captured = this.events.filter((e) => e.type === 'capture').length;
    const total = missed + captured;
    return {
      total,
      missed,
      captured,
      captureRate: safeDivide(captured, total),
    };
  }

  // ── Miss reason breakdown ────────────────────────────────────────

  getMissReasonBreakdown(): Record<string, { count: number; avgPnlMissed: number }> {
    const buckets: Map<string, { count: number; totalPnl: number }> = new Map();

    for (const ev of this.events) {
      if (ev.type !== 'miss') continue;
      const miss = ev.data as MissedOpportunity;
      const reason = miss.missReason || 'unknown';
      const existing = buckets.get(reason) || { count: 0, totalPnl: 0 };
      existing.count += 1;
      existing.totalPnl += safe(miss.peakPnlPct);
      buckets.set(reason, existing);
    }

    const result: Record<string, { count: number; avgPnlMissed: number }> = {};
    for (const [reason, stats] of buckets.entries()) {
      result[reason] = {
        count: stats.count,
        avgPnlMissed: safe(safeDivide(stats.totalPnl, stats.count)),
      };
    }
    return result;
  }

  // ── Comprehensive stats ──────────────────────────────────────────

  getStats(): {
    missRate: ReturnType<OpportunityLearner['getMissRate']>;
    latency: ReturnType<OpportunityLearner['getLatencyDistribution']>;
    missReasons: ReturnType<OpportunityLearner['getMissReasonBreakdown']>;
    filterAccuracies: Record<string, { correctRejects: number; incorrectRejects: number; accuracy: number }>;
    totalEvents: number;
    oldestEventAge: number;
    recommendationCount: number;
    avgMissedPnlPct: number;
    avgCapturedPnl: number;
    topMissedMarkets: { market: string; count: number }[];
  } {
    const misses = this.getMisses();
    const captures = this.getCaptures();

    // Average missed PnL
    const totalMissedPnl = misses.reduce((s, m) => s + safe(m.peakPnlPct), 0);
    const avgMissedPnlPct = safe(safeDivide(totalMissedPnl, misses.length));

    // Average captured PnL
    const totalCapturedPnl = captures.reduce((s, c) => s + safe(c.pnl), 0);
    const avgCapturedPnl = safe(safeDivide(totalCapturedPnl, captures.length));

    // Top missed markets
    const marketCounts: Map<string, number> = new Map();
    for (const m of misses) {
      marketCounts.set(m.market, (marketCounts.get(m.market) || 0) + 1);
    }
    const topMissedMarkets = Array.from(marketCounts.entries())
      .map(([market, count]) => ({ market, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Filter accuracies
    const filterAccuracies: Record<string, { correctRejects: number; incorrectRejects: number; accuracy: number }> = {};
    for (const filterName of this.filterStats.keys()) {
      filterAccuracies[filterName] = this.getFilterAccuracy(filterName);
    }

    // Oldest event age
    const oldestEventAge = this.events.length > 0
      ? Date.now() - this.events[0].timestamp
      : 0;

    return {
      missRate: this.getMissRate(),
      latency: this.getLatencyDistribution(),
      missReasons: this.getMissReasonBreakdown(),
      filterAccuracies,
      totalEvents: this.events.length,
      oldestEventAge: safe(oldestEventAge),
      recommendationCount: this.recommendationHistory.length,
      avgMissedPnlPct,
      avgCapturedPnl,
      topMissedMarkets,
    };
  }

  // ── Reset ────────────────────────────────────────────────────────

  reset(): void {
    this.events = [];
    this.filterStats.clear();
    this.recommendationHistory = [];
  }

  // ── Private helpers ──────────────────────────────────────────────

  private pushEvent(record: EventRecord): void {
    this.events.push(record);
    // LRU eviction: drop oldest when over limit
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(this.events.length - MAX_EVENTS);
    }
  }

  private updateFilterStats(filterName: string, peakPnlPct: number): void {
    // Enforce max filters — evict least-used if at capacity
    if (!this.filterStats.has(filterName) && this.filterStats.size >= MAX_FILTERS) {
      let minKey = '';
      let minTotal = Infinity;
      for (const [key, stats] of this.filterStats.entries()) {
        const total = stats.correctRejects + stats.incorrectRejects;
        if (total < minTotal) {
          minTotal = total;
          minKey = key;
        }
      }
      if (minKey) this.filterStats.delete(minKey);
    }

    const stats = this.filterStats.get(filterName) || { correctRejects: 0, incorrectRejects: 0 };

    if (Number.isFinite(peakPnlPct) && peakPnlPct > 0) {
      // Trade would have been profitable — filter was wrong to reject
      stats.incorrectRejects += 1;
    } else {
      // Trade would have lost or broken even — filter was correct
      stats.correctRejects += 1;
    }

    this.filterStats.set(filterName, stats);
  }

  private getMisses(): MissedOpportunity[] {
    return this.events
      .filter((e) => e.type === 'miss')
      .map((e) => e.data as MissedOpportunity);
  }

  private getCaptures(): CapturedOpportunity[] {
    return this.events
      .filter((e) => e.type === 'capture')
      .map((e) => e.data as CapturedOpportunity);
  }
}
