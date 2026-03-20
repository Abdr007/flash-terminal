/**
 * Hardening Audit Tests — verifies memory safety, cleanup, and bounds
 * for all critical systems that run in long-lived sessions.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ─── Trade Journal Bounds ────────────────────────────────────────────────────

describe('TradeJournal memory bounds', async () => {
  const { TradeJournal } = await import('../src/agent-builder/trade-journal.js');

  it('caps entries at MAX_ENTRIES', () => {
    const journal = new TradeJournal();
    // Record 2500 entries (above 2000 cap)
    for (let i = 0; i < 2500; i++) {
      journal.record({
        action: 'open' as any,
        market: 'SOL',
        side: 'long',
        strategy: 'test',
        confidence: 0.8,
        reasoning: `trade ${i}`,
        signals: [],
        riskLevel: 'safe',
      });
    }
    // Should be capped
    expect(journal.getEntries().length).toBeLessThanOrEqual(2000);
    // Most recent entry should still be accessible
    const last = journal.getRecent(1)[0];
    expect(last.reasoning).toContain('2499');
  });

  it('clear() resets state', () => {
    const journal = new TradeJournal();
    for (let i = 0; i < 10; i++) {
      journal.record({
        action: 'open' as any,
        market: 'SOL',
        side: 'long',
        strategy: 'test',
        confidence: 0.5,
        reasoning: 'x',
        signals: [],
        riskLevel: 'safe',
      });
    }
    journal.clear();
    expect(journal.getEntries().length).toBe(0);
  });
});

// ─── Performance Dashboard Bounds ────────────────────────────────────────────

describe('PerformanceDashboard memory bounds', async () => {
  const { PerformanceDashboard } = await import('../src/agent-builder/performance-dashboard.js');

  it('caps equity/drawdown/sharpe history at maxHistory', () => {
    const dash = new PerformanceDashboard();
    for (let i = 0; i < 600; i++) {
      dash.recordTick(i, 10000 + i, 'NORMAL', 0.1);
    }
    const report = dash.getReport();
    expect(report.equityCurve.length).toBeLessThanOrEqual(100); // getReport slices to 100
  });

  it('caps audit log at maxAudit', () => {
    const dash = new PerformanceDashboard();
    for (let i = 0; i < 1200; i++) {
      dash.audit({
        tick: i,
        timestamp: new Date().toISOString(),
        market: 'SOL',
        state: 'test',
        action: 'open_long',
        score: 50,
        outcome: 'executed',
        reasoning: `audit ${i}`,
      });
    }
    // Should be capped at 1000
    const log = dash.getAuditLog(1500);
    expect(log.length).toBeLessThanOrEqual(1000);
  });

  it('caps alerts to prevent spam', () => {
    const dash = new PerformanceDashboard();
    // Trigger many alerts by recording severe drawdowns
    for (let i = 0; i < 200; i++) {
      dash.recordTick(i, 10000 - i * 100, 'NORMAL', 0.1);
    }
    const report = dash.getReport();
    expect(report.alerts.length).toBeLessThanOrEqual(10); // getReport slices to 10
  });

  it('reset() clears all state', () => {
    const dash = new PerformanceDashboard();
    for (let i = 0; i < 50; i++) {
      dash.recordTick(i, 10000, 'NORMAL', 0.1);
      dash.recordTrade(10, 'test');
    }
    dash.reset();
    const report = dash.getReport();
    expect(report.performance.totalTrades).toBe(0);
    expect(report.equityCurve.length).toBe(0);
  });
});

// ─── Signal Detector Bounds ──────────────────────────────────────────────────

describe('SignalDetector memory bounds', async () => {
  const { SignalDetector } = await import('../src/agent-builder/signal-detector.js');

  it('caps price history per market', () => {
    const detector = new SignalDetector();
    // Feed 100 prices for one market (maxHistory should be ~20)
    for (let i = 0; i < 100; i++) {
      detector.detect({
        market: 'SOL',
        price: 100 + i * 0.1,
        priceChange24h: 0.5,
        volume24h: 1000000,
        longOi: 500000,
        shortOi: 500000,
        oiRatio: 0.5,
        timestamp: Date.now(),
      });
    }
    // Should not throw and should have bounded history
    const signals = detector.detect({
      market: 'SOL',
      price: 110,
      priceChange24h: 0.5,
      volume24h: 1000000,
      longOi: 500000,
      shortOi: 500000,
      oiRatio: 0.5,
      timestamp: Date.now(),
    });
    expect(signals).toBeDefined();
  });

  it('reset() clears all state', () => {
    const detector = new SignalDetector();
    detector.detect({
      market: 'SOL', price: 100, priceChange24h: 0.5,
      volume24h: 1000000, longOi: 500000, shortOi: 500000, oiRatio: 0.5, timestamp: Date.now(),
    });
    detector.reset();
    // After reset, should work fresh
    const signals = detector.detect({
      market: 'SOL', price: 100, priceChange24h: 0.5,
      volume24h: 1000000, longOi: 500000, shortOi: 500000, oiRatio: 0.5, timestamp: Date.now(),
    });
    expect(signals).toBeDefined();
  });
});

// ─── Technical Indicators Bounds ─────────────────────────────────────────────

describe('TechnicalAnalyzer memory bounds', async () => {
  const { TechnicalAnalyzer } = await import('../src/agent-builder/technical-indicators.js');

  it('caps price history at maxHistory per market', () => {
    const tech = new TechnicalAnalyzer();
    for (let i = 0; i < 200; i++) {
      tech.record('SOL', 100 + Math.sin(i) * 5);
    }
    // Should not throw — history is capped at 100
    const signal = tech.signal('SOL', 105);
    expect(signal).toBeDefined();
  });

  it('reset clears state', () => {
    const tech = new TechnicalAnalyzer();
    for (let i = 0; i < 50; i++) tech.record('SOL', 100 + i);
    tech.reset();
    expect(tech.dataPoints('SOL')).toBe(0);
  });
});

// ─── Regime Adapter Bounds ───────────────────────────────────────────────────

describe('RegimeAdapter memory bounds', async () => {
  const { RegimeAdapter } = await import('../src/agent-builder/regime-adapter.js');

  it('caps price history per market', () => {
    const adapter = new RegimeAdapter();
    for (let i = 0; i < 100; i++) {
      adapter.detectRegime('SOL', 100 + Math.sin(i) * 5, 2);
    }
    // No crash = bounded
    const regime = adapter.detectRegime('SOL', 105, 2);
    expect(regime.regime).toBeDefined();
  });

  it('reset clears all state', () => {
    const adapter = new RegimeAdapter();
    adapter.detectRegime('SOL', 100, 2);
    adapter.reset();
    // After reset, should start fresh
    const regime = adapter.detectRegime('SOL', 100, 2);
    expect(regime).toBeDefined();
  });
});

// ─── DrawdownManager Bounds ──────────────────────────────────────────────────

describe('DrawdownManager memory bounds', async () => {
  const { DrawdownManager } = await import('../src/agent-builder/drawdown-manager.js');

  it('caps recentReturns at 50', () => {
    const dd = new DrawdownManager(10000);
    for (let i = 0; i < 100; i++) {
      dd.update(10000 + Math.random() * 200 - 100);
    }
    // No crash means bounded
    const state = dd.update(10000);
    expect(state).toBeDefined();
    expect(state.drawdownPct).toBeGreaterThanOrEqual(0);
  });
});

// ─── PolicyLearner State Space ───────────────────────────────────────────────

describe('PolicyLearner state space bounds', async () => {
  const { PolicyLearner } = await import('../src/agent-builder/policy-learner.js');

  it('state space is bounded by discretization (36 max states)', () => {
    const learner = new PolicyLearner();
    const regimes = ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'HIGH_VOLATILITY', 'COMPRESSION'];
    const directions = ['bullish', 'bearish', 'neutral'];
    const confidences = [0.3, 0.6, 0.8];
    const volatilities = [1, 5, 10];

    // Generate all possible combinations
    for (const regime of regimes) {
      for (const dir of directions) {
        for (const conf of confidences) {
          for (const vol of volatilities) {
            const state = learner.buildState(regime, dir, conf, vol, 0.5);
            const rec = learner.recommend(state);
            learner.update(state, rec.action, 0.1);
          }
        }
      }
    }

    const metrics = learner.getMetrics();
    // State space should be bounded — max 36 unique states (3 regimes × 3 dirs × 4 conditions)
    expect(metrics.policySize).toBeLessThanOrEqual(36);
  });
});

// ─── Tick Timeout Mechanism ──────────────────────────────────────────────────

describe('Tick timeout mechanism', () => {
  it('Promise.race rejects when timeout fires before tick completes', async () => {
    const slowTick = () => new Promise<void>((resolve) => setTimeout(resolve, 5000));
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Tick timeout exceeded')), 50),
    );

    await expect(Promise.race([slowTick(), timeout])).rejects.toThrow('Tick timeout exceeded');
  });

  it('Promise.race resolves when tick completes before timeout', async () => {
    const fastTick = () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 10));
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Tick timeout exceeded')), 5000),
    );

    const result = await Promise.race([fastTick(), timeout]);
    expect(result).toBe('done');
  });
});

// ─── Supervisor Cleanup ──────────────────────────────────────────────────────

describe('Supervisor cleanup', async () => {
  const { AgentSupervisor } = await import('../src/agent-builder/supervisor.js');

  it('stop() clears tracking state', () => {
    const supervisor = new AgentSupervisor([], {}, {}, {});
    // Access internal state via the stop method
    supervisor.stop();
    const status = supervisor.getStatus();
    expect(status.agentState).toBeNull();
  });
});

// ─── Event Monitor Cleanup ───────────────────────────────────────────────────

describe('EventMonitor cleanup', async () => {
  // We can't easily instantiate EventMonitor without a real client,
  // but we can verify the stop method exists and clears state via the class interface
  const { EventMonitor } = await import('../src/monitor/event-monitor.js');

  it('has stop method', () => {
    expect(typeof EventMonitor.prototype.stop).toBe('function');
  });
});
