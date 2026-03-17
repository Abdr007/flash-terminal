/**
 * Agent Builder Test Suite
 *
 * Tests all components: RiskManager, SignalDetector, Strategies,
 * TradeJournal, and TradingAgent orchestration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RiskManager } from '../src/agent-builder/risk-manager.js';
import { SignalDetector } from '../src/agent-builder/signal-detector.js';
import { TradeJournal } from '../src/agent-builder/trade-journal.js';
import {
  TrendContinuation,
  BreakoutStrategy,
  MeanReversionStrategy,
  selectBestStrategy,
} from '../src/agent-builder/strategy.js';
import type { AgentState, MarketSnapshot, Signal, DecisionAction } from '../src/agent-builder/types.js';
import { AgentStatus } from '../src/agent-builder/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    status: AgentStatus.RUNNING,
    iteration: 1,
    startingCapital: 1000,
    currentCapital: 1000,
    dailyPnl: 0,
    dailyTradeCount: 0,
    lastTradeTimestamp: 0,
    inCooldown: false,
    cooldownUntil: 0,
    positions: [],
    consecutiveLosses: 0,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    market: 'SOL',
    price: 95,
    priceChange24h: 5.2,
    volume24h: 50_000_000,
    volumeChange: 1.2,
    longOi: 30_000_000,
    shortOi: 20_000_000,
    oiRatio: 1.5,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── RiskManager ─────────────────────────────────────────────────────────────

describe('RiskManager', () => {
  let risk: RiskManager;

  beforeEach(() => {
    risk = new RiskManager({
      maxPositions: 2,
      maxLeverage: 5,
      positionSizePct: 0.02,
      maxDailyLossPct: 0.05,
      cooldownAfterLossMs: 60_000,
    });
  });

  describe('checkTradeAllowed', () => {
    it('allows trade when all conditions met', () => {
      const state = makeState();
      const result = risk.checkTradeAllowed(state, 'SOL', 'long', 3);
      expect(result.allowed).toBe(true);
    });

    it('blocks when max positions reached', () => {
      const state = makeState({
        positions: [
          { market: 'SOL', side: 'long', leverage: 3, sizeUsd: 300, collateralUsd: 100, entryPrice: 95 },
          { market: 'BTC', side: 'short', leverage: 2, sizeUsd: 200, collateralUsd: 100, entryPrice: 60000 },
        ],
      });
      const result = risk.checkTradeAllowed(state, 'ETH', 'long', 3);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Max positions');
    });

    it('blocks when leverage exceeds max', () => {
      const result = risk.checkTradeAllowed(makeState(), 'SOL', 'long', 10);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Leverage');
    });

    it('blocks when daily loss limit reached', () => {
      const state = makeState({ dailyPnl: -55 }); // 5.5% of $1000
      const result = risk.checkTradeAllowed(state, 'SOL', 'long', 3);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily loss');
    });

    it('blocks during cooldown', () => {
      const state = makeState({
        inCooldown: true,
        cooldownUntil: Date.now() + 30_000,
      });
      const result = risk.checkTradeAllowed(state, 'SOL', 'long', 3);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cooldown');
    });

    it('blocks averaging down (same market/side)', () => {
      const state = makeState({
        positions: [
          { market: 'SOL', side: 'long', leverage: 3, sizeUsd: 300, collateralUsd: 100, entryPrice: 95 },
        ],
      });
      const result = risk.checkTradeAllowed(state, 'SOL', 'long', 3);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('averaging down');
    });

    it('allows opposite side on same market', () => {
      const state = makeState({
        positions: [
          { market: 'SOL', side: 'long', leverage: 3, sizeUsd: 300, collateralUsd: 100, entryPrice: 95 },
        ],
      });
      const result = risk.checkTradeAllowed(state, 'SOL', 'short', 3);
      expect(result.allowed).toBe(true);
    });

    it('blocks market not in allowed list', () => {
      const strictRisk = new RiskManager({ allowedMarkets: ['SOL', 'BTC'] });
      const result = strictRisk.checkTradeAllowed(makeState(), 'DOGE', 'long', 3);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowed list');
    });
  });

  describe('calculatePositionSize', () => {
    it('calculates 2% of capital', () => {
      const size = risk.calculatePositionSize(1000);
      expect(size).toBe(20); // 2% of 1000
    });

    it('floors to minimum $1', () => {
      const size = risk.calculatePositionSize(10);
      expect(size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('clampLeverage', () => {
    it('clamps to max', () => {
      expect(risk.clampLeverage(10)).toBe(5);
    });

    it('allows within range', () => {
      expect(risk.clampLeverage(3)).toBe(3);
    });

    it('floors to 1', () => {
      expect(risk.clampLeverage(0)).toBe(1);
    });
  });

  describe('processTradeResult', () => {
    it('enters cooldown after loss', () => {
      const state = makeState();
      const updated = risk.processTradeResult(state, -10);
      expect(updated.inCooldown).toBe(true);
      expect(updated.cooldownUntil).toBeGreaterThan(Date.now());
      expect(updated.consecutiveLosses).toBe(1);
    });

    it('resets consecutive losses on win', () => {
      const state = makeState({ consecutiveLosses: 3 });
      const updated = risk.processTradeResult(state, 10);
      expect(updated.consecutiveLosses).toBe(0);
      expect(updated.inCooldown).toBe(false);
    });

    it('tracks daily PnL', () => {
      const state = makeState({ dailyPnl: -5 });
      const updated = risk.processTradeResult(state, -10);
      expect(updated.dailyPnl).toBe(-15);
    });
  });
});

// ─── SignalDetector ──────────────────────────────────────────────────────────

describe('SignalDetector', () => {
  let detector: SignalDetector;

  beforeEach(() => {
    detector = new SignalDetector();
  });

  describe('detect', () => {
    it('detects bullish trend from positive price change', () => {
      const signals = detector.detect(makeSnapshot({ priceChange24h: 8 }));
      const trend = signals.find((s) => s.source === 'trend');
      expect(trend).toBeDefined();
      expect(trend!.direction).toBe('bullish');
    });

    it('detects bearish trend from negative price change', () => {
      const signals = detector.detect(makeSnapshot({ priceChange24h: -6 }));
      const trend = signals.find((s) => s.source === 'trend');
      expect(trend).toBeDefined();
      expect(trend!.direction).toBe('bearish');
    });

    it('no trend signal on small moves', () => {
      const signals = detector.detect(makeSnapshot({ priceChange24h: 0.5 }));
      const trend = signals.find((s) => s.source === 'trend');
      expect(trend).toBeUndefined();
    });

    it('detects volume spike', () => {
      const signals = detector.detect(makeSnapshot({ volumeChange: 2.0 }));
      const vol = signals.find((s) => s.source === 'volume');
      expect(vol).toBeDefined();
      expect(vol!.direction).toBe('neutral'); // Volume is directionally neutral
    });

    it('detects OI imbalance (heavy longs = bearish)', () => {
      const signals = detector.detect(makeSnapshot({ longOi: 80_000_000, shortOi: 20_000_000 }));
      const oi = signals.find((s) => s.source === 'oi_imbalance');
      expect(oi).toBeDefined();
      expect(oi!.direction).toBe('bearish'); // Crowded longs
    });
  });

  describe('areSignalsAligned', () => {
    it('returns aligned when all bullish', () => {
      const signals: Signal[] = [
        { source: 'trend', direction: 'bullish', confidence: 0.7, reason: '' },
        { source: 'volume', direction: 'neutral', confidence: 0.5, reason: '' },
      ];
      const result = detector.areSignalsAligned(signals);
      expect(result.aligned).toBe(true);
      expect(result.direction).toBe('bullish');
    });

    it('returns not aligned when conflicting', () => {
      const signals: Signal[] = [
        { source: 'trend', direction: 'bullish', confidence: 0.7, reason: '' },
        { source: 'oi', direction: 'bearish', confidence: 0.6, reason: '' },
      ];
      const result = detector.areSignalsAligned(signals);
      expect(result.aligned).toBe(false);
    });

    it('neutral with no directional signals', () => {
      const signals: Signal[] = [
        { source: 'volume', direction: 'neutral', confidence: 0.5, reason: '' },
      ];
      const result = detector.areSignalsAligned(signals);
      expect(result.aligned).toBe(true);
      expect(result.direction).toBe('neutral');
    });
  });
});

// ─── Strategies ──────────────────────────────────────────────────────────────

describe('Strategies', () => {
  describe('TrendContinuation', () => {
    const strategy = new TrendContinuation();

    it('signals trade on strong trend', () => {
      const signals: Signal[] = [
        { source: 'trend', direction: 'bullish', confidence: 0.7, reason: 'SOL trending up' },
      ];
      const result = strategy.evaluate(makeSnapshot({ priceChange24h: 8 }), signals);
      expect(result.shouldTrade).toBe(true);
      expect(result.side).toBe('long');
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.suggestedTp).toBeGreaterThan(95);
      expect(result.suggestedSl).toBeLessThan(95);
    });

    it('no trade without trend signal', () => {
      const result = strategy.evaluate(makeSnapshot(), []);
      expect(result.shouldTrade).toBe(false);
    });

    it('no trade when OI conflicts with trend', () => {
      const signals: Signal[] = [
        { source: 'trend', direction: 'bullish', confidence: 0.7, reason: '' },
        { source: 'oi_imbalance', direction: 'bearish', confidence: 0.6, reason: '' },
      ];
      const result = strategy.evaluate(makeSnapshot({ priceChange24h: 5 }), signals);
      expect(result.shouldTrade).toBe(false);
      expect(result.reasoning).toContain('conflict');
    });
  });

  describe('BreakoutStrategy', () => {
    const strategy = new BreakoutStrategy();

    it('signals on volume spike + directional move', () => {
      const signals: Signal[] = [
        { source: 'trend', direction: 'bullish', confidence: 0.6, reason: '' },
        { source: 'volume', direction: 'neutral', confidence: 0.6, reason: '', metadata: { volumeChange: 2.0 } },
      ];
      const result = strategy.evaluate(makeSnapshot({ priceChange24h: 6 }), signals);
      expect(result.shouldTrade).toBe(true);
      expect(result.strategy).toBe('breakout');
    });

    it('no trade without volume spike', () => {
      const signals: Signal[] = [
        { source: 'trend', direction: 'bullish', confidence: 0.7, reason: '' },
      ];
      const result = strategy.evaluate(makeSnapshot(), signals);
      expect(result.shouldTrade).toBe(false);
    });
  });

  describe('MeanReversionStrategy', () => {
    const strategy = new MeanReversionStrategy();

    it('fades extreme bullish move (go short)', () => {
      const signals: Signal[] = [
        { source: 'trend', direction: 'bullish', confidence: 0.7, reason: '' },
      ];
      const result = strategy.evaluate(makeSnapshot({ priceChange24h: 12 }), signals);
      expect(result.shouldTrade).toBe(true);
      expect(result.side).toBe('short'); // Fading the move
    });

    it('no trade when volume is spiking (move not exhausted)', () => {
      const signals: Signal[] = [
        { source: 'volume', direction: 'neutral', confidence: 0.7, reason: '' },
      ];
      const result = strategy.evaluate(makeSnapshot({ priceChange24h: 8 }), signals);
      expect(result.shouldTrade).toBe(false);
      expect(result.reasoning).toContain('not exhausted');
    });

    it('no trade on small moves', () => {
      const result = strategy.evaluate(makeSnapshot({ priceChange24h: 2 }), []);
      expect(result.shouldTrade).toBe(false);
    });
  });

  describe('selectBestStrategy', () => {
    it('picks highest confidence', () => {
      const strategies = [new TrendContinuation(), new BreakoutStrategy()];
      const signals: Signal[] = [
        { source: 'trend', direction: 'bullish', confidence: 0.8, reason: '' },
        { source: 'volume', direction: 'neutral', confidence: 0.6, reason: '', metadata: { volumeChange: 2.0 } },
      ];
      const result = selectBestStrategy(strategies, makeSnapshot({ priceChange24h: 7 }), signals);
      expect(result).not.toBeNull();
      expect(result!.shouldTrade).toBe(true);
    });

    it('returns null when no strategy triggers', () => {
      const strategies = [new TrendContinuation()];
      const result = selectBestStrategy(strategies, makeSnapshot({ priceChange24h: 0.5 }), []);
      expect(result).toBeNull();
    });
  });
});

// ─── TradeJournal ────────────────────────────────────────────────────────────

describe('TradeJournal', () => {
  let journal: TradeJournal;

  beforeEach(() => {
    journal = new TradeJournal();
  });

  it('records trade entries', () => {
    const decision = {
      action: 'open' as DecisionAction,
      market: 'SOL',
      side: 'long' as const,
      leverage: 3,
      collateral: 20,
      strategy: 'trend_continuation',
      confidence: 0.75,
      reasoning: 'Bullish trend',
      signals: [],
      riskLevel: 'safe' as const,
    };
    const entry = journal.record(decision, { entryPrice: 95 });
    expect(entry.id).toBe(1);
    expect(entry.market).toBe('SOL');
    expect(entry.outcome).toBe('pending');
  });

  it('closes entries with PnL', () => {
    const decision = {
      action: 'open' as DecisionAction,
      market: 'SOL',
      side: 'long' as const,
      strategy: 'test',
      confidence: 0.7,
      reasoning: '',
      signals: [],
      riskLevel: 'safe' as const,
    };
    const entry = journal.record(decision);
    const closed = journal.closeEntry(entry.id, { exitPrice: 100, pnl: 15, pnlPercent: 7.5 });
    expect(closed).not.toBeNull();
    expect(closed!.outcome).toBe('win');
    expect(closed!.pnl).toBe(15);
  });

  it('calculates stats correctly', () => {
    // 2 wins, 1 loss
    const base = { action: 'open' as DecisionAction, market: 'SOL', strategy: 'test', confidence: 0.7, reasoning: '', signals: [], riskLevel: 'safe' as const };
    journal.record(base, { pnl: 10 });
    journal.record(base, { pnl: 20 });
    journal.record(base, { pnl: -5 });

    const stats = journal.getStats();
    expect(stats.totalTrades).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.totalPnl).toBe(25);
    expect(stats.winRate).toBeCloseTo(0.667, 2);
    expect(stats.avgWin).toBe(15);
    expect(stats.avgLoss).toBe(5);
    expect(stats.profitFactor).toBe(6); // 30/5
  });

  it('getByMarket filters correctly', () => {
    const base = { action: 'open' as DecisionAction, strategy: 'test', confidence: 0.7, reasoning: '', signals: [], riskLevel: 'safe' as const };
    journal.record({ ...base, market: 'SOL' });
    journal.record({ ...base, market: 'BTC' });
    journal.record({ ...base, market: 'SOL' });

    expect(journal.getByMarket('SOL')).toHaveLength(2);
    expect(journal.getByMarket('BTC')).toHaveLength(1);
  });

  it('formatStats produces readable output', () => {
    const base = { action: 'open' as DecisionAction, market: 'SOL', strategy: 'test', confidence: 0.7, reasoning: '', signals: [], riskLevel: 'safe' as const };
    journal.record(base, { pnl: 10 });
    const output = journal.formatStats();
    expect(output).toContain('Win Rate');
    expect(output).toContain('Total PnL');
  });

  it('clear resets everything', () => {
    const base = { action: 'open' as DecisionAction, market: 'SOL', strategy: 'test', confidence: 0.7, reasoning: '', signals: [], riskLevel: 'safe' as const };
    journal.record(base, { pnl: 10 });
    journal.clear();
    expect(journal.getEntries()).toHaveLength(0);
    expect(journal.getStats().totalTrades).toBe(0);
  });
});
