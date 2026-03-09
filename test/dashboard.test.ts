/**
 * Dashboard observability tests.
 *
 * Validates that the production dashboard:
 * 1. Contains NO trade signals, recommendations, or confidence scores
 * 2. Contains all 6 required sections
 * 3. Uses real data source patterns (formatUsd, formatPercent)
 * 4. Has box-drawing rendering
 * 5. Shows "Data unavailable" for missing data (never fabricates)
 */

import assert from 'assert';
import { allAgentTools } from '../src/agent/agent-tools.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  \u2714 ${name}`);
  } catch (e: unknown) {
    failed++;
    console.log(`  \u2716 ${name}`);
    console.log(`    ${(e as Error).message}`);
  }
}

console.log('\n  DASHBOARD OBSERVABILITY TESTS\n');

// ─── Tool metadata ──────────────────────────────────────────────────────────

const dashboard = allAgentTools.find(t => t.name === 'ai_dashboard');

test('Dashboard tool exists', () => {
  assert.ok(dashboard, 'ai_dashboard tool not found');
});

test('Dashboard description mentions observability', () => {
  assert.ok(dashboard, 'missing');
  const desc = dashboard!.description.toLowerCase();
  assert.ok(
    desc.includes('observability') || desc.includes('protocol health') || desc.includes('real-time'),
    `Description should mention observability: "${dashboard!.description}"`
  );
});

test('Dashboard description does NOT mention signals or opportunities', () => {
  assert.ok(dashboard, 'missing');
  const desc = dashboard!.description.toLowerCase();
  const forbidden = ['signal', 'opportunit', 'recommend', 'predict', 'score', 'confidence'];
  for (const word of forbidden) {
    assert.ok(!desc.includes(word), `Description contains forbidden word "${word}": "${dashboard!.description}"`);
  }
});

test('Dashboard takes no parameters', () => {
  assert.ok(dashboard, 'missing');
  // Zod schema for empty object should have no keys
  const shape = (dashboard!.parameters as { shape?: Record<string, unknown> }).shape ?? {};
  assert.strictEqual(Object.keys(shape).length, 0, 'Dashboard should have zero parameters');
});

// ─── Source code analysis (static checks on the tool function body) ─────────

// Read the tool's execute function source to verify content
const execSrc = dashboard?.execute.toString() ?? '';

test('Dashboard renders 6 sections via boxTop()', () => {
  // Count boxTop calls — should be at least 6 (Protocol Health, Top Volume,
  // OI Leaders, Funding Rates, Your Portfolio, Terminal Status)
  const boxTopCount = (execSrc.match(/boxTop\(/g) || []).length;
  assert.ok(boxTopCount >= 6, `Expected >= 6 boxTop() calls, found ${boxTopCount}`);
});

test('Dashboard renders "Flash Terminal" header', () => {
  assert.ok(execSrc.includes('Flash Terminal'), 'Should render "Flash Terminal" in header');
});

test('Dashboard renders "Deterministic Protocol Trading Terminal" subtitle', () => {
  assert.ok(
    execSrc.includes('Deterministic Protocol Trading Terminal'),
    'Should render deterministic subtitle'
  );
});

test('Dashboard shows "Protocol Health" section', () => {
  assert.ok(execSrc.includes('Protocol Health'), 'Missing Protocol Health section');
});

test('Dashboard shows "Top Volume Markets" section', () => {
  assert.ok(execSrc.includes('Top Volume Markets'), 'Missing Top Volume Markets section');
});

test('Dashboard shows "Open Interest Leaders" section', () => {
  assert.ok(execSrc.includes('Open Interest Leaders'), 'Missing OI Leaders section');
});

test('Dashboard shows "Funding Rates" section', () => {
  assert.ok(execSrc.includes('Funding Rates'), 'Missing Funding Rates section');
});

test('Dashboard shows "Your Portfolio" section', () => {
  assert.ok(execSrc.includes('Your Portfolio'), 'Missing Portfolio section');
});

test('Dashboard shows "Terminal Status" section', () => {
  assert.ok(execSrc.includes('Terminal Status'), 'Missing Terminal Status section');
});

// ─── Metric presence ────────────────────────────────────────────────────────

test('Shows Active Markets metric', () => {
  assert.ok(execSrc.includes('Active Markets'), 'Missing Active Markets');
});

test('Shows Total Open Interest metric', () => {
  assert.ok(execSrc.includes('Total Open Interest'), 'Missing Total OI');
});

test('Shows 24h Volume metric', () => {
  assert.ok(execSrc.includes('24h Volume'), 'Missing 24h Volume');
});

test('Shows Avg Funding Rate metric', () => {
  assert.ok(execSrc.includes('Avg Funding Rate'), 'Missing Avg Funding Rate');
});

test('Shows Oracle Latency metric', () => {
  assert.ok(execSrc.includes('Oracle Latency'), 'Missing Oracle Latency');
});

test('Shows RPC Latency metric', () => {
  assert.ok(execSrc.includes('RPC Latency'), 'Missing RPC Latency');
});

test('Shows Current Slot metric', () => {
  assert.ok(execSrc.includes('Current Slot'), 'Missing Current Slot');
});

test('Shows Positions metric', () => {
  assert.ok(execSrc.includes('Positions:'), 'Missing Positions count');
});

test('Shows Balance metric', () => {
  assert.ok(execSrc.includes('Balance:'), 'Missing Balance');
});

test('Shows Exposure metric', () => {
  assert.ok(execSrc.includes('Exposure:'), 'Missing Exposure');
});

test('Shows Unrealized PnL metric', () => {
  assert.ok(execSrc.includes('Unrealized PnL'), 'Missing Unrealized PnL');
});

test('Shows Mode (Sim/Live)', () => {
  assert.ok(execSrc.includes('Mode:'), 'Missing Mode display');
});

test('Shows Wallet name', () => {
  assert.ok(execSrc.includes('Wallet:'), 'Missing Wallet display');
});

test('Shows RPC endpoint status', () => {
  assert.ok(execSrc.includes('Healthy') || execSrc.includes('Degraded'), 'Missing RPC health indicator');
});

test('Shows Last Update timestamp', () => {
  assert.ok(execSrc.includes('Last Update'), 'Missing Last Update');
});

// ─── Data integrity (no fabrication) ────────────────────────────────────────

test('Uses "Data unavailable" for missing data', () => {
  assert.ok(execSrc.includes('Data unavailable'), 'Should show "Data unavailable" for missing data');
});

test('Does NOT contain "opportunity" or "signal" or "confidence"', () => {
  const lower = execSrc.toLowerCase();
  assert.ok(!lower.includes('opportunity'), 'Dashboard source mentions opportunity');
  assert.ok(!lower.includes('trade signal'), 'Dashboard source mentions trade signal');
  assert.ok(!lower.includes('confidence'), 'Dashboard source mentions confidence');
  assert.ok(!lower.includes('recommend'), 'Dashboard source mentions recommend');
});

test('Uses real data sources (getFullSnapshot, getSlot, getRpcManagerInstance)', () => {
  assert.ok(execSrc.includes('getFullSnapshot'), 'Should fetch full snapshot');
  assert.ok(execSrc.includes('getSlot'), 'Should fetch current slot');
  assert.ok(execSrc.includes('getRpcManagerInstance'), 'Should access RPC manager');
});

test('Uses computeExposure for portfolio exposure (not synthetic)', () => {
  assert.ok(execSrc.includes('computeExposure'), 'Should compute real exposure');
});

test('Uses assessAllPositions for risk level (not synthetic)', () => {
  assert.ok(execSrc.includes('assessAllPositions'), 'Should assess real risk');
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
