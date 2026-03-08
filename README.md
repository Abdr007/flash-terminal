![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D20-blue)
![TypeScript](https://img.shields.io/badge/typescript-5.7-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Solana](https://img.shields.io/badge/solana-mainnet--beta-purple)

# FLASH AI TERMINAL

A command-line trading terminal for the [Flash Trade](https://www.flash.trade/) protocol on Solana providing AI-assisted commands, real-time market analysis, risk monitoring, and on-chain execution.

---

## Overview

Flash AI Terminal connects directly to the Flash Trade perpetual futures protocol on Solana. It combines an AI command interpreter, a multi-strategy market scanner, a real-time risk monitor, and a hardened transaction pipeline into a single CLI tool.

The terminal operates in two modes:

- **Simulation** -- Paper trading against live market prices with a virtual balance. No wallet required.
- **Live** -- Signs and submits real transactions to the Solana blockchain. Requires a funded wallet.

All market data is live. No synthetic prices, no fabricated signals.

```
  FLASH AI TERMINAL

  LIVE TRADING MODE

  Wallet:  7xKp...3nRq
  Network: mainnet-beta
  Balance: 2.41 SOL

  Market Intelligence
  --------------------

  Regime:    TRENDING
  Markets:   9 scanned

  Top Opportunities
    1. SOL    LONG   72%
    2. BTC    SHORT  65%
    3. JUP    LONG   58%

flash [live] > _
```

---

## Key Features

### Trading Execution

- Open and close leveraged perpetual positions
- Add and remove collateral from existing positions
- On-chain transaction signing and submission via Flash SDK
- Trade confirmation gates with full position summary before execution
- Per-market trade mutex prevents concurrent transaction submissions
- Transaction signature cache (60s TTL) prevents duplicate submissions

### Market Intelligence

- Multi-strategy market scanner (momentum, mean reversion, whale follow)
- Live market monitor with real-time price, OI, and long/short ratio
- Deep asset analysis with regime-aware signal aggregation
- Whale activity detection from on-chain position data
- Open interest and volume tracking across all markets

### Risk Management

- Real-time liquidation distance monitoring with tiered alerts
- Portfolio exposure analysis and directional bias detection
- Hysteresis-based alert thresholds to prevent notification spam
- Automatic collateral suggestions when positions approach liquidation

### Protocol Inspection

- Protocol-level overview (program ID, pools, TVL)
- Per-pool inspection (assets, utilization, OI breakdown)
- Per-market deep dive (long/short ratio, whale positions, risk metrics)

### Infrastructure

- Blockchain state reconciliation (local state syncs with on-chain state)
- RPC endpoint management with slot lag auto-failover and cooldown
- Signing security guards with rate limiting and audit logging
- Transaction dry-run with Solana simulation (no signing)
- Plugin architecture for custom tools and strategies

---

## Architecture

```
User Command
     |
     v
+-----------------------------------------------+
|              AI Command Parser                 |
|  Fast dispatch --> Regex parser --> LLM engine  |
+----------------------+------------------------+
                       |  ParsedIntent
                       v
+-----------------------------------------------+
|             Execution Engine                   |
|  Middleware --> Tool dispatch --> Execute       |
+--------+-----------+-----------+--------------+
         |           |           |
         v           v           v
    +---------+ +---------+ +----------+
    | Scanner | |Portfolio| | Trading  |
    |         | | Engine  | |  Tools   |
    +----+----+ +----+----+ +----+-----+
         |           |           |
         v           v           v
+-----------------------------------------------+
|              Risk Engine                       |
|  Leverage limits - Position sizing -           |
|  Exposure caps - Liquidation monitoring        |
+----------------------+------------------------+
                       |
                       v
+-----------------------------------------------+
|           Transaction Pipeline                 |
|  SimulatedFlashClient | FlashClient (live)     |
+----------------------+------------------------+
                       |
                       v
+-----------------------------------------------+
|          Flash Trade Protocol                  |
|  Flash SDK - Pyth Oracles - Solana RPC         |
+----------------------+------------------------+
                       |
                       v
               Solana Blockchain
```

| Subsystem | Responsibility |
|-----------|---------------|
| **AI Command Parser** | Converts user input to structured intents. Single-token commands use fast dispatch; structured commands use regex; natural language falls back to LLM. |
| **Execution Engine** | Routes intents to registered tool functions. Runs pre-execution middleware (logging, wallet checks, read-only guard). |
| **Scanner** | Runs momentum, mean reversion, and whale follow strategies across all markets. Regime detection adjusts strategy weights. |
| **Portfolio Engine** | Tracks exposure, directional bias, and capital allocation. Produces rebalance suggestions. |
| **Risk Engine** | Enforces position limits, leverage bounds, directional caps, and exposure limits before any trade. |
| **Risk Monitor** | Background process checking liquidation distance every 5s (prices) and 20s (positions). Emits alerts on threshold crossings. |
| **Transaction Pipeline** | Builds, signs, and submits Solana transactions. Handles confirmation polling, retry logic, and trade mutex. |
| **State Reconciler** | Syncs local state with blockchain on startup, after trades, on wallet switch, and every 60s. Blockchain is authoritative. |
| **Plugin System** | Dynamically loads plugins from `src/plugins/` at startup. Plugins can register tools and lifecycle hooks. |

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed subsystem documentation.

---

## Installation

**Requirements:** Node.js >= 20.0.0

```bash
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
npm install
npm run build
```

Start the terminal:

```bash
npm start
```

Or link globally:

```bash
npm link
flash
```

---

## Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

### Required

| Variable | Description |
|----------|-------------|
| `RPC_URL` | Solana RPC endpoint. Use a premium provider (Helius, Triton, QuickNode) for live trading. |

### Trading

| Variable | Default | Description |
|----------|---------|-------------|
| `SIMULATION_MODE` | `true` | `true` for paper trading, `false` for live on-chain execution. |
| `DEFAULT_POOL` | `Crypto.1` | Default Flash Trade pool for market resolution. |
| `DEFAULT_SLIPPAGE_BPS` | `150` | Slippage tolerance in basis points (150 = 1.5%). |
| `COMPUTE_UNIT_LIMIT` | `600000` | Transaction compute unit budget. |
| `COMPUTE_UNIT_PRICE` | `500000` | Priority fee in microLamports. |

### Signing Guards

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_COLLATERAL_PER_TRADE` | `0` (unlimited) | Maximum collateral per single trade in USD. |
| `MAX_POSITION_SIZE` | `0` (unlimited) | Maximum position size in USD. |
| `MAX_LEVERAGE` | `0` (unlimited) | Maximum allowed leverage multiplier. |
| `MAX_TRADES_PER_MINUTE` | `10` | Rate limit on trade submissions. |
| `MIN_DELAY_BETWEEN_TRADES_MS` | `3000` | Minimum delay between consecutive trades in milliseconds. |

### RPC Failover

| Variable | Description |
|----------|-------------|
| `BACKUP_RPC_1` | First backup RPC endpoint for automatic failover. |
| `BACKUP_RPC_2` | Second backup RPC endpoint for automatic failover. |

The RPC manager monitors endpoint health every 30 seconds. Failover triggers on: endpoint down, latency > 5s, or slot lag > 50 slots behind network tip. A 60-second cooldown prevents oscillation between endpoints.

### AI Features (Optional)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for LLM-powered natural language command parsing. |
| `GROQ_API_KEY` | API key for alternative LLM provider. |

All commands work without AI keys. The built-in regex parser handles standard commands. AI keys add natural language support for conversational input.

### Network

| Variable | Default | Description |
|----------|---------|-------------|
| `NETWORK` | `mainnet-beta` | Solana network (`mainnet-beta` or `devnet`). |
| `PYTHNET_URL` | `https://pythnet.rpcpool.com` | Pyth oracle RPC endpoint. |
| `WALLET_PATH` | `~/.config/solana/id.json` | Path to Solana CLI keypair file. |

---

## Quick Start

```bash
# 1. Clone and build
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
npm install && npm run build

# 2. Configure
cp .env.example .env
# Edit .env with your RPC_URL (required)

# 3. Start in simulation mode (default)
npm start

# 4. Try commands
flash [sim] > markets          # List available markets
flash [sim] > scan             # Scan for opportunities
flash [sim] > analyze SOL      # Deep analysis
flash [sim] > open 2x long SOL $10
flash [sim] > positions        # View open positions
flash [sim] > portfolio        # Portfolio summary
flash [sim] > close SOL long   # Close position
```

---

## Example CLI Commands

### Market Data

```
markets                    List all available trading markets
scan                       Scan all markets for opportunities
analyze SOL                Deep analysis of a specific market
monitor                    Live market monitor (refreshes every 5s)
volume                     Trading volume data
open interest              Open interest breakdown
leaderboard                Top traders by PnL
```

### Trading

```
open 5x long SOL $500     Open a leveraged position
close SOL long            Close a position
add $200 to SOL long      Add collateral
remove $100 from ETH long Remove collateral
trade history             View recent trades (simulation)
dryrun open 2x long SOL $10   Preview without signing
```

### Portfolio and Risk

```
positions                 View open positions
portfolio                 Portfolio summary with PnL
exposure                  Directional exposure breakdown
risk report               Position risk assessment
risk monitor on           Start liquidation monitoring
risk monitor off          Stop monitoring
```

### Wallet

```
wallet import main ~/.config/solana/id.json
wallet list               List saved wallets
wallet use main           Switch wallet
wallet balance            SOL balance
wallet tokens             All token balances
wallet disconnect         Disconnect wallet
```

### System

```
system status             System health overview
rpc status                Active RPC endpoint info
rpc test                  Test all RPC endpoints
inspect protocol          Flash Trade protocol overview
inspect pool Crypto.1     Pool details
inspect market SOL        Market deep dive
tx inspect <signature>    Inspect a transaction
```

### Natural Language

The terminal accepts natural English instructions:

```
flash > buy sol with 5x leverage and 100 dollars
flash > short ethereum with 3x leverage $50
flash > close my solana long position
flash > add twenty dollars to my sol long
flash > what are the best opportunities right now
```

The interpreter normalizes number words, asset names, leverage notation, and collateral amounts. If the AI cannot determine intent, the system falls back to the built-in regex parser.

---

## Market Monitor

The `monitor` command displays a live-updating market table that refreshes every 5 seconds.

```
flash [sim] > monitor

  MARKET MONITOR
  12:34:56 PM  |  Refreshing every 5s  |  Press any key to exit
  --------------------------------------------------------------------

  Asset         Price    24h Change   Open Interest   Long / Short
  --------------------------------------------------------------------
  SOL         $148.52       +3.20%          $2.14M        62 / 38
  BTC      $63,200.00       -0.40%        $438.00K        48 / 52
  ETH       $3,420.00       +0.70%         $32.00K        61 / 39
  JUP          $1.24       +5.10%         $18.50K        71 / 29
  BONK         $0.00       -1.30%          $8.20K        45 / 55
```

Data sources:
- **Prices and 24h change** from CoinGecko
- **Open interest and long/short ratio** from fstats.io
- Markets sorted by total open interest (most active first)

Press any key to exit the monitor and return to the command prompt.

---

## Protocol Inspection

Inspect Flash Trade protocol state directly from the terminal.

```
flash [sim] > inspect protocol
  Flash Trade Protocol
  ================================
  Program ID:   FLASH...
  Pools:        8
  Total OI:     $12.4M

flash [sim] > inspect pool Crypto.1
  Pool: Crypto.1
  --------------------------------
  Assets:       SOL, BTC, ETH, ZEC, BNB
  Utilization:  42%
  OI Long:      $5.2M
  OI Short:     $3.8M

flash [sim] > inspect market SOL
  SOL Market
  --------------------------------
  Long/Short Ratio:  1.37
  Open Interest:     $2.1M
  Whale Positions:   3
  Largest Position:  $180K LONG
```

---

## Risk Monitor

The risk monitor runs as a background process checking liquidation distance for all open positions.

```
flash [sim] > risk monitor on
  Risk monitor started. (prices every 5s, positions every 20s)
```

### Alert Levels

| Level | Distance to Liquidation | Action |
|-------|------------------------|--------|
| **Safe** | > 35% | No alert |
| **Warning** | < 30% | Yellow warning with position details |
| **Critical** | < 15% | Red alert with collateral suggestion |

Hysteresis thresholds prevent alert oscillation:

- Warning triggers at < 30%, recovers at > 35%
- Critical triggers at < 15%, recovers at > 18%

The monitor auto-calculates the exact collateral amount needed to restore a safe liquidation distance using binary search over the leverage-to-liquidation model.

---

## Transaction Preview (Dry Run)

The `dryrun` command compiles a transaction and runs Solana simulation without signing or sending.

```
flash [live] > dryrun open 2x long SOL $10

  TRANSACTION PREVIEW (DRY RUN)
  --------------------------------

  Trade Parameters
    Market:         SOL
    Side:           LONG
    Collateral:     $10.00
    Leverage:       2x
    Position Size:  $20.00
    Entry Price:    $148.52
    Liq. Price:     $81.69
    Est. Fee:       $0.0160

  Solana Transaction
    Program:        FLASHhBBFyEr...
    Accounts:       14
    Instructions:   4
    Tx Size:        892 bytes
    CU Budget:      400,000

  Simulation Result
    Status:         SUCCESS
    CU Consumed:    123,456

  No transaction was signed or sent.
```

---

## Security Model

### Transaction Signing

- Every trade displays a full position summary and requires explicit confirmation
- Signing rate limiter prevents rapid-fire submissions
- Per-market trade mutex prevents concurrent transaction submissions
- Transaction signature cache (60s TTL) prevents duplicate submissions
- All trade attempts are logged to `~/.flash/signing-audit.log`
- Configurable per-trade limits (`MAX_COLLATERAL_PER_TRADE`, `MAX_POSITION_SIZE`, `MAX_LEVERAGE`)

### Wallet Security

- Wallet files stored in `~/.flash/wallets/` with `0600` permissions (owner-only)
- Wallet import validates path within home directory; symlinks are resolved and checked
- File size limits prevent reading non-wallet files
- Private keys are never printed to the terminal or written to log files
- Key bytes are zeroed from memory after use

### Network Security

- RPC URLs validated for HTTPS protocol
- All API calls have timeouts and response body size limits
- Slot lag monitoring with automatic failover (>50 slots behind triggers switch)
- Log files rotate at 10MB with automatic cleanup
- API keys automatically scrubbed from all log output

See [SECURITY.md](SECURITY.md) for the full security policy.

---

## State Reconciliation

The terminal maintains a local view of on-chain positions. The state reconciliation engine ensures this view stays accurate.

| Trigger | Behavior |
|---------|----------|
| **Startup** | Fetches all positions from blockchain, builds local state |
| **After trade** | Verifies the position exists on-chain; warns if not yet settled |
| **Wallet switch** | Clears local state, re-fetches for new wallet |
| **Every 60 seconds** | Background sync in live mode; detects externally opened/closed positions |

If the reconciler detects a discrepancy, it logs the event and rebuilds local state from the blockchain. Blockchain state is always authoritative.

---

## Plugin System

Extend the terminal by adding plugins to `src/plugins/`.

### Plugin Interface

```typescript
interface FlashPlugin {
  name: string;
  version?: string;
  description?: string;
  tools?: () => ToolDefinition[];
  onInit?: (context: ToolContext) => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
}
```

### Creating a Plugin

Create a file in `src/plugins/` (e.g., `my-scanner.ts`):

```typescript
import { FlashPlugin } from './plugin-loader.js';

const plugin: FlashPlugin = {
  name: 'my-scanner',
  version: '1.0.0',
  tools: () => [
    {
      name: 'my_custom_scan',
      description: 'Run custom scanner',
      parameters: z.object({}),
      execute: async (_params, context) => {
        return { success: true, message: 'Scan complete' };
      },
    },
  ],
};

export default plugin;
```

Plugins are discovered automatically at startup. Files starting with `_` are skipped.

---

## Development Setup

### Run in Development Mode

```bash
npm run dev
```

Uses `tsx` for TypeScript execution without a compile step.

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/` and makes the CLI executable.

### Run Tests

```bash
npm run test            # Single run
npm run test:watch      # Watch mode
```

### Type Check

```bash
npx tsc --noEmit
```

---

## Project Structure

```
src/
  cli/            Terminal REPL, user interaction, confirmation flow
  ai/             Intent parsing (regex + NLP normalization + LLM fallback)
  tools/          Tool definitions, registry, and dispatch engine
  client/         Flash Trade SDK client and paper trading client
  agent/          AI-powered analysis, scanner, autopilot, dashboard
  strategies/     Momentum, mean reversion, whale follow strategies
  scanner/        Multi-market opportunity scanner
  portfolio/      Allocation, exposure, rebalance logic
  risk/           Liquidation risk, exposure computation
  monitor/        Real-time risk monitoring engine
  regime/         Market regime detection (trending/ranging/volatile)
  protocol/       Flash Trade protocol inspector
  core/           Execution middleware, state reconciliation
  network/        RPC endpoint management with failover
  system/         System diagnostics, health checks, tx inspection
  security/       Signing guard, rate limiter, audit logging
  plugins/        Plugin loader and user plugins
  wallet/         Keypair management, wallet store, session tracking
  automation/     Autopilot loop (simulation only)
  data/           CoinGecko, fstats.io API clients
  config/         Environment config, pool/market mapping, risk config
  types/          All types, enums, interfaces, Zod schemas
  utils/          Logger, retry, formatting, safe math
docs/
  FLASH-TRADE-OVERVIEW.md   Flash Trade protocol reference
  architecture.md           Detailed architecture notes
  project-structure.md      Module-level documentation
  quickstart.md             Getting started guide
test/                       Test suites
```

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
| Remora.1 | TSLAr, MSTRr, CRCLr, NVDAr, SPYr |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding guidelines, and pull request process.

---

## Repository Documentation

| File | Description |
|------|-------------|
| [README.md](README.md) | This file |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture and design decisions |
| [SECURITY.md](SECURITY.md) | Security policy, vulnerability reporting, key management |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, coding style, PR guidelines |
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
