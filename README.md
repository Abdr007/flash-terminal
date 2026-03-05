<div align="center">

# Flash

**AI trading terminal for Flash Trade**

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Solana](https://img.shields.io/badge/Solana-mainnet-purple?logo=solana&logoColor=white)](https://solana.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Trade perpetuals on [Flash Trade](https://www.flash.trade/) using natural language from your terminal.

```
flash > open a 5x long position on SOL with 0.1 SOL
flash > show my portfolio
flash > close my BTC trade
```

</div>

---

## Overview

Flash is a command-line trading terminal that connects to the [Flash Trade](https://www.flash.trade/) perpetuals protocol on Solana. Instead of navigating complex trading dashboards, you type plain English commands into a terminal and Flash handles the rest.

The system parses natural language input, maps it to structured trading intents, and executes them through the Flash Trade protocol — or locally in simulation mode for safe testing.

### Core Design

- **Natural language in, trades out.** No memorizing CLI flags or JSON schemas.
- **Simulation by default.** Paper trade with live market prices before risking capital.
- **Strict type safety.** Zero `any` types across the entire codebase.
- **Modular tool architecture.** Every trading action is an isolated, testable tool.

---

## Features

| Feature | Description |
|---|---|
| **Natural Language Trading** | Execute trades, manage positions, and query markets using plain English |
| **AI Command Interpreter** | Local regex parser for common commands, Claude API fallback for complex inputs |
| **Tool Execution Engine** | Intent-to-tool routing following the agent tool-use pattern |
| **Flash Protocol Integration** | Direct execution through `flash-sdk` on Solana mainnet |
| **Simulation Mode** | Full paper trading engine with live price feeds from fstats.io |
| **Market Intelligence** | Volume, open interest, leaderboards, and fee analytics |
| **Professional CLI** | Formatted tables, colored output, spinners, and trade confirmation prompts |
| **Pyth Oracle Prices** | Real-time price feeds with staleness detection |
| **Trade Safety** | Leverage limits per market, liquidation warnings, balance validation |

---

## Architecture

```
                ┌───────────────────┐
                │       User        │
                │   (English text)  │
                └─────────┬─────────┘
                          │
                          ▼
                ┌───────────────────┐
                │    Flash CLI      │
                │    Terminal       │
                └─────────┬─────────┘
                          │
                          ▼
                ┌───────────────────┐
                │  AI Interpreter   │──── Local regex parser (fast path)
                │                   │──── Claude API (complex inputs)
                └─────────┬─────────┘
                          │
                          ▼
                ┌───────────────────┐
                │   Tool Engine     │
                │   (intent → tool) │
                └─────────┬─────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Trading  │ │  Query   │ │Analytics │
        │  Tools   │ │  Tools   │ │  Tools   │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │            │            │
             ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Flash   │ │  Flash   │ │ fstats   │
        │  Client  │ │  Client  │ │   API    │
        └────┬─────┘ └────┬─────┘ └──────────┘
             │            │
             ▼            ▼
        ┌─────────────────────────┐
        │   Flash Trade Protocol  │
        │        (Solana)         │
        └─────────────────────────┘
```

### Data Sources

| Source | Purpose |
|---|---|
| **Flash Trade Protocol** | Position management, trade execution |
| **Pyth Network** | Real-time oracle price feeds |
| **fstats.io API** | Volume, open interest, leaderboards, fees |
| **Solana RPC** | Transaction submission and account reads |

---

## Repository Structure

```
flash/
├── src/
│   ├── index.ts              ← entrypoint and CLI commands
│   ├── ai/
│   │   └── interpreter.ts    ← NL parser (regex + Claude API)
│   ├── cli/
│   │   └── terminal.ts       ← interactive terminal loop
│   ├── client/
│   │   ├── flash-client.ts   ← Flash Trade SDK wrapper
│   │   └── simulation.ts     ← paper trading engine
│   ├── config/
│   │   └── index.ts          ← pools, markets, env config
│   ├── data/
│   │   ├── fstats.ts         ← fstats.io REST client
│   │   └── prices.ts         ← Pyth oracle price service
│   ├── tools/
│   │   ├── registry.ts       ← tool registration system
│   │   ├── engine.ts         ← intent → tool router
│   │   └── flash-tools.ts    ← all trading tool implementations
│   ├── types/
│   │   └── index.ts          ← interfaces, enums, Zod schemas
│   └── utils/
│       ├── format.ts         ← table formatting and colors
│       ├── logger.ts         ← structured logging
│       └── retry.ts          ← retry with exponential backoff
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## Tool System

Flash uses a tool-based execution model. The AI interpreter converts user input into a `ParsedIntent`, and the tool engine routes it to the appropriate tool.

### Trading Tools

| Tool | Action | Example Command |
|---|---|---|
| `flash_open_position` | Open a leveraged position | *"open a 5x long on SOL with $500"* |
| `flash_close_position` | Close an existing position | *"close my SOL long"* |
| `flash_add_collateral` | Add collateral to a position | *"add $200 to my BTC short"* |
| `flash_remove_collateral` | Remove collateral | *"remove $100 from my ETH long"* |

### Query Tools

| Tool | Action | Example Command |
|---|---|---|
| `flash_get_positions` | View open positions | *"positions"* |
| `flash_get_market_data` | Get market prices | *"SOL price"* |
| `flash_get_portfolio` | Portfolio summary | *"portfolio"* |

### Analytics Tools

| Tool | Action | Example Command |
|---|---|---|
| `flash_get_volume` | Trading volume data | *"volume"* |
| `flash_get_open_interest` | Open interest breakdown | *"open interest"* |
| `flash_get_leaderboard` | Top traders ranking | *"leaderboard"* |
| `flash_get_fees` | Protocol fee data | *"fees"* |
| `flash_get_trader_profile` | Trader profile lookup | *"trader 7xKX..."* |

### Execution Flow

```
User: "open a 5x long on SOL with $500"
  │
  ├─ AI Interpreter   → { action: "open_position", market: "SOL", side: "long", collateral: 500, leverage: 5 }
  ├─ Tool Engine       → routes to flash_open_position
  ├─ Tool Execute      → displays confirmation prompt
  ├─ User Confirms     → "yes"
  └─ Flash Client      → submits transaction to Solana
```

---

## Example Session

```
  ⚡ FLASH AI TERMINAL ⚡
  ━━━━━━━━━━━━━━━━━━━━━
  AI-Powered Trading on Flash Trade

  SIMULATION  Pool: Crypto.1
  Wallet: SIM_A3F2..B71C
  Balance: $10,000.00

  Type "help" for commands, "exit" to quit.

flash [sim] > open a 5x long on SOL with $500

  Opening Position
  ─────────────────
  Market:     SOL LONG
  Leverage:   5x
  Collateral: $500.00
  Size:       $2,500.00

  Execute trade? (yes/no) yes

  Position Opened
  ─────────────────
  Entry Price: $142.35
  Size:        $2,500.00
  TX: SIM_a3f29b71

flash [sim] > portfolio

  Portfolio Summary
  ─────────────────────
  Wallet:         SIM_A3F2..B71C
  Balance: $9,500.00
  Collateral:     $500.00
  Position Value: $2,500.00
  Unrealized PnL: +$12.50
  Positions:      1

flash [sim] > positions

  Market  Side  Leverage  Size        Collateral  PnL              Liq Price
  ──────  ────  ────────  ──────────  ──────────  ───────────────  ─────────
  SOL     LONG  5.0x      $2,500.00   $500.00     +$12.50 (+2.5%) $114.16

flash [sim] > close my SOL long

  Closing Position
  ─────────────────
  Market: SOL LONG

  Confirm close? (yes/no) yes

  Position Closed
  ─────────────────
  Exit Price: $142.60
  PnL: +$8.78
  TX: SIM_CLOSE_a3f29b71
```

---

## Installation

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
git clone https://github.com/AustinJR6/flash-ai-terminal.git
cd flash-ai-terminal
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# Required for AI parsing (optional — regex parser works without it)
ANTHROPIC_API_KEY=sk-ant-...

# Solana configuration (only needed for live trading)
RPC_URL=https://api.mainnet-beta.solana.com
PYTHNET_URL=https://pythnet.rpcpool.com
WALLET_PATH=~/.config/solana/id.json

# Defaults
SIMULATION_MODE=true
DEFAULT_POOL=Crypto.1
NETWORK=mainnet-beta
DEFAULT_SLIPPAGE_BPS=800
COMPUTE_UNIT_LIMIT=600000
COMPUTE_UNIT_PRICE=50000
```

### Run

```bash
# Development
npx tsx src/index.ts

# Build and run
npm run build
npm start

# Run tests
npm test
```

---

## Available Commands

### Built-in Commands

| Command | Description |
|---|---|
| `help` | Show all available commands |
| `markets` | List all available markets |
| `portfolio` | View portfolio summary |
| `positions` | View open positions |
| `exit` | Quit the terminal |

### Natural Language Commands

Flash understands a wide range of natural language inputs:

```
open 5x long SOL $500           Open a leveraged position
long SOL $500 5x                Alternate syntax
close SOL long                  Close a position
add $200 to SOL long            Add collateral
remove $100 from ETH long       Remove collateral
SOL price                       Get market price
volume                          Trading volume data
open interest                   Open interest breakdown
leaderboard                     Top traders
fees                            Protocol fees
```

### CLI Subcommands

```bash
flash start                # Start interactive terminal (default)
flash start --live         # Live trading mode
flash start --simulate     # Simulation mode (default)
flash start --pool Crypto.1
flash markets              # List markets and exit
flash stats                # Show protocol stats and exit
flash stats --period 7d
flash leaderboard          # Show leaderboard and exit
flash leaderboard --metric volume --days 7
```

---

## Available Markets

| Pool | Markets |
|---|---|
| **Crypto.1** | SOL, BTC, ETH, ZEC, BNB |
| **Virtual.1** | XAG, XAU, CRUDEOIL, EUR, GBP, USDJPY, USDCNH |
| **Governance.1** | JTO, JUP, PYTH, RAY, HYPE, MET, KMNO |
| **Community.1** | PUMP, BONK, PENGU |
| **Community.2** | WIF |
| **Trump.1** | FARTCOIN |
| **Ore.1** | ORE |
| **Remora.1** | TSLAr, MSTRr, CRCLr, NVDAr, SPYr |

---

## Simulation Mode

Flash runs in simulation mode by default. The simulation engine:

- Uses **live market prices** from fstats.io open positions
- Tracks positions, collateral, and PnL locally
- Validates trades with the same rules as live mode (leverage limits, balance checks)
- Calculates approximate liquidation prices
- Starts with a **$10,000 paper balance**
- Requires no wallet, no RPC connection, and no API key

```bash
npx tsx src/index.ts              # Starts in simulation mode
npx tsx src/index.ts --live       # Switch to live trading
```

---

## Trade Safety

Flash includes built-in trade validation before every execution:

- **Leverage limits** enforced per market (e.g., SOL max 100x, BTC max 100x)
- **Balance validation** prevents over-allocation
- **Liquidation distance warnings** when liquidation price is within 10% of entry
- **High leverage warnings** displayed above 50x
- **Confirmation prompts** on all trading actions — no accidental executions

---

## Configuration Reference

| Variable | Description | Default |
|---|---|---|
| `RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `PYTHNET_URL` | Pyth oracle RPC | `https://pythnet.rpcpool.com` |
| `WALLET_PATH` | Path to Solana keypair | `~/.config/solana/id.json` |
| `ANTHROPIC_API_KEY` | Claude API key for NL parsing | *(optional)* |
| `DEFAULT_POOL` | Default trading pool | `Crypto.1` |
| `NETWORK` | Solana network | `mainnet-beta` |
| `SIMULATION_MODE` | Paper trading mode | `true` |
| `DEFAULT_SLIPPAGE_BPS` | Slippage tolerance in basis points | `800` |
| `COMPUTE_UNIT_LIMIT` | Solana compute unit limit | `600000` |
| `COMPUTE_UNIT_PRICE` | Solana priority fee | `50000` |

---

## Tech Stack

| Component | Technology |
|---|---|
| Language | TypeScript 5.7 (strict mode, zero `any`) |
| Runtime | Node.js 18+ |
| Blockchain | Solana via `@solana/web3.js` + `@coral-xyz/anchor` |
| Protocol SDK | `flash-sdk` v15.4 |
| AI | Anthropic Claude API (`claude-haiku-4-5`) + local regex |
| Validation | Zod schemas |
| CLI | Commander.js + readline + chalk + ora |
| Oracles | Pyth Network |
| Analytics | fstats.io REST API |
| Testing | Vitest |

---

## Roadmap

| Phase | Milestone | Status |
|---|---|---|
| **1** | CLI architecture and simulation engine | Complete |
| **2** | Wallet integration and live trading | Complete |
| **3** | AI market analysis and trade suggestions | Planned |
| **4** | Limit orders and advanced order types | Planned |
| **5** | Automated trading strategies | Planned |

---

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Ensure `npx tsc --noEmit` passes with zero errors
5. Push to your branch (`git push origin feature/your-feature`)
6. Open a pull request

All code must maintain the **zero-`any` policy** — strict TypeScript throughout.

---

## License

[MIT](LICENSE)
