import { z } from 'zod';
import chalk from 'chalk';
import {
  ToolDefinition,
  ToolResult,
  ToolContext,
  MarketAnalysis,
  StrategySignal,
  RawActivityRecord,
  Opportunity,
} from '../types/index.js';
import { SolanaInspector } from './solana-inspector.js';
import { MarketScanner } from '../scanner/market-scanner.js';
import { ClawdAgent } from './clawd-agent.js';
import { Autopilot } from '../automation/autopilot.js';
import { DEFAULT_AUTOPILOT_CONFIG } from '../config/risk-config.js';
import { computeMomentumSignal } from '../strategies/momentum.js';
import { computeMeanReversionSignal } from '../strategies/mean-reversion.js';
import { computeWhaleFollowSignal, WhaleActivity } from '../strategies/whale-follow.js';
import { generateFallbackSuggestion } from '../ai/signal-aggregator.js';
import { assessAllPositions } from '../risk/liquidation-risk.js';
import { computeExposure } from '../risk/exposure.js';
import { PortfolioManager } from '../portfolio/portfolio-manager.js';
import { RegimeDetector, MarketRegime } from '../regime/index.js';
import {
  formatUsd,
  formatPrice,
  formatPercent,
  colorPercent,
  colorPnl,
  colorSide,
  formatTable,
} from '../utils/format.js';

let inspectorInstance: SolanaInspector | null = null;
let scannerInstance: MarketScanner | null = null;
let portfolioManagerInstance: PortfolioManager | null = null;
let _clawdApiKey: string | undefined;

/** Set the Anthropic API key for Clawd tools only. Called once at startup. */
export function setClawdApiKey(apiKey: string | undefined): void {
  _clawdApiKey = apiKey;
}

/** Get the scoped API key (not stored in ToolContext). */
export function getClawdApiKey(): string | undefined {
  return _clawdApiKey;
}

function getInspector(context: ToolContext): SolanaInspector {
  if (!inspectorInstance) {
    inspectorInstance = new SolanaInspector(context.flashClient, context.dataClient);
  }
  return inspectorInstance;
}

export function getScanner(context: ToolContext): MarketScanner {
  if (!scannerInstance) {
    scannerInstance = new MarketScanner(getInspector(context));
  }
  return scannerInstance;
}

export function getPortfolioManager(): PortfolioManager {
  if (!portfolioManagerInstance) {
    portfolioManagerInstance = new PortfolioManager();
  }
  return portfolioManagerInstance;
}

let regimeDetectorInstance: RegimeDetector | null = null;

export function getRegimeDetector(): RegimeDetector {
  if (!regimeDetectorInstance) {
    regimeDetectorInstance = new RegimeDetector();
  }
  return regimeDetectorInstance;
}

function regimeLabel(regime?: string): string {
  if (!regime) return chalk.gray('—');
  switch (regime) {
    case MarketRegime.TRENDING: return chalk.green(regime);
    case MarketRegime.RANGING: return chalk.blue(regime);
    case MarketRegime.HIGH_VOLATILITY: return chalk.red(regime);
    case MarketRegime.LOW_VOLATILITY: return chalk.gray(regime);
    case MarketRegime.WHALE_DOMINATED: return chalk.magenta(regime);
    case MarketRegime.LOW_LIQUIDITY: return chalk.yellow(regime);
    default: return chalk.gray(regime);
  }
}

function signalColor(signal: string): string {
  if (signal === 'bullish') return chalk.green(signal.toUpperCase());
  if (signal === 'bearish') return chalk.red(signal.toUpperCase());
  return chalk.gray(signal.toUpperCase());
}

// ─── analyze <market> ──────────────────────────────────────────────────────────

export const clawdAnalyze: ToolDefinition = {
  name: 'clawd_analyze',
  description: 'Analyze a market with strategy signals (momentum, mean reversion, whale follow)',
  parameters: z.object({
    market: z.string(),
  }),
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);
    const marketUpper = String(params.market).toUpperCase();

    const [markets, openInterest, volume, recentActivity, openPositions] = await Promise.all([
      inspector.getMarkets(marketUpper),
      inspector.getOpenInterest(),
      inspector.getVolume(),
      inspector.getRecentActivity(),
      inspector.getOpenPositions(),
    ]);

    const market = markets.find((m) => m.symbol.toUpperCase() === marketUpper);
    if (!market) {
      return { success: false, message: chalk.red(`  Market ${marketUpper} not found.`) };
    }

    // Compute strategy signals
    const momentumSignal = computeMomentumSignal({ market, volume });
    const meanReversionSignal = computeMeanReversionSignal({ market, openInterest });

    // Normalize whale data
    const whaleRecentActivity: WhaleActivity[] = recentActivity.map((a) => ({
      market: String(a.market_symbol ?? a.market ?? ''),
      side: String(a.side ?? 'long'),
      sizeUsd: Number(a.size_usd ?? 0),
      timestamp: Number(a.timestamp ?? Date.now()),
    }));
    const whaleOpenPositions: WhaleActivity[] = openPositions.map((p) => ({
      market: String(p.market_symbol ?? p.market ?? ''),
      side: String(p.side ?? 'long'),
      sizeUsd: Number(p.size_usd ?? 0),
      timestamp: Number(p.timestamp ?? Date.now()),
    }));

    const whaleSignal = computeWhaleFollowSignal({
      recentActivity: whaleRecentActivity,
      openPositions: whaleOpenPositions,
      targetMarket: marketUpper,
    });

    const signals: StrategySignal[] = [momentumSignal, meanReversionSignal, whaleSignal];

    // Determine overall sentiment
    const bullishCount = signals.filter((s) => s.signal === 'bullish').length;
    const bearishCount = signals.filter((s) => s.signal === 'bearish').length;
    let overallSentiment = 'NEUTRAL';
    if (bullishCount > bearishCount) overallSentiment = 'BULLISH';
    else if (bearishCount > bullishCount) overallSentiment = 'BEARISH';

    const oi = openInterest.markets.find((m) => m.market.toUpperCase() === marketUpper);
    const totalOi = oi ? oi.longOi + oi.shortOi : 0;

    // Volume for last day
    const lastDay = volume.dailyVolumes.length > 0
      ? volume.dailyVolumes[volume.dailyVolumes.length - 1]
      : null;

    const analysis: MarketAnalysis = {
      market: marketUpper,
      price: market.price,
      priceChange24h: market.priceChange24h,
      openInterestLong: market.openInterestLong,
      openInterestShort: market.openInterestShort,
      volume24h: lastDay?.volumeUsd ?? 0,
      signals,
      summary: `${marketUpper} overall sentiment: ${overallSentiment}`,
    };

    // Format output
    const lines = [
      '',
      chalk.bold.cyan(`  ═══ ${marketUpper} Market Analysis ═══`),
      '',
      `  Price:         ${formatPrice(market.price)}  ${colorPercent(market.priceChange24h)}`,
      `  Open Interest: ${formatUsd(totalOi)} (Long: ${formatUsd(oi?.longOi ?? 0)} / Short: ${formatUsd(oi?.shortOi ?? 0)})`,
      `  24h Volume:    ${formatUsd(lastDay?.volumeUsd ?? 0)}`,
      `  Max Leverage:  ${market.maxLeverage}x`,
    ];

    // Regime detection
    const rd = getRegimeDetector();
    const regimeState = rd.detectRegime(market, volume, openInterest);
    const rWeights = rd.getWeights(regimeState.regime);
    lines.push(`  Regime:        ${regimeLabel(regimeState.regime)} ${chalk.dim(`(confidence ${(regimeState.confidence * 100).toFixed(0)}%)`)}`);
    lines.push('');
    lines.push(chalk.bold('  Strategy Signals:'));
    lines.push(chalk.dim(`  (Regime weights: momentum=${rWeights.momentum} mean-rev=${rWeights.meanReversion} whale=${rWeights.whaleFollow})`));
    lines.push('');

    for (const sig of signals) {
      lines.push(`    ${chalk.bold(sig.name.padEnd(16))} ${signalColor(sig.signal).padEnd(20)} ${chalk.dim(`(${(sig.confidence * 100).toFixed(0)}% confidence)`)}`);
      lines.push(`    ${chalk.dim(sig.reasoning)}`);
      lines.push('');
    }

    const sentimentColor = overallSentiment === 'BULLISH' ? chalk.green : overallSentiment === 'BEARISH' ? chalk.red : chalk.gray;
    lines.push(`  Overall: ${sentimentColor(overallSentiment)}`);
    lines.push('');

    return {
      success: true,
      data: { analysis },
      message: lines.join('\n'),
    };
  },
};

// ─── suggest trade ─────────────────────────────────────────────────────────────

export const clawdSuggestTrade: ToolDefinition = {
  name: 'clawd_suggest_trade',
  description: 'Get an AI-powered trade suggestion using Claude reasoning (falls back to strategy engine)',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);
    const apiKey = getClawdApiKey();
    const hasApiKey = apiKey && apiKey !== 'sk-ant-...';

    const [markets, positions, openInterest, volume, recentActivity, openPositions] = await Promise.all([
      inspector.getMarkets(),
      inspector.getPositions(),
      inspector.getOpenInterest(),
      inspector.getVolume(),
      inspector.getRecentActivity(),
      inspector.getOpenPositions(),
    ]);

    const targetMarket = params.market ? String(params.market).toUpperCase() : undefined;
    const relevantMarkets = targetMarket
      ? markets.filter((m) => m.symbol.toUpperCase() === targetMarket)
      : markets.slice(0, 5);

    const signals: StrategySignal[] = [];
    for (const m of relevantMarkets) {
      signals.push(computeMomentumSignal({ market: m, volume }));
      signals.push(computeMeanReversionSignal({ market: m, openInterest }));
    }

    // Normalize whale data for fallback
    const whaleRecentActivity: WhaleActivity[] = recentActivity.map((a) => ({
      market: String(a.market_symbol ?? a.market ?? ''),
      side: String(a.side ?? 'long'),
      sizeUsd: Number(a.size_usd ?? 0),
      timestamp: Number(a.timestamp ?? Date.now()),
    }));
    const whaleOpenPositions: WhaleActivity[] = openPositions.map((p) => ({
      market: String(p.market_symbol ?? p.market ?? ''),
      side: String(p.side ?? 'long'),
      sizeUsd: Number(p.size_usd ?? 0),
      timestamp: Number(p.timestamp ?? Date.now()),
    }));

    const balance = context.flashClient.getBalance();
    let suggestion;
    let source: 'claude' | 'strategy_engine' = 'claude';

    if (hasApiKey) {
      // Try Claude first — it will auto-fallback to strategy engine on failure
      const agent = new ClawdAgent(apiKey!);
      suggestion = await agent.suggestTrade({
        markets: relevantMarkets,
        signals,
        positions,
        balance,
        targetMarket,
        volume,
        openInterest,
        whaleRecentActivity,
        whaleOpenPositions,
      });

      // Detect if fallback was used
      if (suggestion?.reasoning.startsWith('Strategy Engine fallback')) {
        source = 'strategy_engine';
      }
    } else {
      // No API key — use strategy engine directly
      source = 'strategy_engine';
      suggestion = generateFallbackSuggestion({
        markets: relevantMarkets,
        volume,
        openInterest,
        whaleRecentActivity,
        whaleOpenPositions,
        balance,
        targetMarket,
      });
    }

    if (!suggestion) {
      return {
        success: false,
        message: chalk.yellow('  No strong trade signal detected. Market conditions are unclear.'),
      };
    }

    const sideColor = suggestion.side === 'long' ? chalk.green : chalk.red;
    const sourceTag = source === 'claude'
      ? chalk.magenta('AI Trade Suggestion')
      : chalk.yellow('Suggested Trade (Strategy Engine)');

    const lines = [
      '',
      chalk.bold(`  ═══ ${sourceTag} ═══`),
      '',
      `  Market:      ${chalk.bold(suggestion.market)}`,
      `  Direction:   ${sideColor(suggestion.side.toUpperCase())}`,
      `  Leverage:    ${chalk.bold(suggestion.leverage + 'x')}`,
      `  Collateral:  ${chalk.bold(formatUsd(suggestion.collateral))}`,
      `  Confidence:  ${chalk.bold((suggestion.confidence * 100).toFixed(0) + '%')}`,
      '',
      chalk.bold('  Reasoning:'),
      `  ${chalk.dim(suggestion.reasoning)}`,
      '',
      chalk.bold('  Risks:'),
      ...suggestion.risks.map((r) => `    ${chalk.yellow('•')} ${r}`),
      '',
      chalk.dim(`  To execute: ${suggestion.side} ${suggestion.market} $${suggestion.collateral} ${suggestion.leverage}x`),
      '',
    ];

    return {
      success: true,
      data: { suggestion },
      message: lines.join('\n'),
    };
  },
};

// ─── risk report ───────────────────────────────────────────────────────────────

export const clawdRiskReport: ToolDefinition = {
  name: 'clawd_risk_report',
  description: 'Show liquidation risk for all positions and portfolio exposure summary',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);

    const [positions, portfolio] = await Promise.all([
      inspector.getPositions(),
      inspector.getPortfolio(),
    ]);

    if (positions.length === 0) {
      return {
        success: true,
        message: chalk.dim('\n  No open positions. Nothing to assess.\n'),
      };
    }

    const riskAssessments = assessAllPositions(positions);
    const exposure = computeExposure(portfolio);

    const lines = [
      '',
      chalk.bold.yellow('  ═══ Risk Report ═══'),
      '',
      chalk.bold('  Position Risks:'),
    ];

    for (const risk of riskAssessments) {
      const riskColor = risk.riskLevel === 'critical' ? chalk.red.bold
        : risk.riskLevel === 'warning' ? chalk.yellow
        : chalk.green;
      lines.push(`    ${riskColor(`[${risk.riskLevel.toUpperCase()}]`)} ${risk.message}`);
    }

    lines.push('');
    lines.push(chalk.bold('  Exposure Summary:'));
    lines.push(`    Long Exposure:  ${formatUsd(exposure.totalLongExposure)}`);
    lines.push(`    Short Exposure: ${formatUsd(exposure.totalShortExposure)}`);
    lines.push(`    Net Exposure:   ${colorPnl(exposure.netExposure)}`);
    lines.push(`    Collateral:     ${formatUsd(exposure.totalCollateral)}`);
    lines.push(`    Utilization:    ${exposure.collateralUtilization.toFixed(1)}%`);

    if (exposure.concentrationRisk.length > 0) {
      lines.push('');
      lines.push(chalk.bold('  Concentration:'));
      for (const c of exposure.concentrationRisk) {
        const warn = c.percentage > 50 ? chalk.yellow(' (concentrated)') : '';
        lines.push(`    ${c.market}: ${c.percentage.toFixed(1)}%${warn}`);
      }
    }

    lines.push('');

    return {
      success: true,
      data: { riskAssessments, exposure },
      message: lines.join('\n'),
    };
  },
};

// ─── dashboard ─────────────────────────────────────────────────────────────────

export const clawdDashboard: ToolDefinition = {
  name: 'clawd_dashboard',
  description: 'Combined portfolio, market, and platform stats view',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);
    const snapshot = await inspector.getFullSnapshot();

    const lines = [
      '',
      chalk.bold.cyan('  ═══ Clawd Dashboard ═══'),
      '',
    ];

    // Autopilot status
    const autopilot = getAutopilot(context);
    const apState = autopilot.state;
    const apStatus = apState.active ? chalk.green.bold('ACTIVE') : chalk.gray('INACTIVE');
    lines.push(`  Autopilot: ${apStatus}`);
    lines.push('');

    // Active strategy signals (from autopilot or computed fresh)
    if (apState.lastSignals.length > 0) {
      lines.push(chalk.bold('  Signals:'));
      for (const sig of apState.lastSignals) {
        const color = sig.signal === 'bullish' ? chalk.green : sig.signal === 'bearish' ? chalk.red : chalk.gray;
        lines.push(`    ${sig.name}: ${color(sig.signal)}`);
      }
      lines.push('');
    }

    // Portfolio section
    lines.push(chalk.bold('  Portfolio:'));
    lines.push(`    Balance:       ${formatUsd(snapshot.portfolio.balance)}`);
    lines.push(`    Collateral:    ${formatUsd(snapshot.portfolio.totalCollateralUsd)}`);
    lines.push(`    Unrealized PnL: ${colorPnl(snapshot.portfolio.totalUnrealizedPnl)}`);
    lines.push(`    Positions:     ${snapshot.positions.length}`);
    lines.push('');

    // Risk exposure
    if (snapshot.positions.length > 0) {
      const exposure = computeExposure(snapshot.portfolio);
      const risks = assessAllPositions(snapshot.positions);
      const minLiqDist = risks.length > 0
        ? Math.min(...risks.map((r) => r.distanceToLiquidation))
        : 0;

      lines.push(chalk.bold('  Risk:'));
      lines.push(`    Exposure:              ${formatUsd(exposure.totalLongExposure + exposure.totalShortExposure)}`);
      lines.push(`    Liquidation Distance:  ${minLiqDist.toFixed(1)}%`);
      lines.push('');
    }

    // Markets section
    lines.push(chalk.bold('  Markets:'));
    if (snapshot.markets.length > 0) {
      const headers = ['Market', 'Price', '24h Change', 'OI Total'];
      const rows = snapshot.markets.slice(0, 8).map((m) => [
        m.symbol,
        formatPrice(m.price),
        colorPercent(m.priceChange24h),
        formatUsd(m.openInterestLong + m.openInterestShort),
      ]);
      lines.push(formatTable(headers, rows).split('\n').map((l) => '    ' + l).join('\n'));
    } else {
      lines.push(chalk.dim('    No market data available'));
    }
    lines.push('');

    // Market Regimes section
    try {
      const rd = getRegimeDetector();
      const regimes = rd.detectAll(snapshot.markets, snapshot.volume, snapshot.openInterest);
      if (regimes.size > 0) {
        lines.push(chalk.bold('  Market Regimes:'));
        for (const [market, state] of regimes) {
          lines.push(`    ${market.padEnd(8)} ${regimeLabel(state.regime)} ${chalk.dim(`(confidence ${(state.confidence * 100).toFixed(0)}%)`)}`);
        }
        lines.push('');
      }
    } catch {
      // Regime detection failure is non-critical for dashboard
    }

    // Market Intelligence section
    try {
      const scanner = getScanner(context);
      const balance = context.flashClient.getBalance();
      const opportunities = await scanner.scan(balance, 3);
      if (opportunities.length > 0) {
        lines.push(chalk.bold('  Market Intelligence:'));
        for (const opp of opportunities) {
          const dirColor = opp.direction === 'long' ? chalk.green : chalk.red;
          lines.push(`    ${opp.market.padEnd(6)} ${dirColor(opp.direction.toUpperCase().padEnd(6))} confidence: ${(opp.confidence * 100).toFixed(0)}%  score: ${opp.totalScore.toFixed(2)}  ${regimeLabel(opp.regime)}`);
        }
        lines.push('');
      }
    } catch {
      // Scanner failure is non-critical for dashboard
    }

    // Portfolio Intelligence section
    if (snapshot.positions.length > 0) {
      try {
        const pm = getPortfolioManager();
        const balance = context.flashClient.getBalance();
        const pState = pm.getState(snapshot.positions, balance);
        lines.push(chalk.bold('  Portfolio Intelligence:'));
        lines.push(`    Capital:     ${formatUsd(pState.totalCapital)} (${pState.utilizationPct.toFixed(0)}% utilized)`);
        lines.push(`    Free:        ${formatUsd(pState.freeCapital)}`);
        lines.push(`    Long:        ${formatUsd(pState.exposureLong)}`);
        lines.push(`    Short:       ${formatUsd(pState.exposureShort)}`);
        const rebalance = pm.analyzeRebalance(snapshot.positions, balance);
        if (!rebalance.balanced) {
          lines.push(`    Balance:     ${chalk.yellow(rebalance.directionalBias + ' — rebalance suggested')}`);
        } else {
          lines.push(`    Balance:     ${chalk.green('Balanced')}`);
        }
        lines.push('');
      } catch {
        // Portfolio computation failure is non-critical for dashboard
      }
    }

    // Platform stats
    lines.push(chalk.bold('  Platform Stats (30d):'));
    lines.push(`    Volume:        ${formatUsd(snapshot.overviewStats.volumeUsd)} (${formatPercent(snapshot.overviewStats.volumeChangePct)})`);
    lines.push(`    Trades:        ${snapshot.overviewStats.trades.toLocaleString()}`);
    lines.push(`    Fees:          ${formatUsd(snapshot.overviewStats.feesUsd)}`);
    lines.push(`    Traders:       ${snapshot.overviewStats.uniqueTraders.toLocaleString()}`);
    lines.push('');

    return {
      success: true,
      data: {
        portfolio: snapshot.portfolio,
        markets: snapshot.markets,
        positions: snapshot.positions,
      },
      message: lines.join('\n'),
    };
  },
};

// ─── whale activity ────────────────────────────────────────────────────────────

export const clawdWhaleActivity: ToolDefinition = {
  name: 'clawd_whale_activity',
  description: 'Show recent large positions from fstats',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);
    const [recentActivity, openPositions] = await Promise.all([
      inspector.getRecentActivity(50),
      inspector.getOpenPositions(),
    ]);

    // Normalize and filter
    const WHALE_THRESHOLD = 10_000;
    const marketFilter = params.market ? String(params.market).toUpperCase() : undefined;

    const normalize = (items: RawActivityRecord[]): { market: string; side: string; sizeUsd: number; price: number }[] =>
      items
        .map((a) => ({
          market: String(a.market_symbol ?? a.market ?? 'UNKNOWN'),
          side: String(a.side ?? 'long'),
          sizeUsd: Number(a.size_usd ?? 0),
          price: Number(a.entry_price ?? a.mark_price ?? 0),
        }))
        .filter((a) => a.sizeUsd >= WHALE_THRESHOLD)
        .filter((a) => !marketFilter || a.market.toUpperCase() === marketFilter);

    const whaleRecent = normalize(recentActivity);
    const whaleOpen = normalize(openPositions);
    const allWhales = [...whaleRecent, ...whaleOpen];

    if (allWhales.length === 0) {
      const marketMsg = marketFilter ? ` in ${marketFilter}` : '';
      return {
        success: true,
        message: chalk.dim(`\n  No whale activity detected${marketMsg} (threshold: $${WHALE_THRESHOLD.toLocaleString()}).\n`),
      };
    }

    // Sort by size
    allWhales.sort((a, b) => b.sizeUsd - a.sizeUsd);
    const top = allWhales.slice(0, 20);

    const headers = ['Market', 'Side', 'Size', 'Price'];
    const rows = top.map((w) => [
      w.market,
      w.side === 'long' ? chalk.green('LONG') : chalk.red('SHORT'),
      formatUsd(w.sizeUsd),
      formatPrice(w.price),
    ]);

    const marketMsg = marketFilter ? ` — ${marketFilter}` : '';
    const lines = [
      '',
      chalk.bold.blue(`  ═══ Whale Activity${marketMsg} ═══`),
      '',
      formatTable(headers, rows).split('\n').map((l) => '    ' + l).join('\n'),
      '',
      chalk.dim(`  Showing ${top.length} positions >= $${WHALE_THRESHOLD.toLocaleString()}`),
      '',
    ];

    return {
      success: true,
      message: lines.join('\n'),
    };
  },
};

// ─── Market Scanner ──────────────────────────────────────────────────────────

export const clawdScanMarkets: ToolDefinition = {
  name: 'clawd_scan_markets',
  description: 'Scan all markets for trade opportunities and rank them by score',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const scanner = getScanner(context);
    const balance = context.flashClient.getBalance();
    const opportunities = await scanner.scan(balance);

    if (opportunities.length === 0) {
      return {
        success: true,
        message: chalk.dim('\n  No trade opportunities detected. Market conditions are unclear.\n'),
      };
    }

    const lines = [
      '',
      chalk.bold.cyan('  ═══ Market Opportunity Scanner ═══'),
      '',
    ];

    // Table header
    const headers = ['Rank', 'Market', 'Direction', 'Confidence', 'Score', 'Leverage', 'Regime'];
    const rows = opportunities.map((opp, i) => [
      String(i + 1),
      opp.market,
      opp.direction === 'long' ? chalk.green('LONG') : chalk.red('SHORT'),
      `${(opp.confidence * 100).toFixed(0)}%`,
      opp.totalScore.toFixed(2),
      `${opp.recommendedLeverage}x`,
      regimeLabel(opp.regime),
    ]);

    lines.push(formatTable(headers, rows).split('\n').map((l) => '    ' + l).join('\n'));
    lines.push('');

    // Detailed breakdown for top 3
    const top3 = opportunities.slice(0, 3);
    lines.push(chalk.bold('  Top Opportunities:'));
    lines.push('');

    for (const opp of top3) {
      const dirColor = opp.direction === 'long' ? chalk.green : chalk.red;
      lines.push(`    ${chalk.bold(opp.market)} ${dirColor(opp.direction.toUpperCase())}`);
      lines.push('');

      for (const sig of opp.signals) {
        const sigColor = sig.signal === 'bullish' ? chalk.green
          : sig.signal === 'bearish' ? chalk.red
          : chalk.gray;
        lines.push(`      ${sig.name.padEnd(16)} ${sigColor(sig.signal.toUpperCase().padEnd(8))} ${chalk.dim(`${(sig.confidence * 100).toFixed(0)}%`)}`);
      }

      lines.push(`      ${'Score'.padEnd(16)} ${chalk.bold(opp.totalScore.toFixed(2).padEnd(8))} ${chalk.dim(`vol=${opp.volumeScore.toFixed(2)} oi=${opp.oiScore.toFixed(2)} whale=${opp.whaleScore.toFixed(2)}`)}`);
      lines.push(`      ${'Suggested'.padEnd(16)} ${chalk.bold(`${opp.recommendedLeverage}x`)} ${chalk.dim(`$${opp.recommendedCollateral}`)}`);
      lines.push('');
    }

    lines.push(chalk.dim(`  Scanned ${opportunities.length} markets. Use "suggest trade <market>" to execute.`));
    lines.push('');

    return {
      success: true,
      data: { opportunities },
      message: lines.join('\n'),
    };
  },
};

// ─── Autopilot ─────────────────────────────────────────────────────────────────

let autopilotInstance: Autopilot | null = null;

export function getAutopilot(context: ToolContext): Autopilot {
  if (!autopilotInstance) {
    autopilotInstance = new Autopilot(context, DEFAULT_AUTOPILOT_CONFIG);
  }
  return autopilotInstance;
}

/** Returns the existing autopilot instance without creating one. Used for safe shutdown. */
export function getAutopilotIfExists(): Autopilot | null {
  return autopilotInstance;
}

export const autopilotStart: ToolDefinition = {
  name: 'autopilot_start',
  description: 'Start automated trading mode with strategy signals and risk controls',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    // Guard: autopilot only allowed in simulation mode
    if (!context.simulationMode) {
      return {
        success: false,
        message: [
          '',
          chalk.red('  Autopilot disabled in LIVE mode.'),
          chalk.yellow('  Run terminal with: flash --sim'),
          chalk.dim('  to test automated trading.'),
          '',
        ].join('\n'),
      };
    }

    const autopilot = getAutopilot(context);

    autopilot.setLogHandler((msg) => {
      console.log(msg);
    });

    autopilot.setTradeHandler(async (suggestion) => {
      try {
        await context.flashClient.openPosition(
          suggestion.market,
          suggestion.side,
          suggestion.collateral,
          suggestion.leverage,
        );
        console.log(chalk.green(`  [Autopilot] Executed: ${suggestion.side} ${suggestion.market} $${suggestion.collateral} ${suggestion.leverage}x`));
      } catch {
        console.log(chalk.red(`  [Autopilot] Trade execution failed`));
      }
    });

    const message = autopilot.start();
    return { success: true, message };
  },
};

export const autopilotStop: ToolDefinition = {
  name: 'autopilot_stop',
  description: 'Stop automated trading mode',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    if (!context.simulationMode) {
      return {
        success: false,
        message: [
          '',
          chalk.red('  Autopilot disabled in LIVE mode.'),
          chalk.yellow('  Run terminal with: flash --sim'),
          chalk.dim('  to test automated trading.'),
          '',
        ].join('\n'),
      };
    }
    const autopilot = getAutopilot(context);
    const message = autopilot.stop();
    return { success: true, message };
  },
};

export const autopilotStatus: ToolDefinition = {
  name: 'autopilot_status',
  description: 'Show current autopilot status, signals, and last suggestion',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    if (!context.simulationMode) {
      return {
        success: false,
        message: [
          '',
          chalk.red('  Autopilot disabled in LIVE mode.'),
          chalk.yellow('  Run terminal with: flash --sim'),
          chalk.dim('  to test automated trading.'),
          '',
        ].join('\n'),
      };
    }
    const autopilot = getAutopilot(context);
    const message = autopilot.getStatus();
    return { success: true, message };
  },
};

// ─── Portfolio Intelligence ──────────────────────────────────────────────────

export const portfolioStateTool: ToolDefinition = {
  name: 'portfolio_state',
  description: 'Show portfolio capital allocation state',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);
    const pm = getPortfolioManager();

    const [positions] = await Promise.all([inspector.getPositions()]);
    const balance = context.flashClient.getBalance();
    const state = pm.getState(positions, balance);

    const lines = [
      '',
      chalk.bold.cyan('  ═══ Portfolio State ═══'),
      '',
      `  Total Capital:     ${formatUsd(state.totalCapital)}`,
      `  Allocated:         ${formatUsd(state.allocatedCapital)}  (${state.utilizationPct.toFixed(1)}%)`,
      `  Free Capital:      ${formatUsd(state.freeCapital)}`,
      `  Positions:         ${state.positionCount}`,
      '',
    ];

    if (state.positions.length > 0) {
      lines.push(chalk.bold('  Positions:'));
      const headers = ['Market', 'Side', 'Leverage', 'Collateral', 'Notional', 'PnL%'];
      const rows = state.positions.map((p) => [
        p.market,
        colorSide(p.side),
        `${p.leverage}x`,
        formatUsd(p.collateral),
        formatUsd(p.notional),
        colorPercent(p.pnlPct),
      ]);
      lines.push(formatTable(headers, rows).split('\n').map((l) => '    ' + l).join('\n'));
      lines.push('');
    }

    lines.push(chalk.bold('  Exposure:'));
    lines.push(`    Long:   ${formatUsd(state.exposureLong)}`);
    lines.push(`    Short:  ${formatUsd(state.exposureShort)}`);
    lines.push(`    Net:    ${colorPnl(state.exposureLong - state.exposureShort)}`);

    if (Object.keys(state.exposureByMarket).length > 0) {
      lines.push('');
      lines.push(chalk.bold('  By Market:'));
      for (const [market, exposure] of Object.entries(state.exposureByMarket)) {
        const pct = state.totalCapital > 0 ? (exposure / state.totalCapital) * 100 : 0;
        const warn = pct > 30 ? chalk.yellow(' (concentrated)') : '';
        lines.push(`    ${market.padEnd(6)} ${formatUsd(exposure)} (${pct.toFixed(1)}%)${warn}`);
      }
    }

    lines.push('');
    return { success: true, data: { state }, message: lines.join('\n') };
  },
};

export const portfolioExposureTool: ToolDefinition = {
  name: 'portfolio_exposure',
  description: 'Show portfolio exposure breakdown by market and direction',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);
    const pm = getPortfolioManager();

    const [positions, portfolio] = await Promise.all([
      inspector.getPositions(),
      inspector.getPortfolio(),
    ]);
    const balance = context.flashClient.getBalance();
    const state = pm.getState(positions, balance);
    const exposure = computeExposure(portfolio);

    const totalExposure = state.exposureLong + state.exposureShort;
    const longPct = totalExposure > 0 ? (state.exposureLong / totalExposure) * 100 : 0;
    const shortPct = totalExposure > 0 ? (state.exposureShort / totalExposure) * 100 : 0;

    const lines = [
      '',
      chalk.bold.cyan('  ═══ Portfolio Exposure ═══'),
      '',
      `  Total Exposure:  ${formatUsd(totalExposure)}`,
      `  Long:            ${formatUsd(state.exposureLong)} (${longPct.toFixed(1)}%)`,
      `  Short:           ${formatUsd(state.exposureShort)} (${shortPct.toFixed(1)}%)`,
      `  Net:             ${colorPnl(exposure.netExposure)}`,
      `  Collateral:      ${formatUsd(exposure.totalCollateral)}`,
      `  Utilization:     ${state.utilizationPct.toFixed(1)}%`,
      '',
    ];

    if (exposure.concentrationRisk.length > 0) {
      lines.push(chalk.bold('  Concentration by Market:'));
      for (const c of exposure.concentrationRisk) {
        const warn = c.percentage > 30 ? chalk.yellow(' ⚠') : '';
        lines.push(`    ${c.market.padEnd(6)} ${c.percentage.toFixed(1)}%${warn}`);
      }
      lines.push('');
    }

    // Directional bias warning
    if (longPct > 60) {
      lines.push(chalk.yellow(`  ⚠ Heavy long bias (${longPct.toFixed(0)}%) — consider hedging with shorts`));
      lines.push('');
    } else if (shortPct > 60) {
      lines.push(chalk.yellow(`  ⚠ Heavy short bias (${shortPct.toFixed(0)}%) — consider reducing short exposure`));
      lines.push('');
    }

    return { success: true, data: { exposure, state }, message: lines.join('\n') };
  },
};

export const portfolioRebalanceTool: ToolDefinition = {
  name: 'portfolio_rebalance',
  description: 'Analyze portfolio balance and suggest rebalancing actions',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);
    const pm = getPortfolioManager();

    const positions = await inspector.getPositions();
    const balance = context.flashClient.getBalance();

    if (positions.length === 0) {
      return {
        success: true,
        message: chalk.dim('\n  No open positions. Nothing to rebalance.\n'),
      };
    }

    const result = pm.analyzeRebalance(positions, balance);

    const lines = [
      '',
      chalk.bold.cyan('  ═══ Portfolio Rebalance Analysis ═══'),
      '',
      `  Status:           ${result.balanced ? chalk.green('BALANCED') : chalk.yellow('IMBALANCED')}`,
      `  Long Exposure:    ${result.longPct.toFixed(1)}%`,
      `  Short Exposure:   ${result.shortPct.toFixed(1)}%`,
      `  Directional Bias: ${result.directionalBias}`,
      '',
    ];

    if (result.actions.length > 0) {
      lines.push(chalk.bold('  Suggested Actions:'));
      for (const action of result.actions) {
        const icon = action.type === 'close_position' ? chalk.red('✕') : chalk.yellow('↓');
        lines.push(`    ${icon} ${action.type.toUpperCase()} ${action.market} ${action.side} — ${action.reason}`);
      }
      lines.push('');
    } else {
      lines.push(chalk.green('  Portfolio is well-balanced. No action needed.'));
      lines.push('');
    }

    return { success: true, data: { rebalance: result }, message: lines.join('\n') };
  },
};

// ─── Export all ─────────────────────────────────────────────────────────────────

export const allClawdTools: ToolDefinition[] = [
  clawdAnalyze,
  clawdSuggestTrade,
  clawdScanMarkets,
  clawdRiskReport,
  clawdDashboard,
  clawdWhaleActivity,
  autopilotStart,
  autopilotStop,
  autopilotStatus,
  portfolioStateTool,
  portfolioExposureTool,
  portfolioRebalanceTool,
];
