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

## Introduction

Flash AI Terminal provides a complete trading workflow for [Flash Trade](https://www.flash.trade/) perpetual futures on Solana. It connects directly to the Flash Trade program on mainnet using the Flash SDK and real blockchain data.

The terminal operates in two modes:

- **Simulation** — Paper trading with a virtual balance. No transactions are signed or broadcast.
- **Live** — On-chain execution with real funds. Every trade requires explicit confirmation.

Mode is locked at startup and cannot change mid-session.

### Why This Tool Exists

Trading on DeFi protocols typically requires a browser, a wallet extension, and a web UI. Flash AI Terminal removes that dependency. It gives developers and traders direct command-line access to Flash Trade — the same way professional trading desks operate through terminal interfaces.

It is built for people who prefer working in the terminal, want programmatic access to protocol state, or need a lightweight tool that runs anywhere Node.js runs.

---

## Built With

| Technology | Purpose |
|------------|---------|
| [TypeScript](https://www.typescriptlang.org/) | Language (strict mode, ESM) |
| [Flash Trade SDK](https://www.flash.trade/) | Protocol interaction, instruction building |
| [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/) | Transaction compilation, RPC communication |
| [Pyth Network](https://pyth.network/) | Oracle price feeds |
| [Zod](https://zod.dev/) | Runtime schema validation |
| [Chalk](https://github.com/chalk/chalk) | Terminal styling |
| Node.js readline | Interactive REPL, autocomplete |

---

## Features

| Category | Capabilities |
|----------|-------------|
| **Trading** | Open, close, add/remove collateral on leveraged perpetual positions |
| **Transaction Preview** | Compile and simulate transactions without signing (`dryrun`) |
| **Market Scanner** | Multi-strategy opportunity detection (momentum, mean reversion, whale follow) |
| **Risk Monitoring** | Real-time liquidation distance alerts with hysteresis thresholds |
| **Market Monitor** | Live-updating price, OI, and long/short ratio table |
| **Watch Mode** | Auto-refresh any read-only command on a timer |
| **Protocol Inspector** | Query protocol state, pool utilization, market depth, whale positions |
| **Trade Journal** | Full trade history with entry/exit prices, PnL, and fees |
| **Portfolio Analysis** | Exposure breakdown, allocation, and rebalance suggestions |
| **RPC Failover** | Automatic endpoint switching on failure, high latency, or slot lag |
| **Command Autocomplete** | TAB completion for commands, markets, and pool names |
| **Typo Correction** | "Did you mean?" suggestions for mistyped commands |
| **Diagnostics** | Built-in `doctor`, `system status`, `rpc test` commands |
| **Plugin System** | Extend functionality with custom tools loaded at startup |

### Feature Comparison

| Capability | Flash AI Terminal | Manual RPC | Block Explorer |
|------------|:-:|:-:|:-:|
| Open/close positions from CLI | Y | - | - |
| Transaction preview without signing | Y | - | - |
| Real-time market monitor | Y | - | - |
| Protocol state inspection | Y | - | Y |
| Multi-strategy scanner | Y | - | - |
| Risk alerts with hysteresis | Y | - | - |
| RPC failover + health monitoring | Y | - | - |
| Paper trading simulation | Y | - | - |
| Command autocomplete | Y | - | - |
| Signing audit log | Y | - | - |

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

## Installation

Requires **Node.js >= 20.0.0**.

```bash
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
npm install
npm run build
```

---

## Quick Start

```bash
# Start in simulation mode (default — no wallet required)
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

### Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

| Variable | Purpose | Default |
|----------|---------|---------|
| `RPC_URL` | Primary Solana RPC endpoint | Public RPC |
| `BACKUP_RPC_1`, `BACKUP_RPC_2` | Failover RPC endpoints | None |
| `SIMULATION_MODE` | Paper trading mode | `true` |
| `ANTHROPIC_API_KEY` | LLM-powered command parsing (optional) | None |
| `MAX_COLLATERAL_PER_TRADE` | Per-trade collateral limit (USD) | Unlimited |
| `MAX_LEVERAGE` | Maximum leverage multiplier | Market default |
| `COMPUTE_UNIT_PRICE` | Priority fee in microLamports | `500000` |

See [.env.example](.env.example) for all options.

---

## Terminal Walkthrough

A complete session demonstrating the core workflow:

```
$ flash
```

Select **Simulation** mode at the prompt. The terminal displays a welcome screen with quick start hints.

```
flash [sim] > system status
```

Verify the system is healthy. Shows RPC provider, latency, wallet state, and session uptime.

```
flash [sim] > markets
```

List all 24 supported markets across 7 pools (Crypto, Virtual, Governance, Community, and more).

```
flash [sim] > inspect protocol
```

View protocol-wide statistics: total open interest, 30-day volume, trade count, fees collected, and the aggregate long/short ratio.

```
flash [sim] > inspect market SOL
```

Deep-dive into a specific market. Shows trading hours, open interest breakdown by side, and the largest open positions.

```
flash [sim] > dryrun open 2x long SOL $10
```

Preview a trade without signing. The terminal compiles the full Solana transaction, simulates it on-chain, and displays entry price, liquidation price, and estimated fees. No transaction is broadcast.

```
flash [sim] > open 2x long SOL $10
```

Execute the trade. A confirmation summary is displayed showing market, leverage, collateral, position size, fees, and wallet address. Type `yes` to confirm. In simulation mode, the position is tracked with mark-to-market PnL.

```
flash [sim] > positions
```

View all open positions in a table: market, side, leverage, size, collateral, entry price, mark price, unrealized PnL, fees, and liquidation price.

```
flash [sim] > close SOL long
```

Close the position. Confirmation required. Realized PnL is recorded in the trade journal.

```
flash [sim] > watch volume
```

Auto-refresh the volume command every 5 seconds. The screen redraws in place. Press `q` to exit.

```
flash [sim] > exit
```

Clean shutdown. All subsystems stop in order: status bar, risk monitor, reconciler, plugins, RPC manager. Terminal returns to the shell.

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

## Safety Features

### Transaction Safety Pipeline

Every trade passes through a multi-stage validation pipeline before reaching the blockchain:

```
User Command
     |
     v
Intent Parsing ---------- regex + NLP + LLM
     |
     v
Schema Validation -------- Zod parameter schemas
     |
     v
Execution Middleware ----- wallet check, read-only guard
     |
     v
Trade Limit Validation --- max collateral, position size, leverage
     |
     v
Rate Limit Check --------- trades per minute, minimum delay
     |
     v
Confirmation Gate -------- full summary displayed to user
     |
     v
User Confirmation -------- explicit "yes" required
     |
     v
Instruction Build -------- Flash SDK instruction generation
     |
     v
Transaction Compile ------ MessageV0.compile with compute budget
     |
     v
Pre-Send Simulation ------ Solana runtime simulation
     |
     v
Transaction Signing ------ keypair signs compiled transaction
     |
     v
Broadcast ---------------- sendRawTransaction with retry
     |
     v
Confirmation Polling ----- HTTP polling + periodic resends
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
| **Wallet isolation** | Home-directory restriction, symlink resolution | Prevents path traversal |
| **Key protection** | Keys never logged, zeroed after use, import input hidden | Prevents key exposure |
| **HTTPS enforcement** | RPC URLs must use HTTPS (HTTP only for localhost) | Prevents cleartext traffic |
| **Dry run sandbox** | Transaction compiled and simulated, never signed | Prevents accidental sends |
| **Audit log** | Every trade attempt logged with outcome | Full signing audit trail |

### RPC Failover

The RPC manager monitors all configured endpoints and automatically switches on:

- **Endpoint failure** — unhealthy response or unreachable
- **High latency** — response time exceeding 3-second threshold
- **Slot lag** — endpoint falls more than 50 slots behind network tip
- **High failure rate** — rolling 20-sample window exceeds 50% failures

Failover includes a 60-second cooldown to prevent oscillation. Connection pinning ensures the same RPC is used for an entire transaction lifecycle.

### Wallet Security

- Wallet files stored with owner-only permissions (`0600`)
- Private keys never written to log files or console output
- Key material zeroed from memory after use
- Wallet import input hidden (no terminal echo)
- File paths validated within home directory with symlink resolution

See [SECURITY.md](SECURITY.md) for the full security policy.

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

Contributions are welcome.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run the build: `npm run build`
5. Run tests: `npm run test`
6. Commit with a clear message
7. Open a pull request

### Guidelines

- Do not modify the trading pipeline unless explicitly working on a trading bug
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
