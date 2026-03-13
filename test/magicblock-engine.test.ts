/**
 * MagicBlock Execution Engine tests.
 *
 * Verifies:
 * - Engine router creation and configuration
 * - RPC execution mode (default)
 * - MagicBlock execution mode
 * - Automatic fallback from MagicBlock → RPC on failure
 * - Transaction signature passthrough
 * - Engine switching behavior
 * - On-chain failure propagation (no fallback)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EngineRouter,
  type ExecutionEngine,
  type EngineRouterConfig,
} from '../src/execution/engine-router.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    trade: () => {},
  }),
}));

// ─── Router Creation ────────────────────────────────────────────────────────

describe('EngineRouter creation', () => {
  it('creates with rpc engine (default)', () => {
    const router = new EngineRouter({ engine: 'rpc' });
    expect(router.engine).toBe('rpc');
    expect(router.label).toBe('RPC');
    expect(router.magicblockEndpoint).toBeNull();
  });

  it('creates with magicblock engine', () => {
    const router = new EngineRouter({
      engine: 'magicblock',
      magicblockRpcUrl: 'https://rpc.magicblock.xyz',
    });
    expect(router.engine).toBe('magicblock');
    expect(router.label).toBe('MagicBlock');
    expect(router.magicblockEndpoint).toBe('https://rpc.magicblock.xyz');
  });

  it('throws when magicblock engine has no URL', () => {
    expect(() => new EngineRouter({ engine: 'magicblock' })).toThrow(
      'MAGICBLOCK_RPC_URL',
    );
  });
});

// ─── RPC Execution Mode ─────────────────────────────────────────────────────

describe('RPC execution mode', () => {
  it('delegates directly to rpcSend callback', async () => {
    const router = new EngineRouter({ engine: 'rpc' });

    const mockSend = vi.fn().mockResolvedValue('rpc-sig-abc123');

    const result = await router.executeTransaction(
      Buffer.from([1, 2, 3]),
      mockSend,
    );

    expect(result.signature).toBe('rpc-sig-abc123');
    expect(result.engine).toBe('rpc');
    expect(result.fallback).toBe(false);
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
  });

  it('passes through RPC errors', async () => {
    const router = new EngineRouter({ engine: 'rpc' });
    const mockSend = vi.fn().mockRejectedValue(new Error('RPC timeout'));

    await expect(
      router.executeTransaction(Buffer.from([1, 2, 3]), mockSend),
    ).rejects.toThrow('RPC timeout');
  });

  it('records latency', async () => {
    const router = new EngineRouter({ engine: 'rpc' });
    const mockSend = vi.fn().mockImplementation(
      () => new Promise(r => setTimeout(() => r('sig-latency'), 10)),
    );

    const result = await router.executeTransaction(
      Buffer.from([1, 2, 3]),
      mockSend,
    );

    expect(result.latencyMs).toBeGreaterThanOrEqual(10);
  });
});

// ─── MagicBlock Execution Mode ──────────────────────────────────────────────

describe('MagicBlock execution mode', () => {
  it('attempts MagicBlock first when engine=magicblock', async () => {
    const router = new EngineRouter({
      engine: 'magicblock',
      magicblockRpcUrl: 'https://rpc.magicblock.xyz',
    });

    // Mock the internal MagicBlock client's sendTransaction
    const mbClient = (router as any).magicblockClient;
    mbClient.sendTransaction = vi.fn().mockResolvedValue({
      signature: 'mb-sig-xyz789',
      latencyMs: 50,
      engine: 'magicblock',
    });

    const rpcSend = vi.fn().mockResolvedValue('rpc-fallback-sig');

    const result = await router.executeTransaction(
      Buffer.from([1, 2, 3]),
      rpcSend,
    );

    expect(result.signature).toBe('mb-sig-xyz789');
    expect(result.engine).toBe('magicblock');
    expect(result.fallback).toBe(false);
    // RPC should NOT have been called
    expect(rpcSend).not.toHaveBeenCalled();
  });
});

// ─── Fallback Behavior ──────────────────────────────────────────────────────

describe('MagicBlock → RPC fallback', () => {
  it('falls back to RPC when MagicBlock fails with network error', async () => {
    const router = new EngineRouter({
      engine: 'magicblock',
      magicblockRpcUrl: 'https://rpc.magicblock.xyz',
    });

    // Simulate MagicBlock failure
    const mbClient = (router as any).magicblockClient;
    mbClient.sendTransaction = vi.fn().mockRejectedValue(
      new Error('MagicBlock connection refused'),
    );

    const rpcSend = vi.fn().mockResolvedValue('rpc-fallback-sig');

    const result = await router.executeTransaction(
      Buffer.from([1, 2, 3]),
      rpcSend,
    );

    expect(result.signature).toBe('rpc-fallback-sig');
    expect(result.engine).toBe('rpc');
    expect(result.fallback).toBe(true);
    expect(rpcSend).toHaveBeenCalledOnce();
  });

  it('does NOT fallback on on-chain failure', async () => {
    const router = new EngineRouter({
      engine: 'magicblock',
      magicblockRpcUrl: 'https://rpc.magicblock.xyz',
    });

    const mbClient = (router as any).magicblockClient;
    mbClient.sendTransaction = vi.fn().mockRejectedValue(
      new Error('MagicBlock tx failed on-chain: {"InstructionError":[0,"Custom"]}'),
    );

    const rpcSend = vi.fn().mockResolvedValue('should-not-reach');

    await expect(
      router.executeTransaction(Buffer.from([1, 2, 3]), rpcSend),
    ).rejects.toThrow('failed on-chain');

    // RPC should NOT have been called — on-chain failures are terminal
    expect(rpcSend).not.toHaveBeenCalled();
  });

  it('does NOT fallback on MagicBlock timeout but propagates to RPC path', async () => {
    const router = new EngineRouter({
      engine: 'magicblock',
      magicblockRpcUrl: 'https://rpc.magicblock.xyz',
    });

    const mbClient = (router as any).magicblockClient;
    mbClient.sendTransaction = vi.fn().mockRejectedValue(
      new Error('MagicBlock tx not confirmed within 30s'),
    );

    const rpcSend = vi.fn().mockResolvedValue('rpc-fallback-sig');

    const result = await router.executeTransaction(
      Buffer.from([1, 2, 3]),
      rpcSend,
    );

    expect(result.signature).toBe('rpc-fallback-sig');
    expect(result.fallback).toBe(true);
  });
});

// ─── Transaction Signature Passthrough ──────────────────────────────────────

describe('signature passthrough', () => {
  it('returns exact signature from MagicBlock', async () => {
    const router = new EngineRouter({
      engine: 'magicblock',
      magicblockRpcUrl: 'https://rpc.magicblock.xyz',
    });

    const mbClient = (router as any).magicblockClient;
    const expectedSig = '5KtP9BAZS1MuWferSfTipvyVwZh2XKhVJvWzH2bZ4fDuKZ9W1czRLGhxFU9K6v';
    mbClient.sendTransaction = vi.fn().mockResolvedValue({
      signature: expectedSig,
      latencyMs: 120,
      engine: 'magicblock',
    });

    const result = await router.executeTransaction(
      Buffer.from([1, 2, 3]),
      vi.fn(),
    );

    expect(result.signature).toBe(expectedSig);
  });

  it('returns exact signature from RPC fallback', async () => {
    const router = new EngineRouter({ engine: 'rpc' });
    const expectedSig = '3nB7pFQ1oYxmFB1aK9EGREWzYX7C8DvwqJyBmHhd4bfs';

    const result = await router.executeTransaction(
      Buffer.from([1, 2, 3]),
      vi.fn().mockResolvedValue(expectedSig),
    );

    expect(result.signature).toBe(expectedSig);
  });
});

// ─── Engine Switching ───────────────────────────────────────────────────────

describe('engine switching', () => {
  it('different router instances can use different engines', () => {
    const rpcRouter = new EngineRouter({ engine: 'rpc' });
    const mbRouter = new EngineRouter({
      engine: 'magicblock',
      magicblockRpcUrl: 'https://rpc.magicblock.xyz',
    });

    expect(rpcRouter.engine).toBe('rpc');
    expect(mbRouter.engine).toBe('magicblock');
    expect(rpcRouter.label).toBe('RPC');
    expect(mbRouter.label).toBe('MagicBlock');
  });
});

// ─── Ping ───────────────────────────────────────────────────────────────────

describe('engine ping', () => {
  it('rpc engine always returns ok', async () => {
    const router = new EngineRouter({ engine: 'rpc' });
    const ping = await router.ping();
    expect(ping.engine).toBe('rpc');
    expect(ping.ok).toBe(true);
    expect(ping.latencyMs).toBe(0);
  });

  it('magicblock engine pings the MagicBlock endpoint', async () => {
    const router = new EngineRouter({
      engine: 'magicblock',
      magicblockRpcUrl: 'https://rpc.magicblock.xyz',
    });

    // Mock the internal client's ping
    const mbClient = (router as any).magicblockClient;
    mbClient.ping = vi.fn().mockResolvedValue({ ok: true, latencyMs: 45 });

    const ping = await router.ping();
    expect(ping.engine).toBe('magicblock');
    expect(ping.ok).toBe(true);
    expect(ping.latencyMs).toBe(45);
  });
});

// ─── MagicBlockClient Unit Tests ────────────────────────────────────────────

describe('MagicBlockClient', () => {
  it('exposes endpoint URL', async () => {
    const { MagicBlockClient } = await import('../src/execution/magicblock-client.js');
    const client = new MagicBlockClient('https://rpc.magicblock.xyz');
    expect(client.endpoint).toBe('https://rpc.magicblock.xyz');
  });
});

// ─── Config Integration ─────────────────────────────────────────────────────

describe('config integration', () => {
  it('loadConfig returns rpc as default engine', async () => {
    // Clear any env override
    const savedEngine = process.env.EXECUTION_ENGINE;
    delete process.env.EXECUTION_ENGINE;

    try {
      const { loadConfig } = await import('../src/config/index.js');
      const config = loadConfig();
      expect(config.executionEngine).toBe('rpc');
    } finally {
      if (savedEngine) process.env.EXECUTION_ENGINE = savedEngine;
    }
  });

  it('loadConfig respects EXECUTION_ENGINE=magicblock', async () => {
    const savedEngine = process.env.EXECUTION_ENGINE;
    process.env.EXECUTION_ENGINE = 'magicblock';

    try {
      const { loadConfig } = await import('../src/config/index.js');
      const config = loadConfig();
      expect(config.executionEngine).toBe('magicblock');
    } finally {
      if (savedEngine !== undefined) {
        process.env.EXECUTION_ENGINE = savedEngine;
      } else {
        delete process.env.EXECUTION_ENGINE;
      }
    }
  });

  it('loadConfig reads MAGICBLOCK_RPC_URL', async () => {
    const savedUrl = process.env.MAGICBLOCK_RPC_URL;
    process.env.MAGICBLOCK_RPC_URL = 'https://custom.magicblock.xyz';

    try {
      const { loadConfig } = await import('../src/config/index.js');
      const config = loadConfig();
      expect(config.magicblockRpcUrl).toBe('https://custom.magicblock.xyz');
    } finally {
      if (savedUrl !== undefined) {
        process.env.MAGICBLOCK_RPC_URL = savedUrl;
      } else {
        delete process.env.MAGICBLOCK_RPC_URL;
      }
    }
  });
});
