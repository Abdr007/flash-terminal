/**
 * Agent Builder — Type Definitions
 *
 * All types for the autonomous trading agent framework.
 * Built on top of Flash SDK types.
 */

import type { TradeSide, Position } from '../sdk/types.js';

// ─── Agent Status ────────────────────────────────────────────────────────────

export enum AgentStatus {
  /** Agent is initializing */
  INITIALIZING = 'initializing',
  /** Agent is running and observing */
  RUNNING = 'running',
  /** Agent is paused (manual or cooldown) */
  PAUSED = 'paused',
  /** Agent detected anomaly — stopped for safety */
  SAFETY_STOP = 'safety_stop',
  /** Agent has been shut down */
  STOPPED = 'stopped',
}

// ─── Signal Types ────────────────────────────────────────────────────────────

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';

export interface Signal {
  /** Signal source (e.g. 'trend', 'volume', 'oi_imbalance', 'volatility') */
  source: string;
  /** Direction indicated */
  direction: SignalDirection;
  /** Confidence 0-1 */
  confidence: number;
  /** Human-readable reasoning */
  reason: string;
  /** Raw data that produced this signal */
  metadata?: Record<string, unknown>;
}

// ─── Market Snapshot ─────────────────────────────────────────────────────────

export interface MarketSnapshot {
  market: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  volumeChange?: number;
  longOi: number;
  shortOi: number;
  oiRatio: number;
  fundingRate?: number;
  timestamp: number;
}

// ─── Strategy Types ──────────────────────────────────────────────────────────

export interface StrategyResult {
  /** Strategy name */
  strategy: string;
  /** Whether conditions are met for a trade */
  shouldTrade: boolean;
  /** Trade direction if shouldTrade */
  side?: TradeSide;
  /** Market to trade */
  market?: string;
  /** Confidence 0-1 */
  confidence: number;
  /** Signals that contributed to this decision */
  signals: Signal[];
  /** Why this decision was made */
  reasoning: string;
  /** Suggested take-profit price */
  suggestedTp?: number;
  /** Suggested stop-loss price */
  suggestedSl?: number;
  /** Entry invalidation condition description */
  invalidation?: string;
}

export interface Strategy {
  /** Unique strategy name */
  readonly name: string;
  /** Evaluate market conditions and return a trading decision */
  evaluate(snapshot: MarketSnapshot, signals: Signal[]): StrategyResult;
}

// ─── Trade Decision ──────────────────────────────────────────────────────────

export enum DecisionAction {
  OPEN = 'open',
  CLOSE = 'close',
  HOLD = 'hold',
  SKIP = 'skip',
}

export interface TradeDecision {
  action: DecisionAction;
  market: string;
  side?: TradeSide;
  leverage?: number;
  collateral?: number;
  /** Take-profit price */
  tp?: number;
  /** Stop-loss price */
  sl?: number;
  /** Percent to close (for partial close) */
  closePercent?: number;
  /** Strategy that produced this decision */
  strategy: string;
  /** Overall confidence 0-1 */
  confidence: number;
  /** Reasoning chain */
  reasoning: string;
  /** Signals used */
  signals: Signal[];
  /** Risk level assessed by risk manager */
  riskLevel: 'safe' | 'elevated' | 'blocked';
  /** If blocked, why */
  blockReason?: string;
}

// ─── Risk Limits ─────────────────────────────────────────────────────────────

export interface RiskLimits {
  /** Max concurrent open positions (default: 2) */
  maxPositions: number;
  /** Max leverage allowed (default: 5) */
  maxLeverage: number;
  /** Position size as percentage of capital (default: 0.02 = 2%) */
  positionSizePct: number;
  /** Max daily loss as percentage of starting capital (default: 0.05 = 5%) */
  maxDailyLossPct: number;
  /** Cooldown in ms after a losing trade (default: 300_000 = 5 min) */
  cooldownAfterLossMs: number;
  /** Minimum confidence threshold to trade (default: 0.6) */
  minConfidence: number;
  /** Markets allowed to trade (empty = all) */
  allowedMarkets: string[];
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPositions: 2,
  maxLeverage: 5,
  positionSizePct: 0.02,
  maxDailyLossPct: 0.05,
  cooldownAfterLossMs: 300_000,
  minConfidence: 0.6,
  allowedMarkets: [],
};

// ─── Agent Configuration ─────────────────────────────────────────────────────

export interface AgentConfig {
  /** Agent name for logging */
  name: string;
  /** Markets to monitor */
  markets: string[];
  /** Polling interval in ms (default: 10_000) */
  pollIntervalMs: number;
  /** Risk limits */
  risk: RiskLimits;
  /** Max iterations before auto-stop (0 = unlimited, default: 0) */
  maxIterations: number;
  /** Enable dry-run mode — log decisions but don't execute (default: false) */
  dryRun: boolean;
  /** Log level: 'quiet' | 'normal' | 'verbose' (default: 'normal') */
  logLevel: 'quiet' | 'normal' | 'verbose';
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  name: 'flash-agent',
  markets: ['SOL', 'BTC', 'ETH'],
  pollIntervalMs: 10_000,
  risk: DEFAULT_RISK_LIMITS,
  maxIterations: 0,
  dryRun: false,
  logLevel: 'normal',
};

// ─── Agent State ─────────────────────────────────────────────────────────────

export interface AgentState {
  status: AgentStatus;
  iteration: number;
  /** Capital at start of day/session */
  startingCapital: number;
  /** Current capital */
  currentCapital: number;
  /** Realized PnL today */
  dailyPnl: number;
  /** Number of trades today */
  dailyTradeCount: number;
  /** Timestamp of last trade */
  lastTradeTimestamp: number;
  /** Whether agent is in cooldown */
  inCooldown: boolean;
  /** Cooldown expires at (ms) */
  cooldownUntil: number;
  /** Active positions tracked by agent */
  positions: Position[];
  /** Reason for safety stop (if any) */
  safetyStopReason?: string;
  /** Consecutive losses (for cooldown tracking) */
  consecutiveLosses: number;
}

// ─── Trade Journal ───────────────────────────────────────────────────────────

export interface JournalEntry {
  id: number;
  timestamp: string;
  action: DecisionAction;
  market: string;
  side?: TradeSide;
  leverage?: number;
  collateral?: number;
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  fees?: number;
  strategy: string;
  confidence: number;
  signals: Signal[];
  reasoning: string;
  outcome?: 'win' | 'loss' | 'breakeven' | 'pending';
  durationMs?: number;
  /** Whether the strategy signal was correct in hindsight */
  signalCorrect?: boolean;
  error?: string;
}

export interface JournalStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  totalPnl: number;
  totalFees: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  avgConfidence: number;
  signalAccuracy: number;
  bestTrade: number;
  worstTrade: number;
}

// ─── Agent Event Callbacks ───────────────────────────────────────────────────

export interface AgentCallbacks {
  /** Called on each observation tick */
  onTick?: (state: AgentState, iteration: number) => void;
  /** Called when a trade decision is made */
  onDecision?: (decision: TradeDecision) => void;
  /** Called after a trade is executed */
  onTrade?: (entry: JournalEntry) => void;
  /** Called when agent enters safety stop */
  onSafetyStop?: (reason: string, state: AgentState) => void;
  /** Called on any error */
  onError?: (error: Error, context: string) => void;
  /** Called when agent status changes */
  onStatusChange?: (status: AgentStatus, previousStatus: AgentStatus) => void;
}
