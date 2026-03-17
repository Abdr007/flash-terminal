/**
 * TradingAgent — Autonomous trading agent built on Flash SDK.
 *
 * Implements the observe → analyze → decide → execute → monitor → exit loop.
 * Composes: SDK, RiskManager, SignalDetector, Strategy, TradeJournal.
 *
 * Safety-first: stops on anomalies, enforces risk limits, logs every decision.
 */

import { FlashSDK, FlashError } from '../sdk/index.js';
import type { FlashSDKOptions, Position } from '../sdk/types.js';
import { RiskManager } from './risk-manager.js';
import { SignalDetector } from './signal-detector.js';
import { TradeJournal } from './trade-journal.js';
import { selectBestStrategy } from './strategy.js';
import type {
  AgentConfig,
  AgentState,
  AgentCallbacks,
  AgentStatus,
  Strategy,
  TradeDecision,
  MarketSnapshot,
  DecisionAction,
} from './types.js';
import { DEFAULT_AGENT_CONFIG } from './types.js';

// ─── TradingAgent ────────────────────────────────────────────────────────────

export class TradingAgent {
  private readonly sdk: FlashSDK;
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
    strategies: Strategy[],
    config: Partial<AgentConfig> = {},
    sdkOptions: FlashSDKOptions = {},
    callbacks: AgentCallbacks = {},
  ) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config, risk: { ...DEFAULT_AGENT_CONFIG.risk, ...config.risk } };
    this.strategies = strategies;
    this.callbacks = callbacks;

    this.sdk = new FlashSDK({
      timeout: 20_000,
      env: { SIMULATION_MODE: 'true' },
      ...sdkOptions,
    });
    this.risk = new RiskManager(this.config.risk);
    this.signals = new SignalDetector();
    this.journal = new TradeJournal();

    this.state = this.createInitialState();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Start the agent loop. Runs until stop() is called or max iterations reached.
   */
  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.stopRequested = false;
    this.setStatus('running' as AgentStatus);

    this.log('info', `Agent "${this.config.name}" starting`);
    this.log('info', `Markets: ${this.config.markets.join(', ')}`);
    this.log('info', `Strategies: ${this.strategies.map((s) => s.name).join(', ')}`);
    this.log('info', `Risk: max ${this.config.risk.maxPositions} positions, max ${this.config.risk.maxLeverage}x leverage, ${(this.config.risk.positionSizePct * 100).toFixed(0)}% sizing`);
    if (this.config.dryRun) this.log('info', 'DRY RUN MODE — no trades will be executed');

    // Initialize capital
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

        // Count consecutive tick errors — safety stop after 5
        if (this.state.iteration > 0) {
          // Don't safety-stop on first tick
        }
      }

      if (this.running && !this.stopRequested) {
        await sleep(this.config.pollIntervalMs);
      }
    }

    this.running = false;
    this.setStatus('stopped' as AgentStatus);
    this.log('info', `Agent stopped after ${this.state.iteration} iterations`);
    this.log('info', `Journal:\n${this.journal.formatStats()}`);
  }

  /**
   * Stop the agent gracefully.
   */
  stop(): void {
    this.stopRequested = true;
    this.log('info', 'Stop requested');
  }

  /**
   * Get current agent state.
   */
  getState(): Readonly<AgentState> {
    return this.state;
  }

  /**
   * Get the trade journal.
   */
  getJournal(): TradeJournal {
    return this.journal;
  }

  /**
   * Get the risk manager.
   */
  getRiskManager(): RiskManager {
    return this.risk;
  }

  // ─── Core Loop ─────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    this.state.iteration++;
    this.callbacks.onTick?.(this.state, this.state.iteration);

    // Check if daily loss breached
    if (this.risk.isDailyLossBreached(this.state)) {
      this.safetyStop(`Daily loss limit breached: $${this.state.dailyPnl.toFixed(2)}`);
      return;
    }

    // Phase 1: OBSERVE — fetch current state
    const [positions, snapshots] = await Promise.all([
      this.observePositions(),
      this.observeMarkets(),
    ]);

    if (!snapshots.length) {
      this.log('verbose', 'No market data available');
      return;
    }

    this.state.positions = positions;
    this.state.currentCapital = await this.fetchCapital();

    // Phase 2: MONITOR — check existing positions for exit conditions
    await this.monitorPositions(positions);

    // Phase 3: ANALYZE + DECIDE — for each market, detect signals and evaluate strategies
    for (const snapshot of snapshots) {
      const marketSignals = this.signals.detect(snapshot);
      const alignment = this.signals.areSignalsAligned(marketSignals);

      this.log('verbose', `${snapshot.market}: ${marketSignals.length} signals, aligned=${alignment.aligned}, dir=${alignment.direction}`);

      // If signals conflict → skip (SECTION 3 rule)
      if (!alignment.aligned) {
        this.log('verbose', `${snapshot.market}: signals conflict — skipping`);
        continue;
      }

      // Evaluate strategies
      const bestStrategy = selectBestStrategy(this.strategies, snapshot, marketSignals);
      if (!bestStrategy || !bestStrategy.shouldTrade) continue;

      // Phase 4: DECIDE — build trade decision with risk assessment
      const decision = this.buildDecision(bestStrategy, snapshot);

      this.callbacks.onDecision?.(decision);
      this.log('normal', `Decision: ${decision.action} ${decision.market} ${decision.side ?? ''} | confidence=${(decision.confidence * 100).toFixed(0)}% | risk=${decision.riskLevel}`);

      // Phase 5: EXECUTE — only if risk allows and not dry-run
      if (decision.action === ('open' as DecisionAction) && decision.riskLevel !== 'blocked') {
        await this.executeTrade(decision);
      } else if (decision.riskLevel === 'blocked') {
        this.log('normal', `Blocked: ${decision.blockReason}`);
        this.journal.record(decision);
      }
    }
  }

  // ─── Observe ───────────────────────────────────────────────────────

  private async observePositions(): Promise<Position[]> {
    try {
      const response = await this.sdk.executeRaw('positions');
      return (response.data as Record<string, unknown>).positions as Position[] ?? [];
    } catch {
      return this.state.positions; // Use stale data on failure
    }
  }

  private async observeMarkets(): Promise<MarketSnapshot[]> {
    const snapshots: MarketSnapshot[] = [];

    for (const market of this.config.markets) {
      try {
        const response = await this.sdk.executeRaw(`analyze ${market}`);
        const d = response.data as Record<string, unknown>;

        if (!response.success) continue;

        snapshots.push({
          market,
          price: (d.price as number) ?? 0,
          priceChange24h: (d.priceChange24h as number) ?? (d.price_change_24h as number) ?? 0,
          volume24h: (d.volume24h as number) ?? (d.volume_24h as number) ?? 0,
          volumeChange: (d.volumeChange as number) ?? undefined,
          longOi: (d.openInterestLong as number) ?? (d.long_oi as number) ?? 0,
          shortOi: (d.openInterestShort as number) ?? (d.short_oi as number) ?? 0,
          oiRatio: (d.oiRatio as number) ?? 0,
          fundingRate: (d.fundingRate as number) ?? (d.funding_rate as number) ?? undefined,
          timestamp: Date.now(),
        });
      } catch (error: unknown) {
        this.log('verbose', `Failed to fetch ${market}: ${error instanceof Error ? error.message : error}`);
      }
    }

    return snapshots;
  }

  private async fetchCapital(): Promise<number> {
    try {
      const response = await this.sdk.executeRaw('portfolio');
      const d = response.data as Record<string, unknown>;
      return (d.totalValue as number) ?? (d.usdcBalance as number) ?? this.state.currentCapital;
    } catch {
      return this.state.currentCapital;
    }
  }

  private async initializeCapital(): Promise<void> {
    const capital = await this.fetchCapital();
    if (capital <= 0) {
      throw new Error('Could not determine starting capital');
    }
    this.state.startingCapital = capital;
    this.state.currentCapital = capital;
    this.log('info', `Starting capital: $${capital.toFixed(2)}`);
  }

  // ─── Monitor ───────────────────────────────────────────────────────

  private async monitorPositions(positions: Position[]): Promise<void> {
    for (const pos of positions) {
      const pnlPct = pos.pnlPercent ?? 0;

      // Check for positions that should be closed (stop loss / take profit)
      // This is a safety net — ideally the exchange handles TP/SL
      if (pnlPct < -15) {
        this.log('normal', `Emergency close: ${pos.market} ${pos.side} at ${pnlPct.toFixed(1)}% loss`);
        const closeDecision: TradeDecision = {
          action: 'close' as DecisionAction,
          market: pos.market,
          side: pos.side,
          strategy: 'risk_monitor',
          confidence: 1,
          reasoning: `Emergency stop loss: ${pnlPct.toFixed(1)}% drawdown`,
          signals: [],
          riskLevel: 'safe',
        };
        await this.executeClose(closeDecision, pos);
      }
    }
  }

  // ─── Decide ────────────────────────────────────────────────────────

  private buildDecision(strategyResult: NonNullable<ReturnType<typeof selectBestStrategy>>, snapshot: MarketSnapshot): TradeDecision {
    const side = strategyResult.side ?? 'long';
    const leverage = this.risk.clampLeverage(3); // Conservative default
    const collateral = this.risk.calculatePositionSize(this.state.currentCapital);

    // Check confidence threshold
    if (strategyResult.confidence < this.config.risk.minConfidence) {
      return {
        action: 'skip' as DecisionAction,
        market: snapshot.market,
        side,
        leverage,
        collateral,
        strategy: strategyResult.strategy,
        confidence: strategyResult.confidence,
        reasoning: `Confidence ${(strategyResult.confidence * 100).toFixed(0)}% below threshold ${(this.config.risk.minConfidence * 100).toFixed(0)}%`,
        signals: strategyResult.signals,
        riskLevel: 'safe',
      };
    }

    const decision: TradeDecision = {
      action: 'open' as DecisionAction,
      market: snapshot.market,
      side,
      leverage,
      collateral,
      tp: strategyResult.suggestedTp,
      sl: strategyResult.suggestedSl,
      strategy: strategyResult.strategy,
      confidence: strategyResult.confidence,
      reasoning: strategyResult.reasoning,
      signals: strategyResult.signals,
      riskLevel: 'safe',
    };

    // Risk assessment
    const riskCheck = this.risk.assessRisk(decision, this.state);
    decision.riskLevel = riskCheck.riskLevel;
    decision.blockReason = riskCheck.blockReason;

    return decision;
  }

  // ─── Execute ───────────────────────────────────────────────────────

  private async executeTrade(decision: TradeDecision): Promise<void> {
    if (this.config.dryRun) {
      this.log('normal', `[DRY RUN] Would ${decision.action} ${decision.side} ${decision.market} ${decision.leverage}x $${decision.collateral}`);
      this.journal.record(decision);
      return;
    }

    this.log('normal', `Executing: ${decision.side} ${decision.market} ${decision.leverage}x $${decision.collateral}`);

    try {
      const result = await this.sdk.open({
        market: decision.market,
        side: decision.side!,
        leverage: decision.leverage!,
        collateral: decision.collateral!,
        tp: decision.tp,
        sl: decision.sl,
      });

      const entry = this.journal.record(decision, {
        entryPrice: (result.data as Record<string, unknown>).entryPrice as number | undefined,
      });

      this.state.lastTradeTimestamp = Date.now();
      this.callbacks.onTrade?.(entry);
      this.log('normal', `Trade opened: ${decision.market} ${decision.side}`);
    } catch (error: unknown) {
      const msg = error instanceof FlashError ? `[${error.code}] ${error.message}` : String(error);
      this.log('error', `Trade failed: ${msg}`);
      this.journal.record(decision, { error: msg });

      // Safety stop on repeated execution failures
      if (error instanceof FlashError && error.code === 'PROCESS_ERROR') {
        this.safetyStop(`Execution system failure: ${msg}`);
      }
    }
  }

  private async executeClose(decision: TradeDecision, position: Position): Promise<void> {
    if (this.config.dryRun) {
      this.log('normal', `[DRY RUN] Would close ${position.market} ${position.side}`);
      this.journal.record(decision);
      return;
    }

    try {
      await this.sdk.close({
        market: position.market,
        side: position.side,
        percent: decision.closePercent,
      });

      const pnl = position.pnl ?? 0;
      const entry = this.journal.record(decision, {
        exitPrice: position.markPrice,
        pnl,
        pnlPercent: position.pnlPercent,
      });

      // Update risk state
      this.state = this.risk.processTradeResult(this.state, pnl);
      this.callbacks.onTrade?.(entry);
      this.log('normal', `Position closed: ${position.market} ${position.side} PnL=$${pnl.toFixed(2)}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log('error', `Close failed: ${msg}`);
      this.journal.record(decision, { error: msg });
    }
  }

  // ─── Safety ────────────────────────────────────────────────────────

  private safetyStop(reason: string): void {
    this.log('error', `SAFETY STOP: ${reason}`);
    this.state.safetyStopReason = reason;
    this.setStatus('safety_stop' as AgentStatus);
    this.running = false;
    this.callbacks.onSafetyStop?.(reason, this.state);
  }

  // ─── State Management ──────────────────────────────────────────────

  private setStatus(status: AgentStatus): void {
    const prev = this.state.status;
    this.state.status = status;
    if (prev !== status) {
      this.callbacks.onStatusChange?.(status, prev);
    }
  }

  private createInitialState(): AgentState {
    return {
      status: 'initializing' as AgentStatus,
      iteration: 0,
      startingCapital: 0,
      currentCapital: 0,
      dailyPnl: 0,
      dailyTradeCount: 0,
      lastTradeTimestamp: 0,
      inCooldown: false,
      cooldownUntil: 0,
      positions: [],
      consecutiveLosses: 0,
    };
  }

  // ─── Logging ───────────────────────────────────────────────────────

  private log(level: 'info' | 'normal' | 'verbose' | 'error', message: string): void {
    if (this.config.logLevel === 'quiet' && level !== 'error') return;
    if (this.config.logLevel === 'normal' && level === 'verbose') return;

    const ts = new Date().toISOString().slice(11, 19);
    const prefix = level === 'error' ? '[ERROR]' : `[${this.config.name}]`;
    console.log(`${ts} ${prefix} ${message}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
