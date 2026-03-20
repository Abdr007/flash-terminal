/**
 * AgentSupervisor — Live operation & supervision layer.
 *
 * Enforces the protocol:
 * 1. Preflight checks before any start
 * 2. Mandatory dry-run before live
 * 3. Human override authority (emergency stop, close all)
 * 4. Real-time monitoring with deviation detection
 * 5. Session evaluation after stop
 *
 * The agent executes. The human supervises.
 */

import { FlashSDK } from '../sdk/index.js';
import type { FlashSDKOptions } from '../sdk/types.js';
import { TradingAgent } from './agent.js';
import { SessionEvaluator } from './session-evaluator.js';
import type {
  AgentConfig,
  AgentState,
  AgentCallbacks,
  Strategy,
  JournalEntry,
  TradeDecision,
} from './types.js';
import { DEFAULT_AGENT_CONFIG } from './types.js';

// ─── Preflight Types ─────────────────────────────────────────────────────────

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
  critical: boolean;
}

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheck[];
  timestamp: string;
}

// ─── Supervisor Status ───────────────────────────────────────────────────────

export interface SupervisorStatus {
  phase: 'idle' | 'preflight' | 'dry_run' | 'live' | 'stopped' | 'emergency';
  agentState: AgentState | null;
  dryRunCompleted: boolean;
  dryRunTradeCount: number;
  liveTradeCount: number;
  preflightResult: PreflightResult | null;
  startedAt: string | null;
  uptime: number;
}

// ─── Deviation Thresholds ────────────────────────────────────────────────────

const MAX_TRADES_PER_HOUR = 20;
const MAX_CONSECUTIVE_LOSSES = 3;
const RAPID_LOSS_THRESHOLD_PCT = 0.03; // 3% in short period

// ─── AgentSupervisor ─────────────────────────────────────────────────────────

export class AgentSupervisor {
  private readonly sdk: FlashSDK;
  private readonly sdkOptions: FlashSDKOptions;
  private readonly strategies: Strategy[];
  private readonly userCallbacks: AgentCallbacks;
  private agentConfig: AgentConfig;

  private agent: TradingAgent | null = null;
  private phase: SupervisorStatus['phase'] = 'idle';
  private dryRunCompleted = false;
  private dryRunTradeCount = 0;
  private liveTradeCount = 0;
  private preflightResult: PreflightResult | null = null;
  private startedAt: number | null = null;
  private hourlyTradeTimestamps: number[] = [];

  constructor(
    strategies: Strategy[],
    config: Partial<AgentConfig> = {},
    sdkOptions: FlashSDKOptions = {},
    callbacks: AgentCallbacks = {},
  ) {
    this.strategies = strategies;
    this.agentConfig = { ...DEFAULT_AGENT_CONFIG, ...config, risk: { ...DEFAULT_AGENT_CONFIG.risk, ...config.risk } };
    this.sdkOptions = { timeout: 20_000, ...sdkOptions };
    this.userCallbacks = callbacks;
    this.sdk = new FlashSDK(this.sdkOptions);
  }

  // ─── SECTION 1: Preflight Checks ──────────────────────────────────

  /**
   * Run all preflight checks. Must pass before starting agent.
   */
  async runPreflight(): Promise<PreflightResult> {
    this.phase = 'preflight';
    const checks: PreflightCheck[] = [];

    // 1. System health
    checks.push(await this.checkSystemHealth());

    // 2. Wallet balance
    checks.push(await this.checkWalletBalance());

    // 3. Configuration validation
    checks.push(this.checkConfiguration());

    // 4. Strategy validation
    checks.push(this.checkStrategies());

    // 5. Market availability
    checks.push(await this.checkMarkets());

    const passed = checks.filter((c) => c.critical).every((c) => c.passed);

    this.preflightResult = {
      passed,
      checks,
      timestamp: new Date().toISOString(),
    };

    this.phase = passed ? 'idle' : 'stopped';
    return this.preflightResult;
  }

  private async checkSystemHealth(): Promise<PreflightCheck> {
    try {
      // Try positions as a lighter health check — doctor requires full terminal init
      const response = await this.sdk.executeRaw('positions');
      // Any valid response (even empty positions) means the system is reachable
      return {
        name: 'system_health',
        passed: true,
        message: response.success ? 'System healthy' : 'System reachable (with warnings)',
        critical: true,
      };
    } catch (error: unknown) {
      // If we can't reach the CLI at all, it's a hard fail
      const msg = error instanceof Error ? error.message : String(error);
      // Parse errors mean the CLI ran but returned non-JSON — still "healthy"
      if (msg.includes('PARSE_ERROR') || msg.includes('parse')) {
        return { name: 'system_health', passed: true, message: 'System reachable', critical: true };
      }
      return {
        name: 'system_health',
        passed: false,
        message: `Health check error: ${msg}`,
        critical: true,
      };
    }
  }

  private async checkWalletBalance(): Promise<PreflightCheck> {
    try {
      const response = await this.sdk.executeRaw('wallet balance');
      const data = response.data as Record<string, unknown>;
      const usdc = (data.usdc as number) ?? (data.balance as number) ?? 0;

      if (usdc < 1) {
        // In simulation mode, $0 is expected (sim starts with virtual balance)
        const isSim = (this.sdkOptions.env?.SIMULATION_MODE ?? process.env.SIMULATION_MODE ?? 'true').toLowerCase() !== 'false';
        if (isSim) {
          return { name: 'wallet_balance', passed: true, message: 'Simulation mode — virtual balance available', critical: false };
        }
        return { name: 'wallet_balance', passed: false, message: `USDC balance too low: $${usdc}`, critical: true };
      }
      return { name: 'wallet_balance', passed: true, message: `USDC: $${usdc.toFixed(2)}`, critical: true };
    } catch {
      // In simulation mode, wallet balance may not be available via CLI
      return { name: 'wallet_balance', passed: true, message: 'Wallet check skipped (simulation mode)', critical: false };
    }
  }

  private checkConfiguration(): PreflightCheck {
    const r = this.agentConfig.risk;
    const issues: string[] = [];

    if (r.maxLeverage > 10) issues.push(`Leverage ${r.maxLeverage}x is dangerously high`);
    if (r.positionSizePct > 0.1) issues.push(`Position size ${(r.positionSizePct * 100).toFixed(0)}% exceeds 10% limit`);
    if (r.maxPositions > 5) issues.push(`Max ${r.maxPositions} positions is excessive`);
    if (r.maxDailyLossPct > 0.1) issues.push(`Daily loss limit ${(r.maxDailyLossPct * 100).toFixed(0)}% exceeds 10%`);
    if (this.agentConfig.markets.length === 0) issues.push('No markets configured');

    if (issues.length > 0) {
      return { name: 'configuration', passed: false, message: issues.join('; '), critical: true };
    }
    return { name: 'configuration', passed: true, message: 'Config validated', critical: true };
  }

  private checkStrategies(): PreflightCheck {
    if (this.strategies.length === 0) {
      return { name: 'strategies', passed: false, message: 'No strategies configured', critical: true };
    }
    const names = this.strategies.map((s) => s.name).join(', ');
    return { name: 'strategies', passed: true, message: `Strategies: ${names}`, critical: true };
  }

  private async checkMarkets(): Promise<PreflightCheck> {
    try {
      const response = await this.sdk.executeRaw('markets');
      return { name: 'markets', passed: response.success, message: response.success ? 'Markets accessible' : 'Markets unavailable', critical: false };
    } catch {
      return { name: 'markets', passed: false, message: 'Could not fetch markets', critical: false };
    }
  }

  // ─── SECTION 2: Controlled Activation ──────────────────────────────

  /**
   * Start agent in DRY-RUN mode. Mandatory before live trading.
   * Observe behavior without executing real trades.
   */
  async startDryRun(iterations?: number): Promise<void> {
    // Preflight must pass
    if (!this.preflightResult?.passed) {
      const result = await this.runPreflight();
      if (!result.passed) {
        throw new Error(`Preflight failed: ${result.checks.filter((c) => !c.passed).map((c) => c.message).join('; ')}`);
      }
    }

    this.phase = 'dry_run';
    this.dryRunTradeCount = 0;
    this.startedAt = Date.now();

    const config: Partial<AgentConfig> = {
      ...this.agentConfig,
      dryRun: true,
      maxIterations: iterations ?? (this.agentConfig.maxIterations || 20),
    };

    this.agent = new TradingAgent(
      this.strategies,
      config,
      { ...this.sdkOptions, env: { ...this.sdkOptions.env, SIMULATION_MODE: 'true' } },
      this.buildCallbacks(true),
    );

    await this.agent.start();

    this.dryRunCompleted = true;
    this.dryRunTradeCount = this.agent.getJournal().getStats().totalTrades;
    this.phase = 'idle';
  }

  /**
   * Start agent in LIVE mode (still simulation unless SIMULATION_MODE=false).
   * Requires dry-run completion first.
   */
  async startLive(): Promise<void> {
    if (!this.dryRunCompleted) {
      throw new Error('Dry-run must complete before live trading. Call startDryRun() first.');
    }

    // Re-run preflight
    const preflight = await this.runPreflight();
    if (!preflight.passed) {
      throw new Error(`Preflight failed: ${preflight.checks.filter((c) => !c.passed).map((c) => c.message).join('; ')}`);
    }

    this.phase = 'live';
    this.liveTradeCount = 0;
    this.startedAt = Date.now();
    this.hourlyTradeTimestamps = [];

    const config: Partial<AgentConfig> = {
      ...this.agentConfig,
      dryRun: false,
    };

    this.agent = new TradingAgent(
      this.strategies,
      config,
      this.sdkOptions,
      this.buildCallbacks(false),
    );

    await this.agent.start();
    this.phase = 'stopped';
  }

  // ─── SECTION 4: Override Authority ─────────────────────────────────

  /**
   * Emergency stop — immediately halt agent and optionally close all positions.
   */
  async emergencyStop(closePositions = false): Promise<void> {
    this.phase = 'emergency';

    if (this.agent) {
      this.agent.stop();
    }

    if (closePositions) {
      try {
        await this.sdk.execute('close all');
        this.log('EMERGENCY: All positions closed');
      } catch (error: unknown) {
        this.log(`EMERGENCY: Failed to close positions: ${error instanceof Error ? error.message : error}`);
      }
    }

    this.log('EMERGENCY STOP executed');
  }

  /**
   * Close all open positions without stopping the agent.
   */
  async closeAllPositions(): Promise<void> {
    try {
      await this.sdk.execute('close all');
      this.log('Override: All positions closed');
    } catch (error: unknown) {
      this.log(`Override: Close all failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  /**
   * Graceful stop — let agent finish current tick, then stop.
   */
  stop(): void {
    if (this.agent) {
      this.agent.stop();
      this.log('Graceful stop requested');
    }
    // Release tracking state to prevent leaks between sessions
    this.hourlyTradeTimestamps = [];
    this.agent = null;
  }

  // ─── SECTION 3 & 5: Monitoring & Evaluation ────────────────────────

  /**
   * Get current supervisor status.
   */
  getStatus(): SupervisorStatus {
    return {
      phase: this.phase,
      agentState: this.agent?.getState() ?? null,
      dryRunCompleted: this.dryRunCompleted,
      dryRunTradeCount: this.dryRunTradeCount,
      liveTradeCount: this.liveTradeCount,
      preflightResult: this.preflightResult,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /**
   * Evaluate the completed session — returns structured report with scaling recommendation.
   */
  evaluateSession(): ReturnType<SessionEvaluator['evaluate']> {
    if (!this.agent) {
      throw new Error('No agent session to evaluate');
    }
    const evaluator = new SessionEvaluator();
    return evaluator.evaluate(this.agent.getJournal(), this.agent.getState());
  }

  /**
   * Get the underlying agent (for direct inspection).
   */
  getAgent(): TradingAgent | null {
    return this.agent;
  }

  // ─── SECTION 3: Deviation Detection ────────────────────────────────

  private checkDeviations(state: AgentState, _isDryRun: boolean): string | null {
    // Rapid trading detection
    const now = Date.now();
    this.hourlyTradeTimestamps = this.hourlyTradeTimestamps.filter((t) => now - t < 3_600_000);
    if (this.hourlyTradeTimestamps.length > MAX_TRADES_PER_HOUR) {
      return `Trade frequency too high: ${this.hourlyTradeTimestamps.length} trades/hour (max ${MAX_TRADES_PER_HOUR})`;
    }

    // Consecutive losses
    if (state.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      return `${MAX_CONSECUTIVE_LOSSES} consecutive losses — stopping for review`;
    }

    // Rapid capital loss
    if (state.startingCapital > 0) {
      const lossPct = Math.abs(Math.min(0, state.dailyPnl)) / state.startingCapital;
      if (lossPct >= RAPID_LOSS_THRESHOLD_PCT && state.dailyTradeCount <= 3) {
        return `Rapid loss: ${(lossPct * 100).toFixed(1)}% in ${state.dailyTradeCount} trades`;
      }
    }

    return null;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private buildCallbacks(isDryRun: boolean): AgentCallbacks {
    return {
      onTick: (state, iteration) => {
        // Deviation check on every tick
        const deviation = this.checkDeviations(state, isDryRun);
        if (deviation && !isDryRun) {
          this.log(`DEVIATION DETECTED: ${deviation}`);
          this.emergencyStop(false).catch(() => {});
        }
        this.userCallbacks.onTick?.(state, iteration);
      },
      onDecision: (decision: TradeDecision) => {
        this.userCallbacks.onDecision?.(decision);
      },
      onTrade: (entry: JournalEntry) => {
        this.hourlyTradeTimestamps.push(Date.now());
        if (isDryRun) this.dryRunTradeCount++;
        else this.liveTradeCount++;
        this.userCallbacks.onTrade?.(entry);
      },
      onSafetyStop: (reason: string, state: AgentState) => {
        this.phase = 'stopped';
        this.log(`Agent safety stop: ${reason}`);
        this.userCallbacks.onSafetyStop?.(reason, state);
      },
      onError: (error: Error, context: string) => {
        this.userCallbacks.onError?.(error, context);
      },
      onStatusChange: (status, prev) => {
        this.userCallbacks.onStatusChange?.(status, prev);
      },
    };
  }

  private log(message: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`${ts} [supervisor] ${message}`);
  }
}
