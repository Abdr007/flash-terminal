# Security Policy

Flash AI Terminal interacts with the Solana blockchain and manages cryptographic keys. Security is a core design priority.

---

## Wallet Security

### Key Storage

- Wallet files are stored in `~/.flash/wallets/` with `0600` permissions (owner-only read/write)
- The `~/.flash/` directory is created with `0700` permissions
- Wallet names are sanitized to alphanumeric characters, hyphens, and underscores only (max 64 characters) to prevent path traversal attacks

### Key Handling

- Private keys are **never** printed to the terminal
- Private keys are **never** written to log files
- Private key bytes are zeroed from memory immediately after use
- During interactive wallet import, key input is hidden (no echo)
- Secret key arrays are validated as exactly 64 bytes, each 0-255

### Path Security

- Wallet file paths are restricted to the user's home directory
- Symlinks are resolved and verified to prevent traversal outside the home directory
- File paths are resolved to absolute paths before any file operations

---

## API Key Safety

### Log Scrubbing

The logger automatically scrubs sensitive patterns from all log output:

- `api_key=...` → `api_key=***`
- `sk-ant-...` (AI provider keys) → `sk-ant-***`
- `gsk_...` (Groq keys) → `gsk_***`

### Environment Variables

- API keys should only be set in `.env` files, never in shell history or command arguments
- The `.env` file is listed in `.gitignore` and must never be committed
- `.env.example` contains placeholder values with no real credentials

---

## Environment Configuration

### RPC Provider

The default `https://api.mainnet-beta.solana.com` is rate-limited and not suitable for production trading. For live trading, use a premium RPC provider:

- [Helius](https://helius.dev)
- [Triton](https://triton.one)
- [QuickNode](https://quicknode.com)

### RPC Connection Security

- The connection factory validates that RPC URLs use HTTPS
- WebSocket endpoints are derived from the HTTP URL (no separate configuration required)
- Connection timeouts prevent hanging on unresponsive endpoints

### Simulation Mode

- `SIMULATION_MODE` defaults to `true` — the system starts in paper trading mode
- Autopilot is only available in simulation mode
- Live mode requires explicit opt-in (`SIMULATION_MODE=false`)

---

## Risk Warnings

### Live Trading

- **Real money is at risk.** Live trading executes real on-chain transactions with your funds
- Start with small positions to verify the system works correctly with your setup
- High leverage (20x+) can result in rapid liquidation — the terminal warns about this
- Transaction fees (SOL) and trading fees (Flash Trade protocol fees) apply to every trade
- Network congestion can cause transaction delays or failures

### No Financial Advice

Flash AI Terminal is a tool for interacting with DeFi protocols. It does not provide financial advice. All strategy signals, confidence scores, and trade suggestions are algorithmic computations, not recommendations.

### Data Integrity

- The system uses only live market data — no hardcoded prices or synthetic signals
- Markets without reliable price data are excluded from analysis
- If CoinGecko or fstats.io is unreachable, affected data degrades gracefully rather than producing incorrect results

---

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Email the maintainers with a description of the issue
3. Include steps to reproduce if possible
4. Allow reasonable time for a fix before public disclosure

---

## Dependencies

Key dependencies with security implications:

| Package | Purpose | Trust Level |
|---------|---------|-------------|
| `@solana/web3.js` | Solana RPC and transaction signing | Solana Foundation |
| `flash-sdk` | Flash Trade protocol interaction | Flash Trade team |
| `@pythnetwork/client` | Oracle price feeds | Pyth Network |
| AI SDK (optional) | LLM-powered command parsing | AI provider |
| `zod` | Input validation schemas | Community standard |
