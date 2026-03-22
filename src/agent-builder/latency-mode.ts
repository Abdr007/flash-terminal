// ── Latency Arbitrage Mode Controller ──────────────────────────────────
// Detects when market conditions warrant ultra-fast execution and
// temporarily relaxes validation gates. Self-contained, zero dependencies.

// ── Types ──────────────────────────────────────────────────────────────

type BypassLevel = 'minimal' | 'moderate' | 'aggressive';

interface LatencyModeState {
  active: boolean;
  activatedAt: number;
  reason: string;
  bypassLevel: BypassLevel;
  marketTrigger: string;
  expiresAt: number;
}

interface LatencyGateConfig {
  minimal: string[];
  moderate: string[];
  aggressive: string[];
}

interface ActivationRecord {
  timestamp: number;
  level: BypassLevel;
  reason: string;
  market: string;
  durationMs: number;
  deactivatedAt: number;
}

interface LatencyModeStats {
  totalActivations: number;
  avgDurationMs: number;
  tradesDuringLatencyMode: number;
  pnlDuringLatencyMode: number;
}

interface TradeRecord {
  timestamp: number;
  pnl: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const MAX_HISTORY = 50;
const MAX_TRADE_RECORDS = 200;
const MAX_ACTIVATIONS_PER_WINDOW = 3;
const ACTIVATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const EV_SAMPLE_THRESHOLD = 10;

const EXPIRE_MS: Record<BypassLevel, number> = {
  aggressive: 30_000,
  moderate: 60_000,
  minimal: 120_000,
};

const DEFAULT_GATE_CONFIG: LatencyGateConfig = {
  minimal: ['micro_entry', 'time_intelligence'],
  moderate: ['micro_entry', 'time_intelligence', 'correlation_guard', 'counterfactual'],
  aggressive: [
    'micro_entry',
    'time_intelligence',
    'correlation_guard',
    'counterfactual',
    '2tick_confirmation',
    'regime_filter',
  ],
};

const AGGRESSIVE_PROFIT_REQUIREMENT = 5;

// ── Helpers ────────────────────────────────────────────────────────────

function safe(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

// ── LatencyMode Class ──────────────────────────────────────────────────

export class LatencyMode {
  private state: LatencyModeState;
  private gateConfig: LatencyGateConfig;
  private history: ActivationRecord[] = [];
  private trades: TradeRecord[] = [];
  private activationTimestamps: number[] = [];
  private autoDisabled = false;

  constructor(config?: Partial<LatencyGateConfig>) {
    this.gateConfig = {
      minimal: config?.minimal ?? [...DEFAULT_GATE_CONFIG.minimal],
      moderate: config?.moderate ?? [...DEFAULT_GATE_CONFIG.moderate],
      aggressive: config?.aggressive ?? [...DEFAULT_GATE_CONFIG.aggressive],
    };
    this.state = this.inactiveState();
  }

  // ── Public API ─────────────────────────────────────────────────────

  evaluate(
    priceVelocity: number,
    spreadEstimate: number,
    volatility: number,
    eventCount: number,
    market = 'unknown',
  ): LatencyModeState {
    const vel = safe(priceVelocity);
    const spread = safe(spreadEstimate);
    const _vol = safe(volatility); // reserved for future spread-based activation
    const events = safe(eventCount);

    // If currently active and not expired, keep current state
    if (this.state.active && Date.now() < this.state.expiresAt) {
      return { ...this.state };
    }

    // If active but expired, deactivate first
    if (this.state.active) {
      this.finalizeDeactivation();
    }

    // Check if auto-disabled due to negative EV
    if (this.autoDisabled) {
      return { ...this.inactiveState() };
    }

    // Rate limit: max 3 activations per 10 minutes
    if (this.isRateLimited()) {
      return { ...this.inactiveState() };
    }

    // Determine activation level
    const now = Date.now();
    let level: BypassLevel | null = null;
    let reason = '';

    if (vel > 0.01 && events > 2) {
      // Aggressive requires 5 prior profitable latency trades
      if (this.countProfitableLatencyTrades() >= AGGRESSIVE_PROFIT_REQUIREMENT) {
        level = 'aggressive';
        reason = `Price velocity ${(vel * 100).toFixed(2)}%/tick with ${events} events — aggressive bypass`;
      } else {
        // Downgrade to moderate if insufficient profitable history
        level = 'moderate';
        reason = `Price velocity ${(vel * 100).toFixed(2)}%/tick with ${events} events — downgraded to moderate (need ${AGGRESSIVE_PROFIT_REQUIREMENT} profitable latency trades)`;
      }
    } else if (vel > 0.005) {
      level = 'moderate';
      reason = `Price velocity ${(vel * 100).toFixed(2)}%/tick — moderate bypass`;
    } else if (spread > 2.0) {
      level = 'minimal';
      reason = `Spread ${spread.toFixed(2)}x normal — minimal bypass`;
    }

    if (level === null) {
      return { ...this.inactiveState() };
    }

    // Activate
    const expiresAt = now + EXPIRE_MS[level];
    this.state = {
      active: true,
      activatedAt: now,
      reason,
      bypassLevel: level,
      marketTrigger: market,
      expiresAt,
    };

    this.activationTimestamps.push(now);
    this.pruneActivationTimestamps();

    return { ...this.state };
  }

  isActive(): boolean {
    if (!this.state.active) return false;
    if (Date.now() >= this.state.expiresAt) {
      this.finalizeDeactivation();
      return false;
    }
    return true;
  }

  shouldBypass(gateName: string): boolean {
    if (!this.isActive()) return false;
    const gates = this.gateConfig[this.state.bypassLevel];
    return gates.includes(gateName);
  }

  getState(): LatencyModeState {
    // Refresh active status (handles expiry)
    if (this.state.active) {
      this.isActive();
    }
    return { ...this.state };
  }

  deactivate(): void {
    if (!this.state.active) return;
    this.finalizeDeactivation();
  }

  getBypassedGates(): string[] {
    if (!this.isActive()) return [];
    return [...this.gateConfig[this.state.bypassLevel]];
  }

  getActivationHistory(): ActivationRecord[] {
    return [...this.history];
  }

  getStats(): LatencyModeStats {
    const totalActivations = this.history.length;
    const avgDurationMs =
      totalActivations > 0
        ? safe(this.history.reduce((sum, r) => sum + r.durationMs, 0) / totalActivations)
        : 0;
    const tradesDuringLatencyMode = this.trades.length;
    const pnlDuringLatencyMode = safe(this.trades.reduce((sum, t) => sum + t.pnl, 0));

    return {
      totalActivations,
      avgDurationMs,
      tradesDuringLatencyMode,
      pnlDuringLatencyMode,
    };
  }

  recordTradeResult(pnl: number): void {
    const safePnl = safe(pnl);
    this.trades.push({ timestamp: Date.now(), pnl: safePnl });

    // Bound trade records
    if (this.trades.length > MAX_TRADE_RECORDS) {
      this.trades = this.trades.slice(-MAX_TRADE_RECORDS);
    }

    // Check if should auto-disable
    if (this.shouldDisable()) {
      this.autoDisabled = true;
      if (this.state.active) {
        this.finalizeDeactivation();
      }
    }
  }

  shouldDisable(): boolean {
    if (this.trades.length < EV_SAMPLE_THRESHOLD) return false;
    const totalPnl = safe(this.trades.reduce((sum, t) => sum + t.pnl, 0));
    return totalPnl < 0;
  }

  reset(): void {
    this.state = this.inactiveState();
    this.history = [];
    this.trades = [];
    this.activationTimestamps = [];
    this.autoDisabled = false;
  }

  // ── Private ────────────────────────────────────────────────────────

  private inactiveState(): LatencyModeState {
    return {
      active: false,
      activatedAt: 0,
      reason: '',
      bypassLevel: 'minimal',
      marketTrigger: '',
      expiresAt: 0,
    };
  }

  private finalizeDeactivation(): void {
    if (!this.state.active) return;

    const now = Date.now();
    const durationMs = safe(now - this.state.activatedAt);

    const record: ActivationRecord = {
      timestamp: this.state.activatedAt,
      level: this.state.bypassLevel,
      reason: this.state.reason,
      market: this.state.marketTrigger,
      durationMs,
      deactivatedAt: now,
    };

    this.history.push(record);

    // Bound history
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }

    this.state = this.inactiveState();
  }

  private isRateLimited(): boolean {
    const now = Date.now();
    const cutoff = now - ACTIVATION_WINDOW_MS;
    const recentCount = this.activationTimestamps.filter((t) => t > cutoff).length;
    return recentCount >= MAX_ACTIVATIONS_PER_WINDOW;
  }

  private pruneActivationTimestamps(): void {
    const cutoff = Date.now() - ACTIVATION_WINDOW_MS;
    this.activationTimestamps = this.activationTimestamps.filter((t) => t > cutoff);
  }

  private countProfitableLatencyTrades(): number {
    return this.trades.filter((t) => t.pnl > 0).length;
  }
}
