/* eslint-disable max-lines -- core agent orchestrator; V12-V18 intelligence layers require cohesive class */
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
import { MarketEventBus, MarketEventType } from './event-bus.js';
import { DecisionCache } from './decision-cache.js';
import { PerfMetrics } from './perf-metrics.js';
import { PredictiveEngine } from './predictive-engine.js';
import { OrderbookIntel } from './orderbook-intel.js';
import { AgentCoordinator } from './agent-coordinator.js';
import { LatencyMode } from './latency-mode.js';
import { OpportunityLearner } from './opportunity-learner.js';
import { ExecutionFeedback } from './execution-feedback.js';
import { AdaptiveExecutor } from './adaptive-executor.js';
import { ExecutionKillswitch } from './execution-killswitch.js';
import { EdgeProfiler } from './edge-profiler.js';
import { SystemGovernor } from './system-governor.js';
import { SignalPressure } from './signal-pressure.js';
import { ProductionValidator } from './production-validator.js';
import { saveAgentState, loadAgentState, buildPersistedState } from './state-persistence.js';
import { writeHeartbeat, writePidFile, cleanPidFile, cleanHeartbeat } from '../agent/agent-runtime.js';
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
  /** V_SUPREME: Event-driven market event bus */
  private readonly eventBus: MarketEventBus;
  /** V_SUPREME: Decision cache for fast-path evaluation */
  private readonly decisionCache: DecisionCache;
  /** V_SUPREME: Performance metrics tracker */
  private readonly perf: PerfMetrics;
  /** V_SUPREME: Execution queue — decouples signal from execution */
  private executionQueue: Array<{ decision: TradeDecision; snapshot: MarketSnapshot }> = [];
  /** V_INFINITY: Predictive micro-prediction engine */
  private readonly predictive: PredictiveEngine;
  /** V_INFINITY: Orderbook intelligence (microstructure analysis) */
  private readonly orderbookIntel: OrderbookIntel;
  /** V_INFINITY: Multi-agent coordinator */
  private readonly coordinator: AgentCoordinator;
  /** V_INFINITY: Latency arbitrage mode controller */
  private readonly latencyMode: LatencyMode;
  /** V_INFINITY: Missed opportunity learner */
  private readonly oppLearner: OpportunityLearner;
  /** V_OMEGA: Execution quality feedback loop */
  private readonly execFeedback: ExecutionFeedback;
  /** V_OMEGA: Adaptive execution strategy */
  private readonly adaptiveExec: AdaptiveExecutor;
  /** V_OMEGA: Execution kill-switch */
  private readonly execKillswitch: ExecutionKillswitch;
  /** V_EDGE: Comprehensive edge profiler */
  private readonly edgeProfiler: EdgeProfiler;
  /** V_CONTROL: System governor — normalizes, stabilizes, governs all adaptive systems */
  private readonly governor: SystemGovernor;
  /** V_PRODUCTION: Production validation harness — proves real edge */
  private readonly validator: ProductionValidator;
  /** V_PRODUCTION_STABLE: Signal pressure tracker + near-miss detection */
  private readonly signalPressure: SignalPressure;
  /** V_SUPREME: Pre-computed macro state (updated async every N ticks) */
  private precomputedMacro: { regime: string; tradesBlocked: boolean; sizeMultiplier: number; strategyBias: string; btcTrend: string; avgVolatility: number; correlationStrength: number } | null = null;
  /** V_SUPREME: Pre-computed regime states per market */
  private precomputedRegimes: Map<string, { regime: string; params: import('./regime-adapter.js').RegimeParams }> = new Map();
  /** V_SUPREME: Last precompute timestamp */
  private lastPrecomputeAt = 0;
  /** V_SUPREME: Previous snapshots for event detection */
  private prevSnapshots: MarketSnapshot[] = [];
  /** Track entry state for policy reward computation */
  private activeTradeStates: Map<string, { state: import('./policy-learner.js').MarketState; action: import('./policy-learner.js').PolicyAction; entryTick: number }> = new Map();
  /** Track exit state for exit policy learning */
  private activeExitStates: Map<string, { state: import('./exit-policy-learner.js').ExitState; lastPnlPct: number }> = new Map();
  /** Signal confirmation: track previous tick's direction per market */
  private prevSignals: Map<string, string> = new Map();
  /** V_SIGNAL_CALIBRATION: Track last 10 trade directions for diversity guard */
  private recentTradeDirections: string[] = [];
  /** V_EDGE_EXTRACTION: Track EV by score bucket + regime + direction */
  private edgeBuckets: Map<string, { pnl: number; count: number }> = new Map();
  /** V_EDGE_EXTRACTION: Confidence accuracy tracking */
  private confAccuracy: { highConf: { wins: number; total: number }; midConf: { wins: number; total: number } } = { highConf: { wins: 0, total: 0 }, midConf: { wins: 0, total: 0 } };
  /** Orderbook wall bypass tracking during learning */
  private obBypass: { trades: number; pnl: number; hardBlock: boolean } = { trades: 0, pnl: 0, hardBlock: false };
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
  /** V18: Previous prices for event detection */
  private prevPrices: Map<string, number> = new Map();
  /** V18: Per-market event cooldown (market → timestamp of last event trade) */
  private eventCooldowns: Map<string, number> = new Map();
  /** V18: Event-triggered trade count for validation */
  private eventTradeCount = 0;
  private eventTradeWins = 0;
  private eventTradePnls: number[] = [];     // V19: rolling event PnLs for EV tracking
  private normalTradePnls: number[] = [];    // V19: rolling normal PnLs for comparison
  /** V18: Global event cap — max event trades per minute */
  private eventTradeTimestamps: number[] = [];
  /** V19: Adaptive event sizing tier (0.5 → 0.7 → 1.0) */
  private eventSizeTier = 0.5;
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
      maxFlatTicks: 20,           // ~3 min flat → close
      flatThresholdPct: 0.5,      // ±0.5% counts as flat
      maxHoldTicks: 60,           // ~10 min max hold — balance development vs throughput
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
    this.eventBus = new MarketEventBus();
    this.decisionCache = new DecisionCache();
    this.perf = new PerfMetrics();
    this.predictive = new PredictiveEngine();
    this.orderbookIntel = new OrderbookIntel();
    this.coordinator = new AgentCoordinator();
    this.latencyMode = new LatencyMode();
    this.oppLearner = new OpportunityLearner();
    this.execFeedback = new ExecutionFeedback();
    this.adaptiveExec = new AdaptiveExecutor();
    this.execKillswitch = new ExecutionKillswitch();
    this.edgeProfiler = new EdgeProfiler();
    this.governor = new SystemGovernor();
    this.validator = new ProductionValidator();
    this.signalPressure = new SignalPressure();
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

    // Write PID file + initial heartbeat for external detection
    try { writePidFile(); writeHeartbeat(); } catch { /* non-critical */ }

    this.log('info', `Agent "${this.config.name}" v11 (persistent-learning) starting`);
    this.log('info', `Scanning: ${this.config.markets.length} markets → score + rank → top trades only`);
    this.log('info', `Strategies: ${this.strategies.map((s) => s.name).join(', ')}`);
    this.log('info', `Engines: meta-agent, opportunity scorer, exit-policy, correlation-guard, EV, Bayesian fusion`);
    this.log('info', `Mode: V_SUPREME event-driven | parallel scoring | decision cache`);
    // Subscribe to high-priority events for fast-path execution
    this.eventBus.subscribe(MarketEventType.PRICE_SPIKE, (event) => {
      this.log('verbose', `EVENT BUS: ${event.type} ${event.market} ${event.magnitude > 0 ? '+' : ''}${event.magnitude.toFixed(2)}% [${event.priority}]`);
    });
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
        // V_SUPREME: SMART THROTTLING — dynamic 2s-30s based on activity
        let pollMs = this.config.pollIntervalMs;

        if (this.cachedSnapshots.length > 0) {
          const avgAbsChange = this.cachedSnapshots.reduce((s, snap) => s + Math.abs(snap.priceChange24h), 0) / this.cachedSnapshots.length;
          // V_SUPREME: Aggressive scaling — 2s during spikes, 30s during dead markets
          if (avgAbsChange > 8) pollMs = 2_000;           // Extreme vol → 2s
          else if (avgAbsChange > 5) pollMs = Math.round(pollMs * 0.4);  // High vol → 40%
          else if (avgAbsChange > 2) { /* Normal — keep current pollMs */ }
          else if (avgAbsChange < 0.5) pollMs = Math.min(30_000, Math.round(pollMs * 2.0)); // Dead → 2x slower, cap 30s
          else if (avgAbsChange < 1) pollMs = Math.round(pollMs * 1.5);   // Low vol → 1.5x slower
        }

        // Also accelerate if event bus has recent events
        const recentEvents = this.eventBus.getHistory().filter(e => Date.now() - e.timestamp < 60_000);
        if (recentEvents.length >= 2) pollMs = Math.min(pollMs, 3_000); // Active events → max 3s

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

    // Clean PID file + heartbeat (signal to external detectors that we're stopped)
    try { cleanPidFile(); cleanHeartbeat(); } catch { /* non-critical */ }

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
    // V_SUPREME: Log final performance metrics before cleanup
    const perfReport = this.perf.formatReport();
    if (perfReport) this.log('info', `PERF REPORT:\n${perfReport}`);
    this.eventBus.clear();
    this.decisionCache.reset();
    this.perf.reset();
    this.predictive.reset();
    this.orderbookIntel.reset();
    this.coordinator.reset();
    this.latencyMode.reset();
    this.oppLearner.reset();
    this.execFeedback.reset();
    this.adaptiveExec.reset();
    this.execKillswitch.reset();
    this.edgeProfiler.reset();
    this.governor.reset();
    this.signalPressure.reset();
    // V_PRODUCTION: Print final validation report before reset
    if (this.validator.isActive()) {
      this.log('info', `\n${this.validator.formatReport()}`);
    }
    this.validator.reset();
    this.executionQueue = [];
    this.precomputedMacro = null;
    this.precomputedRegimes.clear();
    this.prevSnapshots = [];
    this.recentTradeEVs = [];
    this.fastPathCount = 0;
    this.fullPipelineCount = 0;
    this.cachedSnapshots = [];
    this.prevPrices.clear();
    this.eventCooldowns.clear();
    this.eventTradeTimestamps = [];
    this.eventTradeCount = 0;
    this.eventTradeWins = 0;
    this.eventTradePnls = [];
    this.normalTradePnls = [];
    this.eventSizeTier = 0.5;
    this.activeTradeStates.clear();
    this.activeExitStates.clear();
    this.marketRegimes.clear();
    this.log('info', 'Stop requested — learning state persisted, memory cleaned');
  }

  getState(): Readonly<AgentState> { return this.state; }
  getJournal(): TradeJournal { return this.journal; }
  getRiskManager(): RiskManager { return this.risk; }
  getDashboard(): PerformanceDashboard { return this.dashboard; }
  getPerf(): PerfMetrics { return this.perf; }
  getEventBus(): MarketEventBus { return this.eventBus; }
  getDecisionCacheStats() { return this.decisionCache.getStats(); }
  getPredictive(): PredictiveEngine { return this.predictive; }
  getCoordinator(): AgentCoordinator { return this.coordinator; }
  getLatencyMode(): LatencyMode { return this.latencyMode; }
  getOpportunityLearner(): OpportunityLearner { return this.oppLearner; }
  getExecutionFeedback(): ExecutionFeedback { return this.execFeedback; }
  getAdaptiveExecutor(): AdaptiveExecutor { return this.adaptiveExec; }
  getExecutionKillswitch(): ExecutionKillswitch { return this.execKillswitch; }
  getEdgeProfiler(): EdgeProfiler { return this.edgeProfiler; }
  getGovernor(): SystemGovernor { return this.governor; }
  getValidator(): ProductionValidator { return this.validator; }
  /** Start production validation mode — freezes architecture for 200 trades */
  startValidation(): void {
    this.validator.activate();
    this.validator.recordEquity(this.state.currentCapital);
    this.log('info', 'V_PRODUCTION: Validation mode ACTIVATED — architecture frozen, pure measurement for 200 trades');
  }
  /** Get formatted validation report */
  getValidationReport(): string {
    if (!this.validator.isActive() && this.validator.getProgress().completed === 0) {
      return 'Validation mode not active. Use "agent validate" to start.';
    }
    return this.validator.formatReport();
  }
  get isRunning(): boolean { return this.running; }

  // ─── Core Loop ─────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const tickTimer = this.perf.startTimer('tick');
    this.state.iteration++;
    this.callbacks.onTick?.(this.state, this.state.iteration);

    // Heartbeat: write timestamp every tick (fire-and-forget, non-blocking)
    try { writeHeartbeat(); } catch { /* never throw from heartbeat */ }

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

    // V_OMEGA: Execution killswitch — halt if execution quality degraded
    const globalExecStats = this.execFeedback.getGlobalStats();
    const recentSlippage = globalExecStats.totalTrades > 0
      ? this.execFeedback.getRecentSlippage('_global', 5).map(s => Math.abs(s))
      : [];
    const ksState = this.execKillswitch.evaluate(
      recentSlippage,
      [], // fill success tracked per-trade, not globally here
      [],
      globalExecStats.totalSlippageCostUsd,
      this.state.currentCapital,
    );
    if (ksState.active) {
      this.log('normal', `V_OMEGA KILLSWITCH: ${ksState.reason} (trigger=${ksState.trigger}) — trading halted until ${new Date(ksState.resumeAt).toISOString().slice(11, 19)}`);
      this.perf.endTimer('tick', tickTimer);
      return;
    }

    // V_EDGE: Stability control — reduce size or halt if returns are unstable
    const stability = this.edgeProfiler.getStabilityReport();
    if (stability.instabilityAction === 'halt') {
      this.log('normal', `V_EDGE STABILITY HALT: sharpe7d=${stability.sharpe7d.toFixed(2)} variance=${stability.returnVariance.toFixed(4)} — halting`);
      this.perf.endTimer('tick', tickTimer);
      return;
    }

    // V_SUPREME: OBSERVE — TTL-aware caching + event bus detection
    const PRICE_TTL_MS = 15_000;
    const cacheAge = Date.now() - this.lastFullScanAt;
    const needsFullScan = this.cachedSnapshots.length === 0 || cacheAge > PRICE_TTL_MS;

    const fetchTimer = this.perf.startTimer('market_fetch');
    const [positions, snapshots] = await Promise.all([
      this.fetchPositions(),
      needsFullScan ? this.fetchMarketSnapshots() : Promise.resolve(this.cachedSnapshots),
    ]);
    this.perf.endTimer('market_fetch', fetchTimer);

    if (needsFullScan && snapshots.length > 0) {
      // V_SUPREME: Detect events via event bus before updating cache
      if (this.prevSnapshots.length > 0) {
        this.eventBus.detectAll(snapshots, this.prevSnapshots);
      }
      this.prevSnapshots = snapshots;
      this.cachedSnapshots = snapshots;
      this.lastFullScanAt = Date.now();
    }

    const isFreshData = needsFullScan || cacheAge < 5_000;

    if (!snapshots.length) {
      this.log('verbose', 'No market data available');
      this.perf.endTimer('tick', tickTimer);
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
      // V_INFINITY: Feed predictive engine + orderbook intel
      this.predictive.record(snapshot.market, snapshot.price, snapshot.oiRatio, snapshot.volume24h);
      this.orderbookIntel.record(snapshot.market, snapshot.price, snapshot.longOi, snapshot.shortOi, snapshot.volume24h);
    }
    // V_INFINITY: Update coordinator portfolio state
    this.coordinator.updatePortfolio(positions.map(p => ({
      market: p.market, side: p.side, sizeUsd: p.sizeUsd, collateralUsd: p.collateralUsd,
      entryPrice: p.entryPrice, markPrice: p.markPrice ?? p.entryPrice, pnl: p.pnl ?? 0, leverage: p.leverage,
    })), this.state.currentCapital);
    this.coordinator.tick();

    // V_SUPREME: EVENT DETECTION — event bus + legacy detector for cached ticks
    const events = this.detectEvents(snapshots);

    // V_INFINITY: Check predictions on every tick (even cached) for pre-positioning
    for (const snap of snapshots) {
      const prediction = this.predictive.predict(snap.market);
      if (prediction.probability > 0.75) {
        const prePos = this.predictive.shouldPrePosition(snap.market);
        if (prePos.prePosition) {
          this.coordinator.submitOpportunity({
            market: snap.market,
            side: prePos.direction === 'up' ? 'long' : 'short',
            score: Math.round(prediction.probability * 100),
            confidence: prediction.confidence,
            urgency: prePos.urgency === 'immediate' ? 'immediate' : prePos.urgency === 'soon' ? 'high' : 'low',
            source: 'prediction',
            timestamp: Date.now(),
            ttlMs: 10_000, // predictions expire in 10s
          });
          this.log('verbose', `PREDICT: ${snap.market} ${prePos.direction} prob=${(prediction.probability * 100).toFixed(0)}% urgency=${prePos.urgency}`);
        }
      }
    }

    // V_INFINITY: Evaluate latency mode based on market conditions
    const avgVelocity = snapshots.reduce((s, snap) => {
      const p = this.predictive.predict(snap.market);
      return s + Math.abs(p.velocity);
    }, 0) / Math.max(1, snapshots.length);
    const recentEventCount = this.eventBus.getHistory().filter(e => Date.now() - e.timestamp < 60_000).length;
    this.latencyMode.evaluate(avgVelocity, 0, avgVelocity * 10, recentEventCount);

    // V_SUPREME: Cached ticks — fast-path event handling
    if (!isFreshData) {
      if (events.length > 0) {
        const eventTimer = this.perf.startTimer('event_path');
        await this.handleEventTriggers(events, positions);
        this.perf.endTimer('event_path', eventTimer);
      } else {
        this.log('verbose', `Fast tick (cache age ${Math.round(cacheAge / 1000)}s) — monitoring only`);
      }
      this.perf.endTimer('tick', tickTimer);
      return;
    }

    // V_SUPREME: PRE-COMPUTED MACRO STATE — update every 5 ticks or when stale
    const PRECOMPUTE_INTERVAL = 5;
    const needsPrecompute = !this.precomputedMacro || this.state.iteration % PRECOMPUTE_INTERVAL === 0 || Date.now() - this.lastPrecomputeAt > 30_000;
    if (needsPrecompute) {
      const macro = this.macroRegime.update(snapshots);
      this.precomputedMacro = macro;
      // Pre-compute regimes for all markets
      for (const snap of snapshots) {
        const regime = this.regimeAdapter.detectRegime(snap.market, snap.price, snap.priceChange24h);
        const params = this.regimeAdapter.getParams(regime.regime);
        this.precomputedRegimes.set(snap.market, { regime: regime.regime, params });
        this.marketRegimes.set(snap.market, regime.regime);
      }
      this.lastPrecomputeAt = Date.now();
    }
    const macro = this.precomputedMacro!;

    if (macro.tradesBlocked) {
      this.log('normal', `MACRO RISK-OFF: ${macro.regime} (BTC ${macro.btcTrend}, vol ${macro.avgVolatility.toFixed(1)}%, corr ${(macro.correlationStrength * 100).toFixed(0)}%) — trades blocked`);
      this.perf.endTimer('tick', tickTimer);
      return;
    }
    if (macro.regime !== 'NEUTRAL') {
      this.log('verbose', `MACRO: ${macro.regime} (BTC ${macro.btcTrend}, size ${(macro.sizeMultiplier * 100).toFixed(0)}%, bias ${macro.strategyBias})`);
    }

    // V_SUPREME: PARALLEL SIGNAL FUSION with decision cache
    const fusionTimer = this.perf.startTimer('signal_fusion');
    const compositeMap = new Map<string, CompositeSignal>();
    await Promise.all(snapshots.map(async (snapshot) => {
      const cached = this.decisionCache.get(snapshot.market, 'signal') as CompositeSignal | null;
      if (cached && this.decisionCache.isDelta(snapshot.market, snapshot)) {
        compositeMap.set(snapshot.market, cached);
      } else {
        const result = this.fusion.fuse(snapshot, snapshot.fundingRate);
        compositeMap.set(snapshot.market, result);
        this.decisionCache.set(snapshot.market, 'signal', result);
      }
    }));
    this.perf.endTimer('signal_fusion', fusionTimer);

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
      this.perf.endTimer('tick', tickTimer);
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
      this.perf.endTimer('tick', tickTimer);
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
    if (this.hourlyTrades.length >= 8) { this.perf.endTimer('tick', tickTimer); return; }
    // Loss streak pause: skip 3 ticks (~30s cooldown), then resume
    if (this.state.consecutiveLosses >= 6) {
      const ticksSinceLastTrade = this.state.lastTradeTimestamp > 0
        ? Math.floor((Date.now() - this.state.lastTradeTimestamp) / (this.config.pollIntervalMs || 10_000))
        : 999;
      if (ticksSinceLastTrade < 3) {
        this.log('normal', `Loss streak ${this.state.consecutiveLosses} — cooling down (${3 - ticksSinceLastTrade} ticks remaining)`);
        return;
      }
      this.log('normal', `Loss streak cooldown expired — resuming`);
      this.state.consecutiveLosses = 0;
    }

    let tickPositionCount = this.state.positions.length;
    let tickCapitalAllocated = this.state.positions.reduce((sum, p) => sum + (p.collateralUsd ?? 0), 0);
    const maxCapital = this.state.currentCapital * 0.15;

    // V_SUPREME: PARALLEL OPPORTUNITY SCORING — evaluate ALL markets concurrently
    const decisionTimer = this.perf.startTimer('decision');
    const opportunities: Array<{ snapshot: typeof snapshots[0]; score: number; decision: TradeDecision }> = [];

    // Phase 4: Pre-filter with short-circuit gates (zero-cost eliminations)
    const candidates = snapshots.filter((snapshot) => {
      if (!tradeableMarkets.has(snapshot.market)) return false;
      const marketCooldown = this.marketCooldowns.get(snapshot.market) ?? 0;
      if (now < marketCooldown) return false;
      const mktTrades = (this.marketHourlyTrades.get(snapshot.market) ?? []).filter((t) => now - t < 3_600_000);
      this.marketHourlyTrades.set(snapshot.market, mktTrades);
      if (mktTrades.length >= 2) return false;
      // Short-circuit: skip if signal is weak (avoids full pipeline)
      const composite = compositeMap.get(snapshot.market);
      if (!composite || composite.confidence < 0.30 || !composite.confirmed) return false;
      return true;
    });

    // Phase 2: Parallel scoring of all candidates (Promise.all)
    const scoringResults = await Promise.all(candidates.map(async (snapshot) => {
      return this.scoreOpportunity(snapshot, compositeMap, stats, metaDecision, macro, now, COLD_START_TRADES);
    }));

    for (const result of scoringResults) {
      if (result) opportunities.push(result);
    }
    this.perf.endTimer('decision', decisionTimer);

    // Execute ONLY the best opportunities (sorted by score, up to max positions)
    // V_SCORE_AMPLIFICATION Phase 6: Rank by (confidence × EV-proxy) blended with score
    // This prevents high-confidence trades from being suppressed by scoring compression
    opportunities.sort((a, b) => {
      const aEVProxy = a.decision.confidence * a.score;
      const bEVProxy = b.decision.confidence * b.score;
      // 70% score + 30% confidence-weighted score
      const aRank = a.score * 0.7 + aEVProxy * 0.003;
      const bRank = b.score * 0.7 + bEVProxy * 0.003;
      return bRank - aRank;
    });

    // SYSTEM HEALTH GATE: block or raise thresholds when runtime is degraded
    // Skip in simulation mode — health monitor tracks RPC/network which doesn't apply
    let healthThresholdMult = 1.0;
    if (!this.context.simulationMode) {
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
    }

    // V17: TRADE QUALITY FILTER — if recent EV is negative, raise thresholds
    // Disabled during cold-start: system needs trades to learn from
    let qualityMult = 1.0;
    if (this.recentTradeEVs.length >= 10 && stats.totalTrades >= COLD_START_TRADES) {
      const rollingEV = this.recentTradeEVs.reduce((a, b) => a + b, 0) / this.recentTradeEVs.length;
      if (rollingEV < 0) {
        qualityMult = 1.15; // Raise threshold 15% (was 30% — too aggressive)
        this.log('verbose', `V17: Rolling EV $${rollingEV.toFixed(2)} < 0 — threshold raised 15%`);
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

    // V_INFINITY: Submit all opportunities to coordinator queue
    for (const opp of opportunities) {
      this.coordinator.submitOpportunity({
        market: opp.decision.market,
        side: opp.decision.side ?? 'long',
        score: opp.score,
        confidence: opp.decision.confidence,
        urgency: opp.score >= 80 ? 'immediate' : opp.score >= 60 ? 'high' : 'normal',
        source: 'scan',
        timestamp: Date.now(),
        ttlMs: 30_000,
        decision: opp.decision,
      });
    }

    // V_SUPREME: PARALLEL EXECUTION — execute top N opportunities (up to 3)
    const execTimer = this.perf.startTimer('execution');
    const executionPromises: Promise<void>[] = [];

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

      // V_SUPREME: Queue execution — serial for now (tx mutex), but decoupled from scoring
      executionPromises.push(this.executeTrade(opp.decision, opp.snapshot));
      tickPositionCount++;
      tickCapitalAllocated += opp.decision.collateral ?? 0;
      this.hourlyTrades.push(now);
      const mt = this.marketHourlyTrades.get(opp.snapshot.market) ?? [];
      mt.push(now);
      this.marketHourlyTrades.set(opp.snapshot.market, mt);
    }

    // Await all executions (serial due to tx mutex, but ready for parallel when safe)
    for (const p of executionPromises) await p;
    this.perf.endTimer('execution', execTimer);

    // V_INFINITY: Record captures for opportunity learner
    for (const opp of opportunities.slice(0, executionPromises.length)) {
      this.oppLearner.recordCapture(
        opp.decision.market,
        opp.decision.side ?? 'long',
        Date.now() - 100, // approximate detection time
        Date.now(),
        opp.snapshot.price,
        0, // PnL unknown at entry time
      );
    }

    // V_INFINITY: Validate predictions against actual prices
    for (const snap of snapshots) {
      this.predictive.validatePrediction(snap.market, snap.price);
    }

    // V_INFINITY: Opportunity learner analysis (every 20 ticks)
    if (this.state.iteration % 20 === 0) {
      const recommendations = this.oppLearner.analyze();
      for (const rec of recommendations) {
        if (rec.confidence > 0.5) {
          this.coordinator.submitLearningUpdate({
            type: rec.type === 'adjust_threshold' ? 'threshold_adjust'
              : rec.type === 'adjust_cache_ttl' ? 'cache_ttl_adjust'
              : rec.type === 'relax_filter' ? 'threshold_adjust'
              : 'weight_update',
            target: rec.target,
            value: rec.suggestedValue,
            reason: rec.reason,
            timestamp: Date.now(),
          });
          this.log('verbose', `V_INFINITY LEARN: ${rec.type} ${rec.target} → ${rec.suggestedValue} (${rec.reason})`);
        }
      }
    }

    // V_CONTROL Phase 3: Check change rate limiting freeze
    const journalStats = this.journal.getStats();
    this.governor.checkFreeze(journalStats.totalTrades);

    // V_CONTROL Phase 5: Capital utilization monitoring (every 10 ticks)
    if (this.state.iteration % 10 === 0) {
      const deployedCapital = this.state.positions.reduce((s, p) => s + (p.collateralUsd ?? 0), 0);
      const realEdge = this.edgeProfiler.getRealEdge();
      const edgeStab = this.edgeProfiler.getStabilityReport();
      const ddState = this.drawdown.getState();
      const utilization = this.governor.evaluateUtilization(
        deployedCapital, this.state.currentCapital,
        0, journalStats.totalTrades,
        realEdge.hasEdge,
        realEdge.realEV, edgeStab.sharpe30d, ddState.drawdownPct,
      );
      if (utilization.underUtilized && utilization.filterRelaxation > 0) {
        this.log('verbose', `V_CONTROL V2: Under-utilized (${(utilization.deployedPct * 100).toFixed(0)}% deployed) — safely relaxed ${(utilization.filterRelaxation * 100).toFixed(0)}%`);
      } else if (utilization.underUtilized) {
        this.log('verbose', `V_CONTROL V2: Under-utilized but edge too weak for relaxation`);
      }
    }

    // V_CONTROL Phase 7: Shadow mode comparison (every 50 ticks)
    if (this.state.iteration % 50 === 0) {
      const shadow = this.governor.compareShadowVsLive();
      if (shadow.revertRecommended) {
        this.log('normal', `V_CONTROL SHADOW: Shadow outperforming live (shadow=$${shadow.shadowPnl.toFixed(2)} vs live=$${shadow.livePnl.toFixed(2)}) — revert recommended`);
      }
    }

    // V_PRODUCTION_STABLE: Signal pressure log on every full tick (not gated by iteration count)
    if (this.signalPressure.getSummary().signalsGenerated > 0) {
      const pressure = this.signalPressure.getSummary();
      this.log('normal', `SIGNALS: gen=${pressure.signalsGenerated} rej=${pressure.signalsRejected} exec=${pressure.signalsExecuted} miss=${pressure.nearMissCount} | top_fail=${pressure.dominantFailure}(${(pressure.dominantFailurePct * 100).toFixed(0)}%) | avg=${pressure.avgScore.toFixed(0)} | capture=${(pressure.captureRate * 100).toFixed(0)}%`);
    }

    // V_SUPREME: End tick timer and log perf on verbose
    this.perf.endTimer('tick', tickTimer);
    if (this.state.iteration % 10 === 0) {
      const tickStats = this.perf.getStats('tick');
      const decStats = this.perf.getStats('decision');
      const execStats = this.perf.getStats('execution');
      if (tickStats && decStats) {
        const missRate = this.oppLearner.getMissRate();
        const predMetrics = this.predictive.getMetrics();
        this.log('verbose', `PERF: tick p50=${tickStats.p50.toFixed(0)}ms p99=${tickStats.p99.toFixed(0)}ms | dec p50=${decStats.p50.toFixed(0)}ms | exec p50=${execStats?.p50.toFixed(0) ?? '-'}ms`);
        this.log('verbose', `V_INFINITY: capture=${(missRate.captureRate * 100).toFixed(0)}% | predict=${(predMetrics.accuracy * 100).toFixed(0)}% | latency=${this.latencyMode.isActive() ? 'ACTIVE' : 'off'} | queue=${this.coordinator.getState().opportunities.length}`);
        // V_PRODUCTION_STABLE: Signal pressure + near-miss observability
        const pressure = this.signalPressure.getSummary();
        this.log('normal', `SIGNALS: gen=${pressure.signalsGenerated} rej=${pressure.signalsRejected} exec=${pressure.signalsExecuted} near-miss=${pressure.nearMissCount} | dominant=${pressure.dominantFailure}(${(pressure.dominantFailurePct * 100).toFixed(0)}%) | avg_score=${pressure.avgScore.toFixed(0)} | capture=${(pressure.captureRate * 100).toFixed(0)}%`);
        const dist = pressure.scoreDistribution;
        this.log('verbose', `SCORES: <30:${dist.below30} | 30-40:${dist.range30_40} | 40-55:${dist.range40_55} | 55-70:${dist.range55_70} | >70:${dist.above70}`);
        // Adaptation suggestion (Phase 5)
        const adaptSuggestion = this.signalPressure.shouldAdapt();
        if (adaptSuggestion) {
          this.log('normal', `SIGNAL ADAPT: ${adaptSuggestion.reason} → ${adaptSuggestion.suggestion}`);
        }
        const gStats = this.execFeedback.getGlobalStats();
        if (gStats.totalTrades > 0) {
          this.log('verbose', `V_OMEGA: slip_avg=${gStats.avgSlippageBps.toFixed(1)}bps p90=${gStats.p90SlippageBps.toFixed(1)}bps | fill=${(gStats.successRate * 100).toFixed(0)}% | cost=$${gStats.totalSlippageCostUsd.toFixed(2)} | ks=${this.execKillswitch.isActive() ? 'ACTIVE' : 'off'}`);
        }
        // V_EDGE: Report real edge + scale readiness
        const realEdge = this.edgeProfiler.getRealEdge();
        const qGate = this.edgeProfiler.getQualityGate();
        if (realEdge.realEV !== 0) {
          this.log('verbose', `V_EDGE: REAL_EV=$${realEdge.realEV.toFixed(2)} | net=$${realEdge.netPnl.toFixed(2)} | cost_drag=${realEdge.costDragPct.toFixed(1)}% | edge=${realEdge.hasEdge ? 'YES' : 'NO'}(${(realEdge.edgeConfidence * 100).toFixed(0)}%) | quality=${qGate.filtering ? `ON(p${qGate.minScorePercentile})` : 'warmup'}`);
        }
        // Scale readiness every 50 ticks
        if (this.state.iteration % 50 === 0) {
          const scale = this.edgeProfiler.getScaleReadiness();
          if (scale.score > 0) {
            this.log('normal', `V_EDGE SCALE: ${scale.ready ? 'READY' : 'NOT READY'} score=${scale.score}/100 | blockers=[${scale.blockers.join(', ')}]`);
          }
          // PnL leak analysis every 50 ticks
          const leaks = this.edgeProfiler.analyzePnlLeaks();
          if (leaks.largestLeakSource !== 'none') {
            this.log('verbose', `V_EDGE LEAKS: ${leaks.largestLeakSource} (${leaks.recommendation})`);
          }
          // V_CONTROL V2: Governor status with clamp analytics
          const govState = this.governor.getState();
          const clampA = this.governor.getClampAnalytics();
          this.log('verbose', `V_CONTROL: meta=${govState.metaStabilityScore}/100 | util=${(govState.utilizationPct * 100).toFixed(0)}% | clamp_freq=${(govState.clampFrequency * 100).toFixed(0)}% | dominant=${govState.dominantFactor} | frozen=${govState.frozen} | lane=${govState.dualLane} | exec_stab=${govState.executionStabilityScore}/20 | shadow_rev=${govState.shadowAutoReverted}`);
          if (clampA.clampFrequency > 0.3) {
            this.log('verbose', `V_CONTROL CLAMP: ${clampA.recommendation}`);
          }
          // V_PRODUCTION: Feed external metrics + report
          if (this.validator.isActive()) {
            this.validator.recordUtilization(govState.utilizationPct);
            this.validator.recordClampFrequency(govState.clampFrequency);
            const shadow = this.governor.compareShadowVsLive();
            this.validator.recordShadowDelta(shadow.shadowSharpe - shadow.liveSharpe);
            const progress = this.validator.getProgress();
            const metrics = this.validator.getMetrics();
            this.log('normal', `V_PRODUCTION [${progress.completed}/${progress.required}]: REAL_EV=$${metrics.realEV.toFixed(2)} | Sharpe=${metrics.sharpe.toFixed(2)} | DD=${(metrics.maxDrawdownPct * 100).toFixed(1)}% | WR=${(metrics.winRate * 100).toFixed(0)}% | PF=${metrics.profitFactor.toFixed(2)} | valid=${this.validator.isValid() ? 'YES' : 'NO'}`);
            // Full report at milestones
            if (progress.completed === 100 || progress.completed === progress.required) {
              const report = this.validator.getReport();
              this.log('info', `\n${this.validator.formatReport()}`);
              if (report.verdict === 'EDGE_CONFIRMED') {
                this.log('info', `V_PRODUCTION: EDGE CONFIRMED — ${report.scaling.action} recommended (${report.scaling.capitalMultiplier}x)`);
              } else if (report.verdict === 'NO_EDGE') {
                this.log('info', `V_PRODUCTION: NO EDGE — ${report.diagnosis.rootCause} (${report.diagnosis.recommendation})`);
              }
            }
          }
        }
      }
    }
  }

  // ─── V_SUPREME: Parallel Opportunity Scorer ──────────────────────────
  // Extracted from tick() for parallel execution. Returns null if opportunity doesn't pass gates.
  private scoreOpportunity(
    snapshot: MarketSnapshot,
    compositeMap: Map<string, CompositeSignal>,
    stats: import('./types.js').JournalStats,
    metaDecision: { mode: string; scoreThreshold: number; sizeMultiplier: number; maxPositions: number },
    macro: { sizeMultiplier: number; strategyBias: string },
    now: number,
    COLD_START_TRADES: number,
  ): { snapshot: MarketSnapshot; score: number; decision: TradeDecision } | null {
    // Use pre-computed regime (Phase 6)
    const precomputed = this.precomputedRegimes.get(snapshot.market);
    const regime = precomputed ?? (() => {
      const detected = this.regimeAdapter.detectRegime(snapshot.market, snapshot.price, snapshot.priceChange24h);
      return { regime: detected.regime, params: this.regimeAdapter.getParams(detected.regime) };
    })();
    const regimeParams = regime.params;
    this.marketRegimes.set(snapshot.market, regime.regime);

    // EDGE REFINER V2: scale down regimes with negative EV
    const regimeRefinerMult = this.edgeRefiner.getRegimeMultiplier(regime.regime);

    const composite = compositeMap.get(snapshot.market)!;
    const marketSignals = this.signals.detect(snapshot);

    // V_PRODUCTION_STABLE: Cold start mode detection (first 10 trades)
    const COLD_START_RELAXED = 10;
    const inColdStart = stats.totalTrades < COLD_START_RELAXED;
    // V_ADAPTIVE_CONFIDENCE Phase 1: Dynamic confidence floor (scales with experience)
    const coldStartConfFloor = stats.totalTrades < 20 ? 0.38
      : stats.totalTrades < 50 ? 0.45
      : 0.50;
    const coldStartSizeMult = inColdStart ? 0.7 : 1.0;

    // V_INFINITY: Orderbook intelligence — avoid entering into walls
    const obAnalysis = this.orderbookIntel.analyze(snapshot.market);
    const earlySide = composite.direction === 'bearish' ? 'short' : 'long';
    const obAvoid = this.orderbookIntel.shouldAvoidEntry(snapshot.market, earlySide);
    // Adaptive orderbook wall: soft gate with penalty — allows trade flow while managing risk.
    // Soft gate: score * 0.75 penalty + size * 0.6 reduction (applied downstream).
    // Hard block only if: (a) auto-stop triggered (bypass EV < 0 after 10 trades), or
    //                     (b) signal too weak (confidence < floor - 0.05).
    let obWallPenalty = 1.0; // no penalty by default
    if (obAvoid.avoid && !this.latencyMode.isActive()) {
      if (!this.obBypass.hardBlock) {
        // SOFT GATE: penalize score, reduce size — let trade through if signal is near threshold
        obWallPenalty = 0.75;
        // Reject only if signal is clearly too weak (floor - 5%)
        if (composite.confidence < (coldStartConfFloor - 0.05)) {
          this.signalPressure.recordSignal(snapshot.market, 0, composite.confidence, true, 'orderbook_wall');
          return null;
        }
      } else {
        // HARD: auto-stop triggered (bypass EV negative) — full rejection
        this.signalPressure.recordSignal(snapshot.market, 0, composite.confidence, true, 'orderbook_wall');
        return null;
      }
    }

    // V_ADAPTIVE_CONFIDENCE Phase 2: Boost confidence for aligned signals (before floor check)
    let effectiveConfidence = composite.confidence;
    const earlyRegime = this.precomputedRegimes.get(snapshot.market);
    if (earlyRegime && snapshot.priceChange24h !== 0 && effectiveConfidence >= 0.40) {
      effectiveConfidence = Math.min(0.85, effectiveConfidence + 0.05);
    }
    // High momentum + strong signal boost
    const earlyPrediction = this.predictive.predict(snapshot.market);
    if (Math.abs(earlyPrediction.velocity) > 0.3 && composite.confirmedFactors >= 1) {
      effectiveConfidence = Math.min(0.85, effectiveConfidence + 0.05);
    }

    // Low confidence short-circuit (uses boosted confidence)
    if (effectiveConfidence < coldStartConfFloor || !composite.confirmed) {
      this.signalPressure.recordSignal(snapshot.market, 0, effectiveConfidence, true, 'low_confidence');
      return null;
    }

    // 2-tick confirmation — V_PRODUCTION_STABLE: allow 1-tick if confidence ≥70% during cold start
    const prevDir = this.prevSignals.get(snapshot.market);
    this.prevSignals.set(snapshot.market, composite.direction);
    if (composite.direction !== 'neutral' && prevDir !== composite.direction) {
      const bypass2tick = this.latencyMode.shouldBypass('2tick_confirmation')
        || (inColdStart && composite.confidence >= 0.70);
      if (!bypass2tick) {
        this.signalPressure.recordSignal(snapshot.market, 0, composite.confidence, true, '2tick_fail');
        return null;
      }
    }

    // POLICY LEARNER
    const policyState = this.policyLearner.buildState(
      regime.regime, composite.direction, composite.confidence,
      Math.abs(snapshot.priceChange24h), stats.winRate,
    );
    const policyRec = this.policyLearner.recommend(policyState);
    const ignorePolicySkip = stats.totalTrades < COLD_START_TRADES;
    if (!policyRec.action.startsWith('trade') && !policyRec.isExploration && !ignorePolicySkip) {
      this.signalPressure.recordSignal(snapshot.market, 0, composite.confidence, true, 'policy_skip');
      this.simEngine.simulate(snapshot.market, composite.direction === 'bearish' ? 'short' : 'long', snapshot.price, 0, 'policy_skip', regime.regime, composite.confidence);
      return null;
    }
    const policyParams = this.policyLearner.actionToParams(policyRec.action);

    // Strategy ensemble — V_PRODUCTION_STABLE: allow 1 strong strategy in cold start
    const ed = this.ensemble.evaluate(snapshot, marketSignals, composite);
    if (!ed.shouldTrade) {
      // Cold start: allow single strategy if confidence ≥ 75%
      const highConfSingle = inColdStart && composite.confidence >= 0.75 && ed.votes.some(v => v.result.shouldTrade);
      if (!highConfSingle) {
        this.signalPressure.recordSignal(snapshot.market, 0, composite.confidence, true, 'ensemble_fail');
        return null;
      }
    }

    // EV check
    const votingStrategies = ed.votes.filter((v) => v.result.shouldTrade && !v.shadow).map((v) => v.strategy);
    const allowedInRegime = this.regimeAdapter.filterStrategies(regime.regime as import('./regime-adapter.js').RegimeType, votingStrategies);
    const regimeAllowed = allowedInRegime.length > 0;
    const primaryStrategy = allowedInRegime[0] || votingStrategies[0] || 'ensemble';
    const evCheck = this.expectancy.checkEV(primaryStrategy, ed.confidence);
    if (!evCheck.allowed && stats.totalTrades >= COLD_START_TRADES && !evCheck.reason?.includes('new')) {
      this.signalPressure.recordSignal(snapshot.market, 0, composite.confidence, true, 'ev_fail');
      return null;
    }

    // Technical signal
    const techSignal = this.technicals.signal(snapshot.market, snapshot.price);
    const techDataAvailable = this.technicals.dataPoints(snapshot.market) >= 30;
    const side = ed.side ?? 'long';

    // Build trade parameters
    const leverage = this.risk.clampLeverage(Math.min(3, regimeParams.maxLeverage ?? 3));
    const minSlPct = 0.015;
    const slDistance = Math.max(snapshot.price * minSlPct, snapshot.price * 0.02 * (regimeParams.stopAtrMultiplier ?? 2.0) / 2.0);
    const tpDistance = slDistance * Math.max(2.0, regimeParams.takeProfitR ?? 2.0);
    const defaultTp = side === 'long' ? snapshot.price + tpDistance : snapshot.price - tpDistance;
    const defaultSl = side === 'long' ? snapshot.price - slDistance : snapshot.price + slDistance;
    const sugTp = ed.bestResult?.suggestedTp;
    const sugSl = ed.bestResult?.suggestedSl;
    const sugRR = sugTp && sugSl ? Math.abs(sugTp - snapshot.price) / Math.abs(snapshot.price - sugSl) : 0;
    const defRR = tpDistance / slDistance;
    const tp = (sugTp && sugRR >= defRR) ? sugTp : defaultTp;
    const sl = (sugSl && sugRR >= defRR) ? sugSl : defaultSl;
    const riskDist = Math.abs(snapshot.price - sl);
    const rewardDist = Math.abs(tp - snapshot.price);
    const rrRatio = riskDist > 0 ? rewardDist / riskDist : 0;

    // Phase 4: SHORT-CIRCUIT — R:R < 1.5 not worth the pipeline cost
    if (rrRatio < 1.5) {
      this.signalPressure.recordSignal(snapshot.market, 0, composite.confidence, true, 'rr_fail');
      return null;
    }

    // V_OMEGA: Slippage prediction — reject if predicted slippage eats the edge
    const totalOiForSlippage = snapshot.longOi + snapshot.shortOi;
    const prediction = this.predictive.predict(snapshot.market);
    const slippagePred = this.adaptiveExec.predictSlippage(
      snapshot.market,
      (this.state.currentCapital * 0.02) * leverage, // approximate position size
      totalOiForSlippage,
      prediction.velocity,
      obAnalysis?.spreadEstimate ?? 0,
    );
    // V_PRODUCTION_STABLE: Relax slippage viability during cold start (OI data may be 0/unreliable)
    if (!slippagePred.viable && !this.latencyMode.isActive() && !inColdStart) {
      this.signalPressure.recordSignal(snapshot.market, 0, composite.confidence, true, 'slippage_viability');
      this.oppLearner.recordMiss({
        market: snapshot.market, side, detectionTime: Date.now(),
        signalPrice: snapshot.price, peakPrice: snapshot.price, peakPnlPct: 0,
        missReason: 'filter_rejected', filterName: 'slippage_prediction',
        score: 0,
      });
      return null;
    }

    // V_OMEGA: Get execution quality adjustment for this market
    const execSlippageAdj = this.execFeedback.getSlippageAdjustment(snapshot.market);

    // Dynamic sizing
    let uncertaintyMultiplier = 1.0;
    if (composite.totalFactors >= 3 && composite.confidence < 0.4) uncertaintyMultiplier = 0.5;
    else if (composite.totalFactors >= 2 && composite.confidence < 0.5) uncertaintyMultiplier = 0.75;

    const ddState = this.drawdown.getState();
    const maxCapital = this.state.currentCapital * 0.15;
    // V_EDGE: Apply stability + regime/market allocation multipliers
    const stabilityMult = this.edgeProfiler.getStabilityReport().sizeMultiplier;
    const regimeAlloc = this.edgeProfiler.getRegimeAllocations().find(r => r.regime === regime.regime);
    const regimeAllocMult = regimeAlloc?.suggestedSizeMultiplier ?? 1.0;
    const marketAlloc = this.edgeProfiler.getMarketAllocations().find(m => m.market === snapshot.market);
    const marketAllocMult = marketAlloc?.suggestedSizeMultiplier ?? 1.0;
    // V_CONTROL V2: Normalize with factor breakdown for clamp intelligence
    const rawCompositeMultiplier = regimeParams.sizeMultiplier * metaDecision.sizeMultiplier * uncertaintyMultiplier * macro.sizeMultiplier * regimeRefinerMult * execSlippageAdj * stabilityMult * regimeAllocMult * marketAllocMult;
    const factorBreakdown = [
      { name: 'regime', value: regimeParams.sizeMultiplier },
      { name: 'meta', value: metaDecision.sizeMultiplier },
      { name: 'uncertainty', value: uncertaintyMultiplier },
      { name: 'macro', value: macro.sizeMultiplier },
      { name: 'refiner', value: regimeRefinerMult },
      { name: 'slippage', value: execSlippageAdj },
      { name: 'stability', value: stabilityMult },
      { name: 'regimeAlloc', value: regimeAllocMult },
      { name: 'marketAlloc', value: marketAllocMult },
    ];
    const normResult = this.governor.normalizeMultiplier(rawCompositeMultiplier, this.state.currentCapital * 0.02, factorBreakdown);
    // V_CONTROL Phase 4: Signal stability filter
    const signalStability = this.governor.evaluateSignalStability([], [], []);
    // V_CONTROL V2: Meta-stability with execution stability input
    const gExecStats = this.execFeedback.getGlobalStats();
    const metaStab = this.governor.computeMetaStability([], [], 0, 0, gExecStats.p90SlippageBps, gExecStats.p50SlippageBps, gExecStats.successRate);
    // V_PROFIT_EXPANSION Phase 4: Position size escalation based on recent WR
    let escalationMult = 1.0;
    const recentJournalEntries = this.journal.getRecent(10);
    const recentWins = recentJournalEntries.filter(e => (e.pnl ?? 0) > 0).length;
    const recentWR = recentJournalEntries.length >= 5 ? recentWins / recentJournalEntries.length : 0;
    const realEdge = this.edgeProfiler.getRealEdge();
    if (recentWR >= 0.50 && realEdge.realEV > 0 && recentJournalEntries.length >= 5) {
      escalationMult = metaDecision.mode === 'CONSERVATIVE' ? 0.8 : 1.2;
    }

    // V_PROFIT_EXPANSION Phase 5: High-confidence boost
    let highConfBoost = 1.0;
    if (composite.confidence >= 0.75 && (evCheck.ev ?? 0) >= 1.0 && regimeAllowed) {
      highConfBoost = 1.3;
    }

    const governedMultiplier = normResult.normalizedMultiplier * signalStability.sizeMultiplier * metaStab.globalSizeMultiplier * escalationMult * highConfBoost;
    const sizing = this.sizer.calculate(this.state.currentCapital, ed.confidence, stats, ddState, governedMultiplier, this.state.consecutiveLosses);

    // Opportunity scoring
    const totalOi = snapshot.longOi + snapshot.shortOi;
    const posSize = sizing.collateral * leverage;
    const oppScore = this.scorer.score(
      composite, ed.confidence, ed.agreeing, ed.totalVoters,
      evCheck, techSignal, techDataAvailable,
      regimeAllowed, rrRatio, metaDecision.scoreThreshold,
      posSize, totalOi, snapshot.price, sl,
    );

    // ── V_SELECTIVE_AGGRESSION + V_SCORE_AMPLIFICATION ──

    // Phase 4: EV PRIORITY — hard reject on negative EV
    const tradeEV = evCheck.ev ?? 0;
    if (tradeEV <= 0 && stats.totalTrades >= 10) {
      this.signalPressure.recordSignal(snapshot.market, oppScore.total, composite.confidence, true, 'ev_fail');
      return null;
    }

    // V_ADAPTIVE_CONFIDENCE Phase 3: Soft multi-confirmation (scales with experience)
    const strongFactors = composite.factors.filter(f => f.confidence >= 0.60 && f.direction !== 'neutral').length;
    const mediumFactors = composite.factors.filter(f => f.confidence >= 0.55 && f.direction !== 'neutral').length;
    const dominantFactor = composite.factors.some(f => f.confidence >= 0.75 && f.direction !== 'neutral');
    let confirmationPasses: boolean;
    if (stats.totalTrades < 30) {
      // Early phase: 1 strong (≥60%) OR 2 medium (≥55%)
      confirmationPasses = strongFactors >= 1 || mediumFactors >= 2;
    } else {
      // Mature phase: 2 strong (≥60%) OR 1 dominant (≥75%)
      confirmationPasses = strongFactors >= 2 || dominantFactor;
    }
    if (!confirmationPasses) {
      this.signalPressure.recordSignal(snapshot.market, oppScore.total, effectiveConfidence, true, 'low_confidence');
      return null;
    }

    let amplifiedScore = Math.round(oppScore.total * obWallPenalty); // Apply orderbook wall penalty (1.0 or 0.75)

    // Phase 2: AMPLIFICATION GUARD — only amplify if baseScore ≥ 50
    if (oppScore.total >= 50) {
      // High-quality signal amplification (+15% for confident, EV+, regime-aligned)
      if (composite.confidence >= 0.65 && tradeEV > 0 && regimeAllowed) {
        amplifiedScore = Math.round(amplifiedScore * 1.15);
      }
      // Penalty clamping — cap total penalty at 30% of raw base
      const rawBase = (composite.confidence * 100);
      if (rawBase > 0 && amplifiedScore < rawBase * 0.7) {
        amplifiedScore = Math.max(amplifiedScore, Math.round(rawBase * 0.7));
      }
      // Regime confidence override
      if (regimeAllowed && composite.confidence >= 0.70 && composite.confirmedFactors >= 2) {
        amplifiedScore = Math.max(amplifiedScore, oppScore.total + 3);
      }
    }

    // V_EDGE_VALIDATION_LOCK: Validated edge extraction (requires real statistical evidence)
    const bucketRegime = regime.regime.toUpperCase();
    const currentBucket = amplifiedScore < 45 ? '40-45' : amplifiedScore < 50 ? '45-50' : amplifiedScore < 55 ? '50-55' : '55+';

    // Phase 7: Edge confidence = min(1.0, count/50) — scales boost with sample size
    const edgeConf = (count: number) => Math.min(1.0, count / 50);

    // Phase 1: Bucket boost (requires 20+ trades, NOT 5)
    const bucketKey = `score:${currentBucket}`;
    const bucketData = this.edgeBuckets.get(bucketKey);
    if (bucketData && bucketData.count >= 20) {
      const bucketEV = bucketData.pnl / bucketData.count;
      const baseBoost = bucketEV > 0 ? 0.05 : 0; // +5% max
      // Phase 2: Require both total EV > 0 AND recent positive trend
      if (baseBoost > 0 && bucketData.pnl > 0) {
        const conf = edgeConf(bucketData.count);
        amplifiedScore = Math.round(amplifiedScore * (1 + baseBoost * conf)); // Scaled by confidence
      }
    }

    // Phase 4: Strategy surface detection (requires 15+ trades, NOT 3)
    const comboKey = `${currentBucket}:${bucketRegime}:${side}`;
    const comboData = this.edgeBuckets.get(comboKey);
    if (comboData && comboData.count >= 15 && comboData.pnl > 0) {
      const conf = edgeConf(comboData.count);
      amplifiedScore = Math.round(amplifiedScore * (1 + 0.10 * conf)); // Up to +10% for proven combo
    }

    // Phase 4 (soft suppression): Bad zone penalties (gentle at first, harder with more data)
    const dirKey = `dir:${side}`;
    const dirData = this.edgeBuckets.get(dirKey);
    if (dirData && dirData.count >= 10) {
      const dirEV = dirData.pnl / dirData.count;
      if (dirEV < -0.5) {
        // Phase 6: Allow 10% exploration even in bad zones (prevent permanent blind spots)
        const suppressMult = dirData.count >= 20 ? 0.8 : 0.9; // Soft first, harder later
        if (Math.random() > 0.10) { // 90% suppressed, 10% exploration allowed
          amplifiedScore = Math.round(amplifiedScore * suppressMult);
        }
      }
    }
    const regKey = `regime:${bucketRegime}`;
    const regData = this.edgeBuckets.get(regKey);
    if (regData && regData.count >= 10) {
      const regEV = regData.pnl / regData.count;
      if (regEV < -0.5) {
        const suppressMult = regData.count >= 20 ? 0.8 : 0.9;
        if (Math.random() > 0.10) {
          amplifiedScore = Math.round(amplifiedScore * suppressMult);
        }
      }
    }

    // Confidence re-calibration (requires 15+ samples for stability)
    if (this.confAccuracy.highConf.total >= 15) {
      const highWR = this.confAccuracy.highConf.wins / this.confAccuracy.highConf.total;
      if (highWR < 0.40 && effectiveConfidence >= 0.60) {
        amplifiedScore = Math.round(amplifiedScore * 0.95);
      }
    }
    if (this.confAccuracy.midConf.total >= 15) {
      const midWR = this.confAccuracy.midConf.wins / this.confAccuracy.midConf.total;
      if (midWR > 0.55 && effectiveConfidence >= 0.40 && effectiveConfidence < 0.60) {
        amplifiedScore = Math.round(amplifiedScore * 1.05);
      }
    }

    // Phase 1: HARD FLOOR BY MODE — non-negotiable minimums
    // V_ADAPTIVE_CONFIDENCE: Mode floors scale with experience
    const learningPhase = stats.totalTrades < 30;
    const modeFloor = metaDecision.mode === 'AGGRESSIVE' ? (learningPhase ? 42 : 50)
      : metaDecision.mode === 'CONSERVATIVE' ? (learningPhase ? 48 : 60)
      : (learningPhase ? 45 : 55); // NORMAL
    const effectiveBaseThreshold = inColdStart ? Math.min(42, modeFloor) : Math.max(modeFloor, metaDecision.scoreThreshold);
    let effectiveScoreThreshold = effectiveBaseThreshold;

    // Adaptive threshold (if scores cluster near threshold with few trades)
    const pressureSummary = this.signalPressure.getSummary();
    if (pressureSummary.signalsGenerated >= 20 && pressureSummary.avgScore >= (effectiveBaseThreshold - 10) && pressureSummary.signalsExecuted < 3) {
      effectiveScoreThreshold = Math.max(modeFloor - 5, effectiveBaseThreshold - 5); // never below mode floor - 5
    }

    // Phase 4 continued: Low EV requires higher score
    if (tradeEV > 0 && tradeEV < 0.5 && amplifiedScore < 60) {
      this.signalPressure.recordSignal(snapshot.market, amplifiedScore, composite.confidence, true, 'ev_fail');
      return null;
    }

    // Near-threshold boost (only for clean signals)
    if (amplifiedScore >= (effectiveScoreThreshold - 5) && amplifiedScore < effectiveScoreThreshold) {
      const noConflicts = composite.confirmedFactors >= 2 && composite.confidence >= 0.55;
      if (noConflicts) {
        amplifiedScore += 5;
      }
    }

    // Phase 6: DECISION SCORE — blended quality metric
    const decisionScore = (amplifiedScore * 0.5) + (effectiveConfidence * 100 * 0.3) + (Math.max(0, tradeEV) * 20 * 0.2);
    // During learning phase, decision threshold is relaxed (0.75x) to allow data collection
    const decisionThreshold = learningPhase ? effectiveScoreThreshold * 0.75 : effectiveScoreThreshold * 0.85;

    // V_CONTROLLED_ACCELERATION: Fast-learning mode (until 50 trades, then revert)
    const fastLearning = stats.totalTrades < 50;

    // Phase 3: Time-based minimum activity — if no trade in 90 min, relax gates
    const msSinceLastTrade = this.state.lastTradeTimestamp > 0 ? Date.now() - this.state.lastTradeTimestamp : 0;
    const tradeDrought = msSinceLastTrade > 90 * 60_000 && fastLearning;
    const droughtRelax = tradeDrought ? 0.05 : 0; // -5% confidence floor during drought

    // Phase 1: Expanded exploration (score ≥42 for first 50 trades, 0.4x size)
    let explorationTrade = false;
    if (fastLearning && amplifiedScore >= 42 && amplifiedScore < effectiveScoreThreshold && tradeEV >= 0) {
      explorationTrade = true;
    }

    // Phase 2: Near-miss promotion boost (score ≥42, confidence ≥45%, EV>0 → 0.6x size)
    let nearMissPromoted = false;
    if (amplifiedScore >= 42 && amplifiedScore < effectiveScoreThreshold
        && effectiveConfidence >= (coldStartConfFloor - droughtRelax - 0.05)
        && tradeEV > 0) {
      nearMissPromoted = true;
    }

    // Phase 4: Partial signal execution — if 2 strong factors agree but full pipeline fails
    let microTrade = false;
    if (fastLearning && !explorationTrade && !nearMissPromoted
        && strongFactors >= 2 && amplifiedScore >= 38 && amplifiedScore < 42) {
      microTrade = true; // 0.3x size — feeds learning loop
    }

    // Phase 3 continued: Allow best near-miss during drought
    if (tradeDrought && !explorationTrade && !nearMissPromoted && !microTrade
        && amplifiedScore >= 38 && effectiveConfidence >= (coldStartConfFloor - 0.10)) {
      nearMissPromoted = true; // Drought override
    }

    const scorePassesRaw = (amplifiedScore >= effectiveScoreThreshold && decisionScore >= decisionThreshold) || nearMissPromoted || explorationTrade || microTrade;

    if (!scorePassesRaw) {
      this.signalPressure.recordSignal(snapshot.market, amplifiedScore, composite.confidence, true, 'other');
      if (amplifiedScore >= effectiveScoreThreshold - 5) {
        this.signalPressure.recordNearMiss(snapshot.market, amplifiedScore, effectiveScoreThreshold, 'other', composite.confidence);
      }
      this.counterfactual.recordSkip(snapshot.market, side, snapshot.price, amplifiedScore, `score<${effectiveScoreThreshold}`, primaryStrategy);
      return null;
    }

    // V_EDGE + V_CONTROL: Trade quality gate with signal stability buffer (uses amplified score)
    const adjustedScore = amplifiedScore - signalStability.extraScoreBuffer;
    const qualityCheck = this.edgeProfiler.shouldTrade(adjustedScore, evCheck.ev ?? 0, slippagePred.expectedBps / 100);
    if (!qualityCheck.allowed) {
      this.signalPressure.recordSignal(snapshot.market, oppScore.total, composite.confidence, true, 'quality_gate');
      if (oppScore.total >= effectiveScoreThreshold) {
        this.signalPressure.recordNearMiss(snapshot.market, oppScore.total, effectiveScoreThreshold, 'quality_gate', composite.confidence);
      }
      this.counterfactual.recordSkip(snapshot.market, side, snapshot.price, oppScore.total, `quality_gate: ${qualityCheck.reason}`, primaryStrategy);
      return null;
    }

    const strategyName = (allowedInRegime.length > 0 ? allowedInRegime : votingStrategies).join('+') || 'ensemble';
    if (this.edgeRefiner.isStrategyDisabled(strategyName)) {
      this.counterfactual.recordSkip(snapshot.market, side, snapshot.price, oppScore.total, 'refiner_disabled', strategyName);
      return null;
    }

    // Portfolio + correlation + micro-entry checks
    const baseCollateral = Math.max(1, Math.min(sizing.collateral, Math.max(1, maxCapital)) * this.edgeRefiner.getSizeMultiplier());
    const portfolioCheck = this.portfolioIntel.check(this.state.positions, snapshot.market, side, baseCollateral * leverage, this.state.currentCapital);
    if (!portfolioCheck.allowed) { this.signalPressure.recordSignal(snapshot.market, oppScore.total, composite.confidence, true, 'portfolio_block'); return null; }
    const corrCheck = this.correlationGuard.check(this.state.positions, snapshot.market, side, baseCollateral * leverage, this.state.currentCapital);
    if (!corrCheck.allowed) { this.signalPressure.recordSignal(snapshot.market, oppScore.total, composite.confidence, true, 'correlation_block'); return null; }
    // V_INFINITY: Micro-entry check (bypassed in latency mode)
    const microCheck = this.microEntry.check(snapshot.market, side, snapshot.price);
    if (!microCheck.enterNow && !this.latencyMode.shouldBypass('micro_entry')) {
      // Track as missed opportunity for learning
      this.oppLearner.recordMiss({
        market: snapshot.market, side, detectionTime: Date.now(),
        signalPrice: snapshot.price, peakPrice: snapshot.price, peakPnlPct: 0,
        missReason: 'filter_rejected', filterName: 'micro_entry',
        score: oppScore.total,
      });
      return null;
    }

    // Apply size adjustments
    let finalCollateral = baseCollateral;
    if (corrCheck.sizeMultiplier < 1.0) finalCollateral = Math.max(1, finalCollateral * corrCheck.sizeMultiplier);
    const timeCheck = this.timeIntel.check();
    if (timeCheck.sizeMultiplier !== 1.0) finalCollateral = Math.max(1, finalCollateral * timeCheck.sizeMultiplier);
    const microBonus = microCheck.quality === 'excellent' ? 5 : microCheck.quality === 'good' ? 2 : 0;
    const finalScore = amplifiedScore + microBonus;
    if (policyParams.sizeMultiplier !== 1.0) finalCollateral = Math.max(1, finalCollateral * policyParams.sizeMultiplier);
    // V_PRODUCTION_STABLE: Apply cold start size reduction (0.7x during first 10 trades)
    if (inColdStart) finalCollateral = Math.max(1, finalCollateral * coldStartSizeMult);
    // Orderbook wall bypass: reduce size + track
    if (obWallPenalty < 1.0) {
      finalCollateral = Math.max(1, finalCollateral * 0.6);
      this.obBypass.trades++;
    }
    // V_CONTROLLED_ACCELERATION: Size by trade type
    if (microTrade) {
      finalCollateral = Math.max(1, finalCollateral * 0.3);
    } else if (explorationTrade) {
      finalCollateral = Math.max(1, finalCollateral * 0.4);
    } else if (nearMissPromoted) {
      finalCollateral = Math.max(1, finalCollateral * 0.6);
    }

    // V_SIGNAL_BALANCE_V2 Phase 2: Directional frequency control (last 20 trades)
    let dirScoreMult = 1.0;
    let dirBlocked = false;
    if (this.recentTradeDirections.length >= 5) {
      const sameCount = this.recentTradeDirections.filter(d => d === side).length;
      const samePct = sameCount / this.recentTradeDirections.length;
      if (samePct >= 0.85) {
        // ≥85% same direction → BLOCK that direction for diversity
        dirBlocked = true;
        this.log('verbose', `DIRECTION BLOCK: ${(samePct * 100).toFixed(0)}% ${side} — blocked for diversity`);
      } else if (samePct >= 0.70) {
        // ≥70% same direction → heavy penalty
        dirScoreMult = 0.6;
        finalCollateral = Math.max(1, finalCollateral * 0.7);
        this.log('verbose', `DIRECTION PENALTY: ${(samePct * 100).toFixed(0)}% ${side} — score×0.6, size×0.7`);
      }
    }
    if (dirBlocked) {
      this.signalPressure.recordSignal(snapshot.market, oppScore.total, composite.confidence, true, 'other');
      return null;
    }

    // V_SIGNAL_BALANCE_V2 Phase 5: Regime-sensitive direction multipliers
    let regimeDirMult = 1.0;
    const regimeName = regime.regime.toUpperCase();
    if (regimeName.includes('TRENDING_UP') || regimeName === 'TRENDING') {
      regimeDirMult = side === 'long' ? 1.2 : 0.8; // Bull: favor longs
    } else if (regimeName.includes('TRENDING_DOWN')) {
      regimeDirMult = side === 'short' ? 1.2 : 0.8; // Bear: favor shorts
    }
    // RANGING: no directional bias (both sides need edge confirmation)

    // V_SIGNAL_BALANCE_V2 Phase 3: Long opportunity boost in non-bear regimes
    // Corrects natural short bias in perp markets (funding/OI structurally favor shorts)
    if (side === 'long' && !regimeName.includes('DOWN') && composite.confidence >= 0.60 && (evCheck.ev ?? 0) > 0) {
      regimeDirMult *= 1.1; // +10% long boost
    }

    // V_SIGNAL_BALANCE_V2 Phase 6: Post-trade direction feedback
    if (this.recentTradeDirections.length >= 10) {
      const recentEntries = this.journal.getRecent(20);
      const longTrades = recentEntries.filter(e => e.side === 'long' && e.pnl !== undefined);
      const shortTrades = recentEntries.filter(e => e.side === 'short' && e.pnl !== undefined);
      const longWR = longTrades.length >= 3 ? longTrades.filter(e => (e.pnl ?? 0) > 0).length / longTrades.length : 0.5;
      const shortWR = shortTrades.length >= 3 ? shortTrades.filter(e => (e.pnl ?? 0) > 0).length / shortTrades.length : 0.5;
      if (side === 'long' && longWR < 0.30 && longTrades.length >= 5) {
        regimeDirMult *= 0.8; // Reduce losing direction
      } else if (side === 'long' && longWR > 0.55 && longTrades.length >= 5) {
        regimeDirMult *= 1.1; // Boost winning direction
      }
      if (side === 'short' && shortWR < 0.30 && shortTrades.length >= 5) {
        regimeDirMult *= 0.8;
      } else if (side === 'short' && shortWR > 0.55 && shortTrades.length >= 5) {
        regimeDirMult *= 1.1;
      }
    }

    // Apply all directional multipliers to collateral
    finalCollateral = Math.max(1, finalCollateral * dirScoreMult * regimeDirMult);

    // Record successful signal + direction
    this.signalPressure.recordSignal(snapshot.market, oppScore.total, composite.confidence, false);
    this.recentTradeDirections.push(side);
    if (this.recentTradeDirections.length > 20) this.recentTradeDirections.shift();

    const decision: TradeDecision = {
      action: 'open' as DecisionAction,
      market: snapshot.market, side, leverage, collateral: finalCollateral, tp, sl,
      strategy: strategyName,
      confidence: ed.confidence,
      reasoning: `SCORE=${oppScore.total} ${oppScore.summary} | ${metaDecision.mode} | ${regime.regime} | dir=${side}(×${regimeDirMult.toFixed(2)})`,
      signals: ed.bestResult?.signals ?? [],
      riskLevel: 'safe',
    };

    const riskCheck = this.risk.assessRisk(decision, this.state);
    decision.riskLevel = riskCheck.riskLevel;
    decision.blockReason = riskCheck.blockReason;

    if (decision.riskLevel === 'blocked') { this.signalPressure.recordSignal(snapshot.market, oppScore.total, composite.confidence, true, 'risk_blocked'); return null; }

    // Store policy state for reward computation
    this.activeTradeStates.set(`${snapshot.market}:${side}`, {
      state: policyState, action: policyRec.action, entryTick: this.state.iteration,
    });

    // Cache decision for fast-path reuse
    this.decisionCache.set(snapshot.market, 'opportunityScore', { score: finalScore, passes: true });

    // Simulate for learning
    this.simEngine.simulate(snapshot.market, side, snapshot.price, finalScore, decision.strategy, regime.regime, ed.confidence);

    return { snapshot, score: finalScore, decision };
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
      const rMultiple = managed?.rMultiple ?? 0;
      const ts = this.activeTradeStates.get(tradeKey);
      const holdingTicks = ts ? this.state.iteration - ts.entryTick : 0;
      const momentum = this.exitPolicy.getMomentumState(pos.market, pos.side as 'long' | 'short');

      // ── V_EXIT_DOMINANCE + V_PROFIT_EXPANSION: Priority-ordered exit logic ──

      // Track peak R per position
      const peakKey = `peak_${tradeKey}`;
      const prevPeakR = (this.activeTradeStates.get(peakKey) as unknown as number) ?? 0;
      const currentPeakR = Math.max(prevPeakR, rMultiple);
      (this.activeTradeStates as Map<string, unknown>).set(peakKey, currentPeakR);

      // V_PROFIT_EXPANSION Phase 1: WINNER EXPANSION — let strong trades run
      // If R≥0.30 + momentum accelerating + no reversal → extend TP, do NOT exit
      const isWinnerExpanding = rMultiple >= 0.30 && momentum === 'accelerating';
      if (isWinnerExpanding) {
        this.log('verbose', `WINNER RUN: ${pos.market} ${pos.side} R=${rMultiple.toFixed(2)} momentum=${momentum} — letting it run`);
        // Fall through to trailing stop — do NOT exit early
      }

      // Priority 2: MOMENTUM REVERSAL EXIT — but only if NOT in winner expansion
      if (!isWinnerExpanding && (momentum === 'decaying' || momentum === 'reversing') && rMultiple > 0) {
        this.log('normal', `MOMENTUM EXIT: ${pos.market} ${pos.side} R=${rMultiple.toFixed(2)} momentum=${momentum} — closing to protect profit`);
        await this.closeWithReason(pos, 'momentum_exit', `Momentum ${momentum} at R=${rMultiple.toFixed(2)}`);
        this.positionMgr.untrack(pos.market, pos.side);
        continue;
      }

      // V_PROFIT_EXPANSION Phase 3: DYNAMIC TRAILING PROFIT LOCK (replaces static give-back)
      // R ≥ 0.20 → trail at peakR × 0.60
      // R ≥ 0.40 → trail at peakR × 0.70 (tighter trailing for big winners)
      if (currentPeakR >= 0.20) {
        const trailFactor = currentPeakR >= 0.40 ? 0.70 : 0.60;
        const trailStop = currentPeakR * trailFactor;
        if (rMultiple < trailStop) {
          this.log('normal', `TRAIL LOCK: ${pos.market} ${pos.side} R=${rMultiple.toFixed(2)} < trail ${trailStop.toFixed(2)} (peak=${currentPeakR.toFixed(2)}×${trailFactor}) — closing`);
          await this.closeWithReason(pos, 'trail_lock', `Trail lock at R=${rMultiple.toFixed(2)} (peak=${currentPeakR.toFixed(2)})`);
          this.positionMgr.untrack(pos.market, pos.side);
          continue;
        }
      }

      // V_PROFIT_EXPANSION Phase 2: PARTIAL TP at R ≥ 0.25 — close 30% (not 50%), let 70% run
      if (rMultiple >= 0.25 && !managed?.action?.includes('partial')) {
        this.log('normal', `PARTIAL TP: ${pos.market} ${pos.side} R=${rMultiple.toFixed(2)} — closing 30%, letting 70% run`);
        await this.closeWithReason(pos, 'partial_tp', `R=${rMultiple.toFixed(2)} partial take profit`, 30);
        continue;
      }

      // STAGNATION EARLY EXIT: Cut flat/losing trades before large loss develops.
      // Triggers at 12 ticks if PnL ≤ -0.3% — catches slow bleed early.
      // Does NOT touch profitable trades (pnlPct > 0) or momentum_exit winners.
      if (holdingTicks >= 12 && pnlPct <= -0.3) {
        this.log('normal', `STAGNATION_EARLY_EXIT: ${pos.market} ${pos.side} ticks=${holdingTicks} pnl=${pnlPct.toFixed(2)}% R=${rMultiple.toFixed(2)} — cutting loss early`);
        await this.closeWithReason(pos, 'stagnation', `Early exit: ${holdingTicks} ticks at ${pnlPct.toFixed(2)}%`);
        this.positionMgr.untrack(pos.market, pos.side);
        continue;
      }

      // V_PROFIT_EXPANSION Phase 6: LOSS COMPRESSION — stagnation exit (keep losses tight)
      // Catches remaining flat trades (near-zero PnL) held too long.
      if (holdingTicks > 20 && rMultiple < 0.10) {
        this.log('normal', `STAGNATION EXIT: ${pos.market} ${pos.side} held ${holdingTicks} ticks at R=${rMultiple.toFixed(2)} — closing`);
        await this.closeWithReason(pos, 'stagnation', `Held ${holdingTicks} ticks with R=${rMultiple.toFixed(2)}`);
        this.positionMgr.untrack(pos.market, pos.side);
        continue;
      }

      // ── END V_EXIT_DOMINANCE — fall through to existing exit logic ──

      if (managed) {
        // For trailing stop / hard stop from position manager — always obey
        if (managed.action === 'trailing_stop_hit' || managed.action === 'close') {
          this.log('normal', `${managed.action}: ${pos.market} ${pos.side} — ${managed.reason}`);
          await this.closeWithReason(pos, managed.action === 'trailing_stop_hit' ? 'trailing_stop' : 'risk_monitor', managed.reason);
          this.positionMgr.untrack(pos.market, pos.side);
          continue;
        }

        // For hold/partial/time_decay — consult exit policy learner (Phase 5: Q-learning is advisory)
        if (managed.action === 'hold' || managed.action === 'partial_close' || managed.action === 'time_decay_exit') {
          const regime = this.marketRegimes.get(pos.market) ?? 'RANGING';

          // Compute distance to TP/SL (approximate from position data)
          const entryPrice = pos.entryPrice ?? 0;
          const markPrice = pos.markPrice ?? entryPrice;
          const liqPrice = pos.liquidationPrice ?? 0;
          const distToSlPct = entryPrice > 0 && liqPrice > 0
            ? Math.abs(markPrice - liqPrice) / entryPrice * 100 : 50;
          // Approximate TP distance from R-multiple targets
          const distToTpPct = managed.rMultiple < 1 ? Math.max(0, (1 - managed.rMultiple) * 3) : 0;

          // momentum + holdingTicks already computed above (V_EXIT_DOMINANCE)
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
          if (!exitRec.isExploration && exitRec.confidence > 0.7) {
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
      // ts, holdingTicks, momentum already computed above (V_EXIT_DOMINANCE)
      const regime = this.marketRegimes.get(pos.market) ?? 'RANGING';
      const fallbackMomentum = momentum;
      const exitState = this.exitPolicy.buildState(pnlPct, holdingTicks, regime, 10, 10, fallbackMomentum);
      const ddState = this.drawdown.getState();
      const exitRec = this.exitPolicy.recommend(exitState, ddState.drawdownPct > 0.05);

      if (!exitRec.isExploration && exitRec.confidence > 0.7 && exitRec.action !== 'hold') {
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
      const execStartMs = Date.now();
      const expectedPrice = snapshot?.price ?? 0;
      const coreSide = decision.side === 'long' ? CoreTradeSide.Long : CoreTradeSide.Short;
      const result = await this.context.flashClient.openPosition(
        decision.market,
        coreSide,
        decision.collateral!,
        decision.leverage!,
      );
      const execElapsedMs = Date.now() - execStartMs;

      // V_OMEGA: Record execution quality
      this.execFeedback.recordOpen(
        decision.market,
        decision.side ?? 'long',
        expectedPrice,
        (decision.collateral ?? 0) * (decision.leverage ?? 1),
        result.entryPrice,
        result.sizeUsd,
        execElapsedMs,
        true,
      );
      // V_OMEGA: Record in latency mode if active
      if (this.latencyMode.isActive()) {
        this.latencyMode.recordTradeResult(0);
      }
      // V_PRODUCTION: Log trade open for validation
      if (this.validator.isActive()) {
        const slipBps = expectedPrice > 0 ? Math.abs(result.entryPrice - expectedPrice) / expectedPrice * 10000 : 0;
        const regimeMatch = decision.reasoning.match(/TRENDING_UP|TRENDING_DOWN|RANGING|HIGH_VOLATILITY|COMPRESSION/);
        this.validator.logTradeOpen({
          market: decision.market, side: decision.side ?? 'long', strategy: decision.strategy,
          score: 0, confidence: decision.confidence, ev: 0,
          regime: regimeMatch?.[0] ?? 'UNKNOWN',
          expectedPrice, actualPrice: result.entryPrice,
          collateral: decision.collateral ?? 0, leverage: decision.leverage ?? 1,
          slippageBps: slipBps, feeCostUsd: result.sizeUsd * 0.0008,
          executionMs: execElapsedMs,
        });
      }

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
      // V_OMEGA: Record failed execution
      this.execFeedback.recordOpen(
        decision.market, decision.side ?? 'long',
        snapshot?.price ?? 0, (decision.collateral ?? 0) * (decision.leverage ?? 1),
        0, 0, Date.now() - (snapshot?.timestamp ?? Date.now()), false, msg,
      );
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

      // Orderbook bypass auto-correction:
      // - If bypass EV < 0 after 10 bypass trades → revert to hard block
      // - If hard block active and 20 more total trades pass → reset and retry soft gate
      this.obBypass.pnl += pnl;
      if (this.obBypass.trades >= 10 && this.obBypass.pnl < 0 && !this.obBypass.hardBlock) {
        this.obBypass.hardBlock = true;
        this.log('normal', `OB WALL: Bypass EV $${(this.obBypass.pnl / this.obBypass.trades).toFixed(2)} < 0 after ${this.obBypass.trades} bypass trades — reverting to HARD BLOCK`);
      }
      // Recovery: after 20 total trades since hard block, reset and give soft gate another chance
      if (this.obBypass.hardBlock && this.obBypass.trades > 0) {
        const totalTrades = this.journal.getStats().totalTrades;
        const tradesSinceBlock = totalTrades - (this.obBypass.trades + 10);
        if (tradesSinceBlock >= 20) {
          this.obBypass = { trades: 0, pnl: 0, hardBlock: false };
          this.log('normal', 'OB WALL: Hard block reset after 20 trades — retrying soft gate');
        }
      }

      // V_EDGE_EXTRACTION Phase 1: Record EV by score bucket + regime + direction
      const scoreMatch = decision.reasoning.match(/SCORE=(\d+)/);
      const regimeMatch = decision.reasoning.match(/TRENDING_UP|TRENDING_DOWN|RANGING|HIGH_VOLATILITY|COMPRESSION/);
      const tradeScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
      const tradeRegime = regimeMatch?.[0] ?? 'UNKNOWN';
      const scoreBucket = tradeScore < 45 ? '40-45' : tradeScore < 50 ? '45-50' : tradeScore < 55 ? '50-55' : '55+';
      for (const key of [
        `score:${scoreBucket}`,
        `regime:${tradeRegime}`,
        `dir:${decision.side ?? 'unknown'}`,
        `${scoreBucket}:${tradeRegime}:${decision.side ?? 'unknown'}`,
      ]) {
        const bucket = this.edgeBuckets.get(key) ?? { pnl: 0, count: 0 };
        bucket.pnl += pnl;
        bucket.count++;
        this.edgeBuckets.set(key, bucket);
      }

      // V_EDGE_EXTRACTION Phase 3: Confidence accuracy tracking
      if (decision.confidence >= 0.60) {
        this.confAccuracy.highConf.total++;
        if (won) this.confAccuracy.highConf.wins++;
      } else if (decision.confidence >= 0.40) {
        this.confAccuracy.midConf.total++;
        if (won) this.confAccuracy.midConf.wins++;
      }

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
        let reward = this.policyLearner.computeReward(pnl, decision.collateral ?? 100, decision.leverage ?? 3, holdingTicks);

        // V_LEARNING_ACCELERATION Phase 3: Fast feedback — bonus/penalty for exit quality
        if (decision.strategy === 'momentum_exit' && pnl > 0) reward += 0.1;   // Good momentum exit
        if (decision.strategy === 'stagnation') reward -= 0.1;                  // Stagnation penalty
        if (decision.strategy === 'trail_lock' && pnl > 0) reward += 0.05;     // Profit protected

        // Phase 2: Learning weight boost for edge discovery trades (score 45-55, EV>0)
        // These trades get +15% reward magnitude to accelerate learning from exploration
        const isEdgeDiscovery = (decision.collateral ?? 0) < (this.state.currentCapital * 0.015); // 0.5x sized = edge discovery
        if (isEdgeDiscovery) reward *= 1.15;

        this.policyLearner.update(tradeState.state, tradeState.action, reward);
        this.activeTradeStates.delete(tradeKey);
        const pm = this.policyLearner.getMetrics();
        this.log('verbose', `Policy: reward=${reward.toFixed(3)} ${tradeState.action}${isEdgeDiscovery ? ' [EXPLORE]' : ''} | LR=${pm.learningRate.toFixed(3)} explore=${(pm.explorationRate * 100).toFixed(0)}% sharpe=${pm.sharpe.toFixed(2)} states=${pm.policySize}`);
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

      // V_OMEGA: Record close execution quality + feed PnL to latency mode
      this.execFeedback.recordClose(
        position.market, position.side,
        position.entryPrice ?? 0, position.markPrice ?? 0,
        0, true,
      );
      if (this.latencyMode.isActive()) {
        this.latencyMode.recordTradeResult(pnl);
      }

      // V_EDGE: Record cost-adjusted trade for edge profiling
      const marketExecStats = this.execFeedback.getMarketStats(position.market);
      const slippageCostEst = marketExecStats ? (marketExecStats.avgSlippageBps / 10000) * (position.sizeUsd ?? 0) : 0;
      const feeCostEst = (position.sizeUsd ?? 0) * 0.0008 * 2; // 8bps round-trip
      const regimeFromReasoning = decision.reasoning.match(/TRENDING_UP|TRENDING_DOWN|RANGING|HIGH_VOLATILITY|COMPRESSION/)?.[0] ?? 'UNKNOWN';
      this.edgeProfiler.recordTrade({
        market: position.market,
        strategy: decision.strategy,
        regime: regimeFromReasoning,
        side: position.side,
        score: 0, // score not available here — recorded at open
        confidence: decision.confidence,
        collateral: decision.collateral ?? 0,
        leverage: decision.leverage ?? position.leverage ?? 1,
        expectedPnl: 0, // could be filled from TP distance at open
        actualPnl: pnl,
        slippageCost: slippageCostEst,
        feeCost: feeCostEst,
        executionCost: slippageCostEst + feeCostEst,
        netPnl: pnl - slippageCostEst - feeCostEst,
        exitEfficiency: 0.5, // default; could be computed from MFE tracking
        holdingTimeMs: tradeState ? (this.state.iteration - tradeState.entryTick) * (this.config.pollIntervalMs || 10_000) : 0,
        timestamp: Date.now(),
      });

      // V_CONTROL Phase 7: Feed live trade PnL to shadow comparison
      this.governor.recordLiveTrade(pnl);

      // V_PRODUCTION: Log trade close for validation
      if (this.validator.isActive()) {
        const netPnl = pnl - slippageCostEst - feeCostEst;
        const holdMs = tradeState ? (this.state.iteration - tradeState.entryTick) * (this.config.pollIntervalMs || 10_000) : 0;
        // Find most recent open log for this market/side
        const openLogs = this.validator.getTradeLogs().filter(t => t.market === position.market && t.side === position.side && t.pnl === 0);
        const openLog = openLogs[openLogs.length - 1];
        if (openLog) {
          this.validator.logTradeClose(openLog.id, {
            pnl, pnlPct: position.pnlPercent ?? 0, netPnl, holdingMs: holdMs,
            exitReason: decision.strategy,
          });
        }
        this.validator.recordEquity(this.state.currentCapital);
      }

      this.log('normal', `Closed: ${position.market} ${position.side} PnL=$${pnl.toFixed(2)} net=$${(pnl - slippageCostEst - feeCostEst).toFixed(2)} | policy+weights updated`);

      // V17: Track rolling trade quality for fast-path gating
      this.recentTradeEVs.push(pnl);
      if (this.recentTradeEVs.length > 20) this.recentTradeEVs.shift();

      // V19: Track event vs normal trade outcomes separately
      if (decision.strategy === 'event_trigger') {
        this.eventTradePnls.push(pnl);
        if (this.eventTradePnls.length > 20) this.eventTradePnls.shift();
        if (pnl > 0) this.eventTradeWins++;
      } else {
        this.normalTradePnls.push(pnl);
        if (this.normalTradePnls.length > 20) this.normalTradePnls.shift();
      }

      // V17: Learning protection — log rapid trading warning for awareness
      if (this.hourlyTrades.length > 4) {
        this.log('verbose', `V17: Rapid trading (${this.hourlyTrades.length} trades/hr) — meta-agent handles aggression`);
      }

      // EDGE REFINEMENT: check if cycle should run
      // V_PRODUCTION: Block ALL adaptive changes during validation mode
      const closedCount = this.journal.getStats().totalTrades;
      if (this.validator.isFrozen()) {
        // Architecture frozen for production validation — no refinements allowed
      } else if (this.governor.isShadowRevertFrozen()) {
        this.log('verbose', `EDGE REFINER: blocked by V_CONTROL shadow revert freeze`);
      } else if (this.governor.isFrozen()) {
        this.log('verbose', `EDGE REFINER: blocked by V_CONTROL rate limit freeze`);
      } else if (this.edgeRefiner.shouldRefine(closedCount)) {
        const refinement = this.edgeRefiner.refine(
          this.journal.getEntries(),
          this.journal.getStats(),
          this.policyLearner.getMetrics(),
        );
        if (refinement.type !== 'no_action') {
          // V_CONTROL V2: Record change for rate limiting
          this.governor.recordChange('edge_refiner', refinement.target, 0, 1, this.state.iteration, closedCount);
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

  // ─── V18: Event-Driven Execution ──────────────────────────────────

  private static readonly EVENT_PRICE_THRESHOLD_PCT = 0.8;  // ≥0.8% move triggers event
  private static readonly EVENT_COOLDOWN_MS = 180_000;       // 3 min per-market cooldown
  private static readonly EVENT_GLOBAL_CAP_PER_MIN = 3;      // Max 3 event trades/min

  /**
   * Detect significant market events from price changes between ticks.
   */
  private detectEvents(snapshots: MarketSnapshot[]): Array<{ market: string; snapshot: MarketSnapshot; changePct: number; type: string }> {
    const events: Array<{ market: string; snapshot: MarketSnapshot; changePct: number; type: string }> = [];
    const now = Date.now();

    for (const snap of snapshots) {
      const prev = this.prevPrices.get(snap.market);
      this.prevPrices.set(snap.market, snap.price);
      if (!prev || prev <= 0) continue;

      const changePct = ((snap.price - prev) / prev) * 100;
      const absChange = Math.abs(changePct);

      // Price spike event
      if (absChange >= LiveTradingAgent.EVENT_PRICE_THRESHOLD_PCT) {
        // Check per-market cooldown
        const lastEvent = this.eventCooldowns.get(snap.market) ?? 0;
        if (now - lastEvent < LiveTradingAgent.EVENT_COOLDOWN_MS) continue;

        // Check global cap
        this.eventTradeTimestamps = this.eventTradeTimestamps.filter((t) => now - t < 60_000);
        if (this.eventTradeTimestamps.length >= LiveTradingAgent.EVENT_GLOBAL_CAP_PER_MIN) continue;

        events.push({ market: snap.market, snapshot: snap, changePct, type: 'price_spike' });
      }
    }

    return events;
  }

  /**
   * V18+V19: Run partial pipeline for event-triggered markets.
   * V19 additions: overextension filter, momentum decay check, EV-based validation,
   * event vs normal comparison, adaptive sizing.
   */
  private async handleEventTriggers(
    events: Array<{ market: string; snapshot: MarketSnapshot; changePct: number; type: string }>,
    positions: Position[],
  ): Promise<void> {
    const stats = this.journal.getStats();
    const now = Date.now();

    // Gate: don't event-trade during cold start
    if (stats.totalTrades < 5) return;

    // Gate: respect position limits
    if (positions.length >= (this.config.risk.maxPositions || 2)) return;

    // V19 Phase 3: EV-based validation (replaces simple win rate check)
    if (this.eventTradePnls.length >= 10) {
      const eventEV = this.eventTradePnls.reduce((a, b) => a + b, 0) / this.eventTradePnls.length;
      if (eventEV <= 0) {
        this.log('verbose', `V19: Event EV $${eventEV.toFixed(2)} ≤ 0 after ${this.eventTradePnls.length} trades — events paused`);
        return;
      }
    }

    // V19 Phase 4: If event EV worse than normal, reduce usage
    if (this.eventTradePnls.length >= 15 && this.normalTradePnls.length >= 15) {
      const eventEV = this.eventTradePnls.reduce((a, b) => a + b, 0) / this.eventTradePnls.length;
      const normalEV = this.normalTradePnls.reduce((a, b) => a + b, 0) / this.normalTradePnls.length;
      if (eventEV < normalEV * 0.5) {
        this.log('verbose', `V19: Event EV $${eventEV.toFixed(2)} < 50% of normal EV $${normalEV.toFixed(2)} — events reduced`);
        return;
      }
    }

    for (const event of events) {
      const { market, snapshot, changePct } = event;

      // V19 Phase 2: Momentum decay check — is the move still accelerating?
      const momentum = this.exitPolicy.getMomentumState(market, changePct > 0 ? 'long' : 'short');
      if (momentum === 'decaying' || momentum === 'reversing') {
        this.log('verbose', `V19: ${market} event rejected — momentum ${momentum}`);
        continue;
      }

      // V19 Phase 1: Overextension filter — reject if price too far from recent mean
      const priceHistory = this.technicals.getHistory(market);
      if (priceHistory && priceHistory.length >= 10) {
        const recentMean = priceHistory.slice(-10).reduce((a, b) => a + b, 0) / 10;
        const extensionPct = Math.abs((snapshot.price - recentMean) / recentMean) * 100;
        if (extensionPct > 3.0) {
          this.log('verbose', `V19: ${market} event rejected — overextended ${extensionPct.toFixed(1)}% from mean`);
          continue;
        }
      }

      // Signal fusion
      const composite = this.fusion.fuse(snapshot, snapshot.fundingRate);
      if (!composite.confirmed || composite.confidence < 0.5) continue;

      // Direction must agree with the move
      const side = changePct > 0 ? 'long' : 'short';
      if (composite.direction === 'bullish' && side !== 'long') continue;
      if (composite.direction === 'bearish' && side !== 'short') continue;

      // EV check
      const evCheck = this.expectancy.checkEV('event_trigger', composite.confidence);
      if (!evCheck.allowed && stats.totalTrades > 15) continue;

      // Confidence gate: events need higher bar (≥60%)
      if (composite.confidence < 0.60) continue;

      // V19 Phase 5: Adaptive sizing based on event track record
      this.updateEventSizeTier();
      const collateral = Math.max(1, this.state.currentCapital * this.config.risk.positionSizePct * this.eventSizeTier);
      const leverage = Math.min(3, this.config.risk.maxLeverage);

      // Quick TP/SL
      const slDistance = snapshot.price * 0.02;
      const tpDistance = slDistance * 2.0;
      const tp = side === 'long' ? snapshot.price + tpDistance : snapshot.price - tpDistance;
      const sl = side === 'long' ? snapshot.price - slDistance : snapshot.price + slDistance;

      const decision: TradeDecision = {
        action: 'open' as DecisionAction,
        market, side, leverage, collateral, tp, sl,
        strategy: 'event_trigger',
        confidence: composite.confidence,
        reasoning: `EVENT ${event.type} ${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}% | momentum=${momentum} | size=${(this.eventSizeTier * 100).toFixed(0)}%`,
        signals: composite.factors.map((f) => ({ source: f.name, direction: f.direction, strength: f.confidence, confidence: f.confidence, reason: f.name })),
        riskLevel: 'safe',
      };

      this.log('normal', `EVENT EXECUTE: ${market} ${side} | ${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}% | momentum=${momentum} | size=${(this.eventSizeTier * 100).toFixed(0)}%`);
      this.eventCooldowns.set(market, now);
      this.eventTradeTimestamps.push(now);
      this.eventTradeCount++;

      await this.executeTrade(decision, snapshot);
      break; // Max 1 event trade per tick
    }
  }

  /** V19: Adjust event size tier based on rolling event EV */
  private updateEventSizeTier(): void {
    if (this.eventTradePnls.length < 5) {
      this.eventSizeTier = 0.5; // Default: conservative
      return;
    }
    const ev = this.eventTradePnls.reduce((a, b) => a + b, 0) / this.eventTradePnls.length;
    if (ev > 1.0 && this.eventTradePnls.length >= 15) {
      this.eventSizeTier = Math.min(1.0, this.eventSizeTier + 0.1); // Ramp up
    } else if (ev > 0) {
      this.eventSizeTier = Math.min(0.7, Math.max(0.5, this.eventSizeTier)); // Mid tier
    } else {
      this.eventSizeTier = Math.max(0.3, this.eventSizeTier - 0.1); // Ramp down
    }
  }

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

    // V18: Clean expired event cooldowns
    for (const [market, ts] of this.eventCooldowns) {
      if (now > ts + LiveTradingAgent.EVENT_COOLDOWN_MS) {
        this.eventCooldowns.delete(market);
      }
    }
    // Cap prevPrices to active markets only
    if (this.prevPrices.size > maxEntries) {
      for (const key of this.prevPrices.keys()) {
        if (!activeMarkets.has(key)) this.prevPrices.delete(key);
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
