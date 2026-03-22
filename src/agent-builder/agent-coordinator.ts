/**
 * Multi-Agent Coordinator
 *
 * Splits the trading agent into 4 specialized sub-agents that communicate
 * via shared state: Scout, Executor, Risk, and Learning.
 *
 * Zero external dependencies. Single-threaded Node.js — no async race conditions.
 */

import type { TradeDecision } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentMode = 'active' | 'degraded' | 'paused';

export interface OpportunityEntry {
  market: string;
  side: string;
  score: number;
  confidence: number;
  urgency: 'immediate' | 'high' | 'normal' | 'low';
  source: 'scan' | 'event' | 'prediction';
  timestamp: number;
  ttlMs: number;
  decision?: TradeDecision;
}

export interface ExecutionEntry {
  id: string;
  opportunity: OpportunityEntry;
  status: 'queued' | 'executing' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  queuedAt: number;
  executedAt?: number;
  result?: { success: boolean; pnl?: number; latencyMs?: number };
}

export interface RiskOverride {
  type: 'block_market' | 'reduce_size' | 'halt_trading' | 'increase_threshold';
  market?: string;
  multiplier?: number;
  reason: string;
  expiresAt: number;
}

export interface LearningUpdate {
  type: 'weight_update' | 'threshold_adjust' | 'strategy_toggle' | 'cache_ttl_adjust';
  target: string;
  value: number;
  reason: string;
  timestamp: number;
}

export interface MarketState {
  price: number;
  change24h: number;
  volume24h: number;
  openInterest: number;
  timestamp: number;
}

export interface PortfolioSnapshot {
  positions: Array<{
    market: string;
    side: string;
    sizeUsd: number;
    collateralUsd: number;
    entryPrice: number;
    markPrice: number;
    pnl: number;
    leverage: number;
  }>;
  capitalUsd: number;
  totalExposure: number;
  timestamp: number;
}

export interface SharedAgentState {
  opportunities: OpportunityEntry[];
  executionQueue: ExecutionEntry[];
  riskOverrides: RiskOverride[];
  learningUpdates: LearningUpdate[];
  marketStates: Map<string, MarketState>;
  portfolioState: PortfolioSnapshot;
  agentModes: {
    scout: AgentMode;
    executor: AgentMode;
    risk: AgentMode;
    learning: AgentMode;
  };
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Queue limits
// ---------------------------------------------------------------------------

const MAX_OPPORTUNITIES = 50;
const MAX_EXECUTION_ENTRIES = 20;
const MAX_RISK_OVERRIDES = 10;
const MAX_LEARNING_UPDATES = 100;

// ---------------------------------------------------------------------------
// AgentCoordinator
// ---------------------------------------------------------------------------

export class AgentCoordinator {
  private state: SharedAgentState;
  private executionIdCounter = 0;

  constructor() {
    this.state = this.createFreshState();
  }

  // -------------------------------------------------------------------------
  // Scout methods
  // -------------------------------------------------------------------------

  /** Push a new opportunity to the queue. FIFO eviction when limit exceeded. */
  submitOpportunity(entry: OpportunityEntry): void {
    this.state.opportunities.push(entry);

    // FIFO eviction
    while (this.state.opportunities.length > MAX_OPPORTUNITIES) {
      this.state.opportunities.shift();
    }
  }

  /** Return non-expired opportunities sorted by score (descending). */
  getActiveOpportunities(): OpportunityEntry[] {
    const now = Date.now();
    return this.state.opportunities
      .filter((o) => now - o.timestamp < o.ttlMs)
      .sort((a, b) => b.score - a.score);
  }

  /** Remove expired entries from the opportunities queue. */
  expireStaleOpportunities(): number {
    const now = Date.now();
    const before = this.state.opportunities.length;
    this.state.opportunities = this.state.opportunities.filter(
      (o) => now - o.timestamp < o.ttlMs,
    );
    return before - this.state.opportunities.length;
  }

  // -------------------------------------------------------------------------
  // Executor methods
  // -------------------------------------------------------------------------

  /** Add an opportunity to the execution queue with a given priority. */
  queueExecution(opportunity: OpportunityEntry, priority: number): string {
    const id = `exec-${++this.executionIdCounter}-${Date.now()}`;
    const entry: ExecutionEntry = {
      id,
      opportunity,
      status: 'queued',
      priority,
      queuedAt: Date.now(),
    };

    this.state.executionQueue.push(entry);

    // FIFO eviction — remove oldest completed/failed first, then oldest queued
    while (this.state.executionQueue.length > MAX_EXECUTION_ENTRIES) {
      const doneIdx = this.state.executionQueue.findIndex(
        (e) => e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled',
      );
      if (doneIdx !== -1) {
        this.state.executionQueue.splice(doneIdx, 1);
      } else {
        // Remove oldest queued entry (FIFO)
        this.state.executionQueue.shift();
      }
    }

    return id;
  }

  /** Returns the highest-priority queued entry and marks it as executing, or null. */
  pullNextExecution(): ExecutionEntry | null {
    const queued = this.state.executionQueue
      .filter((e) => e.status === 'queued')
      .sort((a, b) => b.priority - a.priority);

    if (queued.length === 0) return null;

    const entry = queued[0];
    entry.status = 'executing';
    entry.executedAt = Date.now();
    return entry;
  }

  /** Mark an execution as completed or failed with its result. */
  markExecutionComplete(
    id: string,
    result: { success: boolean; pnl?: number; latencyMs?: number },
  ): boolean {
    const entry = this.state.executionQueue.find((e) => e.id === id);
    if (!entry) return false;

    entry.status = result.success ? 'completed' : 'failed';
    entry.result = result;
    if (!entry.executedAt) entry.executedAt = Date.now();
    return true;
  }

  /** Number of queued (not yet executing) items. */
  getQueueDepth(): number {
    return this.state.executionQueue.filter((e) => e.status === 'queued').length;
  }

  /** Aggregate execution statistics. */
  getExecutionStats(): {
    queued: number;
    executing: number;
    completed: number;
    failed: number;
    avgLatencyMs: number;
  } {
    const q = this.state.executionQueue;
    const completed = q.filter((e) => e.status === 'completed');
    const withLatency = completed.filter(
      (e) => e.result?.latencyMs != null && Number.isFinite(e.result.latencyMs),
    );
    const avgLatencyMs =
      withLatency.length > 0
        ? withLatency.reduce((sum, e) => sum + e.result!.latencyMs!, 0) / withLatency.length
        : 0;

    return {
      queued: q.filter((e) => e.status === 'queued').length,
      executing: q.filter((e) => e.status === 'executing').length,
      completed: completed.length,
      failed: q.filter((e) => e.status === 'failed').length,
      avgLatencyMs,
    };
  }

  // -------------------------------------------------------------------------
  // Risk methods
  // -------------------------------------------------------------------------

  /** Add a risk override. FIFO eviction when limit exceeded. */
  addRiskOverride(override: RiskOverride): void {
    this.state.riskOverrides.push(override);

    while (this.state.riskOverrides.length > MAX_RISK_OVERRIDES) {
      this.state.riskOverrides.shift();
    }
  }

  /** Get active (non-expired) overrides, optionally filtered by market. */
  getActiveOverrides(market?: string): RiskOverride[] {
    const now = Date.now();
    // Auto-expire old ones
    this.state.riskOverrides = this.state.riskOverrides.filter((o) => o.expiresAt > now);

    if (market) {
      return this.state.riskOverrides.filter(
        (o) => !o.market || o.market === market,
      );
    }
    return [...this.state.riskOverrides];
  }

  /** Check if a market is blocked by any active risk override. */
  isMarketBlocked(market: string): boolean {
    const overrides = this.getActiveOverrides(market);
    return overrides.some(
      (o) => o.type === 'block_market' && (!o.market || o.market === market),
    );
  }

  /** Get the combined size multiplier for a market (applies reduce_size overrides). */
  getSizeMultiplier(market: string): number {
    const overrides = this.getActiveOverrides(market);
    let multiplier = 1;
    for (const o of overrides) {
      if (o.type === 'reduce_size' && o.multiplier != null && Number.isFinite(o.multiplier)) {
        multiplier *= o.multiplier;
      }
    }
    return Math.max(0, multiplier);
  }

  /** Check if trading is globally halted. */
  isHalted(): boolean {
    const overrides = this.getActiveOverrides();
    return overrides.some((o) => o.type === 'halt_trading');
  }

  // -------------------------------------------------------------------------
  // Learning methods
  // -------------------------------------------------------------------------

  /** Submit a learning update. FIFO eviction when limit exceeded. */
  submitLearningUpdate(update: LearningUpdate): void {
    this.state.learningUpdates.push(update);

    while (this.state.learningUpdates.length > MAX_LEARNING_UPDATES) {
      this.state.learningUpdates.shift();
    }
  }

  /** Returns and clears all pending learning updates. */
  consumeLearningUpdates(): LearningUpdate[] {
    const updates = this.state.learningUpdates;
    this.state.learningUpdates = [];
    return updates;
  }

  // -------------------------------------------------------------------------
  // Portfolio
  // -------------------------------------------------------------------------

  /** Sync portfolio state from external source. */
  updatePortfolio(
    positions: PortfolioSnapshot['positions'],
    capitalUsd: number,
  ): void {
    const totalExposure = positions.reduce((sum, p) => {
      const size = Number.isFinite(p.sizeUsd) ? p.sizeUsd : 0;
      return sum + Math.abs(size);
    }, 0);

    this.state.portfolioState = {
      positions: [...positions],
      capitalUsd: Number.isFinite(capitalUsd) ? capitalUsd : 0,
      totalExposure,
      timestamp: Date.now(),
    };
  }

  /** Get current portfolio snapshot. */
  getPortfolio(): Readonly<PortfolioSnapshot> {
    return this.state.portfolioState;
  }

  // -------------------------------------------------------------------------
  // Coordination
  // -------------------------------------------------------------------------

  /** Run maintenance: expire stale data, update timestamp. */
  tick(): void {
    this.expireStaleOpportunities();

    // Expire risk overrides
    const now = Date.now();
    this.state.riskOverrides = this.state.riskOverrides.filter((o) => o.expiresAt > now);

    // Update global timestamp
    this.state.timestamp = now;
  }

  /** Get readonly view of the full shared state. */
  getState(): Readonly<SharedAgentState> {
    return this.state;
  }

  /** Control a sub-agent's operational mode. */
  setAgentMode(agent: keyof SharedAgentState['agentModes'], mode: AgentMode): void {
    this.state.agentModes[agent] = mode;
  }

  /** Full cleanup — reset to initial state. */
  reset(): void {
    this.state = this.createFreshState();
    this.executionIdCounter = 0;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private createFreshState(): SharedAgentState {
    return {
      opportunities: [],
      executionQueue: [],
      riskOverrides: [],
      learningUpdates: [],
      marketStates: new Map(),
      portfolioState: {
        positions: [],
        capitalUsd: 0,
        totalExposure: 0,
        timestamp: Date.now(),
      },
      agentModes: {
        scout: 'active',
        executor: 'active',
        risk: 'active',
        learning: 'active',
      },
      timestamp: Date.now(),
    };
  }
}
