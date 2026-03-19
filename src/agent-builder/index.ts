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
export { TrendContinuation, BreakoutStrategy, MeanReversionStrategy, OiSkewStrategy, selectBestStrategy } from './strategy.js';
export { FundingHarvester } from './funding-harvester.js';
export { MarketScanner } from './market-scanner.js';
export type { MarketRanking } from './market-scanner.js';
export { DynamicSizer } from './dynamic-sizer.js';
export type { SizingResult } from './dynamic-sizer.js';
export { TechnicalAnalyzer } from './technical-indicators.js';
export type { IndicatorSet, TechnicalSignal } from './technical-indicators.js';
export { ExpectancyEngine } from './expectancy-engine.js';
export type { StrategyStats, EVDecision } from './expectancy-engine.js';
export { MetaAgent } from './meta-agent.js';
export type { AggressionMode, MetaDecision } from './meta-agent.js';
export { OpportunityScorer } from './opportunity-scorer.js';
export type { OpportunityScore } from './opportunity-scorer.js';
export { PortfolioIntel } from './portfolio-intel.js';
export type { PortfolioCheck } from './portfolio-intel.js';
export { AdaptiveWeights } from './adaptive-weights.js';
export type { WeightState } from './adaptive-weights.js';
export { ExecutionModel } from './execution-model.js';
export type { ExecutionCost } from './execution-model.js';
export { CounterfactualTracker } from './counterfactual-tracker.js';
export type { CounterfactualInsight } from './counterfactual-tracker.js';
export { MicroEntryAnalyzer } from './micro-entry.js';
export { TimeIntelligence } from './time-intelligence.js';
export { PolicyLearner } from './policy-learner.js';
export type { MarketState, PolicyAction, LearnedPattern } from './policy-learner.js';
export { SimulationEngine } from './simulation-engine.js';
export type { SimulationInsight } from './simulation-engine.js';
export { PerformanceDashboard } from './performance-dashboard.js';
export type { PerformanceSnapshot, AuditEntry, DegradationAlert, DashboardReport } from './performance-dashboard.js';

// Supervisor
export { AgentSupervisor } from './supervisor.js';
export type { PreflightCheck, PreflightResult, SupervisorStatus } from './supervisor.js';
export { SessionEvaluator } from './session-evaluator.js';
export type { SessionReport, SessionIssue } from './session-evaluator.js';

// Advanced engines
export { SignalFusionEngine } from './signal-fusion.js';
export type { SignalFactor, CompositeSignal } from './signal-fusion.js';
export { PositionManager } from './position-manager.js';
export type { ManagedPosition, PositionSizeResult, PositionManagerConfig } from './position-manager.js';
export { StrategyEnsemble } from './strategy-ensemble.js';
export type { StrategyVote, EnsembleDecision } from './strategy-ensemble.js';
export { DrawdownManager } from './drawdown-manager.js';
export type { DrawdownState, DrawdownConfig } from './drawdown-manager.js';
export { RegimeAdapter } from './regime-adapter.js';
export type { RegimeType, RegimeDetection, RegimeParams } from './regime-adapter.js';

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
