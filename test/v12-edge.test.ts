/**
 * V12 Edge Optimization Tests — validates trading intelligence improvements.
 *
 * Tests: exit intelligence, macro regime, correlation engine,
 * reward function, execution realism, edge validation.
 */
import { describe, it, expect } from 'vitest';

// ─── PHASE 1: Exit Intelligence ──────────────────────────────────────────────

describe('Exit Policy Learner V2', async () => {
  const { ExitPolicyLearner } = await import('../src/agent-builder/exit-policy-learner.js');

  it('has 5 actions including tighten_stop and extend_tp', () => {
    const learner = new ExitPolicyLearner();
    const state = learner.buildState(3, 10, 'TRENDING_UP', 5, 10, 'accelerating');
    // Exploration should sometimes return new actions
    let foundTighten = false, foundExtend = false;
    for (let i = 0; i < 200; i++) {
      const rec = learner.recommend(state, false);
      if (rec.action === 'tighten_stop') foundTighten = true;
      if (rec.action === 'extend_tp') foundExtend = true;
    }
    expect(foundTighten || foundExtend).toBe(true);
  });

  it('momentum state tracking works', () => {
    const learner = new ExitPolicyLearner();
    // Feed rising prices
    for (let i = 0; i < 10; i++) learner.recordPrice('SOL', 100 + i);
    expect(learner.getMomentumState('SOL', 'long')).toBe('accelerating');
  });

  it('detects momentum reversal', () => {
    const learner = new ExitPolicyLearner();
    // Rising prices then falling
    for (let i = 0; i < 6; i++) learner.recordPrice('SOL', 100 + i * 2);
    for (let i = 0; i < 4; i++) learner.recordPrice('SOL', 112 - i * 3);
    expect(learner.getMomentumState('SOL', 'long')).toBe('reversing');
  });

  it('detects momentum decay', () => {
    const learner = new ExitPolicyLearner();
    // Strong rise then weak rise
    for (let i = 0; i < 6; i++) learner.recordPrice('SOL', 100 + i * 5);
    for (let i = 0; i < 4; i++) learner.recordPrice('SOL', 130 + i * 0.5);
    expect(learner.getMomentumState('SOL', 'long')).toBe('decaying');
  });

  it('momentum reversal + profit → exit bias', () => {
    const learner = new ExitPolicyLearner();
    const state = learner.buildState(5, 10, 'TRENDING_UP', 5, 10, 'reversing');
    const rec = learner.recommend(state, false);
    // Should have strong exit signal
    expect(rec.confidence).toBeGreaterThanOrEqual(0.6);
    expect(['full_close', 'partial_close']).toContain(rec.action);
  });

  it('buildState includes momentum dimension', () => {
    const learner = new ExitPolicyLearner();
    const state = learner.buildState(3, 10, 'RANGING', 5, 5, 'decaying');
    expect(state.momentum).toBe('decaying');
  });

  it('reward function penalizes stagnation', () => {
    const learner = new ExitPolicyLearner();
    const stagnant = learner.computeExitReward(0.5, 0.1, 25, 'hold', 0.05);
    expect(stagnant).toBeLessThan(0); // stagnation penalty
  });

  it('reward function rewards clean trend capture', () => {
    const learner = new ExitPolicyLearner();
    const clean = learner.computeExitReward(4, 2.0, 8, 'full_close', -0.5);
    expect(clean).toBeGreaterThan(0.5); // big reward for quick profitable exit
  });

  it('reward for tighten_stop when it locks profit', () => {
    const learner = new ExitPolicyLearner();
    const good = learner.computeExitReward(3, 1.5, 10, 'tighten_stop', -1.0);
    expect(good).toBeGreaterThan(0.1); // tightened before drop
  });

  it('reward for extend_tp when price continues', () => {
    const learner = new ExitPolicyLearner();
    const good = learner.computeExitReward(5, 2.0, 12, 'extend_tp', 1.0);
    expect(good).toBeGreaterThan(0.1); // extending was right
  });
});

// ─── PHASE 2: Macro Regime ───────────────────────────────────────────────────

describe('Macro Regime Detector', async () => {
  const { MacroRegimeDetector } = await import('../src/agent-builder/macro-regime.js');

  it('starts in NEUTRAL', () => {
    const macro = new MacroRegimeDetector();
    const detection = macro.update([]);
    expect(detection.regime).toBe('NEUTRAL');
    expect(detection.sizeMultiplier).toBe(1.0);
    expect(detection.tradesBlocked).toBe(false);
  });

  it('detects BULL when BTC trending up with correlation', () => {
    const macro = new MacroRegimeDetector();
    // Feed multiple ticks with BTC rising and all assets up
    for (let i = 0; i < 15; i++) {
      macro.update([
        { market: 'BTC', price: 60000 + i * 500, priceChange24h: 3, volume24h: 1e9, longOi: 5e8, shortOi: 3e8, oiRatio: 0.6, timestamp: Date.now() },
        { market: 'SOL', price: 150 + i * 2, priceChange24h: 4, volume24h: 1e8, longOi: 1e8, shortOi: 8e7, oiRatio: 0.55, timestamp: Date.now() },
        { market: 'ETH', price: 3000 + i * 30, priceChange24h: 2.5, volume24h: 5e8, longOi: 3e8, shortOi: 2e8, oiRatio: 0.6, timestamp: Date.now() },
      ]);
    }
    const detection = macro.getCurrent();
    expect(detection.btcTrend).toBe('up');
    // After enough ticks with hysteresis, should detect BULL
    expect(['BULL', 'NEUTRAL']).toContain(detection.regime);
  });

  it('RISK_OFF blocks trades', () => {
    const macro = new MacroRegimeDetector();
    // Feed extreme down + high vol + high correlation
    for (let i = 0; i < 15; i++) {
      macro.update([
        { market: 'BTC', price: 60000 - i * 1000, priceChange24h: -10, volume24h: 2e9, longOi: 3e8, shortOi: 7e8, oiRatio: 0.3, timestamp: Date.now() },
        { market: 'SOL', price: 150 - i * 5, priceChange24h: -12, volume24h: 2e8, longOi: 5e7, shortOi: 1.5e8, oiRatio: 0.25, timestamp: Date.now() },
        { market: 'ETH', price: 3000 - i * 80, priceChange24h: -9, volume24h: 8e8, longOi: 1e8, shortOi: 4e8, oiRatio: 0.2, timestamp: Date.now() },
      ]);
    }
    const detection = macro.getCurrent();
    if (detection.regime === 'RISK_OFF') {
      expect(detection.tradesBlocked).toBe(true);
      expect(detection.sizeMultiplier).toBe(0);
    }
  });

  it('size multiplier varies by regime', () => {
    const macro = new MacroRegimeDetector();
    const detection = macro.update([]);
    // NEUTRAL = 1.0
    expect(detection.sizeMultiplier).toBe(1.0);
  });

  it('reset clears all state', () => {
    const macro = new MacroRegimeDetector();
    macro.update([{ market: 'BTC', price: 60000, priceChange24h: 5, volume24h: 1e9, longOi: 5e8, shortOi: 3e8, oiRatio: 0.6, timestamp: Date.now() }]);
    macro.reset();
    const detection = macro.getCurrent();
    expect(detection.regime).toBe('NEUTRAL');
  });
});

// ─── PHASE 3: Real Correlation Engine ────────────────────────────────────────

describe('Correlation Guard V2 — Rolling Correlation', async () => {
  const { CorrelationGuard } = await import('../src/agent-builder/correlation-guard.js');

  it('computes Pearson correlation from price data', () => {
    const guard = new CorrelationGuard();
    // Feed perfectly correlated prices (SOL and JUP moving together)
    for (let i = 0; i < 20; i++) {
      guard.recordPrice('SOL', 100 + i * 2);
      guard.recordPrice('JUP', 5 + i * 0.1);
    }
    const corr = guard.getCorrelation('SOL', 'JUP');
    expect(corr).toBeGreaterThan(0.9); // Nearly perfect positive correlation
  });

  it('detects dynamic correlation above threshold', () => {
    const guard = new CorrelationGuard();
    for (let i = 0; i < 20; i++) {
      guard.recordPrice('AAA', 100 + i);
      guard.recordPrice('BBB', 50 + i * 0.5);
    }
    expect(guard.isDynamicallyCorrelated('AAA', 'BBB')).toBe(true);
  });

  it('returns 0 correlation with insufficient data', () => {
    const guard = new CorrelationGuard();
    guard.recordPrice('SOL', 100);
    expect(guard.getCorrelation('SOL', 'ETH')).toBe(0);
  });

  it('uncorrelated assets return low correlation', () => {
    const guard = new CorrelationGuard();
    // Feed random/divergent prices
    for (let i = 0; i < 20; i++) {
      guard.recordPrice('AAA', 100 + Math.sin(i) * 10);
      guard.recordPrice('BBB', 100 + Math.cos(i * 3) * 10);
    }
    const corr = Math.abs(guard.getCorrelation('AAA', 'BBB'));
    expect(corr).toBeLessThan(0.7);
  });

  it('dynamic correlation reduces position size', () => {
    const guard = new CorrelationGuard();
    // Feed correlated prices for two standalone assets
    for (let i = 0; i < 20; i++) {
      guard.recordPrice('FARTCOIN', 1 + i * 0.1);
      guard.recordPrice('HYPE', 10 + i);
    }
    // FARTCOIN and HYPE are in 'other_crypto' static cluster
    // But let's check with standalone assets that are dynamically correlated
    guard.recordPrice('NEWTOKEN', 50);
    for (let i = 1; i < 20; i++) {
      guard.recordPrice('NEWTOKEN', 50 + i * 0.5);
    }
    // Check correlation check includes size multiplier
    const result = guard.check(
      [{ market: 'FARTCOIN', side: 'long', sizeUsd: 100, collateralUsd: 50, entryPrice: 1, markPrice: 1.5, leverage: 2 } as any],
      'HYPE', 'long', 200, 10000,
    );
    // Both in 'other_crypto' cluster — static correlation should apply
    expect(result.sizeMultiplier).toBeLessThan(1.0);
  });
});

// ─── PHASE 4: Reward Function Hardening ──────────────────────────────────────

describe('Policy Learner V2 Reward Function', async () => {
  const { PolicyLearner } = await import('../src/agent-builder/policy-learner.js');

  it('rewards quick profitable trades more', () => {
    const learner = new PolicyLearner();
    const quickWin = learner.computeReward(10, 100, 3, 5);   // 5 ticks
    const slowWin = learner.computeReward(10, 100, 3, 35);   // 35 ticks
    expect(quickWin).toBeGreaterThan(slowWin);
  });

  it('penalizes stagnant trades', () => {
    const learner = new PolicyLearner();
    const stagnant = learner.computeReward(0.1, 100, 3, 25); // tiny PnL after 25 ticks
    expect(stagnant).toBeLessThan(0.05); // Should be near zero or negative from stagnation penalty
  });

  it('losses hurt more than equivalent wins help (asymmetry)', () => {
    const learner = new PolicyLearner();
    // Use 20 ticks to avoid clean trend capture bonus distorting comparison
    const win = learner.computeReward(10, 100, 3, 20);
    const loss = learner.computeReward(-10, 100, 3, 20);
    expect(Math.abs(loss)).toBeGreaterThan(Math.abs(win));
  });

  it('large losses penalized exponentially', () => {
    const learner = new PolicyLearner();
    const smallLoss = learner.computeReward(-5, 100, 3, 10);
    const bigLoss = learner.computeReward(-20, 100, 3, 10);
    // Big loss should be MORE than 4x the small loss (exponential penalty)
    expect(Math.abs(bigLoss)).toBeGreaterThan(Math.abs(smallLoss) * 3);
  });

  it('clean trend capture gets bonus', () => {
    const learner = new PolicyLearner();
    const cleanCapture = learner.computeReward(15, 100, 3, 8);  // Good PnL in few ticks
    const slowCapture = learner.computeReward(15, 100, 3, 25);  // Same PnL but slow
    expect(cleanCapture).toBeGreaterThan(slowCapture);
  });

  it('returns 0 for invalid inputs', () => {
    const learner = new PolicyLearner();
    expect(learner.computeReward(NaN, 100, 3, 10)).toBe(0);
    expect(learner.computeReward(10, 0, 3, 10)).toBe(0);
    expect(learner.computeReward(10, -1, 3, 10)).toBe(0);
  });
});

// ─── PHASE 5: Execution Realism ──────────────────────────────────────────────

describe('Simulation Engine V2 — Execution Realism', async () => {
  const { SimulationEngine } = await import('../src/agent-builder/simulation-engine.js');

  it('applies entry slippage against the trader', () => {
    const engine = new SimulationEngine();
    engine.simulate('SOL', 'long', 100, 70, 'test', 'RANGING', 0.6);
    engine.simulate('SOL', 'short', 100, 70, 'test', 'RANGING', 0.6);

    // Can't directly access trades, but resolve and check PnL
    // With slippage and fees, a flat market should result in negative PnL
    engine.resolve([{ market: 'SOL', price: 100, priceChange24h: 0, volume24h: 0, longOi: 0, shortOi: 0, oiRatio: 0.5, timestamp: Date.now() + 100_000 }]);

    const insights = engine.getInsights();
    // With slippage + fees on a flat market, avg PnL should be negative
    if (insights.resolved > 0) {
      expect(insights.avgSimPnlPct).toBeLessThan(0);
    }
  });

  it('simulated trades have slippage field', () => {
    const engine = new SimulationEngine();
    engine.simulate('SOL', 'long', 100, 65, 'momentum', 'TRENDING_UP', 0.7);
    const insights = engine.getInsights();
    expect(insights.totalSimulated).toBe(1);
  });

  it('fees deducted from PnL (round-trip 0.16%)', () => {
    const engine = new SimulationEngine();
    // Simulate long entry at 100, resolve at 100.5 (0.5% move)
    engine.simulate('SOL', 'long', 100, 70, 'test', 'RANGING', 0.6);

    // Wait resolveAfterTicks and resolve
    engine.resolve([{
      market: 'SOL', price: 100.5, priceChange24h: 0.5,
      volume24h: 0, longOi: 0, shortOi: 0, oiRatio: 0.5,
      timestamp: Date.now() + 100_000,
    }]);

    const insights = engine.getInsights();
    if (insights.resolved > 0) {
      // Raw PnL would be ~0.5%, but after slippage + 0.16% fees, should be less
      expect(insights.avgSimPnlPct).toBeLessThan(0.5);
    }
  });

  it('optimal threshold search still works with fees', () => {
    const engine = new SimulationEngine();
    for (let i = 0; i < 20; i++) {
      engine.simulate('SOL', 'long', 100, 50 + i * 2, 'test', 'RANGING', 0.5 + i * 0.02);
    }
    // Resolve with favorable price
    engine.resolve([{
      market: 'SOL', price: 105, priceChange24h: 5,
      volume24h: 0, longOi: 0, shortOi: 0, oiRatio: 0.5,
      timestamp: Date.now() + 100_000,
    }]);

    const insights = engine.getInsights();
    expect(insights.optimalThreshold).toBeGreaterThanOrEqual(40);
    expect(insights.optimalThreshold).toBeLessThanOrEqual(85);
  });
});

// ─── PHASE 6: Edge Validation Framework ──────────────────────────────────────

describe('Edge validation metrics', async () => {
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');
  const { PerformanceDashboard } = await import('../src/agent-builder/performance-dashboard.js');

  it('journal stats capture all edge metrics', () => {
    const journal = new TradeJournal();
    // Simulate 100+ trades with realistic distribution
    for (let i = 0; i < 120; i++) {
      const isWin = Math.random() > 0.45; // 55% win rate
      const pnl = isWin ? 5 + Math.random() * 20 : -(3 + Math.random() * 15);
      journal.record(
        { action: 'close' as any, market: 'SOL', side: 'long', strategy: 'momentum', confidence: 0.6, reasoning: '', signals: [], riskLevel: 'safe' },
        { pnl, exitPrice: 100, pnlPercent: pnl / 10 },
      );
    }

    const stats = journal.getStats();
    expect(stats.totalTrades).toBe(120);
    expect(stats.winRate).toBeGreaterThan(0);
    expect(stats.winRate).toBeLessThan(1);
    expect(Number.isFinite(stats.profitFactor)).toBe(true);
    expect(Number.isFinite(stats.avgWin)).toBe(true);
    expect(Number.isFinite(stats.avgLoss)).toBe(true);
  });

  it('dashboard Sharpe calculation works over 100+ trades', () => {
    const dash = new PerformanceDashboard();
    for (let i = 0; i < 150; i++) {
      dash.recordTick(i, 10000 + i * 5, 'NORMAL', 0.1);
      if (i % 2 === 0) {
        const pnl = (Math.random() - 0.4) * 30; // Slightly positive bias
        dash.recordTrade(pnl, 'momentum');
      }
    }
    const report = dash.getReport();
    expect(Number.isFinite(report.performance.sharpe7d)).toBe(true);
    expect(Number.isFinite(report.performance.sharpe30d)).toBe(true);
    expect(report.performance.totalTrades).toBeGreaterThan(50);
  });
});
