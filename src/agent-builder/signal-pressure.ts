// Signal Pressure Tracker — observability into why trades are/aren't happening
// Zero external dependencies, bounded storage, pure diagnostics (no behavior changes)

export type RejectionReason =
  | 'low_confidence' | 'ev_fail' | 'ensemble_fail' | 'regime_mismatch'
  | 'rr_fail' | '2tick_fail' | 'policy_skip' | 'quality_gate'
  | 'slippage_viability' | 'orderbook_wall' | 'micro_entry'
  | 'portfolio_block' | 'correlation_block' | 'strategy_disabled'
  | 'risk_blocked' | 'other';

export interface SignalRecord {
  market: string;
  score: number;
  confidence: number;
  rejected: boolean;
  reason?: RejectionReason;
  timestamp: number;
}

export interface NearMiss {
  market: string;
  score: number;
  threshold: number;
  blockedBy: RejectionReason;
  confidence: number;
  timestamp: number;
}

export interface ScoreDistribution {
  below30: number;
  range30_40: number;
  range40_55: number;
  range55_70: number;
  above70: number;
  total: number;
}

export interface PressureSummary {
  signalsGenerated: number;
  signalsRejected: number;
  signalsExecuted: number;
  nearMissCount: number;
  dominantFailure: RejectionReason | 'none';
  dominantFailurePct: number;
  avgScore: number;
  scoreDistribution: ScoreDistribution;
  rejectionBreakdown: Record<string, number>;
  captureRate: number;
}

// ---------------------------------------------------------------------------

const MAX_SIGNALS = 500;
const MAX_NEAR_MISSES = 100;

const ADAPT_SUGGESTIONS: Partial<Record<RejectionReason, string>> = {
  '2tick_fail':     'Allow 1-tick for confidence >=70%',
  'ev_fail':        'Adjust EV smoothing window',
  'ensemble_fail':  'Allow single strong strategy temporarily',
  'low_confidence': 'Lower confidence floor by 5%',
  'quality_gate':   'Relax quality gate percentile',
};

function safe(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

export class SignalPressure {
  private signals: SignalRecord[] = [];
  private signalIdx = 0;
  private signalCount = 0;

  private nearMisses: NearMiss[] = [];
  private nearMissIdx = 0;
  private nearMissCount = 0;

  private rejectionCounts: Map<RejectionReason, number> = new Map();
  private totalGenerated = 0;
  private totalRejected = 0;
  private totalExecuted = 0;
  private scoreSum = 0;
  private tickCounter = 0;

  constructor() {
    this.signals = new Array(MAX_SIGNALS);
    this.nearMisses = new Array(MAX_NEAR_MISSES);
  }

  // -- Recording ------------------------------------------------------------

  recordSignal(
    market: string,
    score: number,
    confidence: number,
    rejected: boolean,
    reason?: RejectionReason,
  ): void {
    const s = safe(score);
    const c = safe(confidence);

    const record: SignalRecord = {
      market,
      score: s,
      confidence: c,
      rejected,
      reason: rejected ? (reason ?? 'other') : undefined,
      timestamp: Date.now(),
    };

    this.signals[this.signalIdx] = record;
    this.signalIdx = (this.signalIdx + 1) % MAX_SIGNALS;
    if (this.signalCount < MAX_SIGNALS) this.signalCount++;

    this.totalGenerated++;
    this.scoreSum += s;

    if (rejected) {
      this.totalRejected++;
      const r = reason ?? 'other';
      this.rejectionCounts.set(r, (this.rejectionCounts.get(r) ?? 0) + 1);
    } else {
      this.totalExecuted++;
    }

    this.tickCounter++;
  }

  recordNearMiss(
    market: string,
    score: number,
    threshold: number,
    blockedBy: RejectionReason,
    confidence: number,
  ): void {
    const nm: NearMiss = {
      market,
      score: safe(score),
      threshold: safe(threshold),
      blockedBy,
      confidence: safe(confidence),
      timestamp: Date.now(),
    };

    this.nearMisses[this.nearMissIdx] = nm;
    this.nearMissIdx = (this.nearMissIdx + 1) % MAX_NEAR_MISSES;
    if (this.nearMissCount < MAX_NEAR_MISSES) this.nearMissCount++;
  }

  // -- Queries --------------------------------------------------------------

  getSummary(): PressureSummary {
    const dom = this.getDominantFailure();
    return {
      signalsGenerated: this.totalGenerated,
      signalsRejected: this.totalRejected,
      signalsExecuted: this.totalExecuted,
      nearMissCount: this.nearMissCount,
      dominantFailure: dom.reason,
      dominantFailurePct: dom.pct,
      avgScore: this.totalGenerated > 0
        ? safe(this.scoreSum / this.totalGenerated)
        : 0,
      scoreDistribution: this.getScoreDistribution(),
      rejectionBreakdown: this.getRejectionBreakdown(),
      captureRate: this.totalGenerated > 0
        ? safe(this.totalExecuted / this.totalGenerated)
        : 0,
    };
  }

  getScoreDistribution(): ScoreDistribution {
    const dist: ScoreDistribution = {
      below30: 0, range30_40: 0, range40_55: 0,
      range55_70: 0, above70: 0, total: 0,
    };

    const count = this.signalCount;
    for (let i = 0; i < count; i++) {
      const rec = this.signals[i];
      if (!rec) continue;
      const s = rec.score;
      dist.total++;
      if (s < 30)      dist.below30++;
      else if (s < 40) dist.range30_40++;
      else if (s < 55) dist.range40_55++;
      else if (s < 70) dist.range55_70++;
      else              dist.above70++;
    }
    return dist;
  }

  getNearMisses(last?: number): NearMiss[] {
    const count = this.nearMissCount;
    if (count === 0) return [];

    const result: NearMiss[] = [];
    const limit = (last && Number.isFinite(last) && last > 0)
      ? Math.min(last, count)
      : count;

    // Walk backwards from most recent
    let idx = (this.nearMissIdx - 1 + MAX_NEAR_MISSES) % MAX_NEAR_MISSES;
    for (let i = 0; i < limit; i++) {
      const nm = this.nearMisses[idx];
      if (nm) result.push(nm);
      idx = (idx - 1 + MAX_NEAR_MISSES) % MAX_NEAR_MISSES;
    }
    return result;
  }

  getDominantFailure(): { reason: RejectionReason | 'none'; pct: number; count: number } {
    if (this.totalRejected === 0 || this.rejectionCounts.size === 0) {
      return { reason: 'none', pct: 0, count: 0 };
    }

    let maxReason: RejectionReason = 'other';
    let maxCount = 0;

    for (const [reason, count] of this.rejectionCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxReason = reason;
      }
    }

    const pct = safe((maxCount / this.totalRejected) * 100);
    return { reason: maxReason, pct, count: maxCount };
  }

  getRejectionBreakdown(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [reason, count] of this.rejectionCounts) {
      out[reason] = count;
    }
    return out;
  }

  // -- Adaptation hint ------------------------------------------------------

  shouldAdapt(): { adapt: boolean; reason: RejectionReason; suggestion: string } | null {
    if (this.totalGenerated < 20) return null;
    if (this.nearMissCount < 10) return null;

    const dom = this.getDominantFailure();
    if (dom.reason === 'none') return null;
    if (dom.pct < 60) return null;

    const suggestion = ADAPT_SUGGESTIONS[dom.reason];
    if (!suggestion) return null;

    return {
      adapt: true,
      reason: dom.reason,
      suggestion,
    };
  }

  // -- Formatting -----------------------------------------------------------

  formatLog(): string {
    const gen = this.totalGenerated;
    const rej = this.totalRejected;
    const exec = this.totalExecuted;
    const nm = this.nearMissCount;
    const cap = gen > 0 ? safe((exec / gen) * 100) : 0;
    const avg = gen > 0 ? safe(this.scoreSum / gen) : 0;
    const dom = this.getDominantFailure();
    const dist = this.getScoreDistribution();

    const lines = [
      `SIGNAL PRESSURE [tick ${this.tickCounter}]:`,
      `  Generated: ${gen} | Rejected: ${rej} | Executed: ${exec} | Near-miss: ${nm}`,
      `  Capture rate: ${cap.toFixed(1)}%`,
      `  Dominant failure: ${dom.reason} (${dom.pct.toFixed(1)}%)`,
      `  Score distribution: <30:${dist.below30} | 30-40:${dist.range30_40} | 40-55:${dist.range40_55} | 55-70:${dist.range55_70} | >70:${dist.above70}`,
      `  Avg score: ${avg.toFixed(2)}`,
    ];

    return lines.join('\n');
  }

  // -- Reset ----------------------------------------------------------------

  reset(): void {
    this.signals = new Array(MAX_SIGNALS);
    this.signalIdx = 0;
    this.signalCount = 0;

    this.nearMisses = new Array(MAX_NEAR_MISSES);
    this.nearMissIdx = 0;
    this.nearMissCount = 0;

    this.rejectionCounts.clear();
    this.totalGenerated = 0;
    this.totalRejected = 0;
    this.totalExecuted = 0;
    this.scoreSum = 0;
    this.tickCounter = 0;
  }
}
