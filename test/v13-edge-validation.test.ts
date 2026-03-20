/**
 * V13 Edge Validation Tests — proves the analyzer correctly identifies
 * profitable vs unprofitable trading patterns.
 */
import { describe, it, expect } from 'vitest';

import type { JournalEntry, DecisionAction } from '../src/agent-builder/types.js';

// ─── Helper: Generate realistic trade data ───────────────────────────────────

function makeTrade(overrides: Partial<JournalEntry> & { pnl: number }): JournalEntry {
  const pnl = overrides.pnl;
  return {
    id: Math.floor(Math.random() * 10000),
    timestamp: new Date().toISOString(),
    action: 'close' as DecisionAction,
    market: overrides.market ?? 'SOL',
    side: overrides.side ?? 'long',
    leverage: overrides.leverage ?? 3,
    collateral: overrides.collateral ?? 100,
    entryPrice: overrides.entryPrice ?? 100,
    exitPrice: overrides.exitPrice ?? (100 + pnl / 3),
    pnl,
    pnlPercent: overrides.pnlPercent ?? (pnl / 100) * 100,
    strategy: overrides.strategy ?? 'momentum',
    confidence: overrides.confidence ?? 0.65,
    signals: [],
    reasoning: overrides.reasoning ?? 'SCORE=65 | NORMAL | RANGING',
    outcome: pnl > 0.01 ? 'win' : pnl < -0.01 ? 'loss' : 'breakeven',
    durationMs: overrides.durationMs ?? 30000,
  };
}

function generateProfitableTrades(n: number): JournalEntry[] {
  const trades: JournalEntry[] = [];
  for (let i = 0; i < n; i++) {
    const isWin = Math.random() > 0.42; // 58% win rate
    const pnl = isWin
      ? 3 + Math.random() * 15   // Avg win ~$10
      : -(2 + Math.random() * 8); // Avg loss ~$6
    trades.push(makeTrade({
      pnl,
      strategy: ['momentum', 'mean_reversion', 'breakout'][i % 3],
      reasoning: `SCORE=${55 + Math.floor(Math.random() * 30)} | NORMAL | ${['TRENDING_UP', 'RANGING', 'COMPRESSION'][i % 3]}`,
      durationMs: (5 + Math.random() * 30) * 10_000,
    }));
  }
  return trades;
}

function generateUnprofitableTrades(n: number): JournalEntry[] {
  const trades: JournalEntry[] = [];
  for (let i = 0; i < n; i++) {
    const isWin = Math.random() > 0.62; // 38% win rate
    const pnl = isWin
      ? 2 + Math.random() * 5    // Avg win ~$4.5
      : -(5 + Math.random() * 15); // Avg loss ~$12.5
    trades.push(makeTrade({
      pnl,
      strategy: ['bad_strat', 'also_bad'][i % 2],
      reasoning: `SCORE=${40 + Math.floor(Math.random() * 20)} | NORMAL | RANGING`,
    }));
  }
  return trades;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('EdgeAnalyzer', async () => {
  const { EdgeAnalyzer } = await import('../src/agent-builder/edge-analyzer.js');
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');

  it('detects positive edge in profitable system', () => {
    const analyzer = new EdgeAnalyzer();
    const trades = generateProfitableTrades(150);
    const journal = new TradeJournal();
    for (const t of trades) {
      journal.record(
        { action: t.action, market: t.market, side: t.side, leverage: t.leverage, collateral: t.collateral, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: t.signals, riskLevel: 'safe' },
        { pnl: t.pnl!, exitPrice: t.exitPrice, pnlPercent: t.pnlPercent },
      );
    }

    const stats = journal.getStats();
    const report = analyzer.analyze(journal.getEntries(), stats);

    expect(report.sufficientData).toBe(true);
    expect(report.tradeCount).toBe(150);
    expect(report.ev).toBeGreaterThan(0);
    expect(report.winRate).toBeGreaterThan(0.45);
    expect(report.verdict.hasEdge).toBe(true);
    expect(report.verdict.confidence).toBeGreaterThan(0.5);
  });

  it('detects NO edge in unprofitable system', () => {
    const analyzer = new EdgeAnalyzer();
    const trades = generateUnprofitableTrades(150);
    const journal = new TradeJournal();
    for (const t of trades) {
      journal.record(
        { action: t.action, market: t.market, side: t.side, leverage: t.leverage, collateral: t.collateral, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: t.signals, riskLevel: 'safe' },
        { pnl: t.pnl!, exitPrice: t.exitPrice, pnlPercent: t.pnlPercent },
      );
    }

    const stats = journal.getStats();
    const report = analyzer.analyze(journal.getEntries(), stats);

    expect(report.sufficientData).toBe(true);
    expect(report.ev).toBeLessThan(0);
    expect(report.verdict.hasEdge).toBe(false);
    expect(report.verdict.actions.length).toBeGreaterThan(0);
  });

  it('reports insufficient data below 100 trades', () => {
    const analyzer = new EdgeAnalyzer();
    const trades = generateProfitableTrades(50);
    const journal = new TradeJournal();
    for (const t of trades) {
      journal.record(
        { action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: t.signals, riskLevel: 'safe' },
        { pnl: t.pnl!, exitPrice: t.exitPrice },
      );
    }

    const report = analyzer.analyze(journal.getEntries(), journal.getStats());
    expect(report.sufficientData).toBe(false);
    expect(report.verdict.hasEdge).toBe(false);
    expect(report.verdict.reasons[0]).toContain('Insufficient');
  });
});

// ─── Exit Efficiency Analysis ────────────────────────────────────────────────

describe('Exit efficiency analysis', async () => {
  const { EdgeAnalyzer } = await import('../src/agent-builder/edge-analyzer.js');
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');

  it('detects early exits (small wins)', () => {
    const analyzer = new EdgeAnalyzer();
    const journal = new TradeJournal();

    // Many small wins (early exits) + some losses
    for (let i = 0; i < 100; i++) {
      const isWin = i % 3 !== 0;
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'test', confidence: 0.6, reasoning: 'test', signals: [], riskLevel: 'safe' },
        { pnl: isWin ? 0.5 : -5, pnlPercent: isWin ? 0.5 : -5, exitPrice: 100 },
      );
    }

    const report = analyzer.analyze(journal.getEntries(), journal.getStats());
    expect(report.exitEfficiency.earlyExitCount).toBeGreaterThan(0);
    expect(report.exitEfficiency.earlyExitPct).toBeGreaterThan(0.5); // Most wins are early
  });

  it('detects late exits (big losses)', () => {
    const analyzer = new EdgeAnalyzer();
    const journal = new TradeJournal();

    for (let i = 0; i < 100; i++) {
      const isWin = i % 2 === 0;
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'test', confidence: 0.6, reasoning: 'test', signals: [], riskLevel: 'safe' },
        { pnl: isWin ? 10 : -20, pnlPercent: isWin ? 5 : -10, exitPrice: 100 },
      );
    }

    const report = analyzer.analyze(journal.getEntries(), journal.getStats());
    expect(report.exitEfficiency.lateExitCount).toBeGreaterThan(0);
  });
});

// ─── Regime Breakdown ────────────────────────────────────────────────────────

describe('Regime performance breakdown', async () => {
  const { EdgeAnalyzer } = await import('../src/agent-builder/edge-analyzer.js');
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');

  it('segments trades by regime from reasoning field', () => {
    const analyzer = new EdgeAnalyzer();
    const journal = new TradeJournal();

    // Trending trades (profitable)
    for (let i = 0; i < 50; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'momentum', confidence: 0.7, reasoning: 'SCORE=70 | NORMAL | TRENDING_UP', signals: [], riskLevel: 'safe' },
        { pnl: 5 + Math.random() * 10, exitPrice: 100 },
      );
    }
    // Ranging trades (unprofitable)
    for (let i = 0; i < 50; i++) {
      journal.record(
        { action: 'close' as any, market: 'ETH', side: 'short', strategy: 'mean_reversion', confidence: 0.5, reasoning: 'SCORE=55 | NORMAL | RANGING', signals: [], riskLevel: 'safe' },
        { pnl: -2 - Math.random() * 8, exitPrice: 3000 },
      );
    }

    const report = analyzer.analyze(journal.getEntries(), journal.getStats());
    const trending = report.regimeBreakdown.regimes.find((r) => r.regime === 'TRENDING_UP');
    const ranging = report.regimeBreakdown.regimes.find((r) => r.regime === 'RANGING');

    expect(trending).toBeDefined();
    expect(trending!.profitable).toBe(true);
    expect(trending!.ev).toBeGreaterThan(0);

    expect(ranging).toBeDefined();
    expect(ranging!.profitable).toBe(false);
    expect(ranging!.ev).toBeLessThan(0);
  });
});

// ─── Strategy Contribution ───────────────────────────────────────────────────

describe('Strategy contribution analysis', async () => {
  const { EdgeAnalyzer } = await import('../src/agent-builder/edge-analyzer.js');
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');

  it('identifies profitable and unprofitable strategies', () => {
    const analyzer = new EdgeAnalyzer();
    const journal = new TradeJournal();

    // Profitable strategy
    for (let i = 0; i < 30; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'good_strat', confidence: 0.7, reasoning: 'test', signals: [], riskLevel: 'safe' },
        { pnl: 3 + Math.random() * 10, exitPrice: 100 },
      );
    }
    // Unprofitable strategy
    for (let i = 0; i < 30; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'short', strategy: 'bad_strat', confidence: 0.4, reasoning: 'test', signals: [], riskLevel: 'safe' },
        { pnl: -5 - Math.random() * 10, exitPrice: 100 },
      );
    }

    const report = analyzer.analyze(journal.getEntries(), journal.getStats());
    const good = report.strategyContribution.strategies.find((s) => s.name === 'good_strat');
    const bad = report.strategyContribution.strategies.find((s) => s.name === 'bad_strat');

    expect(good).toBeDefined();
    expect(good!.ev).toBeGreaterThan(0);
    expect(good!.shouldDisable).toBe(false);

    expect(bad).toBeDefined();
    expect(bad!.ev).toBeLessThan(0);
    expect(bad!.shouldDisable).toBe(true);
    expect(bad!.reason).toContain('Negative EV');
  });
});

// ─── Learning Stability ──────────────────────────────────────────────────────

describe('Learning stability analysis', async () => {
  const { EdgeAnalyzer } = await import('../src/agent-builder/edge-analyzer.js');
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');

  it('detects converging policy', () => {
    const analyzer = new EdgeAnalyzer();
    const trades = generateProfitableTrades(100);
    const journal = new TradeJournal();
    for (const t of trades) {
      journal.record(
        { action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: t.signals, riskLevel: 'safe' },
        { pnl: t.pnl!, exitPrice: t.exitPrice },
      );
    }

    const report = analyzer.analyze(journal.getEntries(), journal.getStats(), {
      sharpe: 0.8, explorationRate: 0.03, policySize: 25, degrading: false,
    });

    expect(report.learningStability.converging).toBe(true);
    expect(report.learningStability.oscillating).toBe(false);
  });

  it('detects degrading policy', () => {
    const analyzer = new EdgeAnalyzer();
    const trades = generateProfitableTrades(100);
    const journal = new TradeJournal();
    for (const t of trades) {
      journal.record(
        { action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: t.signals, riskLevel: 'safe' },
        { pnl: t.pnl!, exitPrice: t.exitPrice },
      );
    }

    const report = analyzer.analyze(journal.getEntries(), journal.getStats(), {
      sharpe: -0.2, explorationRate: 0.08, policySize: 5, degrading: true,
    });

    expect(report.learningStability.oscillating).toBe(true);
  });
});

// ─── Report Formatting ──────────────────────────────────────────────────────

describe('Report formatting', async () => {
  const { EdgeAnalyzer } = await import('../src/agent-builder/edge-analyzer.js');
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');

  it('produces readable text report', () => {
    const analyzer = new EdgeAnalyzer();
    const trades = generateProfitableTrades(120);
    const journal = new TradeJournal();
    for (const t of trades) {
      journal.record(
        { action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: t.signals, riskLevel: 'safe' },
        { pnl: t.pnl!, exitPrice: t.exitPrice },
      );
    }

    const report = analyzer.analyze(journal.getEntries(), journal.getStats());
    const text = analyzer.formatReport(report);

    expect(text).toContain('EDGE VALIDATION REPORT');
    expect(text).toContain('Core Edge');
    expect(text).toContain('Exit Efficiency');
    expect(text).toContain('Regime Performance');
    expect(text).toContain('Strategy Contribution');
    expect(text).toContain('Learning Stability');
    expect(text).toContain('VERDICT');
    expect(text.length).toBeGreaterThan(500);
  });

  it('verdict includes actionable recommendations', () => {
    const analyzer = new EdgeAnalyzer();
    const trades = generateUnprofitableTrades(120);
    const journal = new TradeJournal();
    for (const t of trades) {
      journal.record(
        { action: t.action, market: t.market, side: t.side, strategy: t.strategy, confidence: t.confidence, reasoning: t.reasoning, signals: t.signals, riskLevel: 'safe' },
        { pnl: t.pnl!, exitPrice: t.exitPrice },
      );
    }

    const report = analyzer.analyze(journal.getEntries(), journal.getStats());
    expect(report.verdict.hasEdge).toBe(false);
    expect(report.verdict.actions.length).toBeGreaterThan(0);
    // Actions should be specific and actionable
    const allActions = report.verdict.actions.join(' ');
    expect(allActions.length).toBeGreaterThan(20);
  });

  it('handles empty journal gracefully', () => {
    const analyzer = new EdgeAnalyzer();
    const journal = new TradeJournal();
    const report = analyzer.analyze(journal.getEntries(), journal.getStats());

    expect(report.tradeCount).toBe(0);
    expect(report.sufficientData).toBe(false);
    expect(report.ev).toBe(0);
    expect(report.verdict.hasEdge).toBe(false);
    // Should not throw
    const text = analyzer.formatReport(report);
    expect(text).toContain('INSUFFICIENT DATA');
  });
});
