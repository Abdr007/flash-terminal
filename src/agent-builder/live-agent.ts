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
    // Compute fusion signals for all markets first, then rank
    const compositeMap = new Map<string, CompositeSignal>();
    for (const snapshot of snapshots) {
      const composite = this.fusion.fuse(snapshot, snapshot.fundingRate);
      compositeMap.set(snapshot.market, composite);
    }

    // Rank markets by opportunity — only trade the top N
    const rankedMarkets = this.scanner.rank(snapshots, compositeMap);
    const tradeableMarkets = new Set(rankedMarkets.map((r) => r.market));

    if (rankedMarkets.length > 0) {
      this.log('verbose', `Scanner: ${rankedMarkets.map((r) => `${r.market}(${(r.score * 100).toFixed(0)}%)`).join(', ')} | ${snapshots.length - rankedMarkets.length} filtered out`);
    }

    // ─── PHASE 4: ANALYZE + DECIDE (only ranked markets) ─────────
    let tickPositionCount = this.state.positions.length;
    let tickCapitalAllocated = this.state.positions.reduce((sum, p) => sum + (p.collateralUsd ?? 0), 0);
    const maxCapitalPct = 0.15; // Max 15% of capital allocated
    const maxCapital = this.state.currentCapital * maxCapitalPct;

    for (const snapshot of snapshots) {
      // Only trade scanner-approved markets
      if (!tradeableMarkets.has(snapshot.market)) continue;

      // Guard: max positions
      if (tickPositionCount >= this.config.risk.maxPositions) continue;

      // Guard: max capital
      if (tickCapitalAllocated >= maxCapital) continue;

      // Regime detection
      const regime = this.regimeAdapter.detectRegime(snapshot.market, snapshot.price, snapshot.priceChange24h);
      const regimeParams = this.regimeAdapter.getParams(regime.regime);

      // Get pre-computed composite
      const composite = compositeMap.get(snapshot.market)!;
      const marketSignals = this.signals.detect(snapshot);

      // SIGNAL CONFIRMATION: require same direction for 2 consecutive ticks
      const prevDir = this.prevSignals.get(snapshot.market);
      this.prevSignals.set(snapshot.market, composite.direction);
      if (composite.direction !== 'neutral' && prevDir !== composite.direction) {
        this.log('verbose', `${snapshot.market}: awaiting confirmation (${prevDir ?? 'none'} → ${composite.direction})`);
        continue;
      }

      // Minimum signal quality
      if (composite.confidence < 0.35 || !composite.confirmed) {
        continue;
      }

      this.log('verbose', `${snapshot.market}: regime=${regime.regime} composite=${composite.compositeScore.toFixed(3)} dir=${composite.direction} conf=${(composite.confidence * 100).toFixed(0)}% factors=${composite.confirmedFactors}F`);

      // Strategy ensemble
      const ensembleDecision = this.ensemble.evaluate(snapshot, marketSignals, composite);
      if (!ensembleDecision.shouldTrade) continue;

      // Dynamic position sizing
      const sizing = this.sizer.calculate(
        this.state.currentCapital,
        ensembleDecision.confidence,
        stats,
        ddState,
        regimeParams.sizeMultiplier,
        this.state.consecutiveLosses,
      );

      // Cap to remaining budget
      const collateral = Math.min(sizing.collateral, Math.max(1, maxCapital - tickCapitalAllocated));

      // Build decision
      const side = ensembleDecision.side ?? 'long';
      const maxLev = regimeParams.maxLeverage ?? this.config.risk.maxLeverage;
      const leverage = this.risk.clampLeverage(Math.min(3, maxLev));
      const bestResult = ensembleDecision.bestResult;
      const slDistance = snapshot.price * 0.015 * (regimeParams.stopAtrMultiplier ?? 2.0) / 2.0;
      const tpDistance = slDistance * (regimeParams.takeProfitR ?? 2.0);
      const tp = bestResult?.suggestedTp ?? (side === 'long' ? snapshot.price + tpDistance : snapshot.price - tpDistance);
      const sl = bestResult?.suggestedSl ?? (side === 'long' ? snapshot.price - slDistance : snapshot.price + slDistance);

      const strategyName = ensembleDecision.votes.filter((v) => v.result.shouldTrade && !v.shadow).map((v) => v.strategy).join('+') || 'ensemble';

      const decision: TradeDecision = {
        action: 'open' as DecisionAction,
        market: snapshot.market, side, leverage, collateral, tp, sl,
        strategy: strategyName,
        confidence: ensembleDecision.confidence,
        reasoning: `${ensembleDecision.reasoning} | size=$${collateral.toFixed(0)}(${(sizing.sizePct * 100).toFixed(1)}%) | ${regime.regime}`,
        signals: bestResult?.signals ?? [],
        riskLevel: 'safe',
      };

      const riskCheck = this.risk.assessRisk(decision, this.state);
      decision.riskLevel = riskCheck.riskLevel;
      decision.blockReason = riskCheck.blockReason;

      this.callbacks.onDecision?.(decision);
      this.log('normal', `Decision: ${decision.action} ${decision.market} ${decision.side} | conf=${(decision.confidence * 100).toFixed(0)}% | $${collateral.toFixed(0)} | ${decision.reasoning}`);

      if (decision.riskLevel !== 'blocked') {
        await this.executeTrade(decision, snapshot);
        tickPositionCount++;
        tickCapitalAllocated += collateral;
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
