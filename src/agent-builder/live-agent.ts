/**
 * LiveTradingAgent — Runs inside the interactive terminal session.
 *
 * Unlike TradingAgent (which spawns CLI subprocesses), this agent uses the
 * terminal's live ToolContext directly for real-time market data, positions,
 * and trade execution.
 *
 * Usage: from the REPL, type `agent start` or `agent start --dry-run`
 */

import type { ToolContext, MarketData } from '../types/index.js';
import { TradeSide as CoreTradeSide } from '../types/index.js';
import type { Position as CorePosition } from '../types/index.js';
import type { Position } from '../sdk/types.js';
import { RiskManager } from './risk-manager.js';
import { SignalDetector } from './signal-detector.js';
import { TradeJournal } from './trade-journal.js';
import { SignalFusionEngine } from './signal-fusion.js';
import { PositionManager } from './position-manager.js';
import { StrategyEnsemble } from './strategy-ensemble.js';
import { DrawdownManager } from './drawdown-manager.js';
import { RegimeAdapter } from './regime-adapter.js';
import { MarketScanner } from './market-scanner.js';
import { DynamicSizer } from './dynamic-sizer.js';
import type { CompositeSignal } from './signal-fusion.js';

import type {
  AgentConfig,
  AgentState,
  AgentCallbacks,
  Strategy,
  TradeDecision,
  MarketSnapshot,
  DecisionAction,
} from './types.js';
import { AgentStatus, DEFAULT_AGENT_CONFIG } from './types.js';

// ─── LiveTradingAgent ────────────────────────────────────────────────────────

export class LiveTradingAgent {
  private readonly context: ToolContext;
  private readonly config: AgentConfig;
  private readonly risk: RiskManager;
  private readonly signals: SignalDetector;
  private readonly journal: TradeJournal;
  private readonly strategies: Strategy[];
  private readonly callbacks: AgentCallbacks;
  private readonly fusion: SignalFusionEngine;
  private readonly positionMgr: PositionManager;
  private readonly ensemble: StrategyEnsemble;
  private readonly drawdown: DrawdownManager;
  private readonly regimeAdapter: RegimeAdapter;
  private readonly scanner: MarketScanner;
  private readonly sizer: DynamicSizer;
  /** Signal confirmation: track previous tick's direction per market */
  private prevSignals: Map<string, string> = new Map();
  /** Per-market cooldown after trade close */
  private marketCooldowns: Map<string, number> = new Map();
  /** Hourly trade counter for frequency limiting */
  private hourlyTrades: number[] = [];
  /** Per-market hourly trade counter */
  private marketHourlyTrades: Map<string, number[]> = new Map();

  private state: AgentState;
  private running = false;
  private stopRequested = false;

  constructor(
    context: ToolContext,
    strategies: Strategy[],
    config: Partial<AgentConfig> = {},
    callbacks: AgentCallbacks = {},
  ) {
    this.context = context;
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config, risk: { ...DEFAULT_AGENT_CONFIG.risk, ...config.risk } };
    this.strategies = strategies;
    this.callbacks = callbacks;

    this.risk = new RiskManager(this.config.risk);
    this.signals = new SignalDetector();
    this.journal = new TradeJournal();
    this.fusion = new SignalFusionEngine();
    this.positionMgr = new PositionManager({
      atrMultiplier: 2.0,
      scaleOutLevels: [1, 2, 3],
      scaleOutPercents: [30, 30, 40],
      maxFlatTicks: 20,
      maxRiskPct: this.config.risk.positionSizePct,
      kellyFraction: 0.25,
    });
    this.ensemble = new StrategyEnsemble(strategies, {
      minAgreement: 1,
      minConfidence: this.config.risk.minConfidence,
    });
    this.drawdown = new DrawdownManager(10_000);
    this.regimeAdapter = new RegimeAdapter();
    this.scanner = new MarketScanner(3, 0.25); // Top 3 markets, min score 0.25
    this.sizer = new DynamicSizer(0.02, 0.005, 0.03); // 2% base, 0.5% min, 3% max
    this.state = this.createInitialState();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.stopRequested = false;
    this.setStatus(AgentStatus.RUNNING);

    this.log('info', `Agent "${this.config.name}" v4 (quant-level) starting`);
    this.log('info', `Scanning: ${this.config.markets.join(', ')} → trade top 3`);
    this.log('info', `Strategies: ${this.strategies.map((s) => s.name).join(', ')}`);
    this.log('info', `Engines: Bayesian fusion, market scanner, dynamic sizing, regime-adaptive, funding harvester`);
    this.log('info', `Risk: max ${this.config.risk.maxPositions} pos, max ${this.config.risk.maxLeverage}x, 2-tick confirmation`);
    if (this.config.dryRun) this.log('info', 'DRY RUN — decisions logged but not executed');

    // Initialize capital from live context
    try {
      await this.initializeCapital();
    } catch (error: unknown) {
      this.safetyStop(`Failed to initialize: ${error instanceof Error ? error.message : error}`);
      return;
    }

    // Main loop
    while (this.running && !this.stopRequested) {
      if (this.config.maxIterations > 0 && this.state.iteration >= this.config.maxIterations) {
        this.log('info', `Max iterations reached (${this.config.maxIterations})`);
        break;
      }

      try {
        await this.tick();
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.callbacks.onError?.(err, 'tick');
        this.log('error', `Tick error: ${err.message}`);
      }

      if (this.running && !this.stopRequested) {
        await sleep(this.config.pollIntervalMs);
      }
    }

    this.running = false;
    this.setStatus(AgentStatus.STOPPED);
    this.log('info', `Agent stopped after ${this.state.iteration} iterations`);
    this.log('info', `Journal:\n${this.journal.formatStats()}`);
  }

  stop(): void {
    this.stopRequested = true;
    this.log('info', 'Stop requested');
  }

  getState(): Readonly<AgentState> { return this.state; }
  getJournal(): TradeJournal { return this.journal; }
  getRiskManager(): RiskManager { return this.risk; }
  get isRunning(): boolean { return this.running; }

  // ─── Core Loop ─────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    this.state.iteration++;
    this.callbacks.onTick?.(this.state, this.state.iteration);

    if (this.risk.isDailyLossBreached(this.state)) {
      this.safetyStop(`Daily loss limit breached: $${this.state.dailyPnl.toFixed(2)}`);
      return;
    }

    // OBSERVE — use live context directly
    const [positions, snapshots] = await Promise.all([
      this.fetchPositions(),
      this.fetchMarketSnapshots(),
    ]);

    if (!snapshots.length) {
      this.log('verbose', 'No market data available');
      return;
    }

    this.state.positions = positions;
    this.state.currentCapital = await this.fetchCapitalLive();

    // DRAWDOWN CHECK — anti-martingale circuit breaker
    const ddState = this.drawdown.update(this.state.currentCapital);
    if (ddState.halted) {
      this.safetyStop(`Drawdown manager halt: ${ddState.haltReason}`);
      return;
    }
    if (ddState.sizeMultiplier < 0.15) {
      this.log('normal', `Drawdown ${(ddState.drawdownPct * 100).toFixed(1)}% — sizing reduced to ${(ddState.sizeMultiplier * 100).toFixed(0)}%`);
    }

    // MONITOR — check existing positions with advanced position manager
    await this.monitorPositions(positions);

    // Update position manager performance from journal stats
    const stats = this.journal.getStats();
    if (stats.totalTrades > 0) {
      this.positionMgr.updatePerformance(stats.winRate, stats.avgWin, stats.avgLoss);
    }

    // ─── PHASE 3: SCAN + RANK ALL MARKETS ───────────────────────────
    const compositeMap = new Map<string, CompositeSignal>();
    for (const snapshot of snapshots) {
      compositeMap.set(snapshot.market, this.fusion.fuse(snapshot, snapshot.fundingRate));
    }

    const rankedMarkets = this.scanner.rank(snapshots, compositeMap);
    const tradeableMarkets = new Set(rankedMarkets.map((r) => r.market));

    if (rankedMarkets.length > 0) {
      this.log('verbose', `Scanner: ${rankedMarkets.map((r) => `${r.market}(${(r.score * 100).toFixed(0)}%)`).join(', ')} | ${snapshots.length - rankedMarkets.length} filtered out`);
    }

    // ─── PHASE 4: PRECISION-FILTERED ANALYSIS + DECIDE ───────────
    // Clean up hourly counters
    const now = Date.now();
    this.hourlyTrades = this.hourlyTrades.filter((t) => now - t < 3_600_000);

    // FILTER: global trade frequency (max 6/hour)
    if (this.hourlyTrades.length >= 6) {
      this.log('verbose', 'Global trade limit: 6/hour reached');
      return;
    }

    // FILTER: loss streak adaptation (Section 9)
    if (this.state.consecutiveLosses >= 4) {
      this.log('normal', `Loss streak ${this.state.consecutiveLosses} — pausing 10 min`);
      return;
    }

    let tickPositionCount = this.state.positions.length;
    let tickCapitalAllocated = this.state.positions.reduce((sum, p) => sum + (p.collateralUsd ?? 0), 0);
    const maxCapital = this.state.currentCapital * 0.15;

    for (const snapshot of snapshots) {
      if (!tradeableMarkets.has(snapshot.market)) continue;
      if (tickPositionCount >= this.config.risk.maxPositions) continue;
      if (tickCapitalAllocated >= maxCapital) continue;

      // FILTER: per-market cooldown (Section 3)
      const marketCooldown = this.marketCooldowns.get(snapshot.market) ?? 0;
      if (now < marketCooldown) {
        this.log('verbose', `${snapshot.market}: market cooldown (${Math.ceil((marketCooldown - now) / 1000)}s)`);
        continue;
      }

      // FILTER: per-market frequency (max 2/hour per market)
      const mktTrades = (this.marketHourlyTrades.get(snapshot.market) ?? []).filter((t) => now - t < 3_600_000);
      this.marketHourlyTrades.set(snapshot.market, mktTrades);
      if (mktTrades.length >= 2) continue;

      const regime = this.regimeAdapter.detectRegime(snapshot.market, snapshot.price, snapshot.priceChange24h);
      const regimeParams = this.regimeAdapter.getParams(regime.regime);
      const composite = compositeMap.get(snapshot.market)!;
      const marketSignals = this.signals.detect(snapshot);

      // FILTER: 2-tick direction confirmation (Section 7)
      const prevDir = this.prevSignals.get(snapshot.market);
      this.prevSignals.set(snapshot.market, composite.direction);
      if (composite.direction !== 'neutral' && prevDir !== composite.direction) {
        this.log('verbose', `${snapshot.market}: awaiting confirmation (${prevDir ?? 'none'} → ${composite.direction})`);
        continue;
      }

      // FILTER: signal quality (Section 4) — composite score, confidence, clarity
      if (composite.confidence < 0.50) continue; // Raised from 0.35
      if (!composite.confirmed) continue;
      const totalDir = composite.factors.filter((f) => f.direction !== 'neutral').length;
      const aligned = composite.confirmedFactors;
      const clarity = totalDir > 0 ? aligned / totalDir : 0;
      if (clarity < 0.6) {
        this.log('verbose', `${snapshot.market}: low clarity ${(clarity * 100).toFixed(0)}% (${aligned}/${totalDir})`);
        continue;
      }

      this.log('verbose', `${snapshot.market}: regime=${regime.regime} score=${composite.compositeScore.toFixed(3)} conf=${(composite.confidence * 100).toFixed(0)}% clarity=${(clarity * 100).toFixed(0)}% ${composite.confirmedFactors}F`);

      // Strategy ensemble
      const ed = this.ensemble.evaluate(snapshot, marketSignals, composite);
      if (!ed.shouldTrade) continue;

      // FILTER: ensemble strength (Section 1)
      // Require ≥2 strategies agreeing OR single strategy with confidence ≥0.85
      if (ed.agreeing < 2 && ed.confidence < 0.85) {
        this.log('verbose', `${snapshot.market}: weak consensus (${ed.agreeing}/${ed.totalVoters} agree, conf=${(ed.confidence * 100).toFixed(0)}%) — need ≥2 or ≥85%`);
        continue;
      }

      // Build trade parameters
      const side = ed.side ?? 'long';
      const leverage = this.risk.clampLeverage(Math.min(3, regimeParams.maxLeverage ?? 3));
      const slDistance = snapshot.price * 0.02 * (regimeParams.stopAtrMultiplier ?? 2.0) / 2.0;
      const tpDistance = slDistance * Math.max(2.0, regimeParams.takeProfitR ?? 2.0); // Min 2:1 R:R
      const tp = ed.bestResult?.suggestedTp ?? (side === 'long' ? snapshot.price + tpDistance : snapshot.price - tpDistance);
      const sl = ed.bestResult?.suggestedSl ?? (side === 'long' ? snapshot.price - slDistance : snapshot.price + slDistance);

      // FILTER: R:R enforcement (Section 2) — minimum 1.5:1
      const riskDist = Math.abs(snapshot.price - sl);
      const rewardDist = Math.abs(tp - snapshot.price);
      const rrRatio = riskDist > 0 ? rewardDist / riskDist : 0;
      if (rrRatio < 1.5) {
        this.log('verbose', `${snapshot.market}: R:R ${rrRatio.toFixed(1)} < 1.5 — rejected`);
        continue;
      }

      // Dynamic sizing
      const sizing = this.sizer.calculate(this.state.currentCapital, ed.confidence, stats, ddState, regimeParams.sizeMultiplier, this.state.consecutiveLosses);
      const collateral = Math.min(sizing.collateral, Math.max(1, maxCapital - tickCapitalAllocated));

      const strategyName = ed.votes.filter((v) => v.result.shouldTrade && !v.shadow).map((v) => v.strategy).join('+') || 'ensemble';

      const decision: TradeDecision = {
        action: 'open' as DecisionAction,
        market: snapshot.market, side, leverage, collateral, tp, sl,
        strategy: strategyName,
        confidence: ed.confidence,
        reasoning: `${ed.agreeing}/${ed.totalVoters} strategies | R:R=${rrRatio.toFixed(1)} | clarity=${(clarity * 100).toFixed(0)}% | $${collateral.toFixed(0)}(${(sizing.sizePct * 100).toFixed(1)}%) | ${regime.regime}`,
        signals: ed.bestResult?.signals ?? [],
        riskLevel: 'safe',
      };

      const riskCheck = this.risk.assessRisk(decision, this.state);
      decision.riskLevel = riskCheck.riskLevel;
      decision.blockReason = riskCheck.blockReason;

      this.callbacks.onDecision?.(decision);
      this.log('normal', `Decision: ${decision.action} ${decision.market} ${decision.side} | ${ed.agreeing}/${ed.totalVoters} agree | conf=${(ed.confidence * 100).toFixed(0)}% | R:R=${rrRatio.toFixed(1)} | $${collateral.toFixed(0)} | ${regime.regime}`);

      if (decision.riskLevel !== 'blocked') {
        await this.executeTrade(decision, snapshot);
        tickPositionCount++;
        tickCapitalAllocated += collateral;
        // Record trade for frequency limiting
        this.hourlyTrades.push(now);
        const mt = this.marketHourlyTrades.get(snapshot.market) ?? [];
        mt.push(now);
        this.marketHourlyTrades.set(snapshot.market, mt);
      } else {
        this.log('normal', `Blocked: ${decision.blockReason}`);
        this.journal.record(decision);
      }
    }
  }

  // ─── Data Access (Live Context) ────────────────────────────────────

  private async fetchPositions(): Promise<Position[]> {
    try {
      const corePositions = await this.context.flashClient.getPositions();
      return corePositions.map((p: CorePosition) => ({
        market: p.market,
        side: p.side,
        leverage: p.leverage,
        sizeUsd: p.sizeUsd,
        collateralUsd: p.collateralUsd,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        pnl: p.unrealizedPnl,
        pnlPercent: p.unrealizedPnlPercent,
        liquidationPrice: p.liquidationPrice,
        openFee: p.openFee,
        totalFees: p.totalFees,
        fundingRate: p.fundingRate,
      }));
    } catch {
      return this.state.positions;
    }
  }

  private async fetchMarketSnapshots(): Promise<MarketSnapshot[]> {
    const snapshots: MarketSnapshot[] = [];
    const { SolanaInspector } = await import('../agent/solana-inspector.js');
    const inspector = new SolanaInspector(
      this.context.flashClient,
      this.context.dataClient,
    );

    for (const market of this.config.markets) {
      try {
        const [marketData] = await inspector.getMarkets(market);
        if (!marketData) continue;

        let volumeData: { totalVolumeUsd?: number } | null = null;
        let oiData: { markets?: Array<{ market: string; longOi: number; shortOi: number }> } | null = null;

        try { volumeData = await inspector.getVolume(); } catch { /* optional */ }
        try { oiData = await inspector.getOpenInterest(); } catch { /* optional */ }

        const oiMarket = oiData?.markets?.find(
          (m) => m.market.toUpperCase() === market.toUpperCase(),
        );
        const md = marketData as MarketData & Record<string, unknown>;
        const longOi = oiMarket?.longOi ?? (md.openInterestLong as number) ?? 0;
        const shortOi = oiMarket?.shortOi ?? (md.openInterestShort as number) ?? 0;
        const totalOi = longOi + shortOi;

        snapshots.push({
          market: market.toUpperCase(),
          price: marketData.price ?? 0,
          priceChange24h: marketData.priceChange24h ?? 0,
          volume24h: volumeData?.totalVolumeUsd ?? 0,
          longOi,
          shortOi,
          oiRatio: totalOi > 0 ? longOi / totalOi : 0.5,
          fundingRate: (md.fundingRate as number) ?? undefined,
          timestamp: Date.now(),
        });
      } catch (error: unknown) {
        this.log('verbose', `Failed to fetch ${market}: ${error instanceof Error ? error.message : error}`);
      }
    }

    return snapshots;
  }

  private async fetchCapitalLive(): Promise<number> {
    try {
      const portfolio = await this.context.flashClient.getPortfolio();
      const value = portfolio.usdcBalance ?? portfolio.balance ?? 0;
      if (value > 0) return value;
    } catch { /* fallback */ }

    if (this.state.currentCapital > 0) return this.state.currentCapital;
    return this.context.simulationMode ? 10_000 : 0;
  }

  private async initializeCapital(): Promise<void> {
    const capital = await this.fetchCapitalLive();
    if (capital > 0) {
      this.state.startingCapital = capital;
      this.state.currentCapital = capital;
      this.drawdown.reset(capital);
      this.log('info', `Starting capital: $${capital.toFixed(2)}${this.context.simulationMode ? ' (simulation)' : ''}`);
      return;
    }
    throw new Error('Could not determine starting capital');
  }

  // ─── Monitor ───────────────────────────────────────────────────────

  private async monitorPositions(positions: Position[]): Promise<void> {
    for (const pos of positions) {
      // Use PositionManager for advanced tracking
      const managed = this.positionMgr.update(pos);

      if (managed) {
        switch (managed.action) {
          case 'trailing_stop_hit':
            this.log('normal', `Trailing stop: ${pos.market} ${pos.side} — ${managed.reason}`);
            await this.closeWithReason(pos, 'trailing_stop', managed.reason);
            this.positionMgr.untrack(pos.market, pos.side);
            break;

          case 'partial_close':
            this.log('normal', `Scale-out: ${pos.market} ${pos.side} ${managed.closePercent}% — ${managed.reason}`);
            await this.closeWithReason(pos, 'scale_out', managed.reason, managed.closePercent);
            break;

          case 'time_decay_exit':
            this.log('normal', `Time decay: ${pos.market} ${pos.side} — ${managed.reason}`);
            await this.closeWithReason(pos, 'time_decay', managed.reason);
            this.positionMgr.untrack(pos.market, pos.side);
            break;

          case 'close':
            this.log('normal', `Close: ${pos.market} ${pos.side} — ${managed.reason}`);
            await this.closeWithReason(pos, 'risk_monitor', managed.reason);
            this.positionMgr.untrack(pos.market, pos.side);
            break;

          case 'hold':
            this.log('verbose', `Hold: ${pos.market} ${pos.side} — ${managed.reason}`);
            break;
        }
        continue;
      }

      // Fallback for untracked positions — use simple rules
      const pnlPct = pos.pnlPercent ?? 0;

      if (pnlPct < -15) {
        this.log('normal', `Emergency close: ${pos.market} ${pos.side} at ${pnlPct.toFixed(1)}%`);
        await this.closeWithReason(pos, 'emergency', `Emergency stop: ${pnlPct.toFixed(1)}% drawdown`);
      } else if (pnlPct > 5) {
        this.log('normal', `Taking profit: ${pos.market} ${pos.side} at +${pnlPct.toFixed(1)}%`);
        await this.closeWithReason(pos, 'take_profit', `Take profit at +${pnlPct.toFixed(1)}%`);
      } else if (pnlPct < -3) {
        this.log('normal', `Stop loss: ${pos.market} ${pos.side} at ${pnlPct.toFixed(1)}%`);
        await this.closeWithReason(pos, 'stop_loss', `Stop loss at ${pnlPct.toFixed(1)}%`);
      }
    }
  }

  private async closeWithReason(pos: Position, strategy: string, reasoning: string, closePercent?: number): Promise<void> {
    // Set per-market cooldown: 3 min after close, 5 min after loss
    const pnl = pos.pnl ?? 0;
    const cooldownMs = pnl < 0 ? 300_000 : 180_000;
    this.marketCooldowns.set(pos.market, Date.now() + cooldownMs);

    const decision: TradeDecision = {
      action: 'close' as DecisionAction,
      market: pos.market,
      side: pos.side,
      closePercent,
      strategy,
      confidence: 1,
      reasoning,
      signals: [],
      riskLevel: 'safe',
    };
    await this.executeClose(decision, pos);
  }

  private async getMarketSnapshot(market: string): Promise<MarketSnapshot | null> {
    try {
      const { SolanaInspector } = await import('../agent/solana-inspector.js');
      const inspector = new SolanaInspector(this.context.flashClient, this.context.dataClient);
      const [marketData] = await inspector.getMarkets(market);
      if (!marketData) return null;

      let oiData: { markets?: Array<{ market: string; longOi: number; shortOi: number }> } | null = null;
      try { oiData = await inspector.getOpenInterest(); } catch { /* optional */ }

      const md = marketData as MarketData & Record<string, unknown>;
      const oiMarket = oiData?.markets?.find((m) => m.market.toUpperCase() === market.toUpperCase());
      const longOi = oiMarket?.longOi ?? (md.openInterestLong as number) ?? 0;
      const shortOi = oiMarket?.shortOi ?? (md.openInterestShort as number) ?? 0;
      const totalOi = longOi + shortOi;

      return {
        market: market.toUpperCase(),
        price: marketData.price ?? 0,
        priceChange24h: marketData.priceChange24h ?? 0,
        volume24h: 0,
        longOi, shortOi,
        oiRatio: totalOi > 0 ? longOi / totalOi : 0.5,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  // ─── Decide ────────────────────────────────────────────────────────

  private buildDecisionFromEnsemble(
    ensembleDecision: import('./strategy-ensemble.js').EnsembleDecision,
    snapshot: MarketSnapshot,
    composite: import('./signal-fusion.js').CompositeSignal,
    regimeParams?: import('./regime-adapter.js').RegimeParams,
    drawdownMultiplier = 1.0,
  ): TradeDecision {
    const side = ensembleDecision.side ?? 'long';
    const maxLev = regimeParams?.maxLeverage ?? this.config.risk.maxLeverage;
    const leverage = this.risk.clampLeverage(Math.min(3, maxLev));

    // Kelly-criterion position sizing + regime + drawdown multipliers
    const atrMult = regimeParams?.stopAtrMultiplier ?? 2.0;
    const slDistance = snapshot.price * (0.015 * atrMult / 2.0); // Scale SL by regime
    const stopLoss = side === 'long' ? snapshot.price - slDistance : snapshot.price + slDistance;
    const sizing = this.positionMgr.calculatePositionSize(
      this.state.currentCapital,
      snapshot.price,
      stopLoss,
      ensembleDecision.confidence,
      leverage,
    );

    // Apply regime size multiplier + drawdown anti-martingale multiplier
    const regimeMult = regimeParams?.sizeMultiplier ?? 1.0;
    const adjustedCollateral = Math.max(1, sizing.collateral * regimeMult * drawdownMultiplier);

    const bestResult = ensembleDecision.bestResult;
    const tpR = regimeParams?.takeProfitR ?? 2.0;
    const tpDistance = slDistance * tpR;
    const tp = bestResult?.suggestedTp ?? (side === 'long' ? snapshot.price + tpDistance : snapshot.price - tpDistance);
    const sl = bestResult?.suggestedSl ?? stopLoss;

    const strategyName = ensembleDecision.votes
      .filter((v) => v.result.shouldTrade && !v.shadow)
      .map((v) => v.strategy)
      .join('+');

    const decision: TradeDecision = {
      action: 'open' as DecisionAction,
      market: snapshot.market,
      side,
      leverage,
      collateral: adjustedCollateral,
      tp,
      sl,
      strategy: strategyName || 'ensemble',
      confidence: ensembleDecision.confidence,
      reasoning: `${ensembleDecision.reasoning} | Fusion: ${composite.direction} ${(composite.confidence * 100).toFixed(0)}% (${composite.confirmedFactors}F) | Size: $${adjustedCollateral.toFixed(0)} (${sizing.method}, regime=${regimeMult.toFixed(1)}x, dd=${drawdownMultiplier.toFixed(2)}x)`,
      signals: bestResult?.signals ?? [],
      riskLevel: 'safe',
    };

    const riskCheck = this.risk.assessRisk(decision, this.state);
    decision.riskLevel = riskCheck.riskLevel;
    decision.blockReason = riskCheck.blockReason;
    return decision;
  }

  // ─── Execute (via live flashClient) ────────────────────────────────

  private async executeTrade(decision: TradeDecision, snapshot?: MarketSnapshot): Promise<void> {
    if (this.config.dryRun) {
      this.log('normal', `[DRY RUN] Would ${decision.side} ${decision.market} ${decision.leverage}x $${decision.collateral}`);
      this.journal.record(decision);
      this.callbacks.onTrade?.(this.journal.getRecent(1)[0]);
      return;
    }

    this.log('normal', `Executing: ${decision.side} ${decision.market} ${decision.leverage}x $${decision.collateral}`);

    try {
      const coreSide = decision.side === 'long' ? CoreTradeSide.Long : CoreTradeSide.Short;
      const result = await this.context.flashClient.openPosition(
        decision.market,
        coreSide,
        decision.collateral!,
        decision.leverage!,
      );

      const entry = this.journal.record(decision, {
        entryPrice: result.entryPrice,
      });

      // Register with position manager for trailing stop tracking
      if (decision.sl && result.entryPrice) {
        this.positionMgr.track(
          {
            market: decision.market,
            side: decision.side!,
            leverage: decision.leverage!,
            sizeUsd: decision.collateral! * decision.leverage!,
            collateralUsd: decision.collateral!,
            entryPrice: result.entryPrice,
            markPrice: snapshot?.price,
          },
          decision.sl,
        );
      }

      this.state.lastTradeTimestamp = Date.now();
      this.callbacks.onTrade?.(entry);
      this.log('normal', `Trade opened: ${decision.market} ${decision.side}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log('error', `Trade failed: ${msg}`);
      this.journal.record(decision, { error: msg });
    }
  }

  private async executeClose(decision: TradeDecision, position: Position): Promise<void> {
    if (this.config.dryRun) {
      this.log('normal', `[DRY RUN] Would close ${position.market} ${position.side}`);
      this.journal.record(decision);
      return;
    }

    try {
      const coreSide = position.side === 'long' ? CoreTradeSide.Long : CoreTradeSide.Short;
      await this.context.flashClient.closePosition(
        position.market,
        coreSide,
      );

      const pnl = position.pnl ?? 0;
      const entry = this.journal.record(decision, {
        exitPrice: position.markPrice,
        pnl,
        pnlPercent: position.pnlPercent,
      });

      this.state = this.risk.processTradeResult(this.state, pnl);
      this.callbacks.onTrade?.(entry);
      this.log('normal', `Closed: ${position.market} ${position.side} PnL=$${pnl.toFixed(2)}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log('error', `Close failed: ${msg}`);
      this.journal.record(decision, { error: msg });
    }
  }

  // ─── Safety & State ────────────────────────────────────────────────

  private safetyStop(reason: string): void {
    this.log('error', `SAFETY STOP: ${reason}`);
    this.state.safetyStopReason = reason;
    this.setStatus(AgentStatus.SAFETY_STOP);
    this.running = false;
    this.callbacks.onSafetyStop?.(reason, this.state);
  }

  private setStatus(status: AgentStatus): void {
    const prev = this.state.status;
    this.state.status = status;
    if (prev !== status) this.callbacks.onStatusChange?.(status, prev);
  }

  private createInitialState(): AgentState {
    return {
      status: AgentStatus.INITIALIZING,
      iteration: 0, startingCapital: 0, currentCapital: 0,
      dailyPnl: 0, dailyTradeCount: 0, lastTradeTimestamp: 0,
      inCooldown: false, cooldownUntil: 0, positions: [], consecutiveLosses: 0,
    };
  }

  private log(level: 'info' | 'normal' | 'verbose' | 'error', message: string): void {
    if (this.config.logLevel === 'quiet' && level !== 'error') return;
    if (this.config.logLevel === 'normal' && level === 'verbose') return;
    const ts = new Date().toISOString().slice(11, 19);
    const prefix = level === 'error' ? '[ERROR]' : `[${this.config.name}]`;
    console.log(`${ts} ${prefix} ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
