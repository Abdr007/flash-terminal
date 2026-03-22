// ─── Execution Kill-Switch ───────────────────────────────────────────
// Auto-disables trading when execution quality degrades dangerously.
// Zero external dependencies, fully self-contained.
// ─────────────────────────────────────────────────────────────────────

export type KillswitchTrigger =
  | 'slippage_spike'
  | 'fill_failure_streak'
  | 'latency_degradation'
  | 'cost_exceeded'
  | 'manual';

export interface KillswitchState {
  active: boolean;
  activatedAt: number;
  reason: string;
  trigger: KillswitchTrigger;
  resumeAt: number;
  overrideCount: number;
}

export interface KillswitchConfig {
  /** Trigger if avg slippage over last 5 trades > N bps */
  slippageSpikeThresholdBps: number;
  /** Trigger if N consecutive fills fail */
  fillFailureStreakThreshold: number;
  /** Trigger if p90 latency over last 5 trades > N ms */
  latencyThresholdMs: number;
  /** Trigger if cumulative slippage cost > N% of capital */
  costThresholdPct: number;
  /** Auto-resume after N ms (0 = manual only) */
  autoResumeAfterMs: number;
  /** Max overrides before permanent halt */
  maxOverrides: number;
}

interface HistoryEntry {
  trigger: KillswitchTrigger;
  reason: string;
  activatedAt: number;
  deactivatedAt: number;
  durationMs: number;
}

interface KillswitchStats {
  totalActivations: number;
  totalDurationMs: number;
  avgDurationMs: number;
  mostCommonTrigger: KillswitchTrigger | null;
  overridesUsed: number;
}

interface SizeReduction {
  reduce: boolean;
  multiplier: number;
}

const MAX_HISTORY = 20;
const COOLDOWN_MS = 30_000;
const MIN_DATA_POINTS = 3;

const DEFAULT_CONFIG: KillswitchConfig = {
  slippageSpikeThresholdBps: 50,
  fillFailureStreakThreshold: 3,
  latencyThresholdMs: 10_000,
  costThresholdPct: 1.0,
  autoResumeAfterMs: 300_000,
  maxOverrides: 3,
};

function safeNumber(v: number, fallback: number = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function computeP90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.9) - 1;
  return safeNumber(sorted[Math.max(idx, 0)]);
}

function computeAvg(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + safeNumber(v), 0);
  return safeNumber(sum / values.length);
}

export class ExecutionKillswitch {
  private config: KillswitchConfig;
  private state: KillswitchState;
  private history: HistoryEntry[] = [];
  private lastResumeAt: number = 0;
  private permanentHalt: boolean = false;

  constructor(config?: Partial<KillswitchConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      active: false,
      activatedAt: 0,
      reason: '',
      trigger: 'manual',
      resumeAt: 0,
      overrideCount: 0,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────

  evaluate(
    recentSlippageBps: number[],
    recentFillSuccess: boolean[],
    recentLatencyMs: number[],
    cumulativeCostUsd: number,
    capitalUsd: number,
  ): KillswitchState {
    // Not enough data to evaluate
    if (
      recentSlippageBps.length < MIN_DATA_POINTS &&
      recentFillSuccess.length < MIN_DATA_POINTS &&
      recentLatencyMs.length < MIN_DATA_POINTS
    ) {
      return this.getState();
    }

    const now = Date.now();

    // If active, check auto-resume
    if (this.state.active) {
      if (this.state.resumeAt > 0 && now >= this.state.resumeAt) {
        this.doDeactivate(now);
        this.lastResumeAt = now;
        // Fall through to re-evaluate after cooldown check
      } else {
        return this.getState();
      }
    }

    // Cooldown: don't re-evaluate within 30s of a resume
    if (this.lastResumeAt > 0 && now - this.lastResumeAt < COOLDOWN_MS) {
      return this.getState();
    }

    // Permanent halt: after max overrides, next activation is permanent
    if (this.permanentHalt) {
      return this.getState();
    }

    // Check triggers in order of severity (most severe first)

    // 1. Cost exceeded (most severe — capital damage)
    const safeCost = safeNumber(cumulativeCostUsd);
    const safeCap = safeNumber(capitalUsd);
    if (safeCap > 0) {
      const costPct = (safeCost / safeCap) * 100;
      if (Number.isFinite(costPct) && costPct >= this.config.costThresholdPct) {
        this.doActivate('cost_exceeded',
          `Cumulative slippage cost ${costPct.toFixed(2)}% exceeds ${this.config.costThresholdPct}% threshold`,
          now);
        return this.getState();
      }
    }

    // 2. Fill failure streak
    if (recentFillSuccess.length >= MIN_DATA_POINTS) {
      let streak = 0;
      for (let i = recentFillSuccess.length - 1; i >= 0; i--) {
        if (!recentFillSuccess[i]) {
          streak++;
        } else {
          break;
        }
      }
      if (streak >= this.config.fillFailureStreakThreshold) {
        this.doActivate('fill_failure_streak',
          `${streak} consecutive fill failures (threshold: ${this.config.fillFailureStreakThreshold})`,
          now);
        return this.getState();
      }
    }

    // 3. Slippage spike (avg over last 5)
    if (recentSlippageBps.length >= MIN_DATA_POINTS) {
      const window = recentSlippageBps.slice(-5);
      const avgSlippage = computeAvg(window);
      if (avgSlippage >= this.config.slippageSpikeThresholdBps) {
        this.doActivate('slippage_spike',
          `Avg slippage ${avgSlippage.toFixed(1)} bps exceeds ${this.config.slippageSpikeThresholdBps} bps threshold`,
          now);
        return this.getState();
      }
    }

    // 4. Latency degradation (p90 over last 5)
    if (recentLatencyMs.length >= MIN_DATA_POINTS) {
      const window = recentLatencyMs.slice(-5);
      const p90 = computeP90(window);
      if (p90 >= this.config.latencyThresholdMs) {
        this.doActivate('latency_degradation',
          `P90 latency ${p90.toFixed(0)}ms exceeds ${this.config.latencyThresholdMs}ms threshold`,
          now);
        return this.getState();
      }
    }

    return this.getState();
  }

  isActive(): boolean {
    // Check auto-resume even outside evaluate()
    if (this.state.active && this.state.resumeAt > 0 && Date.now() >= this.state.resumeAt) {
      this.doDeactivate(Date.now());
      this.lastResumeAt = Date.now();
    }
    return this.state.active;
  }

  getState(): KillswitchState {
    return { ...this.state };
  }

  /**
   * Manual resume. Returns false if max overrides exceeded.
   */
  override(reason: string): boolean {
    if (!this.state.active) return true;

    if (this.state.overrideCount >= this.config.maxOverrides) {
      this.permanentHalt = true;
      return false;
    }

    const now = Date.now();
    this.state.overrideCount++;
    this.doDeactivate(now);
    this.lastResumeAt = now;
    // Record the override reason in the last history entry
    if (this.history.length > 0) {
      const last = this.history[this.history.length - 1];
      last.reason += ` | Override: ${reason}`;
    }
    return true;
  }

  /**
   * Manual activation.
   */
  activate(trigger: KillswitchTrigger, reason: string): void {
    this.doActivate(trigger, reason, Date.now());
  }

  /**
   * Manual deactivation. Counts as an override.
   */
  deactivate(): boolean {
    return this.override('manual deactivation');
  }

  /**
   * Returns last 20 activations with trigger/reason/duration.
   */
  getHistory(): readonly HistoryEntry[] {
    return [...this.history];
  }

  getStats(): KillswitchStats {
    const total = this.history.length;
    if (total === 0) {
      return {
        totalActivations: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        mostCommonTrigger: null,
        overridesUsed: this.state.overrideCount,
      };
    }

    const totalDuration = this.history.reduce((sum, e) => sum + safeNumber(e.durationMs), 0);
    const avgDuration = safeNumber(totalDuration / total);

    // Find most common trigger
    const counts = new Map<KillswitchTrigger, number>();
    for (const entry of this.history) {
      counts.set(entry.trigger, (counts.get(entry.trigger) ?? 0) + 1);
    }
    let mostCommon: KillswitchTrigger = this.history[0].trigger;
    let maxCount = 0;
    for (const [trigger, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = trigger;
      }
    }

    return {
      totalActivations: total,
      totalDurationMs: safeNumber(totalDuration),
      avgDurationMs: avgDuration,
      mostCommonTrigger: mostCommon,
      overridesUsed: this.state.overrideCount,
    };
  }

  /**
   * Pre-killswitch warning: suggests size reduction when approaching thresholds.
   */
  shouldReduceSize(): SizeReduction {
    // Can't assess without recent evaluate context, so we check state
    if (this.state.active) {
      return { reduce: true, multiplier: 0 };
    }
    // No reduction if not approaching anything
    return { reduce: false, multiplier: 1.0 };
  }

  /**
   * Evaluate with metric proximity and return size reduction advice.
   * Call this with the same data you'd pass to evaluate().
   */
  evaluateSizeReduction(
    recentSlippageBps: number[],
    recentFillSuccess: boolean[],
    recentLatencyMs: number[],
    cumulativeCostUsd: number,
    capitalUsd: number,
  ): SizeReduction {
    if (this.state.active) {
      return { reduce: true, multiplier: 0 };
    }

    let maxProximity = 0; // 0..1 how close to trigger (1 = at threshold)

    // Slippage proximity
    if (recentSlippageBps.length >= MIN_DATA_POINTS) {
      const window = recentSlippageBps.slice(-5);
      const avg = computeAvg(window);
      const threshold = this.config.slippageSpikeThresholdBps;
      if (threshold > 0) {
        const ratio = safeNumber(avg / threshold);
        if (ratio > maxProximity) maxProximity = ratio;
      }
    }

    // Fill failure proximity
    if (recentFillSuccess.length >= MIN_DATA_POINTS) {
      let streak = 0;
      for (let i = recentFillSuccess.length - 1; i >= 0; i--) {
        if (!recentFillSuccess[i]) streak++;
        else break;
      }
      const threshold = this.config.fillFailureStreakThreshold;
      if (threshold > 0) {
        const ratio = safeNumber(streak / threshold);
        if (ratio > maxProximity) maxProximity = ratio;
      }
    }

    // Latency proximity
    if (recentLatencyMs.length >= MIN_DATA_POINTS) {
      const window = recentLatencyMs.slice(-5);
      const p90 = computeP90(window);
      const threshold = this.config.latencyThresholdMs;
      if (threshold > 0) {
        const ratio = safeNumber(p90 / threshold);
        if (ratio > maxProximity) maxProximity = ratio;
      }
    }

    // Cost proximity
    const safeCap = safeNumber(capitalUsd);
    if (safeCap > 0 && this.config.costThresholdPct > 0) {
      const costPct = (safeNumber(cumulativeCostUsd) / safeCap) * 100;
      const ratio = safeNumber(costPct / this.config.costThresholdPct);
      if (ratio > maxProximity) maxProximity = ratio;
    }

    // At or above threshold
    if (maxProximity >= 1.0) {
      return { reduce: true, multiplier: 0 };
    }

    // Above 70% of threshold -> suggest 50% size reduction
    if (maxProximity >= 0.7) {
      return { reduce: true, multiplier: 0.5 };
    }

    return { reduce: false, multiplier: 1.0 };
  }

  /**
   * Full reset including override count and history.
   */
  reset(): void {
    this.state = {
      active: false,
      activatedAt: 0,
      reason: '',
      trigger: 'manual',
      resumeAt: 0,
      overrideCount: 0,
    };
    this.history = [];
    this.lastResumeAt = 0;
    this.permanentHalt = false;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private doActivate(trigger: KillswitchTrigger, reason: string, now: number): void {
    if (this.state.active) return; // Already active

    const resumeAt = this.config.autoResumeAfterMs > 0
      ? now + this.config.autoResumeAfterMs
      : 0;

    this.state = {
      ...this.state,
      active: true,
      activatedAt: now,
      reason,
      trigger,
      resumeAt,
    };
  }

  private doDeactivate(now: number): void {
    if (!this.state.active) return;

    const duration = safeNumber(now - this.state.activatedAt);
    const entry: HistoryEntry = {
      trigger: this.state.trigger,
      reason: this.state.reason,
      activatedAt: this.state.activatedAt,
      deactivatedAt: now,
      durationMs: duration,
    };

    this.history.push(entry);
    // Bound history
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }

    this.state = {
      ...this.state,
      active: false,
      activatedAt: 0,
      reason: '',
      resumeAt: 0,
    };
  }
}
