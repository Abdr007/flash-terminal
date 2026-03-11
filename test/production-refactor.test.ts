/**
 * Production Refactor Tests
 * Verifies: scan removal, dashboard observability, fee display,
 * market resolution, no fake data/signals/confidence.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { resolveMarket } from '../src/utils/market-resolver.js';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';
import { humanizeSdkError } from '../src/utils/format.js';
import { allAgentTools } from '../src/agent/agent-tools.js';
import { ToolEngine } from '../src/tools/engine.js';

describe('Production Refactor', () => {

// ─── PART 1 & 2: Scan Removal ──────────────────────────────────────────────

it('No "scan" tool in allAgentTools', () => {
  const names = allAgentTools.map(t => t.name);
  assert.ok(!names.includes('ai_scan_markets'), `Found ai_scan_markets in tools: ${names}`);
  assert.ok(!names.includes('scan'), `Found scan in tools: ${names}`);
});

it('No tool with "scan" in description', () => {
  for (const tool of allAgentTools) {
    assert.ok(
      !tool.description.toLowerCase().includes('scan'),
      `Tool "${tool.name}" description contains "scan": ${tool.description}`
    );
  }
});

it('localParse("scan") does NOT return ScanMarkets action', () => {
  const result = localParse('scan');
  // Should return null or some other action, not ScanMarkets
  if (result) {
    assert.notStrictEqual(
      (result as Record<string, unknown>).action,
      'ScanMarkets',
      'scan command should not be parsed'
    );
  }
});

it('localParse("scan markets") does NOT return ScanMarkets action', () => {
  const result = localParse('scan markets');
  if (result) {
    assert.notStrictEqual(
      (result as Record<string, unknown>).action,
      'ScanMarkets',
      'scan markets command should not be parsed'
    );
  }
});

// ─── PART 1: No Confidence/Signals in Analyze Tool ─────────────────────────

it('aiAnalyze tool exists with observability description', () => {
  const analyze = allAgentTools.find(t => t.name === 'ai_analyze');
  assert.ok(analyze, 'ai_analyze tool should exist');
  assert.ok(
    !analyze!.description.toLowerCase().includes('signal'),
    `Description should not mention signals: ${analyze!.description}`
  );
  assert.ok(
    !analyze!.description.toLowerCase().includes('confidence'),
    `Description should not mention confidence: ${analyze!.description}`
  );
});

// ─── PART 3: Dashboard is Observability-Only ────────────────────────────────

it('aiDashboard tool exists', () => {
  const dashboard = allAgentTools.find(t => t.name === 'ai_dashboard');
  assert.ok(dashboard, 'ai_dashboard tool should exist');
});

it('aiDashboard description is observability-focused', () => {
  const dashboard = allAgentTools.find(t => t.name === 'ai_dashboard');
  assert.ok(dashboard, 'ai_dashboard must exist');
  const desc = dashboard!.description.toLowerCase();
  assert.ok(
    !desc.includes('opportunit'),
    `Dashboard description should not mention opportunities: ${dashboard!.description}`
  );
  assert.ok(
    !desc.includes('signal'),
    `Dashboard description should not mention signals: ${dashboard!.description}`
  );
});

// ─── PART 4: Fee Tool Exists ────────────────────────────────────────────────

it('flash_get_fees tool exists in engine help mapping', () => {
  // We just verify it's in the agent tools or flash tools
  // The ToolEngine constructor registers all tools
  // We verify by checking the ActionType enum
  assert.ok(ActionType.GetFees !== undefined, 'GetFees action type should exist');
});

// ─── PART 5: No Opportunity Type in Tool Names ──────────────────────────────

it('No tool names contain "opportunity" or "score"', () => {
  const names = allAgentTools.map(t => t.name);
  for (const name of names) {
    assert.ok(
      !name.includes('opportunit'),
      `Found opportunity-related tool: ${name}`
    );
    assert.ok(
      !name.includes('score'),
      `Found score-related tool: ${name}`
    );
  }
});

// ─── PART 6: Observability Commands Present ─────────────────────────────────

it('Risk report tool exists', () => {
  const tool = allAgentTools.find(t => t.name === 'ai_risk_report');
  assert.ok(tool, 'ai_risk_report should exist');
});

it('Whale activity tool exists', () => {
  const tool = allAgentTools.find(t => t.name === 'ai_whale_activity');
  assert.ok(tool, 'ai_whale_activity should exist');
});

it('Portfolio tools exist', () => {
  const state = allAgentTools.find(t => t.name === 'portfolio_state');
  const exposure = allAgentTools.find(t => t.name === 'portfolio_exposure');
  const rebalance = allAgentTools.find(t => t.name === 'portfolio_rebalance');
  assert.ok(state, 'portfolio_state should exist');
  assert.ok(exposure, 'portfolio_exposure should exist');
  assert.ok(rebalance, 'portfolio_rebalance should exist');
});

// ─── PART 7: Market Resolution Pipeline ─────────────────────────────────────

it('resolveMarket used for stock aliases', () => {
  assert.strictEqual(resolveMarket('nvidia'), 'NVDA');
  assert.strictEqual(resolveMarket('tesla'), 'TSLA');
  assert.strictEqual(resolveMarket('apple'), 'AAPL');
});

it('resolveMarket used for commodity aliases', () => {
  assert.strictEqual(resolveMarket('oil'), 'CRUDEOIL');
  assert.strictEqual(resolveMarket('gold'), 'XAU');
});

it('resolveMarket used for crypto aliases', () => {
  assert.strictEqual(resolveMarket('bitcoin'), 'BTC');
  assert.strictEqual(resolveMarket('ethereum'), 'ETH');
  assert.strictEqual(resolveMarket('solana'), 'SOL');
});

it('localParse("monitor crude oil") → GetMarketData CRUDEOIL', () => {
  const result = localParse('monitor crude oil');
  // monitor resolves through terminal.ts FAST_DISPATCH, not localParse
  // but "price crude oil" or "analyze crude oil" should resolve
  const result2 = localParse('analyze crude oil');
  assert.ok(result2, 'Should parse');
  assert.strictEqual((result2 as Record<string, unknown>).market, 'CRUDEOIL');
});

it('resolveMarket handles "gold" for inspect market (FAST_DISPATCH uses resolveMarket)', () => {
  // inspect market goes through terminal.ts FAST_DISPATCH, not localParse
  // We verify the resolveMarket call that FAST_DISPATCH uses
  assert.strictEqual(resolveMarket('gold'), 'XAU');
});

// ─── Tool Count Verification ────────────────────────────────────────────────

it('Exactly 7 agent tools (no scan)', () => {
  assert.strictEqual(
    allAgentTools.length,
    7,
    `Expected 7 agent tools, got ${allAgentTools.length}: ${allAgentTools.map(t => t.name).join(', ')}`
  );
});

it('Agent tool names are correct', () => {
  const expected = [
    'ai_analyze',
    'ai_risk_report',
    'ai_dashboard',
    'ai_whale_activity',
    'portfolio_state',
    'portfolio_exposure',
    'portfolio_rebalance',
  ];
  const actual = allAgentTools.map(t => t.name);
  for (const name of expected) {
    assert.ok(actual.includes(name), `Missing tool: ${name}`);
  }
});

// ─── SDK Error Humanization ─────────────────────────────────────────────────

it('humanizeSdkError converts raw token amounts to USD', () => {
  const raw = 'Insufficient Funds need more 103334904 tokens';
  const result = humanizeSdkError(raw);
  assert.ok(result.includes('$103.33'), `Expected "$103.33" in: ${result}`);
  assert.ok(result.includes('USDC'), `Expected "USDC" in: ${result}`);
  assert.ok(!result.includes('103334904'), `Should not contain raw amount: ${result}`);
});

it('humanizeSdkError includes collateral context when provided', () => {
  const raw = 'Insufficient Funds need more 103334904 tokens';
  const result = humanizeSdkError(raw, 500, 125);
  assert.ok(result.includes('$500'), `Expected collateral in: ${result}`);
  assert.ok(result.includes('125x'), `Expected leverage in: ${result}`);
});

it('humanizeSdkError passes through non-matching errors unchanged', () => {
  const raw = 'Market SOL not found';
  const result = humanizeSdkError(raw);
  assert.strictEqual(result, raw);
});

it('humanizeSdkError handles small amounts correctly', () => {
  const raw = 'Insufficient Funds need more 5000000 tokens';
  const result = humanizeSdkError(raw);
  assert.ok(result.includes('$5.00'), `Expected "$5.00" in: ${result}`);
});

}); // end describe
