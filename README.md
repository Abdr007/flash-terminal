# Flash AI Terminal

**AI-powered quantitative trading terminal for [Flash Trade](https://www.flash.trade/) perpetuals on Solana.**

A CLI trading system that combines market scanning, strategy signals, portfolio management, and risk controls into a single terminal interface. Designed for automated trading experiments with built-in safety rails.

```
flash [sim] > scan

  ┌──────────────────────────────────────────────┐
  │  MARKET SCAN — 9 markets scanned             │
  ├────────┬───────────┬──────────┬──────────────┤
  │ Market │ Price     │ Score    │ Signal       │
  ├────────┼───────────┼──────────┼──────────────┤
  │ SOL    │ $148.32   │ 0.72     │ LONG         │
  │ BTC    │ $67,420   │ 0.65     │ LONG         │
  │ ETH    │ $3,180    │ 0.41     │ NEUTRAL      │
  └────────┴───────────┴──────────┴──────────────┘
```

---

## Key Features

### Market Intelligence
- **Market scanner** across all Flash Trade markets with composite opportunity scoring
- **Regime detection** — classifies markets as trending, ranging, high-volatility, low-liquidity, or whale-dominated
- **Real-time data** from CoinGecko, Pyth oracles, and on-chain activity

### Trading Strategies
- **Momentum** — price direction + volume trend confirmation
- **Mean reversion** — detects OI skew and overextended price moves
- **Whale follow** — tracks large on-chain positions and follows smart money

### Portfolio Engine
- **Position sizing** — Kelly-criterion-inspired allocation with capital limits
- **Exposure controls** — max 20% per position, 30% per market, 60% directional
- **Correlation limits** — prevents overconcentration in correlated assets
- **Rebalancing analysis** — identifies portfolio imbalances

### Risk Management
- **Liquidation monitoring** — tracks distance to liquidation for all positions
- **Leverage limits** — enforced per-trade and at portfolio level
- **Directional exposure caps** — prevents excessive long or short bias
- **NaN/Infinity guards** — defensive numeric validation throughout

### Automation
- **Autopilot engine** — automated scan → signal → allocate → execute loop
- **Cooldown protection** — 60s minimum between trades
- **Duplicate prevention** — won't open positions in markets already held
- **Risk gating** — every autopilot trade passes allocation + risk checks

### Infrastructure
- **CLI terminal** with readline history and fast command dispatch
- **AI command interpreter** — natural language via Claude, with local regex fallback
- **Two-tier caching** — 30s market data, 60s analytics
- **Simulation mode** — full paper trading with live market prices

---

## Architecture

```
                    ┌─────────────────┐
                    │   CLI Terminal   │
                    │  (readline REPL) │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  AI Interpreter  │
                    │ (regex + Claude) │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   Tool Engine   │
                    │  (dispatch hub) │
                    └────────┬────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
  ┌───────▼───────┐ ┌───────▼───────┐ ┌───────▼───────┐
  │ Market Scanner │ │   Portfolio   │ │   Autopilot   │
  │               │ │    Engine     │ │    Engine     │
  └───────┬───────┘ └───────┬───────┘ └───────┬───────┘
          │                  │                  │
  ┌───────▼───────┐ ┌───────▼───────┐ ┌───────▼───────┐
  │  3 Strategy   │ │ Risk Engine   │ │  Allocation   │
  │   Signals     │ │ + Exposure    │ │   + Risk      │
  └───────┬───────┘ └───────┬───────┘ └───────┬───────┘
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                    ┌────────▼────────┐
                    │ Solana Inspector │
                    │  (cached data)  │
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
    ┌───────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
    │  Flash Trade  │ │   CoinGecko │ │  Pyth Oracle │
    │  (on-chain)   │ │   (prices)  │ │  (prices)    │
    └──────────────┘ └─────────────┘ └──────────────┘
```

**Data flows top-down.** User input is parsed into structured intents, dispatched to the appropriate tool, which queries cached on-chain and off-chain data, runs strategy/risk computations, and returns formatted results to the terminal.

---

## Project Structure

```
src/
├── cli/            Terminal interface (readline REPL, prompt loop)
├── ai/             Intent parser (local regex + Claude API fallback)
├── tools/          Tool engine and tool registry
├── scanner/        Market opportunity scanner with composite scoring
├── strategies/     Trading signals (momentum, mean-reversion, whale-follow)
├── regime/         Market regime detection (trend, volatility, liquidity)
├── portfolio/      Portfolio manager, allocation engine, rebalancing
├── risk/           Liquidation risk, exposure analysis
├── automation/     Autopilot trading loop with risk gating
├── clawd/          AI agent tools and Solana data inspector
├── client/         Flash Trade protocol client + simulation client
├── wallet/         Wallet manager, wallet store (~/.flash/wallets/)
├── config/         Configuration loader and risk parameters
├── data/           Price service (CoinGecko) and fstats.io client
├── types/          TypeScript types, Zod schemas, interfaces
└── utils/          Formatting, logging, retry utilities
```

---

## Installation

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- A Solana wallet keypair (for live trading only)

### Setup

```bash
# Clone the repository
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal

# Install dependencies
npm install

# Create your environment file
cp .env.example .env

# Build the project
npm run build

# Start the terminal
npm start
```

### Global Install

```bash
npm run build
npm link

# Now available globally:
flash --sim       # Simulation mode
flash --live      # Live trading mode
```

### Quick Start (Simulation Mode)

No wallet or API keys needed — simulation mode works out of the box:

```bash
flash --sim
```

The terminal starts in simulation mode with $10,000 paper balance.

---

## Configuration

Edit `.env` to configure the terminal:

| Variable | Description | Default |
|---|---|---|
| `RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `ANTHROPIC_API_KEY` | Claude API key for AI features | _(empty — local parsing only)_ |
| `DEFAULT_POOL` | Flash Trade pool | `Crypto.1` |
| `NETWORK` | Solana network | `mainnet-beta` |
| `DEFAULT_SLIPPAGE_BPS` | Slippage tolerance (basis points) | `150` |
| `COMPUTE_UNIT_LIMIT` | Transaction compute budget | `600000` |
| `COMPUTE_UNIT_PRICE` | Priority fee (microLamports) | `50000` |

**AI features are optional.** All commands work without an API key using local regex parsing. The AI interpreter adds natural language understanding for ambiguous inputs.

**Mode selection** is via CLI flags, not environment variables:

```bash
flash --sim       # Simulation mode (default)
flash --live      # Live trading mode (requires wallet)
```

---

## CLI Commands

### Trading

| Command | Description |
|---|---|
| `open 5x long SOL $500` | Open a leveraged position |
| `long SOL $500 5x` | Alternate syntax |
| `close SOL long` | Close a position |
| `add $200 to SOL long` | Add collateral to a position |
| `remove $100 from ETH long` | Remove collateral |

### Market Data

| Command | Description |
|---|---|
| `markets` | Show all Flash Trade markets with pool mapping |
| `SOL price` | Get a specific market price |
| `volume` | Trading volume data |
| `open interest` | Open interest across markets |
| `leaderboard` | Top traders by PnL |
| `fees` | Protocol fee data |

### AI Agent

| Command | Description |
|---|---|
| `scan` | Scan all markets for opportunities |
| `analyze SOL` | Deep market analysis with 3 strategy signals |
| `suggest trade` | AI-powered trade suggestion (requires API key) |
| `risk report` | Position risk assessment + exposure summary |
| `dashboard` | Combined portfolio / market / stats view |
| `whale activity` | Recent large on-chain positions |

### Portfolio Intelligence

| Command | Description |
|---|---|
| `portfolio` | Portfolio summary |
| `positions` | Open positions with P&L |
| `portfolio state` | Capital allocation breakdown |
| `portfolio exposure` | Exposure by market and direction |
| `rebalance` | Analyze portfolio balance |

### Autopilot

| Command | Description |
|---|---|
| `autopilot start` | Start automated trading loop |
| `autopilot stop` | Stop autopilot |
| `autopilot status` | Show autopilot state and recent signals |

### Wallet Management

| Command | Description |
|---|---|
| `wallet` | Show wallet connection status |
| `wallet import <name> <path>` | Import and store a wallet from keypair file |
| `wallet list` | List all stored wallets |
| `wallet use <name>` | Switch to a stored wallet |
| `wallet remove <name>` | Remove a stored wallet |
| `wallet connect <path>` | Connect a wallet (one-time, not stored) |
| `wallet address` | Show connected wallet address |
| `wallet balance` | Show SOL balance |
| `wallet tokens` | Detect all tokens in wallet |

---

## Runtime Modes

Flash AI Terminal uses explicit CLI flags for mode selection. No environment variable guessing.

```bash
flash --sim       # Simulation mode (paper trading, $10,000 balance)
flash --live      # Live trading (requires wallet)
flash             # Defaults to simulation
```

| Flag | Behavior |
|---|---|
| `--sim` | Uses `SimulatedFlashClient` — paper trading with live market prices |
| `--live` | Uses `FlashClient` — real on-chain transactions (requires wallet) |
| _(none)_ | Defaults to `--sim` |

### Live Mode Wallet Gate

Running `flash --live` without a wallet **never silently falls back** to simulation. Instead, an interactive menu appears:

```
LIVE TRADING MODE

No wallet connected.

Choose an option:

  1  wallet import
  2  wallet connect <path>
  3  continue in simulation
  4  exit
```

The user must explicitly choose. This prevents accidental mode switches.

### Wallet Storage

Imported wallets are stored at `~/.flash/wallets/<name>.json` with `0600` permissions. The last-used wallet auto-loads on startup.

```bash
# Import a wallet (private key input is hidden — never echoed)
flash [live] > wallet import main ~/.config/solana/id.json

# List stored wallets
flash [live] > wallet list

# Switch wallets
flash [live] > wallet use trading-wallet
```

---

## Example Workflow

```bash
# Start the terminal (simulation mode)
flash --sim

# Check what's available
flash [sim] > help

# Scan markets for opportunities
flash [sim] > scan

# Analyze the top opportunity
flash [sim] > analyze SOL

# Check your risk before trading
flash [sim] > risk report

# Open a position
flash [sim] > open 5x long SOL $500

# Monitor your portfolio
flash [sim] > dashboard

# Or let the autopilot handle it
flash [sim] > autopilot start

# Check autopilot status
flash [sim] > autopilot status

# Stop when done
flash [sim] > autopilot stop
```

---

## Data Sources

All market data is **live and real-time**. No hardcoded prices or fabricated data.

| Source | Data |
|---|---|
| **CoinGecko API** | Primary price feed for all markets |
| **Pyth Network** | Oracle prices for on-chain execution |
| **Flash Trade** | On-chain positions, pool data, protocol state |
| **fstats.io** | Volume, open interest, leaderboard, whale activity |
| **Solana RPC** | Wallet balance, transaction submission |

If any data source is unavailable, the system degrades gracefully — it will never trade on stale or missing data.

---

## Safety

> **This software is experimental. Use at your own risk.**

Built-in safety measures:

- **Simulation by default** — `flash --sim` is the default; live trading requires explicit `flash --live` plus a connected wallet
- **No silent mode switches** — `flash --live` without a wallet shows an interactive menu, never auto-falls back
- **5-layer autopilot guard** — autopilot is blocked in live mode at dispatch, tool mapping, tool execute, engine start, and engine cycle levels
- **Secure key handling** — private key input is hidden (no echo), keys are zeroed from memory after use, wallet files stored with `0600` permissions
- **Risk gating** — every trade (manual or autopilot) passes position sizing, leverage, and exposure checks
- **Liquidation monitoring** — continuous distance-to-liquidation tracking
- **Autopilot limits** — max $1,000/position, max $2,000 total exposure, max 5x leverage, 60s cooldown
- **Portfolio limits** — max 20% per position, 30% per market, 60% directional, 5 positions
- **HTTPS enforcement** — RPC and oracle connections require HTTPS
- **No hardcoded prices** — prevents trading on stale data if APIs fail

**Recommendations:**
1. Start with simulation mode to understand the system
2. Review `risk report` and `portfolio exposure` before enabling autopilot
3. Use a dedicated wallet with limited funds for live trading
4. Monitor the terminal — autopilot is not a "set and forget" system

---

## Development

```bash
# Build
npm run build

# Development mode (tsx, no build needed)
npm run dev

# Type check
npx tsc --noEmit

# Run tests
npm test
```

### Adding a New Strategy

Strategies are pure functions in `src/strategies/`. Each takes market data and returns a `StrategySignal`:

```typescript
export function computeMySignal(data: MarketInput): StrategySignal {
  return {
    direction: 'long' | 'short' | 'neutral',
    confidence: 0.0 - 1.0,
    label: 'My Strategy',
    reasoning: 'Why this signal was generated',
  };
}
```

Register it in `src/scanner/market-scanner.ts` to include it in the scan pipeline.

### Adding a New Command

1. Add an `ActionType` enum value in `src/types/index.ts`
2. Add a regex pattern in `src/ai/interpreter.ts` → `localParse()`
3. Create a tool definition in `src/tools/` or `src/clawd/`
4. Add a dispatch case in `src/tools/engine.ts`

---

## Available Markets

| Pool | Markets |
|---|---|
| **Crypto.1** | SOL, BTC, ETH, ZEC, BNB |
| **Virtual.1** | XAG, XAU, CRUDEOIL, EUR, GBP, USDJPY, USDCNH |
| **Governance.1** | JTO, JUP, PYTH, RAY, HYPE, MET, KMNO |
| **Community.1** | PUMP, BONK, PENGU |
| **Community.2** | WIF |
| **Remora.1** | TSLAr, MSTRr, CRCLr, NVDAr, SPYr |

---

## Tech Stack

- **TypeScript** — strict mode, ESM modules
- **Solana web3.js** — blockchain interaction
- **Flash SDK** — Flash Trade protocol integration
- **Anchor** — Solana program framework
- **Pyth Client** — oracle price feeds
- **Anthropic SDK** — Claude AI for natural language parsing
- **Zod** — runtime type validation
- **Commander** — CLI framework
- **Chalk** — terminal styling

---

## License

[MIT](LICENSE)

---

> Built for traders who want to understand what their system is doing, not just watch it run.
