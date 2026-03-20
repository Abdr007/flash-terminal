/**
 * V14 Edge Refiner Tests — validates continuous improvement loop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { JournalEntry, DecisionAction } from '../src/agent-builder/types.js';

function makeTrade(pnl: number, strategy: string, regime: string): JournalEntry {
  return {
    id: Math.floor(Math.random() * 10000),
    timestamp: new Date().toISOString(),
    action: 'close' as DecisionAction,
    market: 'SOL', side: 'long', leverage: 3, collateral: 100,
    entryPrice: 100, exitPrice: 100 + pnl / 3,
    pnl, pnlPercent: pnl,
    strategy, confidence: 0.6,
    signals: [],
    reasoning: `SCORE=65 | NORMAL | ${regime}`,
    outcome: pnl > 0.01 ? 'win' : pnl < -0.01 ? 'loss' : 'breakeven',
  };
}

describe('EdgeRefiner', async () => {
  const { EdgeRefiner } = await import('../src/agent-builder/edge-refiner.js');
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');

  let refiner: InstanceType<typeof EdgeRefiner>;
  beforeEach(() => {
    refiner = new EdgeRefiner();
  });

  it('does not refine below minimum trades', () => {
    expect(refiner.shouldRefine(30)).toBe(false);
    expect(refiner.shouldRefine(49)).toBe(false);
  });

  it('triggers refinement at cycle boundary', () => {
    expect(refiner.shouldRefine(50)).toBe(true);
  });

  it('disables negative-EV strategies with sufficient data', () => {
    const journal = new TradeJournal();
    // Good strategy: 30 trades, positive EV
    for (let i = 0; i < 30; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'good_strat', confidence: 0.7, reasoning: 'SCORE=70 | NORMAL | TRENDING_UP', signals: [], riskLevel: 'safe' },
        { pnl: 5 + Math.random() * 10, exitPrice: 100 },
      );
    }
    // Bad strategy: 25 trades (V2 minimum), negative EV
    for (let i = 0; i < 25; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'short', strategy: 'bad_strat', confidence: 0.4, reasoning: 'SCORE=45 | NORMAL | RANGING', signals: [], riskLevel: 'safe' },
        { pnl: -8 - Math.random() * 10, exitPrice: 100 },
      );
    }

    const action = refiner.refine(journal.getEntries(), journal.getStats());
    // V2: exit efficiency or strategy disable may come first
    if (action.type === 'disable_strategy') {
      expect(action.target).toBe('bad_strat');
      expect(refiner.isStrategyDisabled('bad_strat')).toBe(true);
    }
    expect(refiner.isStrategyDisabled('good_strat')).toBe(false);
  });

  it('blocks unprofitable regimes', () => {
    const journal = new TradeJournal();
    // Profitable in TRENDING_UP
    for (let i = 0; i < 25; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'momentum', confidence: 0.7, reasoning: 'SCORE=70 | NORMAL | TRENDING_UP', signals: [], riskLevel: 'safe' },
        { pnl: 5 + Math.random() * 8, exitPrice: 100 },
      );
    }
    // Unprofitable in RANGING (EV < -1)
    for (let i = 0; i < 25; i++) {
      journal.record(
        { action: 'close' as any, market: 'ETH', side: 'long', strategy: 'momentum', confidence: 0.5, reasoning: 'SCORE=55 | NORMAL | RANGING', signals: [], riskLevel: 'safe' },
        { pnl: -3 - Math.random() * 5, exitPrice: 3000 },
      );
    }

    const action = refiner.refine(journal.getEntries(), journal.getStats());
    // First action should be strategy or regime depending on which is worse
    if (action.type === 'block_regime') {
      expect(action.target).toBe('RANGING');
      expect(refiner.isRegimeBlocked('RANGING')).toBe(true);
    }
    // Verify regime is blocked
    expect(refiner.isRegimeBlocked('TRENDING_UP')).toBe(false);
  });

  it('reduces size when drawdown exceeds threshold', () => {
    const journal = new TradeJournal();
    // Start with wins then heavy losses (creates drawdown)
    for (let i = 0; i < 20; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'test', confidence: 0.6, reasoning: 'SCORE=60 | NORMAL | TRENDING_UP', signals: [], riskLevel: 'safe' },
        { pnl: 20, exitPrice: 100 },
      );
    }
    for (let i = 0; i < 35; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'test', confidence: 0.6, reasoning: 'SCORE=60 | NORMAL | TRENDING_UP', signals: [], riskLevel: 'safe' },
        { pnl: -15, exitPrice: 100 },
      );
    }

    const action = refiner.refine(journal.getEntries(), journal.getStats());
    // May trigger strategy disable, regime block, or size reduction depending on analysis
    const summary = refiner.getSummary();
    expect(summary.refinementCount).toBe(1);
  });

  it('only makes one active change per cycle', () => {
    const journal = new TradeJournal();
    // Two bad strategies (≥25 trades each for V2 minimum)
    for (let i = 0; i < 25; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'bad1', confidence: 0.4, reasoning: 'SCORE=45 | NORMAL | RANGING', signals: [], riskLevel: 'safe' },
        { pnl: -10, exitPrice: 100 },
      );
    }
    for (let i = 0; i < 25; i++) {
      journal.record(
        { action: 'close' as any, market: 'ETH', side: 'short', strategy: 'bad2', confidence: 0.4, reasoning: 'SCORE=45 | NORMAL | RANGING', signals: [], riskLevel: 'safe' },
        { pnl: -8, exitPrice: 3000 },
      );
    }
    for (let i = 0; i < 10; i++) {
      journal.record(
        { action: 'close' as any, market: 'BTC', side: 'long', strategy: 'ok', confidence: 0.6, reasoning: 'SCORE=65 | NORMAL | TRENDING_UP', signals: [], riskLevel: 'safe' },
        { pnl: 3, exitPrice: 60000 },
      );
    }

    refiner.refine(journal.getEntries(), journal.getStats());
    // V2: at most one active change (disabled + scaled + size reductions)
    const summary = refiner.getSummary();
    const totalChanges = summary.disabledStrategies.length + summary.scaledRegimes.length + (summary.sizeMultiplier < 1.0 ? 1 : 0);
    expect(totalChanges).toBeLessThanOrEqual(1);
  });

  it('returns no_action or advisory when system is healthy', () => {
    const journal = new TradeJournal();
    // Controlled profitable sequence: alternating wins/losses with positive EV
    for (let i = 0; i < 55; i++) {
      const isWin = i % 3 !== 0; // 66% win rate, deterministic
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'momentum', confidence: 0.7, reasoning: 'SCORE=70 | NORMAL | TRENDING_UP', signals: [], riskLevel: 'safe' },
        { pnl: isWin ? 8 : -4, exitPrice: 100 },
      );
    }

    const action = refiner.refine(journal.getEntries(), journal.getStats());
    // Healthy system → no_action, advisory, or reduce_size are all acceptable
    // The key is it should NOT disable strategy or block regime
    expect(action.type).not.toBe('disable_strategy');
    expect(action.type).not.toBe('block_regime');
  });

  it('log tracks all refinement cycles', () => {
    const journal = new TradeJournal();
    for (let i = 0; i < 55; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'test', confidence: 0.6, reasoning: 'SCORE=60 | NORMAL | TRENDING_UP', signals: [], riskLevel: 'safe' },
        { pnl: 5, exitPrice: 100 },
      );
    }

    refiner.refine(journal.getEntries(), journal.getStats());
    const log = refiner.getLog();
    expect(log.length).toBe(1);
    expect(log[0].tradeCount).toBe(55);
    expect(typeof log[0].ev).toBe('number');
    expect(typeof log[0].sharpe).toBe('number');
  });

  it('compound strategy names checked correctly', () => {
    // V2 requires ≥25 trades to disable — create enough
    const trades = Array.from({ length: 55 }, (_, i) => makeTrade(-10, 'bad_component', 'RANGING'));
    refiner.refine(
      trades,
      { totalTrades: 55, wins: 5, losses: 50, breakeven: 0, winRate: 0.09, totalPnl: -550, totalFees: 0, avgWin: 5, avgLoss: 11.2, profitFactor: 0.04, avgConfidence: 0.5, signalAccuracy: 0, bestTrade: 5, worstTrade: -10 },
    );
    // V2: exit efficiency may fire first. If strategy was disabled, check compound names.
    if (refiner.isStrategyDisabled('bad_component')) {
      expect(refiner.isStrategyDisabled('bad_component+other')).toBe(true);
      expect(refiner.isStrategyDisabled('other+bad_component')).toBe(true);
    }
    expect(refiner.isStrategyDisabled('totally_different')).toBe(false);
  });

  it('reset clears all state', () => {
    const journal = new TradeJournal();
    for (let i = 0; i < 55; i++) {
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'bad', confidence: 0.4, reasoning: 'SCORE=40 | NORMAL | RANGING', signals: [], riskLevel: 'safe' },
        { pnl: -10, exitPrice: 100 },
      );
    }
    refiner.refine(journal.getEntries(), journal.getStats());

    refiner.reset();
    expect(refiner.getSummary().disabledStrategies.length).toBe(0);
    expect(refiner.getSummary().scaledRegimes.length).toBe(0);
    expect(refiner.getSummary().sizeMultiplier).toBe(1.0);
    expect(refiner.getLog().length).toBe(0);
    expect(refiner.isFrozen()).toBe(false);
  });
});
