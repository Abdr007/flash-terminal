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
import { TradeAgent } from './agent-core.js';
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
let _aiApiKey: string | undefined;
let _groqApiKey: string | undefined;

/** Set AI API keys for agent tools. Called once at startup. */
export function setAiApiKey(apiKey: string | undefined, groqApiKey?: string): void {
  _aiApiKey = apiKey;
  _groqApiKey = groqApiKey;
}

/** Get the scoped AI API key. */
export function getAiApiKey(): string | undefined {
  return _aiApiKey;
}

/** Get the scoped Groq API key. */
export function getGroqApiKey(): string | undefined {
  return _groqApiKey;
}

export function getInspector(context: ToolContext): SolanaInspector {
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

export const aiAnalyze: ToolDefinition = {
  name: 'ai_analyze',
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
    const whaleRecentActivity: WhaleActivity[] = recentActivity
      .filter((a) => { const s = String(a.side ?? '').toLowerCase(); return s === 'long' || s === 'short'; })
      .map((a) => ({
        market: String(a.market_symbol ?? a.market ?? ''),
        side: String(a.side),
        sizeUsd: Number(a.size_usd ?? 0),
        timestamp: Number(a.timestamp ?? Date.now()),
      }));
    const whaleOpenPositions: WhaleActivity[] = openPositions
      .filter((p) => { const s = String(p.side ?? '').toLowerCase(); return s === 'long' || s === 'short'; })
      .map((p) => ({
        market: String(p.market_symbol ?? p.market ?? ''),
        side: String(p.side),
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

    // Volume for last day and growth trend
    const lastDay = volume.dailyVolumes.length > 0
      ? volume.dailyVolumes[volume.dailyVolumes.length - 1]
      : null;

    let volumeGrowth = 0;
    if (volume.dailyVolumes.length >= 6) {
      const recent3 = volume.dailyVolumes.slice(-3).reduce((s, d) => s + d.volumeUsd, 0) / 3;
      const prev3 = volume.dailyVolumes.slice(-6, -3).reduce((s, d) => s + d.volumeUsd, 0) / 3;
      volumeGrowth = prev3 > 0 ? (recent3 - prev3) / prev3 : 0;
    }

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

    // Regime detection
    const rd = getRegimeDetector();
    const regimeState = rd.detectRegime(market, volume, openInterest);

    // Format output
    const lines = [
      '',
      chalk.bold(`  ${marketUpper} Market Analysis`),
      chalk.dim('  ─────────────────────────────────────────'),
      '',
    ];

    // Market Regime
    lines.push(chalk.bold('  Market Regime'));
    lines.push(`  ${regimeLabel(regimeState.regime)}`);
    lines.push('');

    // Price
    lines.push(chalk.bold('  Price'));
    lines.push(`  ${formatPrice(market.price)}  ${colorPercent(market.priceChange24h)}`);
    lines.push('');

    // Volume
    lines.push(chalk.bold('  Volume'));
    if (lastDay) {
      const volumeGrowthStr = volumeGrowth > 0.1
        ? 'Trading volume increasing.'
        : volumeGrowth < -0.1
          ? 'Trading volume declining.'
          : 'Trading volume stable.';
      lines.push(`  24h: ${formatUsd(lastDay.volumeUsd)}  ${chalk.dim(volumeGrowthStr)}`);
    } else {
      lines.push(chalk.dim('  Data unavailable.'));
    }
    lines.push('');

    // Open Interest
    lines.push(chalk.bold('  Open Interest'));
    if (oi && totalOi > 0) {
      const longPct = ((oi.longOi / totalOi) * 100).toFixed(0);
      const shortPct = ((oi.shortOi / totalOi) * 100).toFixed(0);
      lines.push(`  ${formatUsd(totalOi)} total (${longPct}% long / ${shortPct}% short)`);
    } else {
      lines.push(chalk.dim('  Data unavailable.'));
    }
    lines.push('');

    // Strategy Signals
    lines.push(chalk.bold('  Strategy Signals'));
    lines.push('');

    for (const sig of signals) {
      lines.push(`  ${chalk.bold(sig.name)} → ${signalColor(sig.signal)}`);
      lines.push(`  ${chalk.dim(sig.reasoning)}`);
      lines.push('');
    }

    // Overall confidence
    const avgConfidence = signals.reduce((s, sig) => s + sig.confidence, 0) / signals.length;
    const sentimentColor = overallSentiment === 'BULLISH' ? chalk.green : overallSentiment === 'BEARISH' ? chalk.red : chalk.gray;
    lines.push(`  Overall: ${sentimentColor(overallSentiment)}  Confidence: ${(avgConfidence * 100).toFixed(0)}%`);
    lines.push('');

    return {
      success: true,
      data: { analysis },
      message: lines.join('\n'),
    };
  },
};

// ─── suggest trade ─────────────────────────────────────────────────────────────

export const aiSuggestTrade: ToolDefinition = {
  name: 'ai_suggest_trade',
  description: 'Get an AI-powered trade suggestion (falls back to strategy engine)',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);
    const apiKey = getAiApiKey();
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
    const whaleRecentActivity: WhaleActivity[] = recentActivity
      .filter((a) => { const s = String(a.side ?? '').toLowerCase(); return s === 'long' || s === 'short'; })
      .map((a) => ({
        market: String(a.market_symbol ?? a.market ?? ''),
        side: String(a.side),
        sizeUsd: Number(a.size_usd ?? 0),
        timestamp: Number(a.timestamp ?? Date.now()),
      }));
    const whaleOpenPositions: WhaleActivity[] = openPositions
      .filter((p) => { const s = String(p.side ?? '').toLowerCase(); return s === 'long' || s === 'short'; })
      .map((p) => ({
        market: String(p.market_symbol ?? p.market ?? ''),
        side: String(p.side),
        sizeUsd: Number(p.size_usd ?? 0),
        timestamp: Number(p.timestamp ?? Date.now()),
      }));

    const balance = context.flashClient.getBalance();
    let suggestion;
    let source: 'ai' | 'strategy_engine' = 'ai';

    const groqKey = getGroqApiKey();
    if (hasApiKey || groqKey) {
      const agent = new TradeAgent(apiKey ?? '', groqKey);
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
        message: [
          '',
          chalk.bold('  Trade Suggestion'),
          chalk.dim('  ─────────────────────────────────────────'),
          '',
          chalk.dim('  No strong trade signal detected.'),
          chalk.dim('  Market conditions are unclear or data is insufficient.'),
          '',
        ].join('\n'),
      };
    }

    const sideColor = suggestion.side === 'long' ? chalk.green : chalk.red;

    const lines = [
      '',
      chalk.bold('  Trade Suggestion'),
      chalk.dim('  ─────────────────────────────────────────'),
      '',
      `  Market:      ${chalk.bold(suggestion.market)}`,
      `  Direction:   ${sideColor(suggestion.side.toUpperCase())}`,
      `  Leverage:    ${chalk.bold(suggestion.leverage + 'x')}`,
      `  Collateral:  ${chalk.bold(formatUsd(suggestion.collateral))}`,
      `  Confidence:  ${chalk.bold((suggestion.confidence * 100).toFixed(0) + '%')}`,
      '',
      chalk.bold('  Reasoning'),
      `  ${suggestion.reasoning}`,
      '',
      chalk.bold('  Risks'),
      ...suggestion.risks.map((r) => `  ${chalk.yellow('•')} ${r}`),
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

export const aiRiskReport: ToolDefinition = {
  name: 'ai_risk_report',
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

    const totalExposure = exposure.totalLongExposure + exposure.totalShortExposure;
    const longPct = totalExposure > 0 ? ((exposure.totalLongExposure / totalExposure) * 100).toFixed(0) : '0';
    const shortPct = totalExposure > 0 ? ((exposure.totalShortExposure / totalExposure) * 100).toFixed(0) : '0';

    const lines = [
      '',
      chalk.bold('  Risk Report'),
      chalk.dim('  ─────────────────────────────────────────'),
      '',
    ];

    // Position risks
    lines.push(chalk.bold('  Position Risks'));
    lines.push('');
    for (const risk of riskAssessments) {
      const riskColor = risk.riskLevel === 'critical' ? chalk.red.bold
        : risk.riskLevel === 'warning' ? chalk.yellow
        : chalk.green;
      lines.push(`  ${riskColor(`[${risk.riskLevel.toUpperCase()}]`)} ${risk.message}`);
    }
    lines.push('');

    // Exposure Summary
    lines.push(chalk.bold('  Exposure Summary'));
    lines.push('');
    lines.push(`  Total Exposure:   ${formatUsd(totalExposure)}`);
    lines.push('');
    lines.push(chalk.bold('  Directional Bias'));
    lines.push(`  LONG:  ${longPct}%`);
    lines.push(`  SHORT: ${shortPct}%`);
    lines.push('');

    // Risk Analysis
    const alerts: string[] = [];
    if (exposure.concentrationRisk.some(c => c.percentage > 50)) {
      alerts.push('Correlated markets detected');
    }
    if (exposure.collateralUtilization < 80) {
      alerts.push('Exposure within configured limits');
    } else {
      alerts.push(`Collateral utilization at ${exposure.collateralUtilization.toFixed(0)}%`);
    }

    lines.push(chalk.bold('  Risk Analysis'));
    for (const alert of alerts) {
      lines.push(`  ${chalk.yellow('•')} ${alert}`);
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

export const aiDashboard: ToolDefinition = {
  name: 'ai_dashboard',
  description: 'Combined portfolio, market, and platform stats view',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const inspector = getInspector(context);
    const snapshot = await inspector.getFullSnapshot();

    const lines = [
      '',
      chalk.bold('  Dashboard'),
      chalk.dim('  ─────────────────────────────────────────'),
      '',
    ];

    // ─── Market Overview ──────────────────────────────────────────────
    lines.push(chalk.bold('  Market Overview'));
    lines.push('');

    // Market Regime summary
    let dominantRegime = 'Unknown';
    try {
      const rd = getRegimeDetector();
      const regimes = rd.detectAll(snapshot.markets, snapshot.volume, snapshot.openInterest);
      if (regimes.size > 0) {
        // Find most common regime
        const regimeCounts = new Map<string, number>();
        for (const [, state] of regimes) {
          regimeCounts.set(state.regime, (regimeCounts.get(state.regime) ?? 0) + 1);
        }
        dominantRegime = [...regimeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown';
        lines.push(`  Market Regime:    ${regimeLabel(dominantRegime)}`);
      } else {
        lines.push(chalk.dim('  Market Regime:    Data unavailable'));
      }
    } catch {
      lines.push(chalk.dim('  Market Regime:    Data unavailable'));
    }
    lines.push('');

    // Top Opportunities
    try {
      const scanner = getScanner(context);
      const balance = context.flashClient.getBalance();
      const opportunities = await scanner.scan(balance, 3);
      if (opportunities.length > 0) {
        lines.push(chalk.bold('  Top Opportunities'));
        for (let i = 0; i < opportunities.length; i++) {
          const opp = opportunities[i];
          const dirColor = opp.direction === 'long' ? chalk.green : chalk.red;
          lines.push(`  ${i + 1}  ${opp.market.padEnd(6)} ${dirColor(opp.direction.toUpperCase().padEnd(6))} ${(opp.confidence * 100).toFixed(0)}%`);
        }
      } else {
        lines.push(chalk.bold('  Top Opportunities'));
        lines.push(chalk.dim('  No clear opportunities detected.'));
      }
    } catch {
      lines.push(chalk.bold('  Top Opportunities'));
      lines.push(chalk.dim('  Data unavailable.'));
    }
    lines.push('');

    // ─── Portfolio ────────────────────────────────────────────────────
    lines.push(chalk.bold('  Portfolio'));
    lines.push('');
    lines.push(`  Positions:       ${snapshot.positions.length}`);
    if (snapshot.positions.length > 0) {
      const exposure = computeExposure(snapshot.portfolio);
      const totalExposure = exposure.totalLongExposure + exposure.totalShortExposure;
      lines.push(`  Total Exposure:  ${formatUsd(totalExposure)}`);

      const longPct = totalExposure > 0 ? ((exposure.totalLongExposure / totalExposure) * 100).toFixed(0) : '0';
      const shortPct = totalExposure > 0 ? ((exposure.totalShortExposure / totalExposure) * 100).toFixed(0) : '0';
      const bias = exposure.totalLongExposure > exposure.totalShortExposure ? 'LONG' : exposure.totalShortExposure > exposure.totalLongExposure ? 'SHORT' : 'NEUTRAL';
      lines.push(`  Directional Bias: ${bias}`);
      lines.push(`  Long: ${longPct}%  Short: ${shortPct}%`);
      lines.push(`  Unrealized PnL:  ${colorPnl(snapshot.portfolio.totalUnrealizedPnl)}`);
      lines.push(`  Realized PnL:    ${colorPnl(snapshot.portfolio.totalRealizedPnl)}`);
      if (snapshot.portfolio.totalFees > 0) {
        lines.push(`  Fees Paid:       ${formatUsd(snapshot.portfolio.totalFees)}`);
      }

      // Largest position
      const largest = snapshot.positions.reduce((max, p) => p.sizeUsd > max.sizeUsd ? p : max, snapshot.positions[0]);
      lines.push(`  Largest:         ${largest.market} ${largest.side.toUpperCase()} ${formatUsd(largest.sizeUsd)}`);

      // Funding rate info
      const fundedPositions = snapshot.positions.filter(p => p.fundingRate !== 0);
      if (fundedPositions.length > 0) {
        const avgFunding = fundedPositions.reduce((s, p) => s + p.fundingRate, 0) / fundedPositions.length;
        lines.push(`  Funding Rate:    ${formatPercent(avgFunding)}`);
      } else {
        lines.push(`  Funding Rate:    ${chalk.dim('unavailable')}`);
      }
    } else {
      lines.push(`  Balance:         ${formatUsd(snapshot.portfolio.balance)}`);
    }
    lines.push('');

    // ─── Risk Alerts ─────────────────────────────────────────────────
    if (snapshot.positions.length > 0) {
      const risks = assessAllPositions(snapshot.positions);
      const exposure = computeExposure(snapshot.portfolio);
      const alerts: string[] = [];

      // Check for risk conditions
      const criticalRisks = risks.filter(r => r.riskLevel === 'critical');
      const warningRisks = risks.filter(r => r.riskLevel === 'warning');
      if (criticalRisks.length > 0) {
        alerts.push(`${criticalRisks.length} position(s) at critical liquidation risk`);
      }
      if (warningRisks.length > 0) {
        alerts.push(`${warningRisks.length} position(s) with elevated leverage`);
      }

      // Concentration risk
      for (const c of exposure.concentrationRisk) {
        if (c.percentage > 50) {
          alerts.push(`${c.market} concentration: ${c.percentage.toFixed(0)}% of exposure`);
        }
      }

      // Overall risk level
      const riskLevel = criticalRisks.length > 0 ? 'CRITICAL' : warningRisks.length > 0 ? 'ELEVATED' : 'HEALTHY';
      const riskColor = riskLevel === 'CRITICAL' ? chalk.red.bold : riskLevel === 'ELEVATED' ? chalk.yellow : chalk.green;
      lines.push(`  Risk Level:  ${riskColor(riskLevel)}`);
      lines.push('');

      if (alerts.length > 0) {
        lines.push(chalk.bold('  Risk Alerts'));
        for (const alert of alerts) {
          lines.push(`  ${chalk.yellow('•')} ${alert}`);
        }
        lines.push('');
      }
    }

    // ─── Autopilot (simulation only) ─────────────────────────────────
    if (context.simulationMode) {
      const autopilot = getAutopilot(context);
      const apState = autopilot.state;
      const apStatus = apState.active ? chalk.green.bold('ACTIVE') : chalk.gray('INACTIVE');
      lines.push(`  Autopilot: ${apStatus}`);
      lines.push('');
    }

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

export const aiWhaleActivity: ToolDefinition = {
  name: 'ai_whale_activity',
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
        message: [
          '',
          chalk.bold('  Whale Activity'),
          chalk.dim('  ─────────────────────────────────────────'),
          '',
          chalk.dim(`  No whale activity detected${marketMsg}.`),
          chalk.dim(`  Threshold: positions >= $${WHALE_THRESHOLD.toLocaleString()}`),
          '',
        ].join('\n'),
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
      chalk.bold(`  Whale Activity${marketMsg}`),
      chalk.dim('  ─────────────────────────────────────────'),
      '',
      formatTable(headers, rows).split('\n').map((l) => '    ' + l).join('\n'),
      '',
      chalk.dim(`  ${top.length} positions >= $${WHALE_THRESHOLD.toLocaleString()}`),
      '',
    ];

    return {
      success: true,
      message: lines.join('\n'),
    };
  },
};

// ─── Market Scanner ──────────────────────────────────────────────────────────

export const aiScanMarkets: ToolDefinition = {
  name: 'ai_scan_markets',
  description: 'Scan all markets for trade opportunities and rank them by score',
  parameters: z.object({}),
  execute: async (_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const scanner = getScanner(context);
    const balance = context.flashClient.getBalance();
    const opportunities = await scanner.scan(balance);

    if (opportunities.length === 0) {
      return {
        success: true,
        message: [
          '',
          chalk.bold('  Market Opportunities'),
          chalk.dim('  ─────────────────────────────────────────'),
          '',
          chalk.dim('  No trade opportunities detected.'),
          chalk.dim('  Market conditions are unclear or data is insufficient.'),
          '',
        ].join('\n'),
      };
    }

    const lines = [
      '',
      chalk.bold('  Market Opportunities'),
      chalk.dim('  ─────────────────────────────────────────'),
      '',
    ];

    // Clean ranked table
    const headers = ['Rank', 'Asset', 'Direction', 'Confidence', 'Strategy'];
    const rows = opportunities.map((opp, i) => {
      // Identify the dominant strategy driving this opportunity
      const dominantSignal = opp.signals
        .filter(s => s.signal !== 'neutral')
        .sort((a, b) => b.confidence - a.confidence)[0];
      const strategyName = dominantSignal?.name ?? 'Mixed';

      return [
        String(i + 1),
        opp.market,
        opp.direction === 'long' ? chalk.green('LONG') : chalk.red('SHORT'),
        `${(opp.confidence * 100).toFixed(0)}%`,
        strategyName,
      ];
    });

    lines.push(formatTable(headers, rows).split('\n').map((l) => '    ' + l).join('\n'));
    lines.push('');

    // Detailed breakdown for top 3
    const top3 = opportunities.slice(0, 3);

    for (const opp of top3) {
      const dirColor = opp.direction === 'long' ? chalk.green : chalk.red;
      lines.push(`  ${chalk.bold(opp.market)} ${dirColor(opp.direction.toUpperCase())}  ${chalk.dim(`Regime: ${opp.regime ?? 'unknown'}`)}`);
      lines.push('');

      for (const sig of opp.signals) {
        lines.push(`    ${chalk.bold(sig.name)} → ${signalColor(sig.signal)}`);
        lines.push(`    ${chalk.dim(sig.reasoning)}`);
        lines.push('');
      }
    }

    lines.push(chalk.dim(`  All data is real-time. Use "analyze <asset>" for deeper analysis.`));
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
          chalk.dim('  Restart terminal and select Simulation to use autopilot.'),
          '',
        ].join('\n'),
      };
    }

    const autopilot = getAutopilot(context);

    autopilot.setLogHandler((msg) => {
      console.log(msg);
    });

    autopilot.setTradeHandler(async (suggestion) => {
      // Defense-in-depth: block autopilot trades if somehow running in live mode
      if (!context.simulationMode) {
        console.log(chalk.red(`  [Autopilot] BLOCKED — autopilot cannot execute trades in live mode`));
        return;
      }
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
          chalk.dim('  Restart terminal and select Simulation to use autopilot.'),
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
          chalk.dim('  Restart terminal and select Simulation to use autopilot.'),
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
      chalk.bold('  Portfolio State'),
      chalk.dim('  ─────────────────────────────────────────'),
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
      chalk.bold('  Portfolio Exposure'),
      chalk.dim('  ─────────────────────────────────────────'),
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
      chalk.bold('  Portfolio Rebalance'),
      chalk.dim('  ─────────────────────────────────────────'),
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

export const allAgentTools: ToolDefinition[] = [
  aiAnalyze,
  aiSuggestTrade,
  aiScanMarkets,
  aiRiskReport,
  aiDashboard,
  aiWhaleActivity,
  autopilotStart,
  autopilotStop,
  autopilotStatus,
  portfolioStateTool,
  portfolioExposureTool,
  portfolioRebalanceTool,
];
