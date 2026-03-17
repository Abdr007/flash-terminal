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
// selectBestStrategy kept as fallback import for non-ensemble path

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
    this.state = this.createInitialState();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.stopRequested = false;
    this.setStatus(AgentStatus.RUNNING);

    this.log('info', `Agent "${this.config.name}" v2 starting (in-process)`);
    this.log('info', `Markets: ${this.config.markets.join(', ')}`);
    this.log('info', `Strategies: ${this.strategies.map((s) => s.name).join(', ')}`);
    this.log('info', `Engines: signal-fusion, position-manager (ATR trailing/Kelly), strategy-ensemble`);
    this.log('info', `Risk: max ${this.config.risk.maxPositions} positions, max ${this.config.risk.maxLeverage}x, Kelly sizing`);
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

    // MONITOR — check existing positions with advanced position manager
    await this.monitorPositions(positions);

    // Update position manager performance from journal stats
    const stats = this.journal.getStats();
    if (stats.totalTrades > 0) {
      this.positionMgr.updatePerformance(stats.winRate, stats.avgWin, stats.avgLoss);
    }

    // ANALYZE + DECIDE — for each market using signal fusion + ensemble
    for (const snapshot of snapshots) {
      // Stage 1: Basic signal detection
      const marketSignals = this.signals.detect(snapshot);

      // Stage 2: Signal fusion (multi-factor weighted scoring)
      const composite = this.fusion.fuse(snapshot, snapshot.fundingRate);

      this.log('verbose', `${snapshot.market}: composite=${composite.compositeScore.toFixed(3)} dir=${composite.direction} conf=${(composite.confidence * 100).toFixed(0)}% factors=${composite.confirmedFactors}/${composite.totalFactors} confirmed=${composite.confirmed}`);

      // Stage 3: Strategy ensemble (performance-weighted voting)
      const ensembleDecision = this.ensemble.evaluate(snapshot, marketSignals, composite);

      if (!ensembleDecision.shouldTrade) {
        if (ensembleDecision.votes.some((v) => v.result.shouldTrade)) {
          this.log('verbose', `${snapshot.market}: ${ensembleDecision.reasoning}`);
        }
        continue;
      }

      // Stage 4: Build trade decision with risk assessment
      const decision = this.buildDecisionFromEnsemble(ensembleDecision, snapshot, composite);

      this.callbacks.onDecision?.(decision);
      this.log('normal', `Decision: ${decision.action} ${decision.market} ${decision.side ?? ''} | conf=${(decision.confidence * 100).toFixed(0)}% | risk=${decision.riskLevel} | ${decision.reasoning}`);

      // Stage 5: Execute
      if (decision.action === ('open' as DecisionAction) && decision.riskLevel !== 'blocked') {
        await this.executeTrade(decision, snapshot);
      } else if (decision.riskLevel === 'blocked') {
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
  ): TradeDecision {
    const side = ensembleDecision.side ?? 'long';
    const leverage = this.risk.clampLeverage(3);

    // Kelly-criterion position sizing using composite signal confidence
    const slDistance = snapshot.price * 0.015; // 1.5% initial SL
    const stopLoss = side === 'long' ? snapshot.price - slDistance : snapshot.price + slDistance;
    const sizing = this.positionMgr.calculatePositionSize(
      this.state.currentCapital,
      snapshot.price,
      stopLoss,
      ensembleDecision.confidence,
      leverage,
    );

    const bestResult = ensembleDecision.bestResult;
    const tp = bestResult?.suggestedTp ?? (side === 'long' ? snapshot.price * 1.02 : snapshot.price * 0.98);
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
      collateral: sizing.collateral,
      tp,
      sl,
      strategy: strategyName || 'ensemble',
      confidence: ensembleDecision.confidence,
      reasoning: `${ensembleDecision.reasoning} | Fusion: ${composite.direction} ${(composite.confidence * 100).toFixed(0)}% (${composite.confirmedFactors}F) | Size: $${sizing.collateral.toFixed(0)} (${sizing.method})`,
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
