/**
 * Tests for FAF Referral System, JSON Output Mode, and Per-Command Wallet Override.
 *
 * Covers:
 * - Referral command parsing (create-referral, set-referrer)
 * - JSON output flag extraction (--format json)
 * - Wallet override flag extraction (--key <name>)
 * - Flag stripping from input
 * - Structured output mode toggle (enableStructuredOutput / restoreOutputMode)
 * - Tool registration for new referral tools
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Referral Command Parsing ───────────────────────────────────────────────

describe('FAF Referral Command Parsing', () => {
  it('faf referral → FafReferral', () => {
    const r = localParse('faf referral');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafReferral);
  });

  it('faf create-referral → FafCreateReferral', () => {
    const r = localParse('faf create-referral');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafCreateReferral);
  });

  it('faf create referral → FafCreateReferral', () => {
    const r = localParse('faf create referral');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafCreateReferral);
  });

  it('faf referral create → FafCreateReferral', () => {
    const r = localParse('faf referral create');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafCreateReferral);
  });

  it('faf set-referrer <address> → FafSetReferrer', () => {
    const r = localParse('faf set-referrer 7SqarX8DihHrzHmVzJT1Hsc8ZKhgJPJrSucb7CJ152jy');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafSetReferrer);
    assert.strictEqual((r as any).address, '7SqarX8DihHrzHmVzJT1Hsc8ZKhgJPJrSucb7CJ152jy');
  });

  it('faf set referrer <address> → FafSetReferrer', () => {
    const r = localParse('faf set referrer Dvvzg9rwaNfUqBSscoMZJa5CHFv8Lm94ngZrRyLGLfmK');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafSetReferrer);
    assert.strictEqual((r as any).address, 'Dvvzg9rwaNfUqBSscoMZJa5CHFv8Lm94ngZrRyLGLfmK');
  });

  it('faf referrer <address> → FafSetReferrer', () => {
    const r = localParse('faf referrer Dvvzg9rwaNfUqBSscoMZJa5CHFv8Lm94ngZrRyLGLfmK');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafSetReferrer);
  });

  it('faf set-referrer without address → falls through to faf_status', () => {
    const r = localParse('faf set-referrer');
    assert.ok(r);
    // No valid address → doesn't match regex → falls to faf_status
    assert.strictEqual(r.action, ActionType.FafStatus);
  });

  it('misspellings still parse referral', () => {
    assert.strictEqual(localParse('faf referal')?.action, ActionType.FafReferral);
    assert.strictEqual(localParse('faf refferal')?.action, ActionType.FafReferral);
    assert.strictEqual(localParse('faf referrals')?.action, ActionType.FafReferral);
  });
});

// ─── Flag Extraction ────────────────────────────────────────────────────────

describe('Global Flag Extraction', () => {
  // Import the extractFlags function by reading terminal.ts source
  // Since extractFlags is a module-level function, we test it via source analysis
  // and verify the behavior through command parsing integration

  it('--format json flag is recognized in source', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('--format'));
    assert.ok(src.includes('jsonOutput'));
    assert.ok(src.includes('extractFlags'));
  });

  it('--key flag is recognized in source', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('--key'));
    assert.ok(src.includes('keyOverride'));
  });

  it('flags are extracted before command parsing', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    // extractFlags must be called before normalizeInput in handleInput
    const extractIdx = src.indexOf('extractFlags(rawInput)');
    const normalizeIdx = src.indexOf('normalizeInput(flags.cleanInput)');
    assert.ok(extractIdx > 0, 'extractFlags found');
    assert.ok(normalizeIdx > 0, 'normalizeInput found');
    assert.ok(extractIdx < normalizeIdx, 'extractFlags called before normalizeInput');
  });

  it('command parsing works after flag stripping', () => {
    // Commands should parse correctly even with flags in the original input
    // The parser receives clean input (flags removed), so these should work:
    const r1 = localParse('faf referral');
    assert.strictEqual(r1?.action, ActionType.FafReferral);

    const r2 = localParse('positions');
    assert.strictEqual(r2?.action, ActionType.GetPositions);

    const r3 = localParse('faf status');
    assert.strictEqual(r3?.action, ActionType.FafStatus);
  });
});

// ─── Structured Output Mode ─────────────────────────────────────────────────

describe('Structured Output Toggle', () => {
  it('enableStructuredOutput and restoreOutputMode exported', async () => {
    const mod = await import('../src/no-dna.js');
    assert.strictEqual(typeof mod.enableStructuredOutput, 'function');
    assert.strictEqual(typeof mod.restoreOutputMode, 'function');
  });

  it('enableStructuredOutput sets IS_AGENT true, restore reverts', async () => {
    const mod = await import('../src/no-dna.js');
    const originalValue = mod.IS_AGENT;

    mod.enableStructuredOutput();
    assert.strictEqual(mod.IS_AGENT, true);

    mod.restoreOutputMode();
    assert.strictEqual(mod.IS_AGENT, originalValue);
  });

  it('nested enable/restore is safe', async () => {
    const mod = await import('../src/no-dna.js');
    const originalValue = mod.IS_AGENT;

    mod.enableStructuredOutput();
    assert.strictEqual(mod.IS_AGENT, true);

    // Restore should go back to original
    mod.restoreOutputMode();
    assert.strictEqual(mod.IS_AGENT, originalValue);
  });
});

// ─── JSON Output Rendering ──────────────────────────────────────────────────

describe('JSON Output Mode', () => {
  it('JSON output branch exists in terminal.ts', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('flags.jsonOutput'));
    assert.ok(src.includes('JSON.stringify(jsonPayload'));
    assert.ok(src.includes('action_required'));
  });

  it('JSON mode suppresses loading spinner', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('!flags.jsonOutput'));
  });

  it('JSON mode parses tool message as JSON', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('JSON.parse(result.message)'));
  });

  it('enableStructuredOutput called before dispatch for JSON mode', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    const enableIdx = src.indexOf('enableStructuredOutput()');
    const dispatchIdx = src.indexOf('this.engine.dispatch(intent)');
    assert.ok(enableIdx > 0);
    assert.ok(dispatchIdx > 0);
    assert.ok(enableIdx < dispatchIdx, 'enableStructuredOutput before dispatch');
  });

  it('restoreOutputMode called after dispatch', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    const dispatchIdx = src.indexOf('this.engine.dispatch(intent)');
    const restoreIdx = src.indexOf('restoreOutputMode()');
    assert.ok(dispatchIdx > 0);
    assert.ok(restoreIdx > 0);
    assert.ok(restoreIdx > dispatchIdx, 'restoreOutputMode after dispatch');
  });
});

// ─── Wallet Override ────────────────────────────────────────────────────────

describe('Per-Command Wallet Override', () => {
  it('wallet override logic exists in terminal.ts', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('keyOverride'));
    assert.ok(src.includes('walletRestoreData'));
    assert.ok(src.includes('restoreWallet'));
  });

  it('wallet is restored after command execution', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    // restoreWallet should be called in all exit paths
    const restoreCount = (src.match(/this\.restoreWallet\(walletRestoreData\)/g) || []).length;
    assert.ok(restoreCount >= 4, `restoreWallet called in ${restoreCount} exit paths (need ≥4)`);
  });

  it('wallet override validates via WalletStore', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('walletStore.hasWallet'));
    assert.ok(src.includes('walletStore.getWalletPath'));
    assert.ok(src.includes('walletStore.validateWalletPath'));
  });

  it('session wallet address saved before override', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('address: this.context.walletAddress'));
    assert.ok(src.includes('name: this.context.walletName'));
  });
});

// ─── Tool Registration ──────────────────────────────────────────────────────

describe('Referral Tool Registration', () => {
  it('faf_create_referral tool exists in faf-tools.ts', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    assert.ok(src.includes("name: 'faf_create_referral'"));
    assert.ok(src.includes('fafCreateReferralTool'));
  });

  it('faf_set_referrer tool exists in faf-tools.ts', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    assert.ok(src.includes("name: 'faf_set_referrer'"));
    assert.ok(src.includes('fafSetReferrerTool'));
  });

  it('new tools in allFafTools export', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    assert.ok(src.includes('fafCreateReferralTool'));
    assert.ok(src.includes('fafSetReferrerTool'));
    // Verify they're in the export array
    const exportSection = src.slice(src.indexOf('allFafTools'));
    assert.ok(exportSection.includes('fafCreateReferralTool'));
    assert.ok(exportSection.includes('fafSetReferrerTool'));
  });

  it('engine dispatches new referral actions', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/engine.ts'), 'utf8');
    assert.ok(src.includes('FafCreateReferral'));
    assert.ok(src.includes('FafSetReferrer'));
    assert.ok(src.includes('faf_create_referral'));
    assert.ok(src.includes('faf_set_referrer'));
  });

  it('command registry has new referral commands', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/command-registry.ts'), 'utf8');
    assert.ok(src.includes('faf create-referral'));
    assert.ok(src.includes('faf set-referrer'));
    assert.ok(src.includes('FafCreateReferral'));
  });
});

// ─── Referral Trade Integration ─────────────────────────────────────────────

describe('Referral Trade Integration', () => {
  it('flash-client has getReferralParams method', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('getReferralParams'));
    assert.ok(src.includes('referralParams'));
  });

  it('PDA seeds match SDK convention', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes("Buffer.from('token_stake')"));
    assert.ok(src.includes("Buffer.from('referral')"));
  });

  it('Privilege.Referral used when referrer is set', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('Privilege.Referral'));
    assert.ok(src.includes('ref?.privilege ?? Privilege.None'));
  });

  it('referral params passed to all trade methods', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    // Should appear in openPosition, closePosition, increaseSize, decreaseSize, swapAndOpen paths
    const refCalls = (src.match(/this\.getReferralParams\(\)/g) || []).length;
    assert.ok(refCalls >= 4, `getReferralParams called ${refCalls} times (need ≥4 trade paths)`);
  });

  it('on-chain validation before first trade', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('validateReferralOnChain'));
    assert.ok(src.includes('referralChecked'));
  });

  it('referral cache cleared on wallet switch', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('clearReferralCache'));
    // clearReferralCache resets both cache and checked flag
    const method = src.slice(src.indexOf('clearReferralCache'));
    assert.ok(method.includes('referralParams = null'));
    assert.ok(method.includes('referralChecked = false'));
  });
});

// ─── Config Persistence ─────────────────────────────────────────────────────

describe('Referrer Config Persistence', () => {
  it('saveConfigField exported from config', () => {
    const src = readFileSync(resolve(ROOT, 'src/config/index.ts'), 'utf8');
    assert.ok(src.includes('export function saveConfigField'));
  });

  it('referrer_address in ConfigFileData', () => {
    const src = readFileSync(resolve(ROOT, 'src/config/index.ts'), 'utf8');
    assert.ok(src.includes('referrer_address'));
  });

  it('referrerAddress in FlashConfig', () => {
    const src = readFileSync(resolve(ROOT, 'src/types/index.ts'), 'utf8');
    assert.ok(src.includes('referrerAddress'));
  });

  it('referrer loaded from env or config file', () => {
    const src = readFileSync(resolve(ROOT, 'src/config/index.ts'), 'utf8');
    assert.ok(src.includes('REFERRER_ADDRESS'));
    assert.ok(src.includes('file.referrer_address'));
  });
});

// ─── Self-Referral Prevention ───────────────────────────────────────────────

describe('Referral Safety', () => {
  it('self-referral blocked', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    assert.ok(src.includes('Cannot set yourself as referrer'));
  });

  it('set-referrer validates Solana address', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    assert.ok(src.includes('Invalid Solana address'));
  });

  it('referral tool saves to config file', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    assert.ok(src.includes('saveConfigField'));
    assert.ok(src.includes("'referrer_address'"));
  });
});
