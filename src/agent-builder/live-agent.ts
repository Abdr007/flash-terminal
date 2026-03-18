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
import { TechnicalAnalyzer } from './technical-indicators.js';
import { ExpectancyEngine } from './expectancy-engine.js';
import { MetaAgent } from './meta-agent.js';
import { OpportunityScorer } from './opportunity-scorer.js';
import { PortfolioIntel } from './portfolio-intel.js';
import { ExecutionModel } from './execution-model.js';
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
  private readonly technicals: TechnicalAnalyzer;
  private readonly expectancy: ExpectancyEngine;
  private readonly meta: MetaAgent;
  private readonly scorer: OpportunityScorer;
  private readonly portfolioIntel: PortfolioIntel;
  /** Signal confirmation: track previous tick's direction per market */
  private prevSignals: Map<string, string> = new Map();
  /** Per-market cooldown after trade close */
  private marketCooldowns: Map<string, number> = new Map();
  /** Hourly trade counter for frequency limiting */
  private hourlyTrades: number[] = [];
  /** Per-market hourly trade counter */
  private marketHourlyTrades: Map<string, number[]> = new Map();
  /** Tick mutex — prevents concurrent tick execution */
  private tickInProgress = false;

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
    this.scanner = new MarketScanner(3, 0.25);
    this.sizer = new DynamicSizer(0.02, 0.005, 0.03);
    this.technicals = new TechnicalAnalyzer();
    this.expectancy = new ExpectancyEngine();
    this.meta = new MetaAgent();
    this.scorer = new OpportunityScorer();
    this.portfolioIntel = new PortfolioIntel(1, 0.20);
    this.state = this.createInitialState();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.stopRequested = false;
    this.setStatus(AgentStatus.RUNNING);

    this.log('info', `Agent "${this.config.name}" v8 (uncertainty-aware) starting`);
    this.log('info', `Scanning: ${this.config.markets.length} markets → score + rank → top trades only`);
    this.log('info', `Strategies: ${this.strategies.map((s) => s.name).join(', ')}`);
    this.log('info', `Engines: meta-agent, opportunity scorer, portfolio intel, EV, Bayesian fusion, technicals`);
    this.log('info', `Mode: adaptive aggression | correlated-trade prevention | self-learning`);
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

      // Tick mutex — skip if previous tick still running
      if (this.tickInProgress) {
        this.log('verbose', 'Tick skipped — previous tick still running');
      } else {
        this.tickInProgress = true;
        try {
          await this.tick();
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.callbacks.onError?.(err, 'tick');
          this.log('error', `Tick error: ${err.message}`);
        } finally {
          this.tickInProgress = false;
        }
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
    // Full cleanup — prevent memory leaks on long sessions
    this.prevSignals.clear();
    this.marketCooldowns.clear();
    this.marketHourlyTrades.clear();
    this.hourlyTrades = [];
    this.fusion.reset();
    this.signals.reset();
    this.positionMgr.reset();
    this.regimeAdapter.reset();
    this.technicals.reset();
    this.meta.reset();
    // Note: expectancy + scorer adaptive weights NOT reset — persist learning
    // this.scorer.reset() — intentionally NOT called
    this.log('info', 'Stop requested — state cleaned (EV stats preserved)');
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

    // ─── PHASE 3: RECORD PRICES + COMPUTE TECHNICALS + SCAN ────────
    // Record every price tick for technical indicator computation
    for (const snapshot of snapshots) {
      this.technicals.record(snapshot.market, snapshot.price);
    }

    const compositeMap = new Map<string, CompositeSignal>();
    for (const snapshot of snapshots) {
      compositeMap.set(snapshot.market, this.fusion.fuse(snapshot, snapshot.fundingRate));
    }

    const rankedMarkets = this.scanner.rank(snapshots, compositeMap);
    const tradeableMarkets = new Set(rankedMarkets.map((r) => r.market));

    if (rankedMarkets.length > 0) {
      this.log('verbose', `Scanner: ${rankedMarkets.map((r) => `${r.market}(${(r.score * 100).toFixed(0)}%)`).join(', ')} | ${snapshots.length - rankedMarkets.length} filtered out`);
    }

    // ─── PHASE 4: META-CONTROLLED SCORING + DECIDE ─────────────────
    const now = Date.now();
    this.hourlyTrades = this.hourlyTrades.filter((t) => now - t < 3_600_000);

    // Forward-looking: feed volatility trend to meta-agent
    const avgVol = snapshots.length > 0
      ? snapshots.reduce((sum, s) => sum + Math.abs(s.priceChange24h), 0) / snapshots.length
      : 0;
    this.meta.recordVolatility(avgVol);

    // META-AGENT: evaluate global conditions → set aggression mode
    const systemEV = this.expectancy.getSystemEV();
    const metaDecision = this.meta.evaluate(
      systemEV,
      this.expectancy.getAllStats(),
      ddState,
      stats.winRate,
      stats.totalTrades,
    );

    if (metaDecision.mode === 'HALT') {
      this.log('normal', `META: HALT — ${metaDecision.reason}`);
      return;
    }

    this.log('verbose', `META: ${metaDecision.reason} | threshold=${metaDecision.scoreThreshold}`);

    // Hard guards (kept as safety net)
    if (this.hourlyTrades.length >= 6) return;
    if (this.state.consecutiveLosses >= 4) { this.log('normal', 'Loss streak 4+ — paused'); return; }

    let tickPositionCount = this.state.positions.length;
    let tickCapitalAllocated = this.state.positions.reduce((sum, p) => sum + (p.collateralUsd ?? 0), 0);
    const maxCapital = this.state.currentCapital * 0.15;

    // Score ALL opportunities, then execute only the best
    const opportunities: Array<{ snapshot: typeof snapshots[0]; score: number; decision: TradeDecision }> = [];

    for (const snapshot of snapshots) {
      if (!tradeableMarkets.has(snapshot.market)) continue;

      // Hard guards (can't soft-gate these)
      const marketCooldown = this.marketCooldowns.get(snapshot.market) ?? 0;
      if (now < marketCooldown) continue;
      const mktTrades = (this.marketHourlyTrades.get(snapshot.market) ?? []).filter((t) => now - t < 3_600_000);
      this.marketHourlyTrades.set(snapshot.market, mktTrades);
      if (mktTrades.length >= 2) continue;

      const regime = this.regimeAdapter.detectRegime(snapshot.market, snapshot.price, snapshot.priceChange24h);
      const regimeParams = this.regimeAdapter.getParams(regime.regime);
      const composite = compositeMap.get(snapshot.market)!;
      const marketSignals = this.signals.detect(snapshot);

      // 2-tick confirmation (hard — prevents noise entries)
      const prevDir = this.prevSignals.get(snapshot.market);
      this.prevSignals.set(snapshot.market, composite.direction);
      if (composite.direction !== 'neutral' && prevDir !== composite.direction) continue;
      if (composite.confidence < 0.30 || !composite.confirmed) continue;

      // Strategy ensemble
      const ed = this.ensemble.evaluate(snapshot, marketSignals, composite);
      if (!ed.shouldTrade) continue;

      // Regime-strategy check (soft — feeds into score)
      const votingStrategies = ed.votes.filter((v) => v.result.shouldTrade && !v.shadow).map((v) => v.strategy);
      const allowedInRegime = this.regimeAdapter.filterStrategies(regime.regime, votingStrategies);
      const regimeAllowed = allowedInRegime.length > 0;

      // EV check (soft — feeds into score)
      const primaryStrategy = allowedInRegime[0] || votingStrategies[0] || 'ensemble';
      const evCheck = this.expectancy.checkEV(primaryStrategy, ed.confidence);

      // Technical signal (soft — feeds into score with reduced weight)
      const techSignal = this.technicals.signal(snapshot.market, snapshot.price);
      const techDataAvailable = this.technicals.dataPoints(snapshot.market) >= 30;
      const side = ed.side ?? 'long';

      // Build trade parameters
      const leverage = this.risk.clampLeverage(Math.min(3, regimeParams.maxLeverage ?? 3));
      const slDistance = snapshot.price * 0.02 * (regimeParams.stopAtrMultiplier ?? 2.0) / 2.0;
      const tpDistance = slDistance * Math.max(metaDecision.minRR, regimeParams.takeProfitR ?? 2.0);
      const tp = ed.bestResult?.suggestedTp ?? (side === 'long' ? snapshot.price + tpDistance : snapshot.price - tpDistance);
      const sl = ed.bestResult?.suggestedSl ?? (side === 'long' ? snapshot.price - slDistance : snapshot.price + slDistance);
      const riskDist = Math.abs(snapshot.price - sl);
      const rewardDist = Math.abs(tp - snapshot.price);
      const rrRatio = riskDist > 0 ? rewardDist / riskDist : 0;

      // Dynamic sizing (meta-adjusted) — compute before scoring for execution cost model
      // UNCERTAINTY: reduce size when signals are unstable (many factors, low confidence)
      let uncertaintyMultiplier = 1.0;
      if (composite.totalFactors >= 3 && composite.confidence < 0.4) {
        uncertaintyMultiplier = 0.5; // High uncertainty → half size
      } else if (composite.totalFactors >= 2 && composite.confidence < 0.5) {
        uncertaintyMultiplier = 0.75; // Moderate uncertainty → 75% size
      }
      const sizing = this.sizer.calculate(this.state.currentCapital, ed.confidence, stats, ddState, regimeParams.sizeMultiplier * metaDecision.sizeMultiplier * uncertaintyMultiplier, this.state.consecutiveLosses);

      // ─── OPPORTUNITY SCORING (adaptive weights + execution costs) ──
      const totalOi = snapshot.longOi + snapshot.shortOi;
      const posSize = sizing.collateral * leverage;
      const oppScore = this.scorer.score(
        composite, ed.confidence, ed.agreeing, ed.totalVoters,
        evCheck, techSignal, techDataAvailable,
        regimeAllowed, rrRatio, metaDecision.scoreThreshold,
        posSize, totalOi, snapshot.price, sl,
      );

      if (!oppScore.passes) {
        this.log('verbose', `${snapshot.market}: score ${oppScore.summary} < threshold ${metaDecision.scoreThreshold}`);
        continue;
      }

      const collateral = Math.min(sizing.collateral, Math.max(1, maxCapital - tickCapitalAllocated));
      const strategyName = (allowedInRegime.length > 0 ? allowedInRegime : votingStrategies).join('+') || 'ensemble';

      const decision: TradeDecision = {
        action: 'open' as DecisionAction,
        market: snapshot.market, side, leverage, collateral, tp, sl,
        strategy: strategyName,
        confidence: ed.confidence,
        reasoning: `SCORE=${oppScore.total} ${oppScore.summary} | ${metaDecision.mode} | ${regime.regime}`,
        signals: ed.bestResult?.signals ?? [],
        riskLevel: 'safe',
      };

      const riskCheck = this.risk.assessRisk(decision, this.state);
      decision.riskLevel = riskCheck.riskLevel;
      decision.blockReason = riskCheck.blockReason;

      // Portfolio intelligence — prevent correlated trades
      const portfolioCheck = this.portfolioIntel.check(this.state.positions, snapshot.market, side, collateral * leverage, this.state.currentCapital);
      if (!portfolioCheck.allowed) {
        this.log('verbose', `${snapshot.market}: portfolio blocked — ${portfolioCheck.reason}`);
        continue;
      }

      if (decision.riskLevel !== 'blocked') {
        opportunities.push({ snapshot, score: oppScore.total, decision });
      }
    }

    // Execute ONLY the best opportunities (sorted by score, up to max positions)
    opportunities.sort((a, b) => b.score - a.score);

    // GLOBAL TRADE FILTER: if best opportunity is weak, do nothing
    const ABSOLUTE_FLOOR = 50; // Never trade below this score regardless of meta threshold
    if (opportunities.length > 0 && opportunities[0].score < ABSOLUTE_FLOOR) {
      this.log('verbose', `Best opportunity ${opportunities[0].decision.market} scored ${opportunities[0].score} < floor ${ABSOLUTE_FLOOR} — no trades this tick`);
      opportunities.length = 0; // Clear all
    }

    for (const opp of opportunities) {
      if (tickPositionCount >= metaDecision.maxPositions) break;
      if (tickCapitalAllocated >= maxCapital) break;

      this.callbacks.onDecision?.(opp.decision);
      this.log('normal', `EXECUTE: ${opp.decision.market} ${opp.decision.side} | ${opp.decision.reasoning}`);

      await this.executeTrade(opp.decision, opp.snapshot);
      tickPositionCount++;
      tickCapitalAllocated += opp.decision.collateral ?? 0;
      this.hourlyTrades.push(now);
      const mt = this.marketHourlyTrades.get(opp.snapshot.market) ?? [];
      mt.push(now);
      this.marketHourlyTrades.set(opp.snapshot.market, mt);
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

      // POST-TRADE LEARNING: update ALL adaptive systems
      const won = pnl > 0;
      this.expectancy.recordTrade(decision.strategy, pnl);
      this.ensemble.recordOutcome(decision.strategy, won);

      // Update fusion engine factor accuracy
      for (const signal of decision.signals) {
        const wasCorrect = (signal.direction === 'bullish' && won && decision.side === 'long') ||
                           (signal.direction === 'bearish' && won && decision.side === 'short');
        this.fusion.recordOutcome(signal.source, wasCorrect);
      }

      // Update ADAPTIVE SCORING WEIGHTS — which components predicted correctly?
      this.scorer.recordOutcome({
        signal: won,           // Did the fusion signal predict correctly?
        strategy: won,         // Did the ensemble pick a winner?
        ev: won,               // Was EV model accurate?
        technicals: won,       // Did technicals align with outcome?
        regime: won,           // Was regime classification correct?
        riskReward: pnl > 0,   // Did the R:R target hold?
      });

      this.callbacks.onTrade?.(entry);
      this.log('normal', `Closed: ${position.market} ${position.side} PnL=$${pnl.toFixed(2)} | weights updated`);
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
