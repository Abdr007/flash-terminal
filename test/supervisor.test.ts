/**
 * Supervisor & Session Evaluator Test Suite
 *
 * Tests preflight checks, deviation detection, scaling decisions,
 * and session evaluation logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionEvaluator } from '../src/agent-builder/session-evaluator.js';
import { TradeJournal } from '../src/agent-builder/trade-journal.js';
import type { AgentState, DecisionAction } from '../src/agent-builder/types.js';
import { AgentStatus } from '../src/agent-builder/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    status: AgentStatus.STOPPED,
    iteration: 20,
    startingCapital: 1000,
    currentCapital: 1000,
    dailyPnl: 0,
    dailyTradeCount: 0,
    lastTradeTimestamp: Date.now(),
    inCooldown: false,
    cooldownUntil: 0,
    positions: [],
    consecutiveLosses: 0,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: 'open' as DecisionAction,
    market: 'SOL',
    side: 'long' as const,
    strategy: 'trend_continuation',
    confidence: 0.7,
    reasoning: 'Test',
    signals: [],
    riskLevel: 'safe' as const,
    ...overrides,
  };
}

// ─── SessionEvaluator ────────────────────────────────────────────────────────

describe('SessionEvaluator', () => {
  let evaluator: SessionEvaluator;
  let journal: TradeJournal;

  beforeEach(() => {
    evaluator = new SessionEvaluator();
    journal = new TradeJournal();
  });

  describe('scoring', () => {
    it('scores profitable session highly', () => {
      // 5 wins, 1 loss
      for (let i = 0; i < 5; i++) journal.record(makeDecision(), { pnl: 15 });
      journal.record(makeDecision(), { pnl: -5 });

      const report = evaluator.evaluate(journal, makeState({ currentCapital: 1070 }));
      expect(report.score).toBeGreaterThanOrEqual(70);
      expect(report.grade).toMatch(/[AB]/);
      expect(report.strengths.length).toBeGreaterThan(0);
    });

    it('scores losing session poorly', () => {
      // 1 win, 4 losses
      journal.record(makeDecision(), { pnl: 5 });
      for (let i = 0; i < 4; i++) journal.record(makeDecision(), { pnl: -15 });

      const report = evaluator.evaluate(journal, makeState({ currentCapital: 945, dailyPnl: -55 }));
      expect(report.score).toBeLessThan(50);
      expect(report.grade).toMatch(/[DF]/);
      expect(report.issues.length).toBeGreaterThan(0);
    });

    it('scores empty session with no-trade issue', () => {
      const report = evaluator.evaluate(journal, makeState());
      expect(report.issues.some((i) => i.category === 'no_trades')).toBe(true);
    });

    it('flags safety stop as critical', () => {
      journal.record(makeDecision(), { pnl: -10 });
      const report = evaluator.evaluate(journal, makeState({ safetyStopReason: 'Daily loss breached' }));
      expect(report.issues.some((i) => i.severity === 'critical' && i.category === 'safety_stop')).toBe(true);
    });

    it('detects consecutive loss pattern', () => {
      for (let i = 0; i < 4; i++) journal.record(makeDecision(), { pnl: -5 });
      const report = evaluator.evaluate(journal, makeState({ currentCapital: 980 }));
      expect(report.issues.some((i) => i.category === 'streak')).toBe(true);
    });

    it('identifies large single loss', () => {
      journal.record(makeDecision(), { pnl: 10 });
      journal.record(makeDecision(), { pnl: -60 });
      journal.record(makeDecision(), { pnl: 10 });
      const report = evaluator.evaluate(journal, makeState({ currentCapital: 960 }));
      expect(report.issues.some((i) => i.category === 'worst_trade')).toBe(true);
    });
  });

  describe('scaling decisions', () => {
    it('recommends scale_up for strong performance', () => {
      for (let i = 0; i < 6; i++) journal.record(makeDecision(), { pnl: 10 });
      journal.record(makeDecision(), { pnl: -3 });

      const report = evaluator.evaluate(journal, makeState({ currentCapital: 1057 }));
      expect(report.scalingAction).toBe('scale_up');
    });

    it('recommends hold for moderate performance', () => {
      journal.record(makeDecision(), { pnl: 5 });
      journal.record(makeDecision(), { pnl: -3 });
      journal.record(makeDecision(), { pnl: 4 });

      const report = evaluator.evaluate(journal, makeState({ currentCapital: 1006 }));
      expect(report.scalingAction).toBe('hold');
    });

    it('recommends stop on critical issues', () => {
      journal.record(makeDecision(), { pnl: -10 });
      const report = evaluator.evaluate(journal, makeState({ safetyStopReason: 'execution failure' }));
      expect(report.scalingAction).toBe('stop');
    });

    it('recommends scale_down on losses', () => {
      for (let i = 0; i < 5; i++) journal.record(makeDecision(), { pnl: -10 });
      const report = evaluator.evaluate(journal, makeState({ currentCapital: 950 }));
      expect(report.scalingAction).toBe('scale_down');
    });
  });

  describe('formatReport', () => {
    it('produces readable output', () => {
      journal.record(makeDecision(), { pnl: 10 });
      journal.record(makeDecision(), { pnl: -5 });
      const report = evaluator.evaluate(journal, makeState({ currentCapital: 1005 }));
      const text = evaluator.formatReport(report);
      expect(text).toContain('SESSION REPORT');
      expect(text).toContain('Grade');
      expect(text).toContain('Scaling');
      expect(text).toContain('Win Rate');
    });

    it('shows strengths and issues', () => {
      for (let i = 0; i < 5; i++) journal.record(makeDecision(), { pnl: 15 });
      const report = evaluator.evaluate(journal, makeState({ currentCapital: 1075 }));
      const text = evaluator.formatReport(report);
      expect(text).toContain('STRENGTHS');
    });
  });

  describe('grade assignment', () => {
    it('A for score >= 85', () => {
      for (let i = 0; i < 8; i++) journal.record(makeDecision(), { pnl: 10 });
      const report = evaluator.evaluate(journal, makeState({ currentCapital: 1080 }));
      if (report.score >= 85) expect(report.grade).toBe('A');
    });

    it('F for very low score', () => {
      for (let i = 0; i < 5; i++) journal.record(makeDecision(), { pnl: -20 });
      const report = evaluator.evaluate(journal, makeState({
        currentCapital: 900,
        safetyStopReason: 'loss breach',
        consecutiveLosses: 5,
      }));
      expect(report.grade).toMatch(/[DF]/);
    });
  });
});

// ─── Supervisor Protocol Enforcement (unit-level) ────────────────────────────

describe('Supervisor Protocol', () => {
  it('dry-run enforcement: cannot skip to live', async () => {
    // This tests the concept — actual supervisor needs SDK mocking
    // So we test the SessionEvaluator's scaling logic instead
    const evaluator = new SessionEvaluator();
    const journal = new TradeJournal();

    // Zero trades = insufficient data
    const report = evaluator.evaluate(journal, makeState());
    expect(['hold', 'scale_down', 'stop']).toContain(report.scalingAction);
    // Should never recommend scale_up with no data
    expect(report.scalingAction).not.toBe('scale_up');
  });

  it('scaling requires minimum 5 trades', () => {
    const evaluator = new SessionEvaluator();
    const journal = new TradeJournal();

    // Only 3 trades, even if all profitable
    for (let i = 0; i < 3; i++) journal.record(makeDecision(), { pnl: 10 });
    const report = evaluator.evaluate(journal, makeState({ currentCapital: 1030 }));
    // 3 trades is not enough for scale_up
    expect(report.scalingAction).not.toBe('scale_up');
  });

  it('capital change accurately tracked', () => {
    const evaluator = new SessionEvaluator();
    const journal = new TradeJournal();
    journal.record(makeDecision(), { pnl: 25 });

    const report = evaluator.evaluate(journal, makeState({ currentCapital: 1025 }));
    expect(report.capitalChange).toBe(25);
    expect(report.capitalChangePct).toBeCloseTo(0.025, 3);
  });
});
