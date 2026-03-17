/**
 * Flash Agent Builder — Public API
 *
 * Usage:
 *   import { TradingAgent, TrendContinuation, BreakoutStrategy } from 'flash-terminal/agent-builder';
 */

// Core agents
export { TradingAgent } from './agent.js';
export { LiveTradingAgent } from './live-agent.js';

// Strategies
export { TrendContinuation, BreakoutStrategy, MeanReversionStrategy, selectBestStrategy } from './strategy.js';

// Supervisor
export { AgentSupervisor } from './supervisor.js';
export type { PreflightCheck, PreflightResult, SupervisorStatus } from './supervisor.js';
export { SessionEvaluator } from './session-evaluator.js';
export type { SessionReport, SessionIssue } from './session-evaluator.js';

// Components
export { RiskManager } from './risk-manager.js';
export { SignalDetector } from './signal-detector.js';
export { TradeJournal } from './trade-journal.js';

// Types
export type {
  AgentConfig,
  AgentState,
  AgentCallbacks,
  AgentStatus,
  RiskLimits,
  Strategy,
  StrategyResult,
  TradeDecision,
  DecisionAction,
  Signal,
  SignalDirection,
  MarketSnapshot,
  JournalEntry,
  JournalStats,
} from './types.js';

export { DEFAULT_AGENT_CONFIG, DEFAULT_RISK_LIMITS } from './types.js';
