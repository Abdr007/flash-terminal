# Flash Terminal

A professional command-line trading terminal for the [Flash Trade](https://www.flash.trade/) perpetual futures protocol on Solana.

Flash Terminal provides deterministic trade execution, protocol inspection, market observability, and portfolio risk management — directly from the terminal using live on-chain data.

---

## Overview

```
flash
flash [sim] > open 5x long SOL $500
flash [sim] > positions
flash [sim] > liquidations SOL
flash [sim] > inspect protocol
flash [sim] > exit
```

Flash Terminal operates as a deterministic trading workstation. Trade commands are parsed with structured regex patterns — no ambiguity, no inference on critical paths. Natural language is supported only for read-only queries.

---

## Key Features

### Deterministic Trade Execution

Every trade command maps to exactly one action. The execution pipeline enforces confirmation, simulation, and signing guards before any transaction reaches the blockchain.

```
open 2x long SOL $10        # structured regex parse
close SOL long               # deterministic dispatch
add $200 to SOL long         # no AI on trade paths
```

### Trade Risk Preview

Full position summary displayed before signing: entry price, liquidation distance, risk classification, portfolio exposure impact, and estimated fees.

### Protocol Inspection

Query Flash Trade protocol state directly: pools, markets, open interest, utilization, whale positions.

```
inspect protocol             # protocol overview
inspect pool Crypto.1        # pool configuration
inspect market SOL           # market deep dive
```

### Market Observability

Live market data commands powered by on-chain state, Pyth oracles, and protocol analytics.

```
liquidations SOL             # liquidation clusters by price zone
funding SOL                  # funding rate with projected accumulation
depth SOL                    # liquidity depth around current price
protocol health              # protocol-wide health metrics
```

### RPC Failover Infrastructure

Automatic endpoint switching on failure, slot lag detection, background health monitoring, and connection pinning with 60-second cooldown.

### Simulation Mode

Paper trade with real oracle prices. Simulate transactions on-chain without signing. Validate strategies before risking capital.

```
dryrun open 5x long SOL $100
```

---

## Architecture

```
User Input
    |
    +-- FAST_DISPATCH (single-token commands — instant)
    +-- Regex Parser (structured commands — deterministic)
    +-- LLM Engine (natural language — read-only fallback)
            |
      ParsedIntent
            |
      ExecutionMiddleware (logging -> wallet -> readOnly guard)
            |
      ToolEngine.dispatch()
            |
            +-- flash-tools (trading, wallet, market data)
            +-- agent-tools (analysis, scanner, dashboard)
            +-- plugin tools (dynamically loaded)
            |
      IFlashClient
            +-- FlashClient (live: Flash SDK + Solana transactions)
            +-- SimulatedFlashClient (paper trading, in-memory)
```

All tools interact through the `IFlashClient` interface. They never know which mode is active.

---

## Commands

| Category | Commands |
|----------|----------|
| **Trading** | `open`, `close`, `add`, `remove`, `positions`, `markets`, `trade history` |
| **Market Data** | `scan`, `analyze`, `volume`, `open interest`, `leaderboard`, `whale activity`, `fees` |
| **Observability** | `liquidations`, `funding`, `depth`, `protocol health` |
| **Portfolio & Risk** | `portfolio`, `dashboard`, `risk report`, `exposure`, `rebalance` |
| **Protocol** | `inspect protocol`, `inspect pool`, `inspect market` |
| **Wallet** | `wallet`, `wallet tokens`, `wallet balance`, `wallet list`, `wallet import`, `wallet use`, `wallet connect`, `wallet disconnect` |
| **Utilities** | `dryrun`, `monitor`, `watch`, `system status`, `rpc status`, `rpc test`, `tx inspect`, `doctor`, `degen` |

Full reference: [COMMANDS.md](COMMANDS.md)

---

## Security

- **Signing confirmation gate** — full position summary before every trade
- **Configurable trade limits** — per-trade collateral, position size, leverage caps
- **Rate limiter** — trades per minute, minimum delay between trades
- **Signing audit log** — all trade attempts logged (never includes key material)
- **Wallet path validation** — restricted to home directory, symlink resolution, size limits
- **RPC URL validation** — HTTPS enforced, credential embedding rejected, SSRF protection
- **API key scrubbing** — sensitive patterns removed from all log output
- **Program ID whitelist** — only approved Solana programs can be targeted
- **Instruction freeze** — transaction instructions frozen after validation, before signing

See [SECURITY.md](SECURITY.md) for the full security model.

---

## Installation

```bash
git clone https://github.com/Abdr007/flash-terminal.git
cd flash-terminal
npm install
npm run build
```

### Configuration

```bash
cp .env.example .env
```

Required:
- `RPC_URL` — Solana mainnet RPC endpoint (HTTPS)

Optional:
- `ANTHROPIC_API_KEY` — enables natural language parsing
- `GROQ_API_KEY` — alternative LLM provider
- `SIMULATION_MODE` — defaults to `true`

### Run

```bash
flash                        # interactive terminal
flash markets                # list markets (non-interactive)
flash doctor                 # run diagnostics
```

---

## Requirements

- Node.js >= 20
- Solana RPC endpoint (mainnet)

---

## Data Sources

| Source | Data |
|--------|------|
| Flash SDK | Position state, pool config, instruction building |
| Pyth Network | Real-time oracle prices |
| Solana RPC | Transaction submission and confirmation |
| fstats API | Volume, open interest, leaderboards, whale activity |
| CoinGecko | Market prices with 24h change |

All data is live. No hardcoded prices, no synthetic signals. If a data source is unreachable, affected features degrade gracefully rather than producing incorrect results.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT — see [LICENSE](LICENSE).
