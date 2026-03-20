/**
 * Agent State Persistence — Save and restore learning state across restarts.
 *
 * Persists to ~/.flash/agent-state.json:
 * - PolicyLearner (Q-table, visit counts, exploration/learning rates)
 * - ExpectancyEngine (strategy stats, global trade count)
 * - AdaptiveWeights (short/long term accuracy, weights)
 * - TimeIntelligence (hourly performance)
 * - ExitPolicyLearner (exit Q-table)
 *
 * Features:
 * - Schema versioning for future migrations
 * - Validation before load (rejects corrupted data)
 * - Periodic autosave (configurable tick interval)
 * - Graceful fallback to defaults on any error
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

// ─── Schema Version ─────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const STATE_DIR = join(homedir(), '.flash');
const STATE_FILE = join(STATE_DIR, 'agent-state.json');
const BACKUP_FILE = join(STATE_DIR, 'agent-state.backup.json');

// ─── Persisted State Shape ──────────────────────────────────────────────────

export interface PersistedPolicyEntry {
  qValues: Record<string, number>;
  visits: number;
  avgReward: number;
}

export interface PersistedExitPolicyEntry {
  qValues: Record<string, number>;
  visits: number;
  avgReward: number;
}

export interface PersistedStrategyStats {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  ev: number;
  profitFactor: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  disabled: boolean;
  disabledReason?: string;
  weight: number;
  recentPnl: number[];
}

export interface PersistedWeightState {
  name: string;
  weight: number;
  baseWeight: number;
  shortTermAccuracy: number;
  longTermAccuracy: number;
  accuracy: number;
  shortTermPredictions: number;
  shortTermCorrect: number;
  longTermPredictions: number;
  longTermCorrect: number;
}

export interface PersistedTimePerf {
  hour: number;
  trades: number;
  wins: number;
  totalPnl: number;
}

export interface PersistedAgentState {
  version: number;
  savedAt: string;
  /** PolicyLearner state */
  policy: {
    entries: Array<{ key: string; entry: PersistedPolicyEntry }>;
    explorationRate: number;
    learningRate: number;
    totalUpdates: number;
    recentRewards: number[];
    shortWindow: number[];
    metrics: { totalReward: number; maxDrawdown: number; peakReward: number; winCount: number; lossCount: number };
  };
  /** ExitPolicyLearner state */
  exitPolicy: {
    entries: Array<{ key: string; entry: PersistedExitPolicyEntry }>;
    explorationRate: number;
    learningRate: number;
    totalUpdates: number;
  };
  /** ExpectancyEngine state */
  expectancy: {
    strategies: PersistedStrategyStats[];
    globalTrades: number;
  };
  /** AdaptiveWeights state */
  adaptiveWeights: PersistedWeightState[];
  /** TimeIntelligence state */
  timeIntel: PersistedTimePerf[];
}

// ─── Validation ─────────────────────────────────────────────────────────────

function isValidState(data: unknown): data is PersistedAgentState {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.version !== SCHEMA_VERSION) return false;
  if (typeof d.savedAt !== 'string') return false;
  if (!d.policy || typeof d.policy !== 'object') return false;
  if (!d.expectancy || typeof d.expectancy !== 'object') return false;
  if (!Array.isArray((d.policy as Record<string, unknown>).entries)) return false;
  if (!Array.isArray((d.expectancy as Record<string, unknown>).strategies)) return false;

  // Validate numeric fields are finite
  const policy = d.policy as Record<string, unknown>;
  if (typeof policy.explorationRate !== 'number' || !Number.isFinite(policy.explorationRate as number)) return false;
  if (typeof policy.learningRate !== 'number' || !Number.isFinite(policy.learningRate as number)) return false;

  return true;
}

// ─── Save / Load ────────────────────────────────────────────────────────────

export function saveAgentState(state: PersistedAgentState): boolean {
  const logger = getLogger();
  try {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }

    // Write to temp file first, then rename (atomic on most filesystems)
    const tempFile = STATE_FILE + '.tmp';
    const json = JSON.stringify(state, null, 2);
    writeFileSync(tempFile, json, 'utf-8');

    // Backup previous state
    if (existsSync(STATE_FILE)) {
      try { renameSync(STATE_FILE, BACKUP_FILE); } catch { /* best effort */ }
    }

    renameSync(tempFile, STATE_FILE);
    logger.debug('PERSIST', `Saved agent state (${state.policy.entries.length} policy entries, ${state.expectancy.strategies.length} strategies)`);
    return true;
  } catch (error: unknown) {
    logger.info('PERSIST', `Failed to save agent state: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

export function loadAgentState(): PersistedAgentState | null {
  const logger = getLogger();
  try {
    if (!existsSync(STATE_FILE)) {
      logger.debug('PERSIST', 'No saved agent state found — starting fresh');
      return null;
    }

    const raw = readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!isValidState(parsed)) {
      logger.info('PERSIST', 'Saved state failed validation — starting fresh');
      return null;
    }

    logger.info('PERSIST', `Loaded agent state from ${parsed.savedAt} (${parsed.policy.entries.length} policy entries, ${parsed.expectancy.strategies.length} strategies)`);
    return parsed;
  } catch (error: unknown) {
    logger.info('PERSIST', `Failed to load agent state: ${error instanceof Error ? error.message : error}`);

    // Try backup
    try {
      if (existsSync(BACKUP_FILE)) {
        const raw = readFileSync(BACKUP_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (isValidState(parsed)) {
          logger.info('PERSIST', 'Loaded from backup state');
          return parsed;
        }
      }
    } catch { /* give up */ }

    return null;
  }
}

// ─── Serialization Helpers ──────────────────────────────────────────────────

/**
 * Build a PersistedAgentState from live components.
 * Each component exposes a serialize() method.
 */
export function buildPersistedState(components: {
  policy: { serialize(): PersistedAgentState['policy'] };
  exitPolicy: { serialize(): PersistedAgentState['exitPolicy'] };
  expectancy: { serialize(): PersistedAgentState['expectancy'] };
  adaptiveWeights: { serialize(): PersistedWeightState[] };
  timeIntel: { serialize(): PersistedTimePerf[] };
}): PersistedAgentState {
  return {
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    policy: components.policy.serialize(),
    exitPolicy: components.exitPolicy.serialize(),
    expectancy: components.expectancy.serialize(),
    adaptiveWeights: components.adaptiveWeights.serialize(),
    timeIntel: components.timeIntel.serialize(),
  };
}
