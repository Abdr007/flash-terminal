/**
 * Agent Runtime Detection — single source of truth for agent lifecycle.
 *
 * Checks ALL execution layers to determine if an agent is running:
 *   1. tmux session (PRIMARY) — flash-night or flash-agent
 *   2. OS process (SECONDARY) — node process running flash terminal
 *   3. PID file (TERTIARY) — ~/.flash/agent.pid
 *   4. Heartbeat (SUPPORTING) — ~/.flash/agent-heartbeat.json
 *   5. In-process reference (INTERNAL) — this.liveAgent?.isRunning
 *
 * Used by CLI for accurate status reporting and safe start/stop.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Constants ───────────────────────────────────────────────────────────────

const FLASH_DIR = join(homedir(), '.flash');
const PID_FILE = join(FLASH_DIR, 'agent.pid');
const HEARTBEAT_FILE = join(FLASH_DIR, 'agent-heartbeat.json');
const STATE_FILE = join(FLASH_DIR, 'agent-state.json');

/** tmux session names to check (in priority order) */
const TMUX_SESSIONS = ['flash-night', 'flash-agent'];

/** Heartbeat is stale if older than this */
const HEARTBEAT_STALE_MS = 60_000;

/** State file is considered "active" if updated within this window */
const _STATE_ACTIVE_MS = 5 * 60_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export type AgentRunMode = 'tmux' | 'process' | 'in-process' | 'none';
export type AgentHealthStatus = 'RUNNING' | 'DEGRADED' | 'STOPPED';

export interface AgentRuntimeState {
  status: AgentHealthStatus;
  mode: AgentRunMode;
  pid?: number;
  session?: string;
  lastHeartbeatMs?: number;
  lastStateUpdateMs?: number;
  stateFileBytes?: number;
  heartbeatStale?: boolean;
}

// ─── Detection Functions ─────────────────────────────────────────────────────

/** Check if a tmux session exists. Returns session name or null. */
function detectTmuxSession(): string | null {
  for (const session of TMUX_SESSIONS) {
    try {
      execSync(`tmux has-session -t ${session} 2>/dev/null`, { stdio: 'pipe' });
      return session;
    } catch {
      // Session doesn't exist
    }
  }
  return null;
}

/** Check for running agent process. Returns PID or null. */
function detectAgentProcess(): number | null {
  try {
    // Look for node process running flash terminal (but not this detection script)
    const output = execSync(
      'ps aux | grep -E "node.*dist/index\\.js|node.*flash-terminal" | grep -v grep | head -1',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (output) {
      const parts = output.split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {
    // No process found
  }
  return null;
}

/** Read PID file. Returns PID if file exists and process is alive, null otherwise. */
function detectPidFile(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const raw = readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;

    // Verify process is actually alive
    try {
      process.kill(pid, 0); // signal 0 = existence check
      return pid;
    } catch {
      // Process doesn't exist — stale PID file
      cleanPidFile();
      return null;
    }
  } catch {
    return null;
  }
}

/** Read heartbeat file. Returns { timestamp, stale } or null. */
function detectHeartbeat(): { timestamp: number; stale: boolean } | null {
  try {
    if (!existsSync(HEARTBEAT_FILE)) return null;
    const raw = readFileSync(HEARTBEAT_FILE, 'utf8');
    const data = JSON.parse(raw) as { timestamp?: number };
    if (typeof data.timestamp !== 'number') return null;

    const age = Date.now() - data.timestamp;
    return { timestamp: data.timestamp, stale: age > HEARTBEAT_STALE_MS };
  } catch {
    return null;
  }
}

/** Get state file info. Returns { mtime, bytes } or null. */
function getStateFileInfo(): { mtimeMs: number; bytes: number } | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const stat = statSync(STATE_FILE);
    return { mtimeMs: stat.mtimeMs, bytes: stat.size };
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get comprehensive agent runtime status.
 * Checks ALL execution layers — tmux is the primary source of truth.
 */
export function getAgentStatus(inProcessRunning = false): AgentRuntimeState {
  // Layer 1: In-process reference (fastest, most direct)
  if (inProcessRunning) {
    const heartbeat = detectHeartbeat();
    const stateInfo = getStateFileInfo();
    return {
      status: 'RUNNING',
      mode: 'in-process',
      pid: process.pid,
      lastHeartbeatMs: heartbeat?.timestamp,
      lastStateUpdateMs: stateInfo?.mtimeMs,
      stateFileBytes: stateInfo?.bytes,
      heartbeatStale: heartbeat?.stale,
    };
  }

  // Layer 2: tmux session (PRIMARY external detection)
  const tmuxSession = detectTmuxSession();
  if (tmuxSession) {
    const heartbeat = detectHeartbeat();
    const stateInfo = getStateFileInfo();
    const pid = detectPidFile() ?? detectAgentProcess();

    // If tmux exists but heartbeat is stale > 60s, mark DEGRADED
    const isDegraded = heartbeat ? heartbeat.stale : false;

    return {
      status: isDegraded ? 'DEGRADED' : 'RUNNING',
      mode: 'tmux',
      session: tmuxSession,
      pid: pid ?? undefined,
      lastHeartbeatMs: heartbeat?.timestamp,
      lastStateUpdateMs: stateInfo?.mtimeMs,
      stateFileBytes: stateInfo?.bytes,
      heartbeatStale: heartbeat?.stale,
    };
  }

  // Layer 3: OS process (SECONDARY — tmux crashed but process lives)
  const processPid = detectPidFile() ?? detectAgentProcess();
  if (processPid) {
    const heartbeat = detectHeartbeat();
    const stateInfo = getStateFileInfo();
    return {
      status: heartbeat?.stale ? 'DEGRADED' : 'RUNNING',
      mode: 'process',
      pid: processPid,
      lastHeartbeatMs: heartbeat?.timestamp,
      lastStateUpdateMs: stateInfo?.mtimeMs,
      stateFileBytes: stateInfo?.bytes,
      heartbeatStale: heartbeat?.stale,
    };
  }

  // Layer 4: No running agent detected
  const stateInfo = getStateFileInfo();
  return {
    status: 'STOPPED',
    mode: 'none',
    lastStateUpdateMs: stateInfo?.mtimeMs,
    stateFileBytes: stateInfo?.bytes,
  };
}

/**
 * Write PID file (call from agent startup).
 */
export function writePidFile(pid?: number): void {
  try {
    if (!existsSync(FLASH_DIR)) mkdirSync(FLASH_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(PID_FILE, String(pid ?? process.pid), { mode: 0o600 });
  } catch {
    // Non-critical
  }
}

/**
 * Clean PID file (call from agent shutdown).
 */
export function cleanPidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // Non-critical
  }
}

/**
 * Write heartbeat (call every 10s from agent tick loop).
 */
export function writeHeartbeat(): void {
  try {
    if (!existsSync(FLASH_DIR)) mkdirSync(FLASH_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(
      HEARTBEAT_FILE,
      JSON.stringify({ timestamp: Date.now(), pid: process.pid }),
      { mode: 0o600 },
    );
  } catch {
    // Non-critical — never throw from heartbeat
  }
}

/**
 * Clean heartbeat file (call from agent shutdown).
 */
export function cleanHeartbeat(): void {
  try {
    if (existsSync(HEARTBEAT_FILE)) unlinkSync(HEARTBEAT_FILE);
  } catch {
    // Non-critical
  }
}

/**
 * Get recent agent logs from tmux pane capture.
 * Returns last N lines of terminal output, or null if no session.
 */
export function getAgentLogs(lines = 200): string | null {
  const session = detectTmuxSession();
  if (!session) return null;

  try {
    return execSync(
      `tmux capture-pane -t ${session} -p -S -${lines}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
    );
  } catch {
    return null;
  }
}

/**
 * Format agent status for display.
 */
export function formatAgentStatus(state: AgentRuntimeState): string {
  switch (state.status) {
    case 'RUNNING':
      if (state.mode === 'tmux') {
        return `Agent is running (tmux: ${state.session})${state.pid ? ` [PID ${state.pid}]` : ''}`;
      }
      if (state.mode === 'process') {
        return `Agent is running (process: PID ${state.pid})`;
      }
      if (state.mode === 'in-process') {
        return `Agent is running (this session)`;
      }
      return 'Agent is running';

    case 'DEGRADED':
      return `Agent is running but DEGRADED (tmux: ${state.session ?? 'unknown'}, heartbeat stale)`;

    case 'STOPPED':
      if (state.stateFileBytes && state.stateFileBytes > 0) {
        return 'Agent is stopped — learning state preserved, safe to start';
      }
      return 'Agent is stopped';
  }
}

/**
 * Get the active tmux session name, or null if no session.
 */
export function getActiveSession(): string | null {
  return detectTmuxSession();
}

// ─── Runtime Integrity Validation ────────────────────────────────────────────

export interface IntegrityResult {
  consistent: boolean;
  actions: string[];
  warnings: string[];
}

/**
 * Validate runtime integrity and self-heal inconsistencies.
 *
 * Invariant enforcement:
 *   - tmux exists BUT PID missing → recreate PID from process scan
 *   - PID exists BUT process dead → clean stale PID
 *   - heartbeat stale + tmux alive → DEGRADED (warn, don't kill)
 *   - state file missing → WARN only (never recreate)
 *
 * Safe to call on every CLI command and periodically from agent.
 */
export function validateRuntimeIntegrity(): IntegrityResult {
  const actions: string[] = [];
  const warnings: string[] = [];

  const tmuxSession = detectTmuxSession();
  const pidFromFile = detectPidFileRaw();
  const heartbeat = detectHeartbeat();
  const stateInfo = getStateFileInfo();

  // Rule 1: tmux exists but PID file missing → try to recover PID
  if (tmuxSession && !pidFromFile) {
    const processPid = detectAgentProcess();
    if (processPid) {
      writePidFile(processPid);
      actions.push(`Recovered PID file (${processPid}) from process scan`);
    }
  }

  // Rule 2: PID file exists but process is dead → clean stale PID
  if (pidFromFile && !isProcessAlive(pidFromFile)) {
    cleanPidFile();
    actions.push(`Cleaned stale PID file (process ${pidFromFile} no longer exists)`);
  }

  // Rule 3: heartbeat stale + tmux alive → warn DEGRADED
  if (tmuxSession && heartbeat?.stale) {
    const ageS = Math.round((Date.now() - heartbeat.timestamp) / 1000);
    warnings.push(`Heartbeat stale (${ageS}s) — agent may be hung in tmux:${tmuxSession}`);
  }

  // Rule 4: no tmux, no process, but heartbeat/PID still exist → clean up
  if (!tmuxSession && !detectAgentProcess()) {
    if (existsSync(HEARTBEAT_FILE)) {
      cleanHeartbeat();
      actions.push('Cleaned orphaned heartbeat file (no running agent)');
    }
    if (existsSync(PID_FILE)) {
      cleanPidFile();
      actions.push('Cleaned orphaned PID file (no running agent)');
    }
  }

  // Rule 5: state file missing → warn (never recreate)
  if (!stateInfo) {
    warnings.push('agent-state.json not found — learning state will start fresh on next agent start');
  }

  return {
    consistent: warnings.length === 0,
    actions,
    warnings,
  };
}

/** Raw PID read without alive-check (for integrity validation). */
function detectPidFileRaw(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const raw = readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Check if a process is alive by PID. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Runtime Snapshot (Observability) ────────────────────────────────────────

const RUNTIME_SNAPSHOT_FILE = join(FLASH_DIR, 'runtime-status.json');

export interface RuntimeSnapshot {
  status: AgentHealthStatus;
  mode: AgentRunMode;
  pid?: number;
  session?: string;
  heartbeatAgeMs?: number;
  stateFileBytes?: number;
  lastStateUpdateMs?: number;
  snapshotTime: number;
}

/**
 * Write a runtime snapshot to disk for external monitoring tools.
 * Call from agent tick loop or CLI status checks.
 */
export function writeRuntimeSnapshot(state?: AgentRuntimeState): void {
  try {
    const s = state ?? getAgentStatus(false);
    const snapshot: RuntimeSnapshot = {
      status: s.status,
      mode: s.mode,
      pid: s.pid,
      session: s.session,
      heartbeatAgeMs: s.lastHeartbeatMs ? Date.now() - s.lastHeartbeatMs : undefined,
      stateFileBytes: s.stateFileBytes,
      lastStateUpdateMs: s.lastStateUpdateMs,
      snapshotTime: Date.now(),
    };
    if (!existsSync(FLASH_DIR)) mkdirSync(FLASH_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(RUNTIME_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  } catch {
    // Non-critical
  }
}
