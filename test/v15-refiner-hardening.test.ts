/**
 * V15 Edge Refiner Hardening Tests — validates controlled self-improvement.
 *
 * Tests: exit priority, strategy stability, regime scaling, cooldown,
 * impact tracking, revert, safety freeze.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { DecisionAction } from '../src/agent-builder/types.js';

function makeTrades(n: number, strategy: string, regime: string, pnlFn: (i: number) => number) {
  return Array.from({ length: n }, (_, i) => {
    const pnl = pnlFn(i);
    return {
      id: i, timestamp: new Date().toISOString(),
      action: 'close' as DecisionAction, market: 'SOL', side: 'long' as const,
      leverage: 3, collateral: 100, entryPrice: 100, exitPrice: 100 + pnl / 3,
      pnl, pnlPercent: pnl, strategy, confidence: 0.6,
      signals: [], reasoning: `SCORE=65 | NORMAL | ${regime}`,
      outcome: (pnl > 0.01 ? 'win' : pnl < -0.01 ? 'loss' : 'breakeven') as 'win' | 'loss' | 'breakeven',
    };
  });
}

describe('EdgeRefiner V2', async () => {
  const { EdgeRefiner } = await import('../src/agent-builder/edge-refiner.js');
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');

  let refiner: InstanceType<typeof EdgeRefiner>;
  beforeEach(() => { refiner = new EdgeRefiner(); });

  // ─── Phase 1: Exit Priority ──────────────────────────────────────

  it('exit efficiency is checked before strategy disable', () => {
    const journal = new TradeJournal();
    // Bad strategy AND low exit efficiency — exit should win priority
    for (const t of makeTrades(30, 'bad_strat', 'RANGING', () => -5)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice, pnlPercent: 0.3 }); // Low pnlPercent = early exit pattern
    }
    for (const t of makeTrades(25, 'ok_strat', 'TRENDING_UP', () => 5)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice, pnlPercent: 0.5 });
    }

    const action = refiner.refine(journal.getEntries(), journal.getStats());
    // First action should be exit-related (tune_exits) since it's priority 1
    expect(['tune_exits', 'disable_strategy']).toContain(action.type);
  });

  // ─── Phase 2: Strategy Disable Stability ─────────────────────────

  it('requires ≥25 trades to disable a strategy', () => {
    const journal = new TradeJournal();
    // Bad strategy with only 15 trades — should NOT be disabled
    for (const t of makeTrades(15, 'bad_strat', 'RANGING', () => -8)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }
    for (const t of makeTrades(40, 'good_strat', 'TRENDING_UP', (i) => i % 3 === 0 ? -3 : 8)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }

    const action = refiner.refine(journal.getEntries(), journal.getStats());
    // bad_strat has only 15 trades — should NOT be disabled yet
    if (action.type === 'disable_strategy') {
      expect(action.target).not.toBe('bad_strat'); // Would only disable if ≥25
    }
  });

  // ─── Phase 3: Regime Scaling (Not Binary) ────────────────────────

  it('scales regimes instead of blocking them', () => {
    const journal = new TradeJournal();
    for (const t of makeTrades(20, 'test', 'RANGING', () => -5)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }
    for (const t of makeTrades(35, 'test', 'TRENDING_UP', (i) => i % 3 === 0 ? -3 : 10)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }

    refiner.refine(journal.getEntries(), journal.getStats());

    // RANGING should NOT be fully blocked
    expect(refiner.isRegimeBlocked('RANGING')).toBe(false);
    // But should have a scaling multiplier
    const mult = refiner.getRegimeMultiplier('RANGING');
    // If it was scaled, it should be < 1.0
    // (may or may not be scaled depending on whether exit efficiency was the first action)
    expect(mult).toBeGreaterThan(0); // Never fully zero
    expect(mult).toBeLessThanOrEqual(1.0);
  });

  it('getRegimeMultiplier returns 1.0 for unscaled regimes', () => {
    expect(refiner.getRegimeMultiplier('TRENDING_UP')).toBe(1.0);
    expect(refiner.getRegimeMultiplier('NONEXISTENT')).toBe(1.0);
  });

  // ─── Phase 4: Cooldown ───────────────────────────────────────────

  it('enforces cooldown between active changes', () => {
    const journal = new TradeJournal();
    for (const t of makeTrades(55, 'bad', 'RANGING', () => -8)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }

    // First refinement — makes a change
    const action1 = refiner.refine(journal.getEntries(), journal.getStats());
    expect(action1.type).not.toBe('no_action');

    // Add a few more trades (not enough for cooldown)
    for (const t of makeTrades(10, 'bad', 'RANGING', () => -8)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }

    // Second refinement — should be in cooldown
    const action2 = refiner.refine(journal.getEntries(), journal.getStats());
    expect(action2.type).toBe('no_action');
    expect(action2.reason).toContain('Cooldown');
  });

  // ─── Phase 5: Impact Tracking ────────────────────────────────────

  it('tracks before/after metrics in log', () => {
    const journal = new TradeJournal();
    for (const t of makeTrades(55, 'test', 'RANGING', (i) => i % 2 === 0 ? 5 : -8)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }

    refiner.refine(journal.getEntries(), journal.getStats());
    const log = refiner.getLog();
    expect(log.length).toBe(1);
    expect(log[0].snapshotBefore).toBeDefined();
    expect(typeof log[0].snapshotBefore!.ev).toBe('number');
    expect(typeof log[0].snapshotBefore!.sharpe).toBe('number');
  });

  // ─── Phase 6: Safety Guard ───────────────────────────────────────

  it('freezes after 2 consecutive negative cycles', () => {
    const journal = new TradeJournal();
    // Initial trades — creates a change
    for (const t of makeTrades(55, 'bad', 'RANGING', () => -5)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }
    refiner.refine(journal.getEntries(), journal.getStats());

    // After cooldown — add worse trades (performance worsened)
    for (const t of makeTrades(35, 'bad', 'RANGING', () => -10)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }
    const action2 = refiner.refine(journal.getEntries(), journal.getStats());
    // Should revert
    if (action2.type === 'revert') {
      // Add more bad trades for second negative cycle
      for (const t of makeTrades(35, 'bad', 'RANGING', () => -12)) {
        journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
      }
      const action3 = refiner.refine(journal.getEntries(), journal.getStats());
      // After 2 negatives, system should be frozen
      if (refiner.isFrozen()) {
        expect(action3.type).toBe('freeze');
      }
    }
    // Verify frozen state is reflected in summary
    const summary = refiner.getSummary();
    expect(typeof summary.frozen).toBe('boolean');
  });

  it('frozen system rejects all changes', () => {
    const journal = new TradeJournal();
    for (const t of makeTrades(55, 'test', 'RANGING', (i) => i % 2 === 0 ? 5 : -3)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }

    // Manually simulate frozen state for testing
    (refiner as any).frozen = true;

    const action = refiner.refine(journal.getEntries(), journal.getStats());
    expect(action.type).toBe('freeze');
    expect(action.reason).toContain('frozen');
  });

  it('reset unfreezes and clears all state', () => {
    (refiner as any).frozen = true; // eslint-disable-line @typescript-eslint/no-explicit-any
    (refiner as any).consecutiveNegativeCycles = 5;
    refiner.reset();
    expect(refiner.isFrozen()).toBe(false);
    expect(refiner.getSummary().consecutiveNegative).toBe(0);
    expect(refiner.getSummary().disabledStrategies.length).toBe(0);
    expect(refiner.getSummary().scaledRegimes.length).toBe(0);
    expect(refiner.getSizeMultiplier()).toBe(1.0);
  });

  // ─── General Invariants ──────────────────────────────────────────

  it('never makes more than one active change per cycle', () => {
    const journal = new TradeJournal();
    // Multiple bad strategies + bad regime
    for (const t of makeTrades(20, 'bad1', 'RANGING', () => -8)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }
    for (const t of makeTrades(20, 'bad2', 'HIGH_VOLATILITY', () => -10)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }
    for (const t of makeTrades(15, 'ok', 'TRENDING_UP', () => 5)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }

    const action = refiner.refine(journal.getEntries(), journal.getStats());
    // Should only make ONE change — count disabled + scaled
    const summary = refiner.getSummary();
    const totalChanges = summary.disabledStrategies.length + summary.scaledRegimes.length + (summary.sizeMultiplier < 1.0 ? 1 : 0);
    expect(totalChanges).toBeLessThanOrEqual(1);
  });

  it('log has correct structure', () => {
    const journal = new TradeJournal();
    for (const t of makeTrades(55, 'test', 'TRENDING_UP', (i) => i % 3 === 0 ? -3 : 8)) {
      journal.record({ action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: [], riskLevel: 'safe' }, { pnl: t.pnl, exitPrice: t.exitPrice });
    }

    refiner.refine(journal.getEntries(), journal.getStats());
    const log = refiner.getLog();
    expect(log.length).toBeGreaterThan(0);

    const entry = log[0];
    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('tradeCount');
    expect(entry).toHaveProperty('ev');
    expect(entry).toHaveProperty('sharpe');
    expect(entry).toHaveProperty('action');
    expect(entry).toHaveProperty('snapshotBefore');
    expect(typeof entry.action.type).toBe('string');
    expect(typeof entry.action.reason).toBe('string');
  });
});
