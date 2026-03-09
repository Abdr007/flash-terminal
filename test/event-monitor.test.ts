/**
 * Event Monitor Tests
 * Verifies: monitor types, event detection, threshold logic, data sources, no synthetic data.
 */

import assert from 'assert';
import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e: unknown) {
    failed++;
    console.log(`  ✖ ${name}`);
    console.log(`    ${(e as Error).message}`);
  }
}

console.log('\n  EVENT MONITOR TESTS\n');

const source = readFileSync('src/monitor/event-monitor.ts', 'utf-8');

// ─── Module Structure ──────────────────────────────────────────────────────

test('EventMonitor class is exported', () => {
  assert.ok(source.includes('export class EventMonitor'), 'EventMonitor class not exported');
});

test('MonitorType type is exported', () => {
  assert.ok(source.includes("export type MonitorType = 'market' | 'position' | 'liquidations' | 'protocol'"), 'MonitorType not exported');
});

// ─── Monitor Types ─────────────────────────────────────────────────────────

test('Supports market monitor', () => {
  assert.ok(source.includes('tickMarket'), 'tickMarket method missing');
});

test('Supports position monitor', () => {
  assert.ok(source.includes('tickPosition'), 'tickPosition method missing');
});

test('Supports liquidation monitor', () => {
  assert.ok(source.includes('tickLiquidations'), 'tickLiquidations method missing');
});

test('Supports protocol monitor', () => {
  assert.ok(source.includes('tickProtocol'), 'tickProtocol method missing');
});

// ─── Event Detection Thresholds ────────────────────────────────────────────

test('Has price change threshold', () => {
  assert.ok(source.includes('PRICE_CHANGE_THRESHOLD_PCT'), 'Price threshold missing');
});

test('Has OI change threshold', () => {
  assert.ok(source.includes('OI_CHANGE_THRESHOLD_PCT'), 'OI threshold missing');
  assert.ok(source.includes('OI_CHANGE_THRESHOLD_USD'), 'OI USD threshold missing');
});

test('Has funding flip threshold', () => {
  assert.ok(source.includes('FUNDING_FLIP_THRESHOLD'), 'Funding threshold missing');
});

test('Has whale size threshold', () => {
  assert.ok(source.includes('WHALE_SIZE_THRESHOLD_USD'), 'Whale threshold missing');
});

test('Has PnL change threshold', () => {
  assert.ok(source.includes('PNL_CHANGE_THRESHOLD_USD'), 'PnL threshold missing');
});

test('Has liquidation distance threshold', () => {
  assert.ok(source.includes('LIQ_DISTANCE_CHANGE_PCT'), 'Liq distance threshold missing');
});

test('Has RPC latency spike threshold', () => {
  assert.ok(source.includes('RPC_LATENCY_SPIKE_MS'), 'RPC latency threshold missing');
});

test('Has oracle delay threshold', () => {
  assert.ok(source.includes('ORACLE_DELAY_THRESHOLD_S'), 'Oracle delay threshold missing');
});

// ─── Data Sources ──────────────────────────────────────────────────────────

test('Uses PriceService (Pyth Hermes)', () => {
  assert.ok(source.includes('PriceService'), 'PriceService not imported');
  assert.ok(source.includes('this.priceSvc.getPrices'), 'Not fetching from PriceService');
});

test('Uses FStatsClient (protocol analytics)', () => {
  assert.ok(source.includes('FStatsClient'), 'FStatsClient not imported');
  assert.ok(source.includes('this.fstats.getOpenInterest'), 'Not fetching OI from fstats');
  assert.ok(source.includes('this.fstats.getOpenPositions'), 'Not fetching whale data from fstats');
});

test('Uses IFlashClient (positions)', () => {
  assert.ok(source.includes('this.client.getPositions'), 'Not fetching positions from client');
  assert.ok(source.includes('this.client.getMarketData'), 'Not fetching market data from client');
});

test('Uses RPC manager for latency', () => {
  assert.ok(source.includes('getRpcManagerInstance'), 'Not using RPC manager');
  assert.ok(source.includes('activeLatencyMs'), 'Not reading latency');
});

// ─── No Synthetic Data ─────────────────────────────────────────────────────

test('No fabricated signals or confidence scores', () => {
  const lower = source.toLowerCase();
  assert.ok(!lower.includes('confidence'), 'Contains "confidence"');
  assert.ok(!lower.includes('signal score'), 'Contains "signal score"');
  assert.ok(!lower.includes('math.random'), 'Contains Math.random');
  assert.ok(!lower.includes('fake'), 'Contains "fake"');
});

// ─── Event Severity System ─────────────────────────────────────────────────

test('Has severity levels: info, warning, critical', () => {
  assert.ok(source.includes("severity: 'info'"), 'Missing info severity');
  assert.ok(source.includes("severity: 'warning'"), 'Missing warning severity');
  assert.ok(source.includes("'critical'"), 'Missing critical severity');
  assert.ok(source.includes("'info' | 'warning' | 'critical'"), 'Missing severity type definition');
});

// ─── State Comparison ──────────────────────────────────────────────────────

test('Maintains previous state for delta detection', () => {
  assert.ok(source.includes('prevMarket'), 'No previous market state');
  assert.ok(source.includes('prevPosition'), 'No previous position state');
  assert.ok(source.includes('prevProtocol'), 'No previous protocol state');
});

test('Only emits events when thresholds exceeded', () => {
  // Price: checks percentage change against threshold
  assert.ok(source.includes('Math.abs(pricePctChange) >= PRICE_CHANGE_THRESHOLD_PCT'), 'No price threshold check');
  // OI: checks absolute and percentage change
  assert.ok(source.includes('OI_CHANGE_THRESHOLD_PCT') && source.includes('OI_CHANGE_THRESHOLD_USD'), 'No OI threshold check');
});

// ─── Safety Guards ─────────────────────────────────────────────────────────

test('Max events per cycle to prevent flood', () => {
  assert.ok(source.includes('MAX_EVENTS_PER_CYCLE'), 'No event cap');
});

test('Whale keys bounded to prevent memory leak', () => {
  assert.ok(source.includes('knownWhaleKeys.size > 500'), 'No whale key bound');
});

test('Periodic heartbeat for liveness', () => {
  assert.ok(source.includes('No significant changes detected'), 'No heartbeat message');
});

// ─── Terminal Integration ──────────────────────────────────────────────────

const terminalSource = readFileSync('src/cli/terminal.ts', 'utf-8');

test('Terminal routes "monitor <market>" to event monitor', () => {
  assert.ok(terminalSource.includes("handleEventMonitor('market'"), 'No market monitor route');
});

test('Terminal routes "monitor position <market>" to position monitor', () => {
  assert.ok(terminalSource.includes("handleEventMonitor('position'"), 'No position monitor route');
});

test('Terminal routes "monitor liquidations <market>" to liquidation monitor', () => {
  assert.ok(terminalSource.includes("handleEventMonitor('liquidations'"), 'No liquidation monitor route');
});

test('Terminal routes "monitor protocol" to protocol monitor', () => {
  assert.ok(terminalSource.includes("handleEventMonitor('protocol'"), 'No protocol monitor route');
});

test('Help text includes all monitor commands', () => {
  const engineSource = readFileSync('src/tools/engine.ts', 'utf-8');
  assert.ok(engineSource.includes('monitor <market>'), 'Help missing monitor <market>');
  assert.ok(engineSource.includes('monitor position'), 'Help missing monitor position');
  assert.ok(engineSource.includes('monitor liquidations'), 'Help missing monitor liquidations');
  assert.ok(engineSource.includes('monitor protocol'), 'Help missing monitor protocol');
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
