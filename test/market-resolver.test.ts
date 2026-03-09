/**
 * Tests for centralized market resolver.
 * Covers alias resolution, case insensitivity, multi-word aliases,
 * and integration with the interpreter localParse.
 */

import { resolveMarket, resolveAndValidateMarket, isValidMarket, normalizeAssetText } from '../src/utils/market-resolver.js';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';
import assert from 'assert';

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

console.log('\n  MARKET RESOLVER TESTS\n');

// ─── resolveMarket() ──────────────────────────────────────────────────────

test('resolves "crude oil" → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('crude oil'), 'CRUDEOIL');
});

test('resolves "oil" → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('oil'), 'CRUDEOIL');
});

test('resolves "CRUDE OIL" → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('CRUDE OIL'), 'CRUDEOIL');
});

test('resolves "crude" → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('crude'), 'CRUDEOIL');
});

test('resolves "Crude Oil" (mixed case) → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('Crude Oil'), 'CRUDEOIL');
});

test('resolves "SOL" → SOL', () => {
  assert.strictEqual(resolveMarket('SOL'), 'SOL');
});

test('resolves "sol" → SOL', () => {
  assert.strictEqual(resolveMarket('sol'), 'SOL');
});

test('resolves "bitcoin" → BTC', () => {
  assert.strictEqual(resolveMarket('bitcoin'), 'BTC');
});

test('resolves "gold" → XAU', () => {
  assert.strictEqual(resolveMarket('gold'), 'XAU');
});

test('resolves "met" → MET (case insensitive canonical lookup)', () => {
  assert.strictEqual(resolveMarket('met'), 'MET');
});

test('resolves "metaplex" → MET', () => {
  assert.strictEqual(resolveMarket('metaplex'), 'MET');
});

test('resolves "yen" → USDJPY', () => {
  assert.strictEqual(resolveMarket('yen'), 'USDJPY');
});

test('resolves "EUR" → EUR', () => {
  assert.strictEqual(resolveMarket('EUR'), 'EUR');
});

test('resolves "fartcoin" → FARTCOIN', () => {
  assert.strictEqual(resolveMarket('fartcoin'), 'FARTCOIN');
});

test('resolves "CRUDEOIL" → CRUDEOIL (already canonical)', () => {
  assert.strictEqual(resolveMarket('CRUDEOIL'), 'CRUDEOIL');
});

// ─── resolveAndValidateMarket() ──────────────────────────────────────────

test('validates "oil" as valid market', () => {
  assert.strictEqual(resolveAndValidateMarket('oil'), 'CRUDEOIL');
});

test('validates "sol" as valid market', () => {
  assert.strictEqual(resolveAndValidateMarket('sol'), 'SOL');
});

test('rejects "NOTAMARKET" as invalid', () => {
  assert.strictEqual(resolveAndValidateMarket('NOTAMARKET'), null);
});

// ─── isValidMarket() ─────────────────────────────────────────────────────

test('isValidMarket("SOL") → true', () => {
  assert.strictEqual(isValidMarket('SOL'), true);
});

test('isValidMarket("CRUDEOIL") → true', () => {
  assert.strictEqual(isValidMarket('CRUDEOIL'), true);
});

test('isValidMarket("MET") → true', () => {
  assert.strictEqual(isValidMarket('MET'), true);
});

test('isValidMarket("FAKE") → false', () => {
  assert.strictEqual(isValidMarket('FAKE'), false);
});

// ─── normalizeAssetText() ────────────────────────────────────────────────

test('normalizeAssetText handles "crude oil" → "crudeoil"', () => {
  const result = normalizeAssetText('analyze crude oil');
  assert.ok(result.includes('crudeoil'), `Expected "crudeoil" in "${result}"`);
});

test('normalizeAssetText handles "gold" → "xau"', () => {
  const result = normalizeAssetText('analyze gold');
  assert.ok(result.includes('xau'), `Expected "xau" in "${result}"`);
});

// ─── localParse integration: analyze ──────────────────────────────────────

test('localParse("analyze crude oil") → Analyze CRUDEOIL', () => {
  const result = localParse('analyze crude oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.Analyze);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

test('localParse("analyze oil") → Analyze CRUDEOIL', () => {
  const result = localParse('analyze oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.Analyze);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

test('localParse("analyse sol") → Analyze SOL (British spelling)', () => {
  const result = localParse('analyse sol');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.Analyze);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
});

test('localParse("analyze met") → Analyze MET', () => {
  const result = localParse('analyze met');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.Analyze);
  assert.strictEqual((result as Record<string, unknown>).market, 'MET');
});

// ─── localParse integration: liquidations ─────────────────────────────────

test('localParse("liquidations crude oil") → LiquidationMap CRUDEOIL', () => {
  const result = localParse('liquidations crude oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.LiquidationMap);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

test('localParse("liquidations sol") → LiquidationMap SOL', () => {
  const result = localParse('liquidations sol');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.LiquidationMap);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
});

// ─── localParse integration: funding ──────────────────────────────────────

test('localParse("funding crude oil") → FundingDashboard CRUDEOIL', () => {
  const result = localParse('funding crude oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.FundingDashboard);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

test('localParse("funding met") → FundingDashboard MET', () => {
  const result = localParse('funding met');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.FundingDashboard);
  assert.strictEqual((result as Record<string, unknown>).market, 'MET');
});

// ─── localParse integration: depth ────────────────────────────────────────

test('localParse("depth crude oil") → LiquidityDepth CRUDEOIL', () => {
  const result = localParse('depth crude oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.LiquidityDepth);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

test('localParse("depth sol") → LiquidityDepth SOL', () => {
  const result = localParse('depth sol');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.LiquidityDepth);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
});

// ─── localParse integration: add collateral with dollar word ──────────────

test('localParse("add $5 collateral on sol long") → AddCollateral SOL', () => {
  const result = localParse('add $5 collateral on sol long');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.AddCollateral);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
  assert.strictEqual((result as Record<string, unknown>).amount, 5);
});

test('localParse("add 5 dollar collateral on sol") → AddCollateral SOL (no side, auto-detect)', () => {
  const result = localParse('add 5 dollar collateral on sol');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.AddCollateral);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
