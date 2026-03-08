![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D20-blue)
![TypeScript](https://img.shields.io/badge/typescript-strict-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Solana](https://img.shields.io/badge/solana-mainnet--beta-purple)
![Flash Trade](https://img.shields.io/badge/Flash%20Trade-protocol-orange)
![Open Source](https://img.shields.io/badge/open%20source-contributor%20friendly-brightgreen)

# Flash AI Terminal

**A professional CLI trading terminal for the [Flash Trade](https://www.flash.trade/) perpetual futures protocol on Solana.**

Inspect protocol state, monitor markets in real time, and execute on-chain trades — all from your terminal.

<p align="center">
  <img src="docs/demo.gif" alt="Flash AI Terminal Demo" width="720" />
  <br />
  <em><!-- Replace with actual recording: asciinema, VHS, or screen capture --></em>
</p>

```
  FLASH AI TERMINAL
  ────────────────────────────────

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
| **Command Autocomplete** | TAB completion for commands, markets, and pool names |
| **Plugin System** | Extend functionality with custom tools loaded at startup |

### Feature Comparison

| Feature | Flash AI Terminal | Manual RPC | Block Explorer |
|---------|:-:|:-:|:-:|
| Open/close positions from CLI | Y | - | - |
| Transaction preview (dry run) | Y | - | - |
| Real-time market monitor | Y | - | - |
| Protocol state inspection | Y | - | Y |
| Multi-strategy scanner | Y | - | - |
| Risk alerts with hysteresis | Y | - | - |
| RPC failover + health monitoring | Y | - | - |
| Paper trading mode | Y | - | - |
| Command autocomplete | Y | - | - |
| Signing audit log | Y | - | - |

---

## Quick Start

```bash
# Clone and build
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
npm install
npm run build

# Start in simulation mode (default)
npm start

# Or link globally
npm link
flash
```

The terminal starts in **simulation mode** by default. No wallet or RPC configuration required to explore.

```
flash [sim] > markets           # View all supported markets
flash [sim] > monitor           # Live market prices
flash [sim] > open 2x long SOL $100
flash [sim] > positions         # View open positions
flash [sim] > close SOL long
```

---

## Installation

Requires **Node.js >= 20.0.0**.

```bash
git clone https://github.com/Abdr007/flash-ai-terminal.git
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

## Command Reference

### Trading

| Command | Description |
|---------|-------------|
| `open <lev>x <long\|short> <asset> $<collateral>` | Open a leveraged position |
| `close <asset> <long\|short>` | Close a position |
| `add $<amount> to <asset> <long\|short>` | Add collateral to a position |
| `remove $<amount> from <asset> <long\|short>` | Remove collateral from a position |
| `dryrun <command>` | Preview a trade without signing |
| `positions` | View all open positions |
| `trade history` | View trade journal |

### Market Intelligence

| Command | Description |
|---------|-------------|
| `scan` | Multi-strategy opportunity scanner |
| `analyze <asset>` | Deep analysis of a specific market |
| `suggest trade` | AI-powered trade suggestion |
| `monitor` | Live-updating market table |
| `watch <command>` | Auto-refresh any read-only command |
| `whale activity` | Recent large trades |

### Portfolio & Risk

| Command | Description |
|---------|-------------|
| `portfolio` | Portfolio summary with exposure breakdown |
| `dashboard` | Full trading dashboard |
| `risk report` | Risk analysis across positions |
| `risk monitor on/off` | Real-time liquidation alerts |

### Market Data

| Command | Description |
|---------|-------------|
| `markets` | List all supported markets and pools |
| `volume` | Protocol trading volume |
| `open interest` | Open interest by market |
| `leaderboard` | Top traders |
| `fees` | Protocol fee data |

### Protocol Inspector

| Command | Description |
|---------|-------------|
| `inspect protocol` | Protocol overview — pools, OI, stats |
| `inspect pool <name>` | Pool deep-dive — markets, OI, whale activity |
| `inspect market <asset>` | Market deep-dive — status, OI, largest positions |

### Wallet

| Command | Description |
|---------|-------------|
| `wallet` | Wallet connection status |
| `wallet tokens` | Token balances |
| `wallet balance` | SOL balance |
| `wallet list` | Saved wallets |
| `wallet import` | Import a wallet from file |

### System

| Command | Description |
|---------|-------------|
| `system status` | Build, RPC, wallet, session info |
| `rpc status` | RPC endpoint health and latency |
| `rpc test` | Full RPC diagnostic with scoring |
| `tx inspect <sig>` | Inspect a transaction on-chain |
| `doctor` | Full system diagnostic |
| `help` | List all commands |
| `exit` | Clean shutdown |

---

## Usage Examples

### Trading

```
flash [sim] > open 5x long SOL $500

  CONFIRM TRANSACTION — Open Position
  -----------------------------------------

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
```

### Portfolio & Risk

```
flash [sim] > positions

  POSITIONS
  ──────────────────────────────────────────────────────────────

  Market  Side   Lev   Size      Collat    Entry     Mark      PnL        Fees
  ──────────────────────────────────────────────────────────────────────────────
  SOL     LONG   5x    $2,500    $500.00   $148.52   $151.20   +$9.02     $2.00
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

  Simulation Result
    Status:         SUCCESS
    CU Consumed:    123,456

  No transaction was signed or sent.
```

### System Diagnostics

```
flash [live] > system status

  SYSTEM STATUS
  ────────────────────────────

  Build
    Version: v1.0.0
    Commit:  a1b2c3d

  RPC
    Active:    Helius
    Latency:   124ms
    Backups:   2

  Wallet
    Status:  Connected
    Address: 7xKX...

  Session
    Mode:    Live Trading
    Uptime:  1h 23m
```

---

## Demo Walkthrough

A typical session demonstrating the core workflow:

1. **Launch** — Start the terminal, select simulation or live mode
2. **System check** — Run `system status` to verify RPC and wallet connectivity
3. **Explore markets** — Run `markets` to see all supported pools and assets
4. **Inspect protocol** — Run `inspect protocol` to view protocol-wide OI and stats
5. **Market deep-dive** — Run `inspect market SOL` to see OI breakdown and largest positions
6. **Preview a trade** — Run `dryrun open 2x long SOL $10` to simulate without signing
7. **Execute a trade** — Run `open 2x long SOL $10`, confirm with `yes`
8. **View positions** — Run `positions` to verify the position
9. **Monitor markets** — Run `monitor` for a live-updating price table
10. **Close and exit** — Run `close SOL long`, then `exit` for clean shutdown

---

## Architecture

```
                    +-----------------------+
                    |     User Input        |
                    +----------+------------+
                               |
                    +----------v------------+
                    |   AI Interpreter      |
                    |  regex + NLP + LLM    |
                    +----------+------------+
                               | ParsedIntent
                    +----------v------------+
                    |  Execution Engine     |
                    |  middleware + tools   |
                    +----------+------------+
                               |
              +----------------+----------------+
              |                |                |
     +--------v------+ +------v------+ +-------v-------+
     |   Scanner     | |  Portfolio  | |   Trading     |
     |  strategies   | |  exposure   | |   pipeline    |
     +--------+------+ +------+------+ +-------+-------+
              |                |                |
              +----------------+----------------+
                               |
                    +----------v------------+
                    |    FlashClient        |
                    |  tx build + sign      |
                    +----------+------------+
                               |
                    +----------v------------+
                    |     Solana RPC        |
                    |  failover + retry     |
                    +----------+------------+
                               |
                    +----------v------------+
                    |  Flash Trade Program  |
                    |  on-chain execution   |
                    +-----------------------+
```

The dual-client architecture (`FlashClient` for live, `SimulatedFlashClient` for paper trading) ensures all tools interact through the `IFlashClient` interface without knowing which mode is active.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

---

## Security Design

### Transaction Safety Pipeline

Every trade passes through a multi-stage validation pipeline before reaching the blockchain. No transaction can be signed without passing all stages.

```
  User Command
       |
       v
  Intent Parsing ---- regex + NLP + LLM
       |
       v
  Schema Validation ---- Zod parameter schemas
       |
       v
  Execution Middleware ---- wallet check, read-only guard
       |
       v
  Trade Limit Validation ---- max collateral, position size, leverage
       |
       v
  Rate Limit Check ---- trades per minute, minimum delay
       |
       v
  Confirmation Gate ---- full position summary displayed to user
       |
       v
  User Confirmation ---- explicit "yes" required
       |
       v
  Instruction Build ---- Flash SDK instruction generation
       |
       v
  Transaction Compile ---- MessageV0.compile with compute budget
       |
       v
  Pre-Send Simulation ---- Solana runtime simulation (sigVerify: false)
       |
       v
  Transaction Signing ---- keypair signs compiled transaction
       |
       v
  Broadcast ---- sendRawTransaction with retry
       |
       v
  Confirmation Polling ---- HTTP polling + periodic resends
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

## Observability

### Structured Logging

```
[2025-03-08T12:34:56.789Z] INFO [TRADE] Trade Request {"market":"SOL","side":"long","collateral":500,"leverage":5}
[2025-03-08T12:34:57.123Z] INFO [CLIENT] Tx sent: 5KtR...3xPq (892 bytes, attempt 1)
[2025-03-08T12:34:59.456Z] INFO [CLIENT] Tx confirmed: 5KtR...3xPq
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

---

## Wallet Security

### Storage

Wallet files are stored in `~/.flash/wallets/<wallet-name>.json` with owner-only permissions (`0600`). The `~/.flash/` directory is created with `0700` permissions.

### Key Handling

- Private keys are never written to log files or console output
- Key material is zeroed from memory after use
- Wallet import input is hidden (no terminal echo)
- File paths are validated within the home directory with symlink resolution

### Recommendations

- Start with simulation mode before committing real funds
- Keep wallet files private and never share them
- Back up wallet files securely in a separate location
- Consider using a hardware wallet for large balances
- Never trade with funds you cannot afford to lose

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

Core tools cannot be overridden by plugins. Duplicate tool names are rejected.

---

## Project Structure

```
src/
  cli/            Terminal REPL, autocomplete, status bar, theme
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

## Contributing

Contributions are welcome. Please read the guidelines before submitting.

### Getting Started

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run the build: `npm run build`
5. Run tests: `npm run test`
6. Commit with a clear message
7. Open a pull request

### Guidelines

- **Do not modify the trading pipeline** unless explicitly working on a trading bug
- All new tools must go through the `ToolEngine` registry
- Use the existing `theme` module for all CLI output styling
- Add `Number.isFinite()` guards on any new numeric computation
- Keep new RPC calls behind caching where possible
- Test in simulation mode before testing live

### Areas for Contribution

- New market analysis strategies
- Plugin development
- Documentation improvements
- CLI UX enhancements
- Test coverage
- Bug reports and fixes

See [CONTRIBUTING.md](CONTRIBUTING.md) for full details.

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
