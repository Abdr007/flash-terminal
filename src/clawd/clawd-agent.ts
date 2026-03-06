import Anthropic from '@anthropic-ai/sdk';
import {
  TradeSuggestion,
  TradeSide,
  MarketData,
  Position,
  StrategySignal,
  VolumeData,
  OpenInterestData,
} from '../types/index.js';
import { generateFallbackSuggestion } from '../ai/signal-aggregator.js';
import { WhaleActivity } from '../strategies/whale-follow.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';

const SYSTEM_PROMPT = `You are Clawd, an AI trading analyst for Flash Trade perpetuals on Solana.
You analyze market data, strategy signals, and current positions to suggest a single trade.

Rules:
- Respond with ONLY valid JSON, no extra text
- Maximum leverage: 5x
- Minimum collateral: $10
- You MUST list at least 2 risks
- Confidence is a number from 0 to 1
- Side must be "long" or "short"

Response format:
{
  "market": "SOL",
  "side": "long",
  "leverage": 5,
  "collateral": 100,
  "reasoning": "Explanation of why this trade makes sense...",
  "confidence": 0.65,
  "risks": ["Risk 1", "Risk 2"]
}`;

export interface SuggestTradeContext {
  markets: MarketData[];
  signals: StrategySignal[];
  positions: Position[];
  balance: number;
  targetMarket?: string;
  // Data for fallback signal aggregation
  volume?: VolumeData;
  openInterest?: OpenInterestData;
  whaleRecentActivity?: WhaleActivity[];
  whaleOpenPositions?: WhaleActivity[];
}

/**
 * Claude reasoning agent for trade suggestions.
 * Only used by the `suggest trade` command.
 */
export class ClawdAgent {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async suggestTrade(context: SuggestTradeContext): Promise<TradeSuggestion | null> {
    const logger = getLogger();

    const userMessage = this.buildPrompt(context);

    try {
      logger.debug('CLAWD', 'Requesting trade suggestion from Claude');

      const controller = new AbortController();
      const apiTimeout = setTimeout(() => controller.abort(), 30_000);

      let response;
      try {
        response = await this.client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 512,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }, { signal: controller.signal });
      } finally {
        clearTimeout(apiTimeout);
      }

      if (response.content.length === 0 || response.content[0].type !== 'text') {
        logger.warn('CLAWD', 'Empty response from Claude, falling back to strategy engine');
        return this.fallback(context);
      }

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('CLAWD', 'No JSON in Claude response, falling back to strategy engine');
        return this.fallback(context);
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      // Validate and clamp values
      const suggestion: TradeSuggestion = {
        market: String(parsed.market ?? 'SOL').toUpperCase(),
        side: parsed.side === 'short' ? TradeSide.Short : TradeSide.Long,
        leverage: Math.min(5, Math.max(1.1, Number(parsed.leverage) || 3)),
        collateral: Math.max(10, Number(parsed.collateral) || 50),
        reasoning: String(parsed.reasoning ?? 'No reasoning provided'),
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : ['Market volatility', 'Liquidation risk'],
      };

      // Ensure at least 2 risks
      while (suggestion.risks.length < 2) {
        suggestion.risks.push('General market risk');
      }

      logger.debug('CLAWD', `Trade suggestion: ${suggestion.side} ${suggestion.market} ${suggestion.leverage}x`);
      return suggestion;
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      if (msg.includes('credit balance') || msg.includes('401') || msg.includes('403') || msg.includes('429')) {
        logger.warn('CLAWD', `Claude API unavailable: ${msg}. Falling back to strategy engine.`);
      } else {
        logger.error('CLAWD', `Suggest trade failed: ${msg}. Falling back to strategy engine.`);
      }
      return this.fallback(context);
    }
  }

  private fallback(context: SuggestTradeContext): TradeSuggestion | null {
    const logger = getLogger();
    logger.info('CLAWD', 'Using strategy engine fallback for trade suggestion');

    return generateFallbackSuggestion({
      markets: context.markets,
      volume: context.volume ?? { period: '30d', totalVolumeUsd: 0, trades: 0, uniqueTraders: 0, dailyVolumes: [] },
      openInterest: context.openInterest ?? { markets: [] },
      whaleRecentActivity: context.whaleRecentActivity ?? [],
      whaleOpenPositions: context.whaleOpenPositions ?? [],
      balance: context.balance,
      targetMarket: context.targetMarket,
    });
  }

  private buildPrompt(context: SuggestTradeContext): string {
    const lines: string[] = [];

    lines.push('## Current Market Data');
    for (const m of context.markets) {
      lines.push(`- ${m.symbol}: $${m.price.toFixed(2)} (24h: ${m.priceChange24h >= 0 ? '+' : ''}${m.priceChange24h.toFixed(2)}%, OI Long: $${m.openInterestLong.toFixed(0)}, OI Short: $${m.openInterestShort.toFixed(0)})`);
    }

    lines.push('\n## Strategy Signals');
    for (const s of context.signals) {
      lines.push(`- ${s.name}: ${s.signal} (confidence: ${(s.confidence * 100).toFixed(0)}%) — ${s.reasoning}`);
    }

    lines.push('\n## Current Positions');
    if (context.positions.length === 0) {
      lines.push('- No open positions');
    } else {
      for (const p of context.positions) {
        lines.push(`- ${p.market} ${p.side} ${p.leverage}x: size $${p.sizeUsd.toFixed(2)}, PnL $${p.unrealizedPnl.toFixed(2)} (${p.unrealizedPnlPercent.toFixed(1)}%)`);
      }
    }

    lines.push(`\n## Available Balance: $${context.balance.toFixed(2)}`);

    if (context.targetMarket) {
      lines.push(`\n## Focus: Suggest a trade for ${context.targetMarket}`);
    } else {
      lines.push('\n## Task: Suggest the best trade opportunity from the available markets');
    }

    return lines.join('\n');
  }
}
