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
import { selectBestStrategy } from './strategy.js';
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
    this.state = this.createInitialState();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.stopRequested = false;
    this.setStatus(AgentStatus.RUNNING);

    this.log('info', `Agent "${this.config.name}" starting (in-process)`);
    this.log('info', `Markets: ${this.config.markets.join(', ')}`);
    this.log('info', `Strategies: ${this.strategies.map((s) => s.name).join(', ')}`);
    this.log('info', `Risk: max ${this.config.risk.maxPositions} positions, max ${this.config.risk.maxLeverage}x, ${(this.config.risk.positionSizePct * 100).toFixed(0)}% sizing`);
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

    // MONITOR — check existing positions
    await this.monitorPositions(positions);

    // ANALYZE + DECIDE — for each market
    for (const snapshot of snapshots) {
      const marketSignals = this.signals.detect(snapshot);
      const alignment = this.signals.areSignalsAligned(marketSignals);

      this.log('verbose', `${snapshot.market}: ${marketSignals.length} signals, aligned=${alignment.aligned}, dir=${alignment.direction}, strength=${alignment.strength.toFixed(2)}`);

      if (!alignment.aligned) {
        this.log('verbose', `${snapshot.market}: signals conflict — skipping`);
        continue;
      }

      const bestStrategy = selectBestStrategy(this.strategies, snapshot, marketSignals);
      if (!bestStrategy || !bestStrategy.shouldTrade) continue;

      const decision = this.buildDecision(bestStrategy, snapshot);

      this.callbacks.onDecision?.(decision);
      this.log('normal', `Decision: ${decision.action} ${decision.market} ${decision.side ?? ''} | conf=${(decision.confidence * 100).toFixed(0)}% | risk=${decision.riskLevel} | ${decision.reasoning}`);

      if (decision.action === ('open' as DecisionAction) && decision.riskLevel !== 'blocked') {
        await this.executeTrade(decision);
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
      const pnlPct = pos.pnlPercent ?? 0;
      if (pnlPct < -15) {
        this.log('normal', `Emergency close: ${pos.market} ${pos.side} at ${pnlPct.toFixed(1)}% loss`);
        const decision: TradeDecision = {
          action: 'close' as DecisionAction,
          market: pos.market,
          side: pos.side,
          strategy: 'risk_monitor',
          confidence: 1,
          reasoning: `Emergency stop loss: ${pnlPct.toFixed(1)}% drawdown`,
          signals: [],
          riskLevel: 'safe',
        };
        await this.executeClose(decision, pos);
      }
    }
  }

  // ─── Decide ────────────────────────────────────────────────────────

  private buildDecision(strategyResult: NonNullable<ReturnType<typeof selectBestStrategy>>, snapshot: MarketSnapshot): TradeDecision {
    const side = strategyResult.side ?? 'long';
    const leverage = this.risk.clampLeverage(3);
    const collateral = this.risk.calculatePositionSize(this.state.currentCapital);

    if (strategyResult.confidence < this.config.risk.minConfidence) {
      return {
        action: 'skip' as DecisionAction, market: snapshot.market, side, leverage, collateral,
        strategy: strategyResult.strategy, confidence: strategyResult.confidence,
        reasoning: `Confidence ${(strategyResult.confidence * 100).toFixed(0)}% below ${(this.config.risk.minConfidence * 100).toFixed(0)}%`,
        signals: strategyResult.signals, riskLevel: 'safe',
      };
    }

    const decision: TradeDecision = {
      action: 'open' as DecisionAction, market: snapshot.market, side, leverage, collateral,
      tp: strategyResult.suggestedTp, sl: strategyResult.suggestedSl,
      strategy: strategyResult.strategy, confidence: strategyResult.confidence,
      reasoning: strategyResult.reasoning, signals: strategyResult.signals, riskLevel: 'safe',
    };

    const riskCheck = this.risk.assessRisk(decision, this.state);
    decision.riskLevel = riskCheck.riskLevel;
    decision.blockReason = riskCheck.blockReason;
    return decision;
  }

  // ─── Execute (via live flashClient) ────────────────────────────────

  private async executeTrade(decision: TradeDecision): Promise<void> {
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
