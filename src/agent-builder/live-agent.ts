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
import { CounterfactualTracker } from './counterfactual-tracker.js';
import { MicroEntryAnalyzer } from './micro-entry.js';
import { TimeIntelligence } from './time-intelligence.js';
import { PolicyLearner } from './policy-learner.js';
import { ExitPolicyLearner } from './exit-policy-learner.js';
import { CorrelationGuard } from './correlation-guard.js';
import { SimulationEngine } from './simulation-engine.js';
import { PerformanceDashboard } from './performance-dashboard.js';
import { MacroRegimeDetector } from './macro-regime.js';
import { EdgeRefiner } from './edge-refiner.js';
import { saveAgentState, loadAgentState, buildPersistedState } from './state-persistence.js';
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
  private readonly counterfactual: CounterfactualTracker;
  private readonly microEntry: MicroEntryAnalyzer;
  private readonly timeIntel: TimeIntelligence;
  private readonly policyLearner: PolicyLearner;
  private readonly exitPolicy: ExitPolicyLearner;
  private readonly correlationGuard: CorrelationGuard;
  private readonly simEngine: SimulationEngine;
  private readonly dashboard: PerformanceDashboard;
  private readonly macroRegime: MacroRegimeDetector;
  private readonly edgeRefiner: EdgeRefiner;
  /** Track entry state for policy reward computation */
  private activeTradeStates: Map<string, { state: import('./policy-learner.js').MarketState; action: import('./policy-learner.js').PolicyAction; entryTick: number }> = new Map();
  /** Track exit state for exit policy learning */
  private activeExitStates: Map<string, { state: import('./exit-policy-learner.js').ExitState; lastPnlPct: number }> = new Map();
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
  /** Autosave counter — save state every N ticks */
  private readonly autosaveInterval = 50;
  /** Tick timeout — prevents infinite hang if SDK call stalls */
  private static readonly TICK_TIMEOUT_MS = 180_000; // 3 min — 32 markets × ~2-3s each
  /** Maximum entries per unbounded map — prevents memory leaks in long sessions */
  private static readonly MAX_MAP_ENTRIES = 200;
  /** Maximum journal entries kept in memory */
  private static readonly MAX_JOURNAL_ENTRIES = 2000;
  /** Daily risk reset tracking */
  private lastDailyResetDate = '';
  /** V16: Cached snapshots for fast ticks (refreshed every full scan) */
  private cachedSnapshots: MarketSnapshot[] = [];
  /** V16: Last full scan timestamp */
  private lastFullScanAt = 0;
  /** V17: Rolling trade quality for fast-path gating */
  private recentTradeEVs: number[] = [];
  /** V17: Fast-path vs full-pipeline trade counter for ratio tracking */
  private fastPathCount = 0;
  private fullPipelineCount = 0;
  /** Current regime per market (for exit policy) */
  private marketRegimes: Map<string, string> = new Map();

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
      maxFlatTicks: 30,           // ~5 min flat → close
      flatThresholdPct: 0.3,      // ±0.3% counts as flat
      maxHoldTicks: 120,          // ~20 min max hold — give trades time to develop
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
    this.counterfactual = new CounterfactualTracker();
    this.microEntry = new MicroEntryAnalyzer();
    this.timeIntel = new TimeIntelligence();
    this.policyLearner = new PolicyLearner();
    this.exitPolicy = new ExitPolicyLearner();
    this.correlationGuard = new CorrelationGuard();
    this.simEngine = new SimulationEngine();
    this.dashboard = new PerformanceDashboard();
    this.macroRegime = new MacroRegimeDetector();
    this.edgeRefiner = new EdgeRefiner();
    this.state = this.createInitialState();

    // Restore persisted learning state
    this.restoreState();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.stopRequested = false;
    this.setStatus(AgentStatus.RUNNING);

    this.log('info', `Agent "${this.config.name}" v11 (persistent-learning) starting`);
    this.log('info', `Scanning: ${this.config.markets.length} markets → score + rank → top trades only`);
    this.log('info', `Strategies: ${this.strategies.map((s) => s.name).join(', ')}`);
    this.log('info', `Engines: meta-agent, opportunity scorer, exit-policy, correlation-guard, EV, Bayesian fusion`);
    this.log('info', `Mode: persistent learning | correlation-aware | exit intelligence`);
    const pm = this.policyLearner.getMetrics();
    if (pm.policySize > 0) this.log('info', `Restored: ${pm.policySize} policy states, ${pm.totalUpdates} prior updates`);
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
          // Tick timeout — prevents infinite hang if SDK/RPC call stalls
          await Promise.race([
            this.tick(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Tick timeout exceeded')), LiveTradingAgent.TICK_TIMEOUT_MS),
            ),
          ]);
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.callbacks.onError?.(err, 'tick');
          this.log('error', `Tick error: ${err.message}`);
        } finally {
          this.tickInProgress = false;
        }
      }

      if (this.running && !this.stopRequested) {
        // V16 ADAPTIVE POLLING: fast when volatile, slow when quiet
        let pollMs = this.config.pollIntervalMs;

        // Volatility-adaptive: if recent snapshots show big moves, poll faster
        if (this.cachedSnapshots.length > 0) {
          const avgAbsChange = this.cachedSnapshots.reduce((s, snap) => s + Math.abs(snap.priceChange24h), 0) / this.cachedSnapshots.length;
          if (avgAbsChange > 5) pollMs = Math.round(pollMs * 0.5);        // High vol → 2x faster
          else if (avgAbsChange < 1) pollMs = Math.round(pollMs * 1.5);   // Low vol → 1.5x slower
        }

        // Health degradation override
        try {
          const { getHealth } = await import('../system/health.js');
          const dp = getHealth()?.getDegradationParams();
          if (dp && dp.scanIntervalMultiplier > 1) pollMs = Math.round(pollMs * dp.scanIntervalMultiplier);
        } catch { /* health module may not be loaded */ }

        await sleep(pollMs);
      }
    }

    this.running = false;
    this.setStatus(AgentStatus.STOPPED);
    this.log('info', `Agent stopped after ${this.state.iteration} iterations`);
    this.log('info', `Journal:\n${this.journal.formatStats()}`);
  }

  stop(): void {
    this.stopRequested = true;

    // PERSIST learning state before cleanup
    this.persistState();

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
    this.microEntry.reset();
    this.counterfactual.reset();
    this.simEngine.reset();
    this.macroRegime.reset();
    this.edgeRefiner.reset();
    this.recentTradeEVs = [];
    this.fastPathCount = 0;
    this.fullPipelineCount = 0;
    this.cachedSnapshots = [];
    this.activeTradeStates.clear();
    this.activeExitStates.clear();
    this.marketRegimes.clear();
    this.log('info', 'Stop requested — learning state persisted, memory cleaned');
  }

  getState(): Readonly<AgentState> { return this.state; }
  getJournal(): TradeJournal { return this.journal; }
  getRiskManager(): RiskManager { return this.risk; }
  getDashboard(): PerformanceDashboard { return this.dashboard; }
  get isRunning(): boolean { return this.running; }

  // ─── Core Loop ─────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    this.state.iteration++;
    this.callbacks.onTick?.(this.state, this.state.iteration);

    // DAILY RESET — reset daily PnL tracking at UTC midnight
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (this.lastDailyResetDate && this.lastDailyResetDate !== todayUtc) {
      this.log('info', `Daily reset: ${this.lastDailyResetDate} → ${todayUtc} | PnL=$${this.state.dailyPnl.toFixed(2)}`);
      this.state.dailyPnl = 0;
      this.state.dailyTradeCount = 0;
      this.state.consecutiveLosses = 0;
      // Reset drawdown daily tracking but keep peak equity
      this.drawdown.resume();
    }
    this.lastDailyResetDate = todayUtc;

    // AUTOSAVE — persist learning state periodically
    if (this.state.iteration % this.autosaveInterval === 0) {
      this.persistState();
    }

    if (this.risk.isDailyLossBreached(this.state)) {
      this.safetyStop(`Daily loss limit breached: $${this.state.dailyPnl.toFixed(2)}`);
      return;
    }

    // V17: OBSERVE — TTL-aware caching with quality-gated fast path
    // Price data TTL: 15s (must be fresh for trading decisions)
    // Full scan on first tick, then only when cache expires
    const PRICE_TTL_MS = 15_000;
    const cacheAge = Date.now() - this.lastFullScanAt;
    const needsFullScan = this.cachedSnapshots.length === 0 || cacheAge > PRICE_TTL_MS;

    const [positions, snapshots] = await Promise.all([
      this.fetchPositions(),
      needsFullScan ? this.fetchMarketSnapshots() : Promise.resolve(this.cachedSnapshots),
    ]);

    if (needsFullScan && snapshots.length > 0) {
      this.cachedSnapshots = snapshots;
      this.lastFullScanAt = Date.now();
    }

    // V17: On cached ticks, only monitor positions (no new entries from stale data)
    const isFreshData = needsFullScan || cacheAge < 5_000; // <5s = fresh enough for entries

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
    // Sync drawdown state to policy learner (disables exploration during DD)
    this.policyLearner.setDrawdownState(ddState.drawdownPct > 0.05);

    // Dashboard halt check (recording moved to after meta-agent for correct mode)
    const haltCheck = this.dashboard.shouldHalt();
    if (haltCheck.halt) {
      this.safetyStop(`Dashboard halt: ${haltCheck.reason}`);
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
    // Always record prices (even from cache — updates technical history)
    for (const snapshot of snapshots) {
      this.technicals.record(snapshot.market, snapshot.price);
      this.exitPolicy.recordPrice(snapshot.market, snapshot.price);
      this.correlationGuard.recordPrice(snapshot.market, snapshot.price);
    }

    // V17: Cached ticks only monitor positions — no new entries from stale data
    if (!isFreshData) {
      this.log('verbose', `Fast tick (cache age ${Math.round(cacheAge / 1000)}s) — monitoring only`);
      return;
    }

    // MACRO REGIME: cross-asset environment detection (only on fresh data)
    const macro = this.macroRegime.update(snapshots);
    if (macro.tradesBlocked) {
      this.log('normal', `MACRO RISK-OFF: ${macro.regime} (BTC ${macro.btcTrend}, vol ${macro.avgVolatility.toFixed(1)}%, corr ${(macro.correlationStrength * 100).toFixed(0)}%) — trades blocked`);
      return;
    }
    if (macro.regime !== 'NEUTRAL') {
      this.log('verbose', `MACRO: ${macro.regime} (BTC ${macro.btcTrend}, size ${(macro.sizeMultiplier * 100).toFixed(0)}%, bias ${macro.strategyBias})`);
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

    // MEMORY SAFETY: periodic cleanup of per-market maps (every 100 ticks)
    if (this.state.iteration % 100 === 0) {
      this.evictStaleMaps(now);
    }

    // MEMORY SAFETY: cap journal entries
    if (this.journal.getEntries().length > LiveTradingAgent.MAX_JOURNAL_ENTRIES) {
      const recent = this.journal.getRecent(LiveTradingAgent.MAX_JOURNAL_ENTRIES);
      this.journal.clear();
      for (const entry of recent) this.journal.record(
        { action: entry.action, market: entry.market, side: entry.side, leverage: entry.leverage, collateral: entry.collateral, strategy: entry.strategy, confidence: entry.confidence, reasoning: entry.reasoning, signals: entry.signals, riskLevel: 'safe' } as TradeDecision,
        { entryPrice: entry.entryPrice, exitPrice: entry.exitPrice, pnl: entry.pnl, pnlPercent: entry.pnlPercent, fees: entry.fees, error: entry.error },
      );
    }

    // Evaluate counterfactual + simulation outcomes from previous ticks
    this.counterfactual.evaluate(snapshots);
    this.simEngine.resolve(snapshots);

    // Record micro-entry prices
    for (const s of snapshots) this.microEntry.record(s.market, s.price);

    // TIME INTELLIGENCE: check if current hour is historically profitable
    const timeCheck = this.timeIntel.check();
    if (!timeCheck.allowed) {
      this.log('verbose', `Time filter: ${timeCheck.reason}`);
      return;
    }

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

    // DEGRADATION DETECTION: if policy performance is dropping, go conservative
    const policyMetrics = this.policyLearner.getMetrics();
    if (policyMetrics.degrading && metaDecision.mode === 'AGGRESSIVE') {
      metaDecision.mode = 'NORMAL' as typeof metaDecision.mode;
      metaDecision.scoreThreshold = 65;
      metaDecision.sizeMultiplier = 1.0;
      this.log('normal', `DEGRADATION detected (shortSharpe=${policyMetrics.shortSharpe.toFixed(2)} vs ${policyMetrics.sharpe.toFixed(2)}) — downgraded to NORMAL`);
    }

    // COLD-START RAMP: relax thresholds until enough trades to learn from.
    // Linearly ramp from exploration floor → normal threshold over first 15 trades.
    // After 15 trades the system has EV data, strategy weights, and technicals.
    // Uses half-size during cold-start to limit risk while exploring.
    const COLD_START_TRADES = 15;
    const COLD_START_THRESHOLD = 40;  // Floor during exploration
    const COLD_START_FLOOR = 30;      // Absolute floor during exploration
    if (stats.totalTrades < COLD_START_TRADES) {
      const rampProgress = stats.totalTrades / COLD_START_TRADES; // 0 → 1
      const normalThreshold = metaDecision.scoreThreshold;
      metaDecision.scoreThreshold = Math.round(COLD_START_THRESHOLD + (normalThreshold - COLD_START_THRESHOLD) * rampProgress);
      // Reduce size during cold-start (half-size to limit exploration risk)
      metaDecision.sizeMultiplier *= Math.max(0.5, 0.5 + 0.5 * rampProgress);
      if (stats.totalTrades === 0) {
        this.log('normal', `COLD START: threshold=${metaDecision.scoreThreshold} (ramp 0/${COLD_START_TRADES}) | half-size exploration`);
      }
    }

    this.log('verbose', `META: ${metaDecision.reason} | threshold=${metaDecision.scoreThreshold} | LR=${policyMetrics.learningRate.toFixed(3)} explore=${(policyMetrics.explorationRate * 100).toFixed(1)}%`);

    // DASHBOARD: record tick with correct mode
    this.dashboard.recordTick(this.state.iteration, this.state.currentCapital, metaDecision.mode, policyMetrics.explorationRate);

    // Hard guards (kept as safety net)
    if (this.hourlyTrades.length >= 6) return;
    // Loss streak pause: skip 5 ticks (~50s cooldown), then resume with reduced size
    if (this.state.consecutiveLosses >= 4) {
      const ticksSinceLastTrade = this.state.lastTradeTimestamp > 0
        ? Math.floor((Date.now() - this.state.lastTradeTimestamp) / (this.config.pollIntervalMs || 10_000))
        : 999;
      if (ticksSinceLastTrade < 5) {
        this.log('normal', `Loss streak ${this.state.consecutiveLosses} — cooling down (${5 - ticksSinceLastTrade} ticks remaining)`);
        return;
      }
      // After cooldown, reset streak so agent can try again (meta-agent already reduces aggression)
      this.log('normal', `Loss streak cooldown expired — resuming with conservative mode`);
      this.state.consecutiveLosses = 0;
    }

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
      this.marketRegimes.set(snapshot.market, regime.regime);

      // EDGE REFINER V2: scale down (not block) regimes with negative EV
      const regimeRefinerMult = this.edgeRefiner.getRegimeMultiplier(regime.regime);

      const composite = compositeMap.get(snapshot.market)!;
      const marketSignals = this.signals.detect(snapshot);

      // 2-tick confirmation (hard — prevents noise entries)
      const prevDir = this.prevSignals.get(snapshot.market);
      this.prevSignals.set(snapshot.market, composite.direction);
      if (composite.direction !== 'neutral' && prevDir !== composite.direction) continue;
      if (composite.confidence < 0.30 || !composite.confirmed) continue;

      // POLICY LEARNER: ask learned policy what to do in this state
      const policyState = this.policyLearner.buildState(
        regime.regime,
        composite.direction,
        composite.confidence,
        Math.abs(snapshot.priceChange24h),
        stats.winRate,
      );
      const policyRec = this.policyLearner.recommend(policyState);

      // COLD-START OVERRIDE: ignore policy SKIP during first 15 trades — need data to learn from
      const ignorePolicySkip = stats.totalTrades < COLD_START_TRADES;
      if (!policyRec.action.startsWith('trade') && !policyRec.isExploration && !ignorePolicySkip) {
        this.log('verbose', `${snapshot.market}: policy recommends SKIP (conf=${(policyRec.confidence * 100).toFixed(0)}%)`);
        // Still simulate for learning
        this.simEngine.simulate(snapshot.market, composite.direction === 'bearish' ? 'short' : 'long', snapshot.price, 0, 'policy_skip', regime.regime, composite.confidence);
        continue;
      }

      // Apply policy parameters to confidence floor
      const policyParams = this.policyLearner.actionToParams(policyRec.action);

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

      // Build trade parameters — ensure minimum SL/TP distance for viable R:R
      const leverage = this.risk.clampLeverage(Math.min(3, regimeParams.maxLeverage ?? 3));
      const minSlPct = 0.015; // Minimum 1.5% stop distance
      const slDistance = Math.max(snapshot.price * minSlPct, snapshot.price * 0.02 * (regimeParams.stopAtrMultiplier ?? 2.0) / 2.0);
      const tpDistance = slDistance * Math.max(2.0, regimeParams.takeProfitR ?? 2.0); // Always at least 2:1
      const defaultTp = side === 'long' ? snapshot.price + tpDistance : snapshot.price - tpDistance;
      const defaultSl = side === 'long' ? snapshot.price - slDistance : snapshot.price + slDistance;
      // Use strategy suggestion if it gives BETTER R:R, otherwise use defaults
      const sugTp = ed.bestResult?.suggestedTp;
      const sugSl = ed.bestResult?.suggestedSl;
      const sugRR = sugTp && sugSl ? Math.abs(sugTp - snapshot.price) / Math.abs(snapshot.price - sugSl) : 0;
      const defRR = tpDistance / slDistance;
      const tp = (sugTp && sugRR >= defRR) ? sugTp : defaultTp;
      const sl = (sugSl && sugRR >= defRR) ? sugSl : defaultSl;
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
      const sizing = this.sizer.calculate(this.state.currentCapital, ed.confidence, stats, ddState, regimeParams.sizeMultiplier * metaDecision.sizeMultiplier * uncertaintyMultiplier * macro.sizeMultiplier * regimeRefinerMult, this.state.consecutiveLosses);

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
        // COUNTERFACTUAL: record this skip to learn from later
        this.counterfactual.recordSkip(snapshot.market, side, snapshot.price, oppScore.total, `score<${metaDecision.scoreThreshold}`, primaryStrategy);
        continue;
      }

      const strategyName = (allowedInRegime.length > 0 ? allowedInRegime : votingStrategies).join('+') || 'ensemble';

      // EDGE REFINER: skip strategies that have been disabled due to negative EV
      if (this.edgeRefiner.isStrategyDisabled(strategyName)) {
        this.log('verbose', `${snapshot.market}: strategy '${strategyName}' disabled by edge refiner`);
        this.counterfactual.recordSkip(snapshot.market, side, snapshot.price, oppScore.total, 'refiner_disabled', strategyName);
        continue;
      }

      // Compute base collateral (further adjustments applied after all gates pass)
      const baseCollateral = Math.max(1, Math.min(sizing.collateral, Math.max(1, maxCapital - tickCapitalAllocated)) * this.edgeRefiner.getSizeMultiplier());

      const decision: TradeDecision = {
        action: 'open' as DecisionAction,
        market: snapshot.market, side, leverage, collateral: baseCollateral, tp, sl,
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
      const portfolioCheck = this.portfolioIntel.check(this.state.positions, snapshot.market, side, baseCollateral * leverage, this.state.currentCapital);
      if (!portfolioCheck.allowed) {
        this.log('verbose', `${snapshot.market}: portfolio blocked — ${portfolioCheck.reason}`);
        this.counterfactual.recordSkip(snapshot.market, side, snapshot.price, oppScore.total, 'portfolio', primaryStrategy);
        continue;
      }

      // CORRELATION GUARD — prevent hidden leverage in correlated assets
      const corrCheck = this.correlationGuard.check(this.state.positions, snapshot.market, side, baseCollateral * leverage, this.state.currentCapital);
      if (!corrCheck.allowed) {
        this.log('verbose', `${snapshot.market}: correlation blocked — ${corrCheck.reason}`);
        this.counterfactual.recordSkip(snapshot.market, side, snapshot.price, oppScore.total, 'correlation', primaryStrategy);
        continue;
      }
      // MICRO-ENTRY: check if current price is good for entry
      const microCheck = this.microEntry.check(snapshot.market, side, snapshot.price);
      if (!microCheck.enterNow) {
        this.log('verbose', `${snapshot.market}: micro-entry poor — ${microCheck.reason}`);
        this.counterfactual.recordSkip(snapshot.market, side, snapshot.price, oppScore.total, 'micro_entry', primaryStrategy);
        continue;
      }

      // Apply all remaining size adjustments (correlation, time, policy)
      let finalCollateral = baseCollateral;
      if (corrCheck.sizeMultiplier < 1.0) finalCollateral = Math.max(1, finalCollateral * corrCheck.sizeMultiplier);
      if (timeCheck.sizeMultiplier !== 1.0) finalCollateral = Math.max(1, finalCollateral * timeCheck.sizeMultiplier);

      // Apply micro-entry quality to score (excellent = bonus, poor already filtered)
      const microBonus = microCheck.quality === 'excellent' ? 5 : microCheck.quality === 'good' ? 2 : 0;
      const finalScore = oppScore.total + microBonus;

      // Apply policy size multiplier and set final collateral on decision
      if (policyParams.sizeMultiplier !== 1.0) finalCollateral = Math.max(1, finalCollateral * policyParams.sizeMultiplier);
      decision.collateral = finalCollateral;

      // SIMULATION: record every scored opportunity for parallel learning
      this.simEngine.simulate(
        snapshot.market, side, snapshot.price, finalScore,
        decision.strategy, regime.regime, ed.confidence,
      );

      if (decision.riskLevel !== 'blocked') {
        // Store policy state for reward computation on close
        this.activeTradeStates.set(`${snapshot.market}:${side}`, {
          state: policyState, action: policyRec.action, entryTick: this.state.iteration,
        });
        opportunities.push({ snapshot, score: finalScore, decision });
      }
    }

    // Execute ONLY the best opportunities (sorted by score, up to max positions)
    opportunities.sort((a, b) => b.score - a.score);

    // SYSTEM HEALTH GATE: block or raise thresholds when runtime is degraded
    let healthThresholdMult = 1.0;
    try {
      const { getHealth } = await import('../system/health.js');
      const h = getHealth();
      if (h?.isTradeBlocked()) {
        this.log('normal', 'System health CRITICAL — skipping trade execution');
        opportunities.length = 0;
      } else if (h) {
        healthThresholdMult = h.getDegradationParams().tradeThresholdMultiplier;
      }
    } catch { /* health module may not be loaded */ }

    // V17: TRADE QUALITY FILTER — if recent EV is negative, raise thresholds
    let qualityMult = 1.0;
    if (this.recentTradeEVs.length >= 10) {
      const rollingEV = this.recentTradeEVs.reduce((a, b) => a + b, 0) / this.recentTradeEVs.length;
      if (rollingEV < 0) {
        qualityMult = 1.3; // Raise threshold 30% when recent trades are negative EV
        this.log('verbose', `V17: Rolling EV $${rollingEV.toFixed(2)} < 0 — threshold raised 30%`);
      }
    }

    // V17: FAST PATH RATIO — limit fast-path trades to 40% of total
    const totalClassified = this.fastPathCount + this.fullPipelineCount;
    const fastRatio = totalClassified > 10 ? this.fastPathCount / totalClassified : 0;
    const fastPathAllowed = fastRatio < 0.4;

    // GLOBAL TRADE FILTER
    const baseFloor = stats.totalTrades < COLD_START_TRADES
      ? Math.round(COLD_START_FLOOR + (50 - COLD_START_FLOOR) * (stats.totalTrades / COLD_START_TRADES))
      : 50;
    const effectiveFloor = Math.round(baseFloor * healthThresholdMult * qualityMult);
    if (opportunities.length > 0 && opportunities[0].score < effectiveFloor) {
      this.log('verbose', `Best opportunity ${opportunities[0].decision.market} scored ${opportunities[0].score} < floor ${effectiveFloor} — no trades this tick`);
      opportunities.length = 0; // Clear all
    }

    for (const opp of opportunities) {
      if (tickPositionCount >= metaDecision.maxPositions) break;
      if (tickCapitalAllocated >= maxCapital) break;

      // V17: Tier classification
      const isTier1 = opp.decision.confidence >= 0.75
        && opp.score >= effectiveFloor + 10
        && opp.decision.riskLevel === 'safe';
      const tier = isTier1 && fastPathAllowed ? 'T1-FAST' : 'T2-FULL';
      if (isTier1) this.fastPathCount++; else this.fullPipelineCount++;

      this.callbacks.onDecision?.(opp.decision);
      this.log('normal', `EXECUTE [${tier}]: ${opp.decision.market} ${opp.decision.side} | ${opp.decision.reasoning}`);

      // AUDIT: log execution
      this.dashboard.audit({
        tick: this.state.iteration,
        timestamp: new Date().toISOString(),
        market: opp.decision.market,
        state: `${opp.decision.strategy}`,
        action: `open_${opp.decision.side}`,
        score: opp.score,
        outcome: 'executed',
        reasoning: opp.decision.reasoning,
      });

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

  /** V16: Parallel market fetch with concurrency limit + single OI/volume call */
  private async fetchMarketSnapshots(): Promise<MarketSnapshot[]> {
    const { SolanaInspector } = await import('../agent/solana-inspector.js');
    const inspector = new SolanaInspector(
      this.context.flashClient,
      this.context.dataClient,
    );

    // Fetch global data ONCE (not per-market)
    let oiData: { markets?: Array<{ market: string; longOi: number; shortOi: number }> } | null = null;
    let volumeData: { totalVolumeUsd?: number } | null = null;
    try { [oiData, volumeData] = await Promise.all([
      inspector.getOpenInterest().catch(() => null),
      inspector.getVolume().catch(() => null),
    ]); } catch { /* non-critical */ }

    // Parallel market fetch with concurrency limit
    const CONCURRENCY = 8;
    const markets = this.config.markets;
    const snapshots: MarketSnapshot[] = [];

    for (let i = 0; i < markets.length; i += CONCURRENCY) {
      const batch = markets.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (market) => {
          const [marketData] = await inspector.getMarkets(market);
          if (!marketData) return null;

          const md = marketData as MarketData & Record<string, unknown>;
          const oiMarket = oiData?.markets?.find(
            (m) => m.market.toUpperCase() === market.toUpperCase(),
          );
          const longOi = oiMarket?.longOi ?? (md.openInterestLong as number) ?? 0;
          const shortOi = oiMarket?.shortOi ?? (md.openInterestShort as number) ?? 0;
          const totalOi = longOi + shortOi;

          return {
            market: market.toUpperCase(),
            price: marketData.price ?? 0,
            priceChange24h: marketData.priceChange24h ?? 0,
            volume24h: volumeData?.totalVolumeUsd ?? 0,
            longOi,
            shortOi,
            oiRatio: totalOi > 0 ? longOi / totalOi : 0.5,
            fundingRate: (md.fundingRate as number) ?? undefined,
            timestamp: Date.now(),
          } as MarketSnapshot;
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          snapshots.push(result.value);
        }
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
      const pnlPct = pos.pnlPercent ?? 0;
      const tradeKey = `${pos.market}:${pos.side}`;

      // SAFETY: Hard emergency stop at -15% — NEVER overridden by exit policy
      if (pnlPct < -15) {
        this.log('normal', `Emergency close: ${pos.market} ${pos.side} at ${pnlPct.toFixed(1)}%`);
        await this.closeWithReason(pos, 'emergency', `Emergency stop: ${pnlPct.toFixed(1)}% drawdown`);
        this.positionMgr.untrack(pos.market, pos.side);
        continue;
      }

      // Use PositionManager for advanced tracking
      const managed = this.positionMgr.update(pos);

      if (managed) {
        // For trailing stop / hard stop from position manager — always obey
        if (managed.action === 'trailing_stop_hit' || managed.action === 'close') {
          this.log('normal', `${managed.action}: ${pos.market} ${pos.side} — ${managed.reason}`);
          await this.closeWithReason(pos, managed.action === 'trailing_stop_hit' ? 'trailing_stop' : 'risk_monitor', managed.reason);
          this.positionMgr.untrack(pos.market, pos.side);
          continue;
        }

        // For hold/partial/time_decay — consult exit policy learner
        if (managed.action === 'hold' || managed.action === 'partial_close' || managed.action === 'time_decay_exit') {
          const ts = this.activeTradeStates.get(tradeKey);
          const holdingTicks = ts ? this.state.iteration - ts.entryTick : 0;
          const regime = this.marketRegimes.get(pos.market) ?? 'RANGING';

          // Compute distance to TP/SL (approximate from position data)
          const entryPrice = pos.entryPrice ?? 0;
          const markPrice = pos.markPrice ?? entryPrice;
          const liqPrice = pos.liquidationPrice ?? 0;
          const distToSlPct = entryPrice > 0 && liqPrice > 0
            ? Math.abs(markPrice - liqPrice) / entryPrice * 100 : 50;
          // Approximate TP distance from R-multiple targets
          const distToTpPct = managed.rMultiple < 1 ? Math.max(0, (1 - managed.rMultiple) * 3) : 0;

          const momentum = this.exitPolicy.getMomentumState(pos.market, pos.side as 'long' | 'short');
          const exitState = this.exitPolicy.buildState(pnlPct, holdingTicks, regime, distToTpPct, distToSlPct, momentum);
          const ddState = this.drawdown.getState();
          const exitRec = this.exitPolicy.recommend(exitState, ddState.drawdownPct > 0.05);

          // Track exit state for learning
          const prevExitState = this.activeExitStates.get(tradeKey);
          this.activeExitStates.set(tradeKey, { state: exitState, lastPnlPct: pnlPct });

          // Learn from previous exit decision
          if (prevExitState && ts) {
            const pnlChange = pnlPct - prevExitState.lastPnlPct;
            const exitReward = this.exitPolicy.computeExitReward(
              prevExitState.lastPnlPct, managed.rMultiple, holdingTicks, 'hold', pnlChange,
            );
            if (Math.abs(exitReward) > 0.005) {
              this.exitPolicy.update(prevExitState.state, 'hold', exitReward);
            }
          }

          // EXIT POLICY DECISION — only trusted recommendations override position manager
          if (!exitRec.isExploration && exitRec.confidence > 0.5) {
            if (exitRec.action === 'full_close') {
              this.log('normal', `Exit policy: CLOSE ${pos.market} ${pos.side} (conf=${(exitRec.confidence * 100).toFixed(0)}%, PnL=${pnlPct.toFixed(1)}%, momentum=${momentum})`);
              await this.closeWithReason(pos, 'exit_policy', `Learned exit: conf=${(exitRec.confidence * 100).toFixed(0)}%`);
              this.positionMgr.untrack(pos.market, pos.side);
              continue;
            } else if (exitRec.action === 'partial_close') {
              this.log('normal', `Exit policy: PARTIAL ${pos.market} ${pos.side} 50% (conf=${(exitRec.confidence * 100).toFixed(0)}%)`);
              await this.closeWithReason(pos, 'exit_policy', `Learned partial exit`, 50);
              continue;
            } else if (exitRec.action === 'tighten_stop') {
              // Tighten stop: reduce SL distance by 30% (applied via position manager)
              this.log('verbose', `Exit policy: TIGHTEN STOP ${pos.market} ${pos.side} (momentum=${momentum})`);
              // Signal position manager to tighten (advisory — PositionManager uses
              // trailing stops internally; tighten_stop reduces the trail distance)
              this.log('verbose', `Tighten stop advisory: ${pos.market} ${pos.side}`);
            } else if (exitRec.action === 'extend_tp') {
              // Extend TP: let position run further
              this.log('verbose', `Exit policy: EXTEND TP ${pos.market} ${pos.side} (momentum=${momentum})`);
              // This is a no-op on the position — we just don't close, letting it ride
            }
            // hold, tighten_stop, extend_tp → fall through to position manager logic
          }

          // Fall back to position manager decisions
          if (managed.action === 'partial_close') {
            this.log('normal', `Scale-out: ${pos.market} ${pos.side} ${managed.closePercent}% — ${managed.reason}`);
            await this.closeWithReason(pos, 'scale_out', managed.reason, managed.closePercent);
          } else if (managed.action === 'time_decay_exit') {
            this.log('normal', `Time decay: ${pos.market} ${pos.side} — ${managed.reason}`);
            await this.closeWithReason(pos, 'time_decay', managed.reason);
            this.positionMgr.untrack(pos.market, pos.side);
          } else {
            // Hold — intermediate reward shaping
            this.log('verbose', `Hold: ${pos.market} ${pos.side} — ${managed.reason}`);
            if (ts) {
              const intReward = this.policyLearner.computeIntermediateReward(pnlPct, managed.rMultiple, holdingTicks);
              if (Math.abs(intReward) > 0.01) {
                this.policyLearner.update(ts.state, ts.action, intReward);
              }
            }
          }
          continue;
        }
      }

      // Fallback for untracked positions — use exit policy or simple rules
      const ts = this.activeTradeStates.get(tradeKey);
      const holdingTicks = ts ? this.state.iteration - ts.entryTick : 0;
      const regime = this.marketRegimes.get(pos.market) ?? 'RANGING';
      const fallbackMomentum = this.exitPolicy.getMomentumState(pos.market, pos.side as 'long' | 'short');
      const exitState = this.exitPolicy.buildState(pnlPct, holdingTicks, regime, 10, 10, fallbackMomentum);
      const ddState = this.drawdown.getState();
      const exitRec = this.exitPolicy.recommend(exitState, ddState.drawdownPct > 0.05);

      if (!exitRec.isExploration && exitRec.confidence > 0.5 && exitRec.action !== 'hold') {
        this.log('normal', `Exit policy (untracked): ${exitRec.action} ${pos.market} ${pos.side} (conf=${(exitRec.confidence * 100).toFixed(0)}%)`);
        const closePct = exitRec.action === 'partial_close' ? 50 : undefined;
        await this.closeWithReason(pos, 'exit_policy', `Learned exit`, closePct);
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

      // Time intelligence: record when this trade happened
      this.timeIntel.record(pnl);

      // POLICY LEARNER: compute reward and update policy
      const tradeKey = `${position.market}:${position.side}`;
      const tradeState = this.activeTradeStates.get(tradeKey);
      if (tradeState) {
        const holdingTicks = this.state.iteration - tradeState.entryTick;
        const reward = this.policyLearner.computeReward(pnl, decision.collateral ?? 100, decision.leverage ?? 3, holdingTicks);
        this.policyLearner.update(tradeState.state, tradeState.action, reward);
        this.activeTradeStates.delete(tradeKey);
        const pm = this.policyLearner.getMetrics();
        this.log('verbose', `Policy: reward=${reward.toFixed(3)} ${tradeState.action} | LR=${pm.learningRate.toFixed(3)} explore=${(pm.explorationRate * 100).toFixed(0)}% sharpe=${pm.sharpe.toFixed(2)} states=${pm.policySize}`);
      }

      // EXIT POLICY: update exit learner with final outcome
      const exitState = this.activeExitStates.get(tradeKey);
      if (exitState) {
        const exitAction = decision.closePercent && decision.closePercent < 100 ? 'partial_close' as const : 'full_close' as const;
        // Reward closing: positive if avoiding further loss, negative if cutting winner
        const exitReward = this.exitPolicy.computeExitReward(
          exitState.lastPnlPct, pnl / Math.max(1, decision.collateral ?? 100), // R-multiple approx
          tradeState ? this.state.iteration - tradeState.entryTick : 0,
          exitAction, 0, // No subsequent price change for final close
        );
        this.exitPolicy.update(exitState.state, exitAction, exitReward);
        this.activeExitStates.delete(tradeKey);
      }

      // Log simulation + counterfactual insights periodically
      const simInsights = this.simEngine.getInsights();
      if (simInsights.resolved >= 10) {
        this.log('verbose', `Sim: ${simInsights.resolved} resolved, WR=${(simInsights.simWinRate * 100).toFixed(0)}%, optimal threshold=${simInsights.optimalThreshold}`);
      }
      const cf = this.counterfactual.getInsights();
      if (cf.missedWins + cf.correctSkips >= 5) {
        this.log('verbose', `Skip analysis: ${cf.correctSkips} correct, ${cf.missedWins} missed (accuracy ${(cf.skipAccuracy * 100).toFixed(0)}%)`);
      }

      // DASHBOARD: record trade + audit
      this.dashboard.recordTrade(pnl, decision.strategy);
      this.dashboard.audit({
        tick: this.state.iteration,
        timestamp: new Date().toISOString(),
        market: position.market,
        state: `${position.side}`,
        action: 'close',
        score: 0,
        outcome: 'executed',
        reward: tradeState ? this.policyLearner.computeReward(pnl, decision.collateral ?? 100, decision.leverage ?? 3, tradeState ? this.state.iteration - tradeState.entryTick : 0) : undefined,
        pnl,
        reasoning: decision.reasoning,
      });

      this.callbacks.onTrade?.(entry);
      this.log('normal', `Closed: ${position.market} ${position.side} PnL=$${pnl.toFixed(2)} | policy+weights updated`);

      // V17: Track rolling trade quality for fast-path gating
      this.recentTradeEVs.push(pnl);
      if (this.recentTradeEVs.length > 20) this.recentTradeEVs.shift();

      // V17: Learning protection — log rapid trading warning for awareness
      if (this.hourlyTrades.length > 4) {
        this.log('verbose', `V17: Rapid trading (${this.hourlyTrades.length} trades/hr) — meta-agent handles aggression`);
      }

      // EDGE REFINEMENT: check if cycle should run
      const closedCount = this.journal.getStats().totalTrades;
      if (this.edgeRefiner.shouldRefine(closedCount)) {
        const refinement = this.edgeRefiner.refine(
          this.journal.getEntries(),
          this.journal.getStats(),
          this.policyLearner.getMetrics(),
        );
        if (refinement.type !== 'no_action') {
          this.log('info', `EDGE REFINER: ${refinement.type} → ${refinement.target} | ${refinement.reason}`);
        }
      }
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

  // ─── State Persistence ──────────────────────────────────────────────

  private persistState(): void {
    try {
      const state = buildPersistedState({
        policy: this.policyLearner,
        exitPolicy: this.exitPolicy,
        expectancy: this.expectancy,
        adaptiveWeights: this.scorer.adaptiveWeights,
        timeIntel: this.timeIntel,
      });
      if (saveAgentState(state)) {
        this.log('verbose', `State persisted (${state.policy.entries.length} policy, ${state.exitPolicy.entries.length} exit, ${state.expectancy.strategies.length} strategies)`);
      }
    } catch (error: unknown) {
      this.log('error', `Failed to persist state: ${error instanceof Error ? error.message : error}`);
    }
  }

  private restoreState(): void {
    try {
      const saved = loadAgentState();
      if (!saved) return;

      this.policyLearner.restore(saved.policy);
      this.exitPolicy.restore(saved.exitPolicy);
      this.expectancy.restore(saved.expectancy);
      if (Array.isArray(saved.adaptiveWeights)) {
        this.scorer.adaptiveWeights.restore(saved.adaptiveWeights);
      }
      if (Array.isArray(saved.timeIntel)) {
        this.timeIntel.restore(saved.timeIntel);
      }
    } catch (error: unknown) {
      this.log('error', `Failed to restore state: ${error instanceof Error ? error.message : error}`);
      // Continue with fresh state — non-fatal
    }
  }

  // ─── Memory Safety ──────────────────────────────────────────────

  /**
   * Evict stale entries from per-market Maps to prevent unbounded growth.
   * Called periodically (every 100 ticks) during long-running sessions.
   */
  private evictStaleMaps(now: number): void {
    const maxEntries = LiveTradingAgent.MAX_MAP_ENTRIES;
    const activeMarkets = new Set(this.config.markets.map((m) => m.toUpperCase()));

    // Clean marketHourlyTrades — remove stale timestamps and inactive markets
    for (const [market, trades] of this.marketHourlyTrades) {
      const fresh = trades.filter((t) => now - t < 3_600_000);
      if (fresh.length === 0 && !activeMarkets.has(market.toUpperCase())) {
        this.marketHourlyTrades.delete(market);
      } else {
        this.marketHourlyTrades.set(market, fresh);
      }
    }

    // Clean expired cooldowns
    for (const [market, expiry] of this.marketCooldowns) {
      if (now > expiry) this.marketCooldowns.delete(market);
    }

    // Cap prevSignals — only keep active markets
    if (this.prevSignals.size > maxEntries) {
      for (const key of this.prevSignals.keys()) {
        if (!activeMarkets.has(key.toUpperCase())) this.prevSignals.delete(key);
      }
    }

    // Cap marketRegimes — only keep active markets
    if (this.marketRegimes.size > maxEntries) {
      for (const key of this.marketRegimes.keys()) {
        if (!activeMarkets.has(key.toUpperCase())) this.marketRegimes.delete(key);
      }
    }

    // Clean stale activeTradeStates — entries older than 6 hours are leaked
    const maxTradeAge = 6 * 3_600_000 / (this.config.pollIntervalMs || 10_000); // 6h in ticks
    for (const [key, ts] of this.activeTradeStates) {
      if (this.state.iteration - ts.entryTick > maxTradeAge) {
        this.activeTradeStates.delete(key);
      }
    }

    // Clean stale activeExitStates — must match activeTradeStates
    for (const key of this.activeExitStates.keys()) {
      if (!this.activeTradeStates.has(key)) {
        this.activeExitStates.delete(key);
      }
    }
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
