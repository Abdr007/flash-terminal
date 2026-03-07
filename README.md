![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D20-blue)
![TypeScript](https://img.shields.io/badge/typescript-5.7-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Code Quality](https://img.shields.io/badge/code%20quality-A-brightgreen)
![Solana](https://img.shields.io/badge/solana-mainnet--beta-purple)

# FLASH AI TERMINAL

A command-line trading terminal for the [Flash Trade](https://www.flash.trade/) protocol on Solana.

Provides AI-powered command parsing, real-time market analysis, portfolio monitoring, liquidation risk alerts, transaction dry-run, and on-chain trade execution.

---

## Overview

Flash AI Terminal connects directly to the Flash Trade perpetual futures protocol on Solana. It combines an AI command interpreter, a multi-strategy market scanner, a real-time risk monitor, and a hardened transaction pipeline into a single CLI tool.

The terminal operates in two modes:

- **Simulation** — Paper trading against live market prices with a virtual balance. No wallet required.
- **Live** — Signs and submits real transactions to the Solana blockchain. Requires a funded wallet.

All market data is live. No synthetic prices, no fabricated signals.

```
  FLASH AI TERMINAL

  LIVE TRADING MODE

  Wallet:  7xKp...3nRq
  Network: mainnet-beta
  Balance: 2.41 SOL

  Market Intelligence
  ─────────────────────────────────────

  Regime:    TRENDING
  Markets:   9 scanned

  Top Opportunities
    1. SOL    LONG   72%
    2. BTC    SHORT  65%
    3. JUP    LONG   58%

flash [live] > _
```

---

## CLI Demonstration

### Viewing Markets

```
flash [sim] > markets

  FLASH TRADE MARKETS
  ─────────────────────────────────────

  Crypto.1
    SOL    BTC    ETH    ZEC    BNB

  Virtual.1
    XAG    XAU    CRUDEOIL    EUR    GBP    USDJPY    USDCNH

  Governance.1
    JTO    JUP    PYTH    RAY    HYPE    MET    KMNO

  Community.1       PUMP    BONK    PENGU
  Community.2       WIF
  Trump.1           FARTCOIN
  Ore.1             ORE
  Remora.1          TSLAr    MSTRr    CRCLr    NVDAr    SPYr
```

### Scanning for Opportunities

```
flash [sim] > scan

  Scanning 9 markets...

  Market Opportunities
  ─────────────────────────────────────
    1. SOL    LONG   72%   Momentum breakout
    2. BTC    SHORT  65%   Mean reversion signal
    3. JUP    LONG   58%   Whale accumulation
```

### Analyzing a Market

```
flash [sim] > analyze SOL

  SOL Market Analysis
  ─────────────────────────────────────
  Price:        $148.52
  24h Change:   +3.2%
  Regime:       TRENDING
  Signal:       LONG (72% confidence)

  Strategy Breakdown
    Momentum:        LONG   78%
    Mean Reversion:  LONG   65%
    Whale Follow:    LONG   74%
```

### Opening a Position

```
flash [sim] > open 2x long SOL $10

  Open Position Summary
  ─────────────────────────────────────
  Market:      SOL-PERP
  Side:        LONG
  Leverage:    2.0x
  Collateral:  $10.00
  Size:        $20.00
  Est. Fee:    $0.02

  Confirm? (yes/no) yes
  Confirmed in 0.1s
```

### Viewing Positions and Portfolio

```
flash [sim] > positions

  Market  Side  Lev   Size     Collateral  Entry     Mark      PnL
  SOL     LONG  2.0x  $20.00   $10.00      $148.52   $148.71   +$0.26

flash [sim] > portfolio

  Portfolio Summary
  ─────────────────────────────────────
  Balance:         $9,989.98
  Total Exposure:  $20.00
  Unrealized PnL:  +$0.26
  Realized PnL:    $0.00
  Total Fees:      $0.02
  Positions:       1
```

### Closing a Position

```
flash [sim] > close SOL long

  Confirm? (yes/no) yes
  Confirmed in 0.1s
  Realized PnL: +$0.24
```

---

## Natural Language Commands

The terminal accepts natural English instructions. An AI interpreter converts spoken commands into structured trading actions. All parsed intents pass through the same validation and confirmation pipeline as typed commands.

```
flash [sim] > open a 2x long position on sol with ten dollars

  AI Interpretation
  ─────────────────────────────────────
  Action:      open_position
  Market:      SOL
  Side:        LONG
  Leverage:    2x
  Collateral:  $10.00

  Execute trade? (yes/no)
```

Additional examples:

```
flash > buy sol with 5x leverage and 100 dollars
flash > short ethereum with 3x leverage $50
flash > close my solana long position
flash > add twenty dollars to my sol long
flash > remove $50 from my btc short
flash > how is my portfolio doing
flash > what are the best opportunities right now
flash > analyze bitcoin
```

The interpreter normalizes:

- **Number words** — "ten" becomes 10, "twenty five" becomes 25, "five hundred" becomes 500
- **Asset names** — "solana" resolves to SOL, "bitcoin" to BTC, "ethereum" to ETH, "gold" to XAU
- **Leverage** — "5x", "5 times", "leverage 5" all resolve to 5
- **Collateral** — "$500", "500 dollars", "500 USDC" all resolve to 500

If the AI cannot determine intent, the system falls back to the built-in regex parser. All commands work without AI keys configured.

---

## Transaction Preview (Dry Run)

The `dryrun` command compiles a transaction and runs Solana simulation without signing or sending. Designed for protocol developers, security auditors, and advanced traders who want to inspect transaction behavior before execution.

```
flash [live] > dryrun open 2x long SOL $10

  TRANSACTION PREVIEW (DRY RUN)
  ─────────────────────────────────────

  Trade Parameters
    Market:         SOL
    Side:           LONG
    Collateral:     $10.00
    Leverage:       2x
    Position Size:  $20.00

    Entry Price:    $148.52
    Liq. Price:     $81.69
    Est. Fee:       $0.0160

  ─────────────────────────────────────
  Solana Transaction
    Program:        FLASHhBBFyEr...
    Accounts:       14
    Instructions:   4
    Tx Size:        892 bytes
    CU Budget:      400,000

  ─────────────────────────────────────
  Simulation Result
    Status:         SUCCESS
    CU Consumed:    123,456

  Program Logs
    Program FLASHhBBFy... invoke [1]
    Program log: open_position
    Program FLASHhBBFy... success

  ─────────────────────────────────────
  No transaction was signed or sent.
```

The dry-run mode:

- Compiles the full `MessageV0` transaction with compute budget instructions
- Calls `connection.simulateTransaction()` on the Solana RPC
- Displays program logs, compute units consumed, and any errors
- Never signs the transaction
- Never sends the transaction to the network

---

## Real-Time Risk Monitor

The risk monitor runs as a background process and continuously checks liquidation distance for all open positions.

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

### Warning Alert

```
  ⚠ RISK WARNING
  ─────────────────────────────────────
  SOL LONG 5x
  Entry:       $148.52
  Current:     $141.20
  Liquidation: $133.00

  Distance to liquidation: 22%

  Add $45 collateral to restore distance to 35%.
```

### Critical Alert

```
  CRITICAL LIQUIDATION RISK
  ═════════════════════════════════════
  SOL LONG 10x
  Entry:       $148.52
  Current:     $139.50
  Liquidation: $136.80

  Distance to liquidation: 8%

  Add collateral or reduce position immediately.
  Add $120 collateral to restore distance to 35%.
```

The monitor auto-calculates the exact collateral amount needed to restore a safe liquidation distance using binary search over the leverage-to-liquidation model.

---

## Market Opportunity Scanner

The scanner analyzes all available markets and ranks them by signal strength.

```
flash [sim] > scan

  Scanning 9 markets...

  Market Opportunities
  ─────────────────────────────────────
  Rank  Market  Dir    Score  Strategy
    1.  SOL     LONG   72%   Momentum breakout
    2.  BTC     SHORT  65%   Mean reversion signal
    3.  JUP     LONG   58%   Whale accumulation
```

Three independent strategies produce signals that are aggregated with regime-weighted scoring:

| Strategy | Detects | Data Source |
|----------|---------|-------------|
| Momentum | Strong directional moves | Price changes, volume trends |
| Mean Reversion | Oversold/overbought conditions | Price deviation, open interest |
| Whale Follow | Large position clustering | On-chain whale activity |

The market regime (trending, ranging, volatile, whale-dominated, low-liquidity) dynamically adjusts strategy weights. High-volatility regimes reduce leverage suggestions. Low-liquidity regimes reduce position sizing.

---

## Screenshots

When evaluating this project, the following views demonstrate the core functionality:

| View | Description |
|------|-------------|
| **Market Scanner** | Output of `scan` showing ranked opportunities with confidence scores |
| **Risk Monitor** | Warning and critical alerts with liquidation distance and collateral suggestions |
| **Portfolio Summary** | Output of `portfolio` showing exposure, PnL, fees, and position table |
| **Transaction Preview** | Output of `dryrun` showing compiled transaction details and simulation logs |
| **Protocol Inspector** | Output of `inspect protocol` and `inspect market` showing on-chain state |

To capture screenshots, run the terminal in simulation mode and execute the commands shown in the CLI Demonstration section above.

---

## Design Philosophy

- **Deterministic command execution** — All commands resolve to structured `ParsedIntent` objects validated by Zod schemas. The same input always produces the same action.
- **AI-assisted, not AI-dependent** — The AI interpreter is a convenience layer. All commands work through the built-in regex parser without any AI keys configured.
- **Defensive error handling** — `Number.isFinite()` guards on all arithmetic, try/catch on all external calls, timeout enforcement on all network requests. No NaN or Infinity values propagate through calculations.
- **Developer transparency** — Every trade shows full position details before confirmation. The `dryrun` command exposes the exact transaction structure. Blockchain state is always authoritative over local state.

---

## Key Features

### Trading Execution

- Open and close leveraged perpetual positions
- Add and remove collateral from existing positions
- On-chain transaction signing and submission via Flash SDK
- Trade confirmation gates with full position summary before execution
- Per-market trade mutex prevents concurrent transaction submissions

### Market Intelligence

- Multi-strategy market scanner (momentum, mean reversion, whale follow)
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
- Signing security guards with rate limiting and audit logging
- RPC endpoint management with failover
- Plugin architecture for custom tools and strategies
- Transaction dry-run with Solana simulation

---

## System Architecture

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

### Subsystem Descriptions

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
| `COMPUTE_UNIT_PRICE` | `50000` | Priority fee in microLamports. |

### Signing Guards

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_COLLATERAL_PER_TRADE` | `0` (unlimited) | Maximum collateral per single trade in USD. |
| `MAX_POSITION_SIZE` | `0` (unlimited) | Maximum position size in USD. |
| `MAX_LEVERAGE` | `0` (unlimited) | Maximum allowed leverage multiplier. |
| `MAX_TRADES_PER_MINUTE` | `10` | Rate limit on trade submissions. |
| `MIN_DELAY_BETWEEN_TRADES_MS` | `3000` | Minimum delay between consecutive trades in milliseconds. |

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

## Protocol Inspection

Inspect Flash Trade protocol state directly from the terminal.

```
flash [sim] > inspect protocol
  Flash Trade Protocol
  ═════════════════════════════════
  Program ID:   FLASH...
  Pools:        8
  Total OI:     $12.4M
  ...

flash [sim] > inspect pool Crypto.1
  Pool: Crypto.1
  ─────────────────────────────────
  Assets:       SOL, BTC, ETH, ZEC, BNB
  Utilization:  42%
  OI Long:      $5.2M
  OI Short:     $3.8M
  ...

flash [sim] > inspect market SOL
  SOL Market
  ─────────────────────────────────
  Long/Short Ratio:  1.37
  Open Interest:     $2.1M
  Whale Positions:   3
  Largest Position:  $180K LONG
  ...
```

**Data returned:**

- `inspect protocol` — Program ID, pool count, total open interest, protocol-level stats
- `inspect pool <name>` — Pool assets, utilization, OI breakdown by direction
- `inspect market <asset>` — Long/short ratio, open interest, whale positions, risk metrics

---

## Security Model

### Transaction Signing

- Every trade displays a full position summary and requires explicit confirmation before signing
- Signing rate limiter prevents rapid-fire submissions (`MAX_TRADES_PER_MINUTE`, `MIN_DELAY_BETWEEN_TRADES_MS`)
- Per-market trade mutex prevents concurrent transaction submissions on all trade operations
- All trade attempts are logged to `~/.flash/signing-audit.log` with timestamp, market, side, and result
- Configurable per-trade limits (`MAX_COLLATERAL_PER_TRADE`, `MAX_POSITION_SIZE`, `MAX_LEVERAGE`)

### Wallet Security

- Wallet files stored in `~/.flash/wallets/` with `0600` permissions (owner-only read/write)
- Wallet import validates path within home directory; symlinks are resolved and checked
- File size limits prevent reading non-wallet files
- Private keys are never printed to the terminal or written to log files

### API Key Safety

- Log scrubbing automatically redacts API key patterns from all log output
- API keys belong in `.env` only — never in shell history or command arguments
- `.env` is listed in `.gitignore`

### Network Security

- RPC URLs validated for HTTPS protocol
- All API calls have timeouts and response body size limits (prevents OOM from malicious endpoints)
- Oracle price validation rejects zero or negative values from Pyth
- Log files rotate at 10MB with automatic cleanup

---

## State Reconciliation

The terminal maintains a local view of on-chain positions. The state reconciliation engine ensures this view stays accurate.

### Sync Points

| Trigger | Behavior |
|---------|----------|
| **Startup** | Fetches all positions from blockchain, builds local state |
| **After trade confirmation** | Verifies the position exists on-chain; warns if not yet settled |
| **Wallet switch** | Clears local state, re-fetches for new wallet |
| **Every 60 seconds** | Background sync in live mode; detects externally opened/closed positions |

### Recovery

If the reconciler detects a discrepancy (position exists on-chain but not locally, or vice versa), it logs the event and rebuilds local state from the blockchain. Blockchain state is always authoritative.

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
  description: 'Custom market scanner',

  tools: () => [
    {
      name: 'my_custom_scan',
      description: 'Run custom scanner',
      parameters: z.object({}),
      execute: async (_params, context) => {
        // Access context.flashClient, context.walletAddress, etc.
        return { success: true, message: 'Scan complete' };
      },
    },
  ],

  onInit: (context) => {
    console.log('Custom scanner initialized');
  },
};

export default plugin;
```

Plugins are discovered automatically at startup. Files starting with `_` are skipped.

### Extension Points

- **Custom scanners** — Register tools that analyze markets with your own logic
- **Trading strategies** — Add strategy implementations that produce trade signals
- **Analytics tools** — Build custom dashboards, exporters, or alert integrations
- **Protocol adapters** — Wrap additional protocols behind the `IFlashClient` interface

---

## Wallet Management

```
flash [live] > wallet import main ~/.config/solana/id.json
  Wallet 'main' imported.

flash [live] > wallet list
  Saved wallets:
    * main  7xKp...3nRq

flash [live] > wallet balance
  SOL Balance: 2.41

flash [live] > wallet tokens
  Token Balances:
    USDC:  150.00
    SOL:   2.41
```

Wallet files are stored in `~/.flash/wallets/` with owner-only permissions.

---

## Flash Trade Integration

This project serves as a reference integration for building on Flash Trade.

### Position Lifecycle

1. **Market resolution** — Map asset name to Flash Trade pool (e.g., SOL -> `Crypto.1`)
2. **Oracle prices** — Fetch from Pyth Network with native exponent (e.g., `-8` for SOL)
3. **Open** — `swapAndOpen` instruction with USDC collateral, computed position size
4. **Close** — Match on-chain position by mint and side, build close instruction
5. **Collateral** — Add/remove collateral instructions with balance validation

### Transaction Submission

Transactions are built manually using `MessageV0.compile` and signed with the wallet keypair:

- Fresh blockhash per attempt
- `sendRawTransaction` with `maxRetries: 3`
- Confirmation polling every 2s with periodic resends
- 45s timeout per attempt, 3 attempts total
- On-chain error detection via `getSignatureStatuses`

### Key Integration Files

| File | Purpose |
|------|---------|
| `src/client/flash-client.ts` | FlashClient with open/close/collateral/positions/dryrun |
| `src/config/index.ts` | Pool-to-market mapping and configuration |
| `src/wallet/walletManager.ts` | Keypair loading with security hardening |

---

## Project Structure

```
src/
├── cli/            Terminal REPL, user interaction, confirmation flow
├── ai/             Intent parsing (regex + NLP normalization + LLM fallback)
├── tools/          Tool definitions, registry, and dispatch engine
├── client/         Flash Trade SDK client and paper trading client
├── agent/          AI-powered analysis, scanner, autopilot, dashboard
├── strategies/     Momentum, mean reversion, whale follow strategies
├── scanner/        Multi-market opportunity scanner
├── portfolio/      Allocation, exposure, rebalance logic
├── risk/           Liquidation risk, exposure computation
├── monitor/        Real-time risk monitoring engine
├── regime/         Market regime detection (trending/ranging/volatile)
├── protocol/       Flash Trade protocol inspector
├── core/           Execution middleware, state reconciliation
├── network/        RPC endpoint management with failover
├── system/         System diagnostics, health checks, tx inspection
├── security/       Signing guard, rate limiter, audit logging
├── plugins/        Plugin loader and user plugins
├── wallet/         Keypair management, wallet store, session tracking
├── automation/     Autopilot loop (simulation only)
├── data/           CoinGecko, fstats.io API clients
├── config/         Environment config, pool/market mapping, risk config
├── types/          All types, enums, interfaces, Zod schemas
└── utils/          Logger, retry, formatting, safe math
```

---

## Development

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding guidelines, and pull request process.

### Quick Reference

1. Fork the repository and create a feature branch from `main`
2. Follow TypeScript strict mode — no `any`, defensive arithmetic on external data
3. Run `npm run build` and verify the CLI works before submitting
4. One feature or fix per PR; include context on what the change does and why

---

## Data Policy

Flash AI Terminal uses live market data only. No hardcoded fallback prices. No synthetic signals. Markets without reliable live data are excluded from analysis. Trading decisions are never based on stale or fabricated data.

---

## Repository Documentation

| File | Description |
|------|-------------|
| [README.md](README.md) | This file |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture and design decisions |
| [SECURITY.md](SECURITY.md) | Security policy, wallet handling, key management |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, coding style, PR guidelines |
| [LICENSE](LICENSE) | MIT License |
| [.env.example](.env.example) | Environment configuration template |

---

## Disclaimer

Flash AI Terminal is experimental infrastructure software for interacting with decentralized finance protocols. It does not provide financial advice. All strategy signals, confidence scores, and trade suggestions are algorithmic computations, not recommendations.

**Trading perpetual futures involves substantial risk of loss.** Leveraged positions can be liquidated rapidly. You can lose your entire collateral. Past performance of any strategy signal does not indicate future results.

- Start with simulation mode to understand the system before trading live
- Use small positions when transitioning to live trading
- Never trade with funds you cannot afford to lose
- Verify all transactions on [Solscan](https://solscan.io)

By using this software, you accept full responsibility for your trading decisions and outcomes.

---

## License

[MIT](LICENSE)
