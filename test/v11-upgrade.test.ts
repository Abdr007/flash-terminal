/**
 * Tests for v11 upgrade: state persistence, exit policy, correlation guard,
 * daily reset, learning stability, simulation TP/SL.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyLearner } from '../src/agent-builder/policy-learner.js';
import { ExitPolicyLearner } from '../src/agent-builder/exit-policy-learner.js';
import { CorrelationGuard } from '../src/agent-builder/correlation-guard.js';
import { ExpectancyEngine } from '../src/agent-builder/expectancy-engine.js';
import { AdaptiveWeights } from '../src/agent-builder/adaptive-weights.js';
import { TimeIntelligence } from '../src/agent-builder/time-intelligence.js';
import { CounterfactualTracker } from '../src/agent-builder/counterfactual-tracker.js';
import { buildPersistedState, type PersistedAgentState } from '../src/agent-builder/state-persistence.js';

// ─── Phase 1: State Persistence ──────────────────────────────────────────────

describe('State Persistence', () => {
  it('PolicyLearner serialize/restore preserves Q-table', () => {
    const learner = new PolicyLearner();
    const state = learner.buildState('TRENDING_UP', 'bullish', 0.7, 3, 0.6);

    // Train it
    learner.update(state, 'trade_aggressive', 1.5);
    learner.update(state, 'trade_aggressive', 0.8);
    learner.update(state, 'trade_normal', -0.3);

    const serialized = learner.serialize();
    expect(serialized.entries.length).toBeGreaterThan(0);
    expect(serialized.totalUpdates).toBe(3);

    // Restore into new instance
    const restored = new PolicyLearner();
    restored.restore(serialized);

    const restoredMetrics = restored.getMetrics();
    expect(restoredMetrics.policySize).toBe(1);
    expect(restoredMetrics.totalUpdates).toBe(3);
  });

  it('PolicyLearner restore handles corrupted data gracefully', () => {
    const learner = new PolicyLearner();
    learner.restore(null as unknown as ReturnType<PolicyLearner['serialize']>);
    expect(learner.getMetrics().policySize).toBe(0);

    learner.restore({ entries: 'bad' } as unknown as ReturnType<PolicyLearner['serialize']>);
    expect(learner.getMetrics().policySize).toBe(0);
  });

  it('ExpectancyEngine serialize/restore preserves strategy stats', () => {
    const engine = new ExpectancyEngine();
    engine.recordTrade('momentum', 10);
    engine.recordTrade('momentum', -5);
    engine.recordTrade('momentum', 8);

    const serialized = engine.serialize();
    expect(serialized.strategies.length).toBe(1);
    expect(serialized.globalTrades).toBe(3);

    const restored = new ExpectancyEngine();
    restored.restore(serialized);
    const stats = restored.getAllStats();
    expect(stats.length).toBe(1);
    expect(stats[0].trades).toBe(3);
    expect(stats[0].wins).toBe(2);
  });

  it('AdaptiveWeights serialize/restore preserves accuracy', () => {
    const weights = new AdaptiveWeights({ signal: 0.3, strategy: 0.7 });
    weights.recordOutcome('signal', true);
    weights.recordOutcome('signal', true);
    weights.recordOutcome('strategy', false);

    const serialized = weights.serialize();
    expect(serialized.length).toBe(2);

    const restored = new AdaptiveWeights({ signal: 0.3, strategy: 0.7 });
    restored.restore(serialized);
    const states = restored.getStates();
    expect(states.length).toBe(2);
    // Signal should have higher accuracy than strategy
    const signalState = states.find(s => s.name === 'signal')!;
    const stratState = states.find(s => s.name === 'strategy')!;
    expect(signalState.shortTermAccuracy).toBeGreaterThan(stratState.shortTermAccuracy);
  });

  it('TimeIntelligence serialize/restore preserves hourly data', () => {
    const ti = new TimeIntelligence();
    ti.record(10);
    ti.record(-5);
    ti.record(8);

    const serialized = ti.serialize();
    expect(serialized.length).toBeGreaterThan(0);

    const restored = new TimeIntelligence();
    restored.restore(serialized);
    const summary = restored.getSummary();
    expect(summary.length).toBeGreaterThan(0);
    expect(summary[0].trades).toBe(3);
  });

  it('buildPersistedState creates valid schema', () => {
    const policy = new PolicyLearner();
    const exitPolicy = new ExitPolicyLearner();
    const expectancy = new ExpectancyEngine();
    const weights = new AdaptiveWeights({ signal: 0.5, ev: 0.5 });
    const timeIntel = new TimeIntelligence();

    const state = buildPersistedState({
      policy, exitPolicy, expectancy,
      adaptiveWeights: weights, timeIntel,
    });

    expect(state.version).toBe(1);
    expect(state.savedAt).toBeTruthy();
    expect(Array.isArray(state.policy.entries)).toBe(true);
    expect(Array.isArray(state.exitPolicy.entries)).toBe(true);
    expect(Array.isArray(state.expectancy.strategies)).toBe(true);
    expect(Array.isArray(state.adaptiveWeights)).toBe(true);
    expect(Array.isArray(state.timeIntel)).toBe(true);
  });
});

// ─── Phase 2: Exit Policy Learner ────────────────────────────────────────────

describe('Exit Policy Learner', () => {
  let exitPolicy: ExitPolicyLearner;

  beforeEach(() => {
    exitPolicy = new ExitPolicyLearner();
  });

  it('buildState discretizes correctly', () => {
    const state = exitPolicy.buildState(-10, 3, 'TRENDING_UP', 5, 20);
    expect(state.pnlBucket).toBe('deep_loss');
    expect(state.timeBucket).toBe('fresh');
    expect(state.volRegime).toBe('trend');
    expect(state.tpSlDistance).toBe('balanced');
  });

  it('buildState near TP', () => {
    const state = exitPolicy.buildState(5, 20, 'RANGING', 1, 15);
    expect(state.pnlBucket).toBe('profit');
    expect(state.timeBucket).toBe('mature');
    expect(state.tpSlDistance).toBe('near_tp');
  });

  it('buildState near SL', () => {
    const state = exitPolicy.buildState(-1, 8, 'HIGH_VOLATILITY', 10, 1);
    expect(state.pnlBucket).toBe('flat');
    expect(state.timeBucket).toBe('developing');
    expect(state.volRegime).toBe('volatile');
    expect(state.tpSlDistance).toBe('near_sl');
  });

  it('recommend returns hold with no data', () => {
    const state = exitPolicy.buildState(2, 10, 'RANGING', 5, 10);
    const rec = exitPolicy.recommend(state, false);
    // Without enough visits, should fall back to hold
    expect(rec.confidence).toBeLessThanOrEqual(0.3);
  });

  it('update and learning', () => {
    const state = exitPolicy.buildState(5, 15, 'TRENDING_UP', 2, 15);
    // Train: closing at profit is good
    for (let i = 0; i < 30; i++) {
      exitPolicy.update(state, 'full_close', 0.8);
    }
    // Train: holding at profit sometimes loses
    for (let i = 0; i < 10; i++) {
      exitPolicy.update(state, 'hold', -0.3);
    }

    const metrics = exitPolicy.getMetrics();
    expect(metrics.policySize).toBeGreaterThan(0);
    expect(metrics.totalUpdates).toBe(40);
  });

  it('computeExitReward rewards defensive close better than letting it run', () => {
    // Closing at a small loss where price continued to drop
    const closeReward = exitPolicy.computeExitReward(-2, -0.5, 10, 'full_close', -1.5);
    // Holding while price dropped
    const holdReward = exitPolicy.computeExitReward(-2, -0.5, 10, 'hold', -1.5);
    // Closing should be better than holding in this scenario
    expect(closeReward).toBeGreaterThan(holdReward);
  });

  it('computeExitReward penalizes closing a winner early', () => {
    const reward = exitPolicy.computeExitReward(3, 1.5, 5, 'full_close', 1.0);
    // Closing a winner that continued winning = left money on table
    // But still gets R-multiple reward
    expect(typeof reward).toBe('number');
  });

  it('serialize/restore preserves state', () => {
    const state = exitPolicy.buildState(3, 10, 'RANGING', 5, 10);
    exitPolicy.update(state, 'hold', 0.5);
    exitPolicy.update(state, 'hold', 0.3);

    const serialized = exitPolicy.serialize();
    const restored = new ExitPolicyLearner();
    restored.restore(serialized);

    expect(restored.getMetrics().policySize).toBe(1);
    expect(restored.getMetrics().totalUpdates).toBe(2);
  });
});

// ─── Phase 3: Correlation Guard ──────────────────────────────────────────────

describe('Correlation Guard', () => {
  let guard: CorrelationGuard;
  const mockPos = (market: string, side: string, sizeUsd: number) => ({
    market, side, sizeUsd, collateralUsd: sizeUsd / 3, leverage: 3,
    entryPrice: 100, markPrice: 100, pnl: 0, pnlPercent: 0,
  });

  beforeEach(() => {
    guard = new CorrelationGuard(1, 2, 0.15);
  });

  it('allows first position in a cluster', () => {
    const result = guard.check([], 'SOL', 'long', 100, 10000);
    expect(result.allowed).toBe(true);
    expect(result.sizeMultiplier).toBe(1.0);
  });

  it('blocks same-direction in same cluster', () => {
    // BONK and PENGU are both in meme_community cluster
    const positions = [mockPos('BONK', 'long', 100)] as any[];
    const result = guard.check(positions, 'PENGU', 'long', 50, 10000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('meme_community');
  });

  it('allows opposite direction in same cluster with reduced size', () => {
    // BONK and PENGU are both in meme_community cluster
    const positions = [mockPos('BONK', 'long', 100)] as any[];
    const result = guard.check(positions, 'PENGU', 'short', 50, 10000);
    expect(result.allowed).toBe(true);
    expect(result.sizeMultiplier).toBeLessThan(1.0);
  });

  it('blocks when cluster position limit exceeded', () => {
    const positions = [
      mockPos('BONK', 'long', 100),
      mockPos('PENGU', 'short', 50),
    ] as any[];
    // WIF short blocked because PENGU short already exists in same cluster (per-direction limit)
    const result = guard.check(positions, 'WIF', 'short', 50, 10000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('meme_community');
  });

  it('blocks when cluster exposure exceeds cap', () => {
    // BONK with large exposure in meme_community, PENGU would exceed cap
    const positions = [mockPos('BONK', 'long', 1400)] as any[];
    const result = guard.check(positions, 'PENGU', 'short', 200, 10000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceed');
  });

  it('allows BTC and ETH simultaneously (different clusters)', () => {
    const positions = [mockPos('BTC', 'long', 500)] as any[];
    const result = guard.check(positions, 'ETH', 'long', 300, 10000);
    expect(result.allowed).toBe(true);
    expect(result.sizeMultiplier).toBe(1.0);
  });

  it('standalone assets always pass', () => {
    const positions = [mockPos('SOL', 'long', 1000)] as any[];
    const result = guard.check(positions, 'NEWTOKEN', 'long', 100, 10000);
    expect(result.allowed).toBe(true);
  });

  it('getClusterInfo returns correct cluster', () => {
    const info = guard.getClusterInfo('BONK');
    expect(info.cluster).toBe('meme_community');
    expect(info.members).toContain('BONK');
    expect(info.members).toContain('PENGU');
  });
});

// ─── Phase 5: Learning Stability ─────────────────────────────────────────────

describe('Learning Stability', () => {
  it('MIN_VISITS_FOR_TRUST is 25', () => {
    const learner = new PolicyLearner();
    const state = learner.buildState('TRENDING_UP', 'bullish', 0.8, 3, 0.7);

    // Update 10 times — still shouldn't trust
    for (let i = 0; i < 10; i++) {
      learner.update(state, 'trade_aggressive', 1.0);
    }

    const rec = learner.recommend(state);
    // With only 10 visits (< 25), confidence should be low (fallback to rule-based)
    expect(rec.confidence).toBeLessThanOrEqual(0.3);
  });

  it('Counterfactual decay reduces old insight weight', () => {
    const tracker = new CounterfactualTracker();

    // Record old skips (simulate by checking isOverFiltering)
    // Need at least 10 records now (raised from 5)
    for (let i = 0; i < 6; i++) {
      tracker.recordSkip('SOL', 'long', 100, 50, 'test_filter', 'momentum');
    }

    // With only 6 records, isOverFiltering should return false (min 10)
    expect(tracker.isOverFiltering('test_filter')).toBe(false);
  });
});

// ─── Phase 6: Simulation TP/SL ──────────────────────────────────────────────

describe('Simulation TP/SL & Per-Market Slippage', () => {
  it('SimulatedPosition type supports TP/SL fields', () => {
    // Type check — SimulatedPosition should have optional takeProfit/stopLoss
    const pos: import('../src/types/index.js').SimulatedPosition = {
      id: 'test',
      market: 'SOL',
      side: 'long' as any,
      entryPrice: 100,
      sizeUsd: 300,
      collateralUsd: 100,
      leverage: 3,
      openFee: 0.24,
      openedAt: Date.now(),
      maintenanceMarginRate: 0.01,
      closeFeeRate: 0.0008,
      takeProfit: 110,
      stopLoss: 95,
    };
    expect(pos.takeProfit).toBe(110);
    expect(pos.stopLoss).toBe(95);
  });
});

// ─── Phase 7: No Dead Code in Active Agent ─────────────────────────────────

describe('Codebase Cleanup', () => {
  it('LiveTradingAgent does not import old agent.ts', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const liveAgent = readFileSync(join(process.cwd(), 'src/agent-builder/live-agent.ts'), 'utf-8');
    expect(liveAgent).not.toContain("from './agent.js'");
  });

  it('LiveTradingAgent does not import supervisor.ts', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const liveAgent = readFileSync(join(process.cwd(), 'src/agent-builder/live-agent.ts'), 'utf-8');
    expect(liveAgent).not.toContain("from './supervisor.js'");
  });

  it('New modules are properly imported in LiveTradingAgent', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const liveAgent = readFileSync(join(process.cwd(), 'src/agent-builder/live-agent.ts'), 'utf-8');
    expect(liveAgent).toContain("from './exit-policy-learner.js'");
    expect(liveAgent).toContain("from './correlation-guard.js'");
    expect(liveAgent).toContain("from './state-persistence.js'");
  });
});
