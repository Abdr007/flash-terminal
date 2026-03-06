import { Connection, type Commitment } from '@solana/web3.js';

/** RPC timeout for all Solana calls (5 seconds). */
const RPC_TIMEOUT_MS = 5_000;

/**
 * Validate an RPC URL: must be well-formed HTTPS (or localhost for development).
 * Rejects: HTTP (non-local), malformed URLs, non-HTTP schemes, embedded credentials.
 */
function validateRpcUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RPC URL: ${url}`);
  }

  // Reject embedded credentials
  if (parsed.username || parsed.password) {
    throw new Error('RPC URL must not contain embedded credentials');
  }

  // Allow localhost/127.0.0.1 over HTTP for development
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol === 'http:' && !isLocalhost) {
    throw new Error(`RPC URL must use HTTPS (got HTTP). Refusing to send signed transactions over plaintext: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`RPC URL must use HTTPS protocol (got ${parsed.protocol}): ${url}`);
  }
}

export function createConnection(
  rpcUrl: string,
  config?: { commitment?: Commitment }
): Connection {
  validateRpcUrl(rpcUrl);
  return new Connection(rpcUrl, {
    commitment: config?.commitment ?? 'processed',
    confirmTransactionInitialTimeout: RPC_TIMEOUT_MS,
    fetch: (url, options) =>
      fetch(url, { ...options, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
  });
}
