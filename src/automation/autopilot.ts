import chalk from 'chalk';
import {
  AutopilotConfig,
  AutopilotState,
  TradeSuggestion,
  ToolContext,
  StrategySignal,
} from '../types/index.js';
import { SolanaInspector } from '../agent/solana-inspector.js';
import { MarketScanner } from '../scanner/market-scanner.js';
import { computeExposure } from '../risk/exposure.js';
import { assessAllPositions } from '../risk/liquidation-risk.js';
import { checkAutopilotRisk } from '../config/risk-config.js';
import { PortfolioManager } from '../portfolio/portfolio-manager.js';
import { formatUsd } from '../utils/format.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

export type AutopilotTradeHandler = (suggestion: TradeSuggestion) => Promise<void>;

/** Minimum balance (USDC) required to trade */
const MIN_TRADE_BALANCE = 10;

/**
 * Autopilot trading loop.
 * Monitors markets, evaluates signals, runs risk checks,
 * and optionally executes trades.
 */
export class Autopilot {
  private config: AutopilotConfig;
  private context: ToolContext;
  private inspector: SolanaInspector;
  private scanner: MarketScanner;
  private portfolioManager: PortfolioManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onTrade: AutopilotTradeHandler | null = null;
  private onLog: ((message: string) => void) | null = null;
  private cycleRunning = false;
  private lastTradeAt = 0;
  private static readonly TRADE_COOLDOWN_MS = 60_000; // 60s between trades
  private static readonly MAX_POSITIONS = 5;
  private static readonly MIN_CONFIDENCE = 0.5;

  readonly state: AutopilotState = {
    active: false,
    startedAt: null,
    cycleCount: 0,
    lastCycleAt: null,
    lastSuggestion: null,
    lastSignals: [],
  };

  constructor(context: ToolContext, config: AutopilotConfig) {
    this.context = context;
    this.config = config;
    this.inspector = new SolanaInspector(context.flashClient, context.dataClient);
    this.scanner = new MarketScanner(this.inspector);
    this.portfolioManager = new PortfolioManager();
  }

  setTradeHandler(handler: AutopilotTradeHandler): void {
    this.onTrade = handler;
  }

  setLogHandler(handler: (message: string) => void): void {
    this.onLog = handler;
  }

  private log(message: string): void {
    if (this.onLog) {
      this.onLog(message);
    }
  }

  start(): string {
    // Hard block: autopilot must never run in live mode
    if (!this.context.simulationMode) {
      return [
        '',
        chalk.red('  Autopilot disabled in LIVE mode.'),
        chalk.dim('  Restart terminal and select Simulation to use autopilot.'),
        '',
      ].join('\n');
    }

    if (this.state.active) {
      return chalk.yellow('  Autopilot is already running.');
    }

    // Clear any orphaned timer from a previous session
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.state.active = true;
    this.state.startedAt = Date.now();
    this.state.cycleCount = 0;

    this.timer = setInterval(() => {
      this.cycle().catch((err) => {
        getLogger().error('AUTOPILOT', `Cycle error: ${getErrorMessage(err)}`);
      });
    }, this.config.intervalMs);
    this.timer.unref();

    const lines = [
      '',
      chalk.bold.green('  Autopilot Started'),
      '',
      `  Monitoring markets every ${this.config.intervalMs / 1000} seconds.`,
      '',
      chalk.bold('  Strategy Signals:'),
      `    Momentum`,
      `    Mean Reversion`,
      `    Whale Tracking`,
      '',
      chalk.bold('  Risk Controls Enabled.'),
      `    Max Position: ${formatUsd(this.config.maxPositionSize)}`,
      `    Max Exposure:  ${formatUsd(this.config.maxExposure)}`,
      `    Max Leverage:  ${this.config.maxLeverage}x`,
      `    Markets:       ${this.config.markets.join(', ')}`,
      '',
    ];

    return lines.join('\n');
  }

  stop(): string {
    if (!this.state.active) {
      return chalk.yellow('  Autopilot is not running.');
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const runtime = this.state.startedAt
      ? Math.round((Date.now() - this.state.startedAt) / 1000)
      : 0;

    this.state.active = false;
    this.state.startedAt = null;

    const lines = [
      '',
      chalk.bold.red('  Autopilot Stopped'),
      '',
      `  Runtime: ${runtime}s`,
      `  Cycles completed: ${this.state.cycleCount}`,
      '',
    ];

    return lines.join('\n');
  }

  getStatus(): string {
    const lines = [
      '',
      chalk.bold('  Autopilot Status'),
      chalk.dim('  ─────────────────────────────────────────'),
      '',
      `  Status:     ${this.state.active ? chalk.green.bold('ACTIVE') : chalk.gray('INACTIVE')}`,
    ];

    if (this.state.active && this.state.startedAt) {
      const runtime = Math.round((Date.now() - this.state.startedAt) / 1000);
      lines.push(`  Runtime:    ${runtime}s`);
      lines.push(`  Cycles:     ${this.state.cycleCount}`);
      lines.push(`  Interval:   ${this.config.intervalMs / 1000}s`);
    }

    if (this.state.lastSignals.length > 0) {
      lines.push('');
      lines.push(chalk.bold('  Latest Signals:'));
      for (const sig of this.state.lastSignals) {
        const color = sig.signal === 'bullish' ? chalk.green : sig.signal === 'bearish' ? chalk.red : chalk.gray;
        lines.push(`    ${sig.name}: ${color(sig.signal.toUpperCase())} (${(sig.confidence * 100).toFixed(0)}%)`);
      }
    }

    if (this.state.lastSuggestion) {
      const s = this.state.lastSuggestion;
      const sideColor = s.side === 'long' ? chalk.green : chalk.red;
      lines.push('');
      lines.push(chalk.bold('  Last Suggestion:'));
      lines.push(`    ${sideColor(s.side.toUpperCase())} ${s.market} ${s.leverage}x — ${(s.confidence * 100).toFixed(0)}% confidence`);
    }

    lines.push('');
    return lines.join('\n');
  }

  private async cycle(): Promise<void> {
    // Concurrency guard: prevent overlapping cycles
    if (this.cycleRunning) {
      getLogger().debug('AUTOPILOT', 'Skipping cycle — previous cycle still running');
      return;
    }
    this.cycleRunning = true;
    const logger = getLogger();

    try {
      this.state.cycleCount++;
      this.state.lastCycleAt = Date.now();

      // Active check: abort if stopped mid-cycle
      if (!this.state.active) return;

      // 1. Fetch FRESH positions and portfolio each cycle (no stale cached data)
      const [positions, portfolio] = await Promise.all([
        this.inspector.getPositions(),
        this.inspector.getPortfolio(),
      ]);

      if (!this.state.active) return;

      // Balance guard: use USDC balance from portfolio if available, fall back to SOL balance
      const usdcBalance = (portfolio as { usdcBalance?: number }).usdcBalance ?? 0;
      const balance = usdcBalance > 0 ? usdcBalance : this.context.flashClient.getBalance();

      if (balance < MIN_TRADE_BALANCE) {
        logger.info('AUTOPILOT', `Cycle ${this.state.cycleCount}: Balance $${balance.toFixed(2)} below minimum $${MIN_TRADE_BALANCE} — skipping`);
        this.log(chalk.yellow(`  [Autopilot] Insufficient balance ($${balance.toFixed(2)}) — skipping cycle`));
        return;
      }

      // Position count cap
      if (positions.length >= Autopilot.MAX_POSITIONS) {
        logger.info('AUTOPILOT', `Cycle ${this.state.cycleCount}: Max positions (${Autopilot.MAX_POSITIONS}) reached`);
        this.log(chalk.yellow(`  [Autopilot] Max positions (${Autopilot.MAX_POSITIONS}) reached — skipping`));
        return;
      }

      // 2. Verify market data availability — skip cycle if prices look unreliable
      const markets = await this.inspector.getMarkets();
      const validPriceMarkets = markets.filter((m) => m.price > 0 && Number.isFinite(m.price));
      if (validPriceMarkets.length === 0) {
        logger.info('AUTOPILOT', `Cycle ${this.state.cycleCount}: No markets with valid prices — skipping`);
        this.log(chalk.yellow('  [Autopilot] No live price data available — skipping cycle'));
        return;
      }
      if (validPriceMarkets.length < markets.length * 0.5) {
        logger.info('AUTOPILOT', `Cycle ${this.state.cycleCount}: Only ${validPriceMarkets.length}/${markets.length} markets have live prices — skipping`);
        this.log(chalk.yellow('  [Autopilot] Insufficient live price data — skipping cycle'));
        return;
      }

      // 3. Use scanner to find opportunities across all markets
      const opportunities = await this.scanner.scan(balance);

      if (opportunities.length === 0) {
        logger.debug('AUTOPILOT', `Cycle ${this.state.cycleCount}: No opportunities found`);
        return;
      }

      // Filter to configured markets
      const configuredMarkets = new Set(this.config.markets.map((m) => m.toUpperCase()));
      const configuredOpps = opportunities.filter((o) => configuredMarkets.has(o.market.toUpperCase()));

      if (configuredOpps.length === 0) {
        logger.debug('AUTOPILOT', `Cycle ${this.state.cycleCount}: No opportunities in configured markets`);
        return;
      }

      // 4. Portfolio-aware evaluation: filters by allocation, correlation, exposure limits
      const bestOpp = this.portfolioManager.evaluate(
        configuredOpps,
        positions,
        balance,
        this.config.maxPositionSize,
        this.config.maxExposure,
      );

      if (!bestOpp) {
        logger.debug('AUTOPILOT', `Cycle ${this.state.cycleCount}: No opportunities passed portfolio constraints`);
        return;
      }

      this.state.lastSignals = bestOpp.signals;

      // Log regime for observability
      if (bestOpp.regime) {
        logger.info('AUTOPILOT', `Cycle ${this.state.cycleCount}: ${bestOpp.market} regime=${bestOpp.regime}`);
      }

      // Convert opportunity to trade suggestion (collateral adjusted by portfolio manager)
      const suggestion: TradeSuggestion = {
        market: bestOpp.market,
        side: bestOpp.direction,
        leverage: bestOpp.recommendedLeverage,
        collateral: bestOpp.recommendedCollateral,
        confidence: bestOpp.confidence,
        reasoning: bestOpp.reasoning,
        risks: ['Strategy-based suggestion', 'Market conditions may change rapidly'],
      };

      this.state.lastSuggestion = suggestion;

      // Confidence floor: reject low-confidence signals
      if (suggestion.confidence < Autopilot.MIN_CONFIDENCE) {
        logger.info('AUTOPILOT', `Cycle ${this.state.cycleCount}: Confidence ${(suggestion.confidence * 100).toFixed(0)}% below minimum ${(Autopilot.MIN_CONFIDENCE * 100).toFixed(0)}%`);
        return;
      }

      // Cooldown: minimum time between trades
      const now = Date.now();
      if (this.lastTradeAt > 0 && (now - this.lastTradeAt) < Autopilot.TRADE_COOLDOWN_MS) {
        const remaining = Math.ceil((Autopilot.TRADE_COOLDOWN_MS - (now - this.lastTradeAt)) / 1000);
        logger.debug('AUTOPILOT', `Cycle ${this.state.cycleCount}: Cooldown — ${remaining}s remaining`);
        return;
      }

      // 5. Run autopilot-specific risk checks (on top of portfolio checks)
      const exposure = computeExposure(portfolio);
      const currentExposure = exposure.totalLongExposure + exposure.totalShortExposure;
      const riskCheck = checkAutopilotRisk({
        collateral: suggestion.collateral,
        leverage: suggestion.leverage,
        balance,
        currentExposure,
        config: this.config,
      });

      if (!riskCheck.passed) {
        logger.info('AUTOPILOT', `Cycle ${this.state.cycleCount}: Risk check blocked — ${riskCheck.reason}`);
        this.log(chalk.yellow(`  [Autopilot] Trade blocked by risk: ${riskCheck.reason}`));
        return;
      }

      // 6. Check liquidation risk on existing positions
      if (positions.length > 0) {
        const risks = assessAllPositions(positions);
        const criticalPositions = risks.filter((r) => r.riskLevel === 'critical');
        if (criticalPositions.length > 0) {
          logger.info('AUTOPILOT', `Cycle ${this.state.cycleCount}: Skipping — ${criticalPositions.length} critical position(s)`);
          this.log(chalk.yellow(`  [Autopilot] Skipping: ${criticalPositions.length} position(s) at critical risk`));
          return;
        }
      }

      // Final active check before execution
      if (!this.state.active) return;

      // Execution safety: block any autopilot trading in live mode
      if (!this.context.simulationMode) {
        logger.error('AUTOPILOT', 'Autopilot execution blocked in live mode');
        this.stop();
        return;
      }

      // 7. Execute in simulation mode
      const sideColor = suggestion.side === 'long' ? chalk.green : chalk.red;
      const msg = `  [Autopilot] Signal: ${sideColor(suggestion.side.toUpperCase())} ${suggestion.market} ${suggestion.leverage}x ${formatUsd(suggestion.collateral)} (${(suggestion.confidence * 100).toFixed(0)}%)`;

      if (this.onTrade) {
        this.log(chalk.cyan(msg + ' — auto-executing in simulation'));
        // Set cooldown BEFORE executing — prevents tight retry loops if onTrade
        // throws (e.g. RPC outage). Without this, the next cycle immediately
        // retries the same trade instead of waiting for cooldown.
        this.lastTradeAt = Date.now();
        try {
          await this.onTrade(suggestion);
        } catch (tradeErr: unknown) {
          logger.error('AUTOPILOT', `Trade execution failed: ${getErrorMessage(tradeErr)}`);
          this.log(chalk.red(`  [Autopilot] Trade failed: ${getErrorMessage(tradeErr)}`));
        }
      } else {
        this.log(chalk.cyan(msg));
      }

      logger.info('AUTOPILOT', `Cycle ${this.state.cycleCount}: ${suggestion.side} ${suggestion.market} ${suggestion.leverage}x`);

    } catch (error: unknown) {
      logger.error('AUTOPILOT', `Cycle ${this.state.cycleCount} failed: ${getErrorMessage(error)}`);
    } finally {
      this.cycleRunning = false;
    }
  }
}
