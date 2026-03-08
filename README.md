![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D20-blue)
![TypeScript](https://img.shields.io/badge/typescript-strict-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Solana](https://img.shields.io/badge/solana-mainnet--beta-purple)

# Flash AI Terminal

An AI-powered command-line trading terminal for the [Flash Trade](https://www.flash.trade/) perpetual futures protocol on Solana. Combines natural language command parsing, real-time market intelligence, risk monitoring, and on-chain execution in a single CLI tool.

```
  ⚡ FLASH AI TERMINAL ⚡
  ━━━━━━━━━━━━━━━━━━━━━━━━

  SIMULATION MODE

  Balance: $10,000.00
  Trades are simulated. No real transactions.

  Quick Start
    help           List all commands
    scan           Find trading opportunities
    monitor        Live market monitoring
    wallet tokens  View token balances
    markets        View available markets

flash [sim] > _
```

---

## Overview

Flash AI Terminal provides a complete trading workflow for Flash Trade perpetual futures:

- Parse commands via regex, contextual patterns, or LLM fallback
- Build, simulate, and broadcast Solana transactions
- Monitor positions with real-time liquidation distance alerts
- Inspect protocol state, pool utilization, and whale activity
- Paper trade with a full mark-to-market simulation engine

The terminal operates in two modes: **Simulation** (paper trading with virtual balance) and **Live** (on-chain execution with real funds). Mode is locked at startup and cannot change mid-session.

---

## Key Features

| Category | Capabilities |
|----------|-------------|
| **Trading** | Open, close, add/remove collateral on leveraged perpetual positions |
| **Natural Language** | Type commands in plain English; the AI interpreter handles parsing |
| **Transaction Preview** | Compile and simulate transactions without signing (`dryrun`) |
| **Market Scanner** | Multi-strategy opportunity detection (momentum, mean reversion, whale follow) |
| **Risk Monitoring** | Real-time liquidation distance alerts with hysteresis thresholds |
| **Market Monitor** | Live-updating price, OI, and long/short ratio table |
| **Protocol Inspector** | Query Flash Trade protocol state, pool utilization, market depth |
| **Trade Journal** | Full trade history with entry/exit prices, PnL, and fees |
| **Portfolio Analysis** | Exposure breakdown, allocation, and rebalance suggestions |
| **RPC Failover** | Automatic endpoint switching on failure, high latency, or slot lag |
| **Plugin System** | Extend functionality with custom tools loaded at startup |

---

## Security Design

### Transaction Safety Pipeline

Every trade passes through a multi-stage validation pipeline before reaching the blockchain. No transaction can be signed without passing all stages.

```
  User Command
       │
       ▼
  Intent Parsing ─── regex + NLP + LLM
       │
       ▼
  Schema Validation ─── Zod parameter schemas
       │
       ▼
  Execution Middleware ─── wallet check, read-only guard
       │
       ▼
  Trade Limit Validation ─── max collateral, position size, leverage
       │
       ▼
  Rate Limit Check ─── trades per minute, minimum delay
       │
       ▼
  Confirmation Gate ─── full position summary displayed to user
       │
       ▼
  User Confirmation ─── explicit "yes" required
       │
       ▼
  Instruction Build ─── Flash SDK instruction generation
       │
       ▼
  Transaction Compile ─── MessageV0.compile with compute budget
       │
       ▼
  Pre-Send Simulation ─── Solana runtime simulation (sigVerify: false)
       │
       ▼
  Transaction Signing ─── keypair signs compiled transaction
       │
       ▼
  Broadcast ─── sendRawTransaction with retry
       │
       ▼
  Confirmation Polling ─── HTTP polling + periodic resends
```

### Safety Mechanisms

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **Confirmation gate** | Full position summary before every trade | Prevents accidental execution |
| **Trade mutex** | Per-market/side lock on concurrent submissions | Prevents race conditions |
| **Signature cache** | 120-second TTL deduplication | Prevents duplicate transactions |
| **Rate limiter** | Configurable trades-per-minute and minimum delay | Prevents rapid-fire submissions |
| **Trade limits** | Configurable max collateral, position size, leverage | Prevents oversized trades |
| **Pre-send simulation** | Solana runtime simulation before broadcast | Catches program errors early |
| **Wallet isolation** | Home-directory restriction, symlink resolution, file size limit | Prevents path traversal |
| **Key protection** | Keys never logged, zeroed after use, import input hidden | Prevents key exposure |
| **HTTPS enforcement** | RPC URLs must use HTTPS (HTTP only for localhost) | Prevents cleartext traffic |
| **Dry run sandbox** | Transaction compiled and simulated, never signed | Prevents accidental sends |
| **Audit log** | Every trade attempt logged with outcome | Full signing audit trail |

---

## Operational Reliability

### RPC Failover

The RPC manager monitors all configured endpoints and automatically switches on:

- **Endpoint failure** — unhealthy response or unreachable
- **High latency** — response time exceeding 3-second threshold
- **Slot lag** — endpoint falls more than 50 slots behind network tip
- **High failure rate** — rolling 20-sample window exceeds 50% failures

Failover includes a 60-second cooldown to prevent oscillation. Background health monitoring runs every 30 seconds. Connection pinning ensures the same RPC is used for an entire transaction lifecycle (send + confirm).

### Retry Logic

All RPC calls use exponential backoff with jitter:

- Base delay: 500ms, capped at 5,000ms
- HTTP 429 detection: parses `Retry-After` header, defaults to 2,000ms
- Rate-limit patterns: `429`, `rate limit`, `too many requests`
- Transaction sends: 3 attempts with fresh blockhash per attempt, 45-second confirmation window each

### Graceful Shutdown

`SIGINT`, `SIGTERM`, and `exit` trigger an ordered cleanup:

1. Save command history
2. Stop autopilot (if active)
3. Stop risk monitor
4. Stop state reconciler
5. Shutdown plugins
6. Stop RPC health monitor
7. Flush shutdown log (synchronous write)

All background timers use `.unref()` so they don't prevent Node.js from exiting.

---

## Observability

### Structured Logging

The file logger records all operational events with consistent format:

```
[2025-03-08T12:34:56.789Z] INFO [TRADE] Trade Request {"market":"SOL","side":"long","collateral":500,"leverage":5}
[2025-03-08T12:34:57.123Z] INFO [CLIENT] Tx sent: 5KtR...3xPq (892 bytes, attempt 1)
[2025-03-08T12:34:59.456Z] INFO [CLIENT] Tx confirmed: 5KtR...3xPq
[2025-03-08T12:35:00.001Z] INFO [TRADE] OPEN {"market":"SOL","side":"long","collateral":500,"leverage":5,"price":148.52,"tx":"5KtR...3xPq"}
```

Features:
- Log rotation at 10MB with `.old` backup
- API key scrubbing (`sk-ant-***`, `gsk_***`, `api_key=***`)
- Structured data fields for machine parsing
- Synchronous flush on shutdown

### Signing Audit Log

Every trade attempt is recorded in `~/.flash/signing-audit.log`:

```json
{"timestamp":"2025-03-08T12:34:56.789Z","type":"open","market":"SOL","side":"long","collateral":500,"leverage":5,"sizeUsd":2500,"walletAddress":"7xKX...","result":"confirmed"}
```

Outcomes tracked: `confirmed`, `rejected`, `failed`, `rate_limited`. Private keys are never logged.

### System Diagnostics

Built-in commands for operational visibility:

| Command | Purpose |
|---------|---------|
| `system status` | Build version, RPC health, wallet state, positions, memory, uptime |
| `rpc status` | Active endpoint, latency, failure rate, slot lag, all endpoints |
| `rpc test` | Full diagnostic of all RPC endpoints with scoring and recommendation |
| `tx inspect <sig>` | Transaction status, fee, compute units, program logs |

---

## CLI Discoverability

The terminal guides new users without requiring documentation:

### Startup Hints

Quick Start commands are displayed after the banner on every session start.

### Unknown Command Suggestions

When an unrecognized command is entered, the terminal suggests relevant commands instead of showing a generic error.

### Command Usage Hints

Typing a command name without required parameters shows usage and examples:

```
flash [sim] > open

  Usage
    open <leverage>x <long|short> <asset> $<collateral>

  Examples
    open 5x long SOL $500
    open 3x short ETH $200
    open 10x long BTC $1000
```

### Organized Help

The `help` command groups all commands into clear sections: Trading, Market Intelligence, Portfolio & Risk, Market Data, Wallet, Protocol Inspector, and System.

---

## Installation

Requires **Node.js >= 20.0.0**.

```bash
git clone https://github.com/user/flash-ai-terminal.git
cd flash-ai-terminal
npm install
npm run build
```

---

## Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Key configuration:

| Variable | Purpose | Default |
|----------|---------|---------|
| `RPC_URL` | Primary Solana RPC endpoint | Public RPC |
| `BACKUP_RPC_1`, `BACKUP_RPC_2` | Failover RPC endpoints | None |
| `SIMULATION_MODE` | Paper trading mode | `true` |
| `ANTHROPIC_API_KEY` | LLM-powered command parsing (optional) | None |
| `MAX_COLLATERAL_PER_TRADE` | Per-trade collateral limit (USD) | Unlimited |
| `MAX_LEVERAGE` | Maximum leverage multiplier | Market default |
| `COMPUTE_UNIT_PRICE` | Priority fee in microLamports | `500000` |

See [.env.example](.env.example) for all options. The terminal works without any configuration using the public Solana RPC, but a premium provider is recommended for live trading.

---

## Usage

### Start the Terminal

```bash
npm start
```

Or link globally:

```bash
npm link
flash
```

### Trading

```
flash [sim] > open 5x long SOL $500

  CONFIRM TRANSACTION — Open Position
  ─────────────────────────────────

  Market:     SOL LONG
  Collateral: $500.00 USDC
  Leverage:   5x
  Size:       $2,500.00
  Pool:       Crypto.1

  Execute trade? (yes/no)

flash [sim] > close SOL long
flash [sim] > add $200 to SOL long
flash [sim] > remove $100 from ETH long
```

### Market Intelligence

```
flash [sim] > scan

  Market Opportunities
  ──────────────────────────────────────────

  #   Market   Signal    Confidence   Regime
  ──────────────────────────────────────────
  1   SOL      LONG      72%          TRENDING
  2   ETH      SHORT     65%          RANGING
  3   JUP      LONG      58%          TRENDING

flash [sim] > monitor

  MARKET MONITOR
  12:34:56 PM  |  Refreshing every 5s  |  Press any key to exit
  ──────────────────────────────────────────────────────────────

  Asset         Price    24h Change   Open Interest   Long / Short
  ──────────────────────────────────────────────────────────────────
  SOL         $148.52       +3.20%          $2.14M        62 / 38
  BTC      $63,200.00       -0.40%        $438.00K        48 / 52

flash [sim] > analyze SOL
flash [sim] > whale activity
```

### Portfolio & Risk

```
flash [sim] > positions

  Open Positions
  ──────────────────────────────────────────────────────────────

  Market  Side   Lev   Size      Collat    Entry     Mark      PnL        Fees
  ──────────────────────────────────────────────────────────────────────────────
  SOL     LONG   5x    $2,500    $500.00   $148.52   $151.20   +$9.02     $2.00

flash [sim] > portfolio
flash [sim] > dashboard
flash [sim] > risk report
flash [sim] > risk monitor on
```

### Wallet

```
flash [live] > wallet tokens
flash [live] > wallet balance
flash [live] > wallet list
flash [live] > wallet import
```

### System Diagnostics

```
flash [live] > system status

  SYSTEM STATUS
  ────────────────────────────

  Build
    Version: v1.0.0
    Commit:  a1b2c3d
    Branch:  main

  RPC
    Active:    Helius
    Latency:   124ms
    Failovers: 0
    Backups:   2

  Wallet
    Status:  Connected
    Address: 7xKX...
    Mode:    Full Access

  Session
    Mode:    Live Trading
    Uptime:  1h 23m

flash [live] > rpc status
flash [live] > rpc test
flash [live] > tx inspect <signature>
```

### Transaction Preview

```
flash [live] > dryrun open 2x long SOL $10

  TRANSACTION PREVIEW (DRY RUN)
  ──────────────────────────────────

  Trade Parameters
    Market:         SOL
    Side:           LONG
    Collateral:     $10.00
    Leverage:       2x
    Position Size:  $20.00
    Entry Price:    $148.52
    Liq. Price:     $81.69

  Solana Transaction
    Program:        FLASH6Lo6h3...
    Instructions:   4
    Tx Size:        892 bytes

  Simulation Result
    Status:         SUCCESS
    CU Consumed:    123,456

  No transaction was signed or sent.
```

---

## Architecture

```
                    ┌─────────────────────┐
                    │     User Input       │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   AI Interpreter     │
                    │  regex + NLP + LLM   │
                    └──────────┬──────────┘
                               │ ParsedIntent
                    ┌──────────▼──────────┐
                    │  Execution Engine    │
                    │  middleware + tools  │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐ ┌──────▼──────┐ ┌───────▼───────┐
     │   Scanner     │ │  Portfolio  │ │   Trading     │
     │  strategies   │ │  exposure   │ │   pipeline    │
     └────────┬──────┘ └──────┬──────┘ └───────┬───────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │    FlashClient      │
                    │  tx build + sign    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │     Solana RPC      │
                    │  failover + retry   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Flash Trade Program │
                    │  on-chain execution  │
                    └─────────────────────┘
```

The dual-client architecture (`FlashClient` for live, `SimulatedFlashClient` for paper trading) ensures all tools interact through the `IFlashClient` interface without knowing which mode is active.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

---

## Supported Markets

| Pool | Markets |
|------|---------|
| Crypto.1 | SOL, BTC, ETH, ZEC, BNB |
| Virtual.1 | XAG, XAU, CRUDEOIL, EUR, GBP, USDJPY, USDCNH |
| Governance.1 | JTO, JUP, PYTH, RAY, HYPE, MET, KMNO |
| Community.1 | PUMP, BONK, PENGU |
| Community.2 | WIF |
| Trump.1 | FARTCOIN |
| Ore.1 | ORE |

7 pools. 24 markets. All sourced from the Flash Trade SDK.

---

## Wallet Security

### Storage

Wallet files are stored in `~/.flash/wallets/<wallet-name>.json` with owner-only permissions (`0600`). The `~/.flash/` directory is created with `0700` permissions.

### Recommendations

- Keep wallet files private and never share them
- Back up wallet files securely in a separate location
- Loss of a wallet file means permanent loss of funds
- Never share your wallet file or private key with anyone
- Consider using a hardware wallet for large balances
- Start with simulation mode before committing real funds

### Key Handling

- Private keys are never written to log files or console output
- Key material is zeroed from memory after use
- Wallet import input is hidden (no terminal echo)
- File paths are validated within the home directory with symlink resolution

See [SECURITY.md](SECURITY.md) for the full security policy.

---

## Plugins

The terminal supports a plugin system for extending functionality. Plugins are `.ts` or `.js` files placed in `src/plugins/` that export a `FlashPlugin` object.

```typescript
export const plugin: FlashPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  tools: () => [/* tool definitions */],
  onInit: async (ctx) => { /* startup logic */ },
  onShutdown: async () => { /* cleanup logic */ },
};
```

Core tools cannot be overridden by plugins. Duplicate tool names are rejected. Use `--no-plugins` to disable plugin loading.

Only install plugins from trusted sources. Plugins run with full system access.

---

## Project Structure

```
src/
  cli/            Terminal REPL, user interaction, confirmation flow
  ai/             Intent parsing (regex + NLP + LLM fallback)
  tools/          Tool definitions, registry, and dispatch engine
  client/         Flash Trade SDK client and paper trading client
  agent/          AI-powered analysis, scanner, dashboard
  strategies/     Momentum, mean reversion, whale follow
  scanner/        Multi-market opportunity scanner
  portfolio/      Allocation, exposure, rebalance
  risk/           Liquidation risk, exposure computation
  monitor/        Real-time risk monitoring engine
  regime/         Market regime detection
  protocol/       Flash Trade protocol inspector
  core/           Execution middleware, state reconciliation
  network/        RPC endpoint management with failover
  system/         System diagnostics, health checks, tx inspection
  security/       Signing guard, rate limiter, audit logging
  plugins/        Plugin loader and user plugins
  wallet/         Keypair management, wallet store
  automation/     Autopilot loop (simulation only)
  data/           CoinGecko, fstats.io API clients
  config/         Environment config, pool/market mapping
  types/          All types, enums, interfaces, Zod schemas
  utils/          Logger, retry, formatting, safe math
```

---

## Development

```bash
# Development mode (tsx, no compile step)
npm run dev

# Build
npm run build

# Type check
npx tsc --noEmit

# Run tests
npm run test
```

---

## Documentation

| File | Description |
|------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture and design decisions |
| [SECURITY.md](SECURITY.md) | Security policy, vulnerability reporting, key management |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, coding guidelines, PR process |
| [LICENSE](LICENSE) | MIT License |
| [.env.example](.env.example) | Environment configuration template |

---

## Disclaimer

Flash AI Terminal is infrastructure software for interacting with decentralized finance protocols. It does not provide financial advice. All strategy signals, confidence scores, and trade suggestions are algorithmic computations, not recommendations.

**Trading perpetual futures involves substantial risk of loss.** Leveraged positions can be liquidated rapidly. You can lose your entire collateral. Past performance of any strategy signal does not indicate future results.

- Start with simulation mode to understand the system before trading live
- Use small positions when transitioning to live trading
- Never trade with funds you cannot afford to lose
- Verify all transactions on [Solscan](https://solscan.io)

By using this software, you accept full responsibility for your trading decisions and outcomes.

---

## License

[MIT](LICENSE)
