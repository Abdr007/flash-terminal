![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D20-blue)
![TypeScript](https://img.shields.io/badge/typescript-strict-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Solana](https://img.shields.io/badge/solana-mainnet--beta-purple)

# Flash AI Terminal

A command-line trading terminal for the [Flash Trade](https://www.flash.trade/) perpetual futures protocol on Solana. Combines natural language command parsing, real-time market analysis, risk monitoring, and on-chain execution in a single CLI tool.

```
  FLASH AI TERMINAL

  SIMULATION MODE

  Network: mainnet-beta
  Balance: $10,000.00 (paper)

  Market Intelligence
  --------------------

  Regime:    TRENDING
  Markets:   24 scanned

  Top Opportunities
    1. SOL    LONG   72%
    2. ETH    SHORT  65%
    3. JUP    LONG   58%

flash [sim] > _
```

---

## Features

- **CLI trading interface** -- Open, close, and manage leveraged perpetual positions from the terminal
- **Natural language commands** -- Type commands in plain English; the AI interpreter handles the rest
- **Transaction preview** -- Compile and simulate transactions without signing (dry run)
- **RPC failover** -- Automatic endpoint switching on failure, high latency, or slot lag
- **Market scanner** -- Multi-strategy opportunity detection (momentum, mean reversion, whale follow)
- **Risk monitoring** -- Real-time liquidation distance alerts with configurable thresholds
- **Protocol inspector** -- Query Flash Trade protocol state, pool utilization, and market depth
- **Trade journal** -- Full trade history with entry/exit prices, PnL, and fees

---

## Installation

Requires Node.js >= 20.0.0.

```bash
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
npm install
npm run build
```

---

## Running the Terminal

```bash
npm start
```

Or link globally:

```bash
npm link
flash
```

The terminal starts in simulation mode by default. No wallet or API keys required to begin.

---

## CLI Demonstration

### Markets

```
flash [sim] > markets

  FLASH TRADE MARKETS
  ──────────────────────────────────────────

  Pool            Markets
  ──────────────────────────────────────────
  Crypto.1        SOL, BTC, ETH, ZEC, BNB
  Virtual.1       XAG, XAU, CRUDEOIL, EUR, GBP, USDJPY, USDCNH
  Governance.1    JTO, JUP, PYTH, RAY, HYPE, MET, KMNO
  Community.1     PUMP, BONK, PENGU
  Community.2     WIF
  Trump.1         FARTCOIN
  Ore.1           ORE
```

### Scanner

```
flash [sim] > scan

  Market Opportunities
  ──────────────────────────────────────────

  #   Market   Signal    Confidence   Regime
  ──────────────────────────────────────────
  1   SOL      LONG      72%          TRENDING
  2   ETH      SHORT     65%          RANGING
  3   JUP      LONG      58%          TRENDING
```

### Natural Language Trading

```
flash [sim] > open a 2x long position on sol with ten dollars

  CONFIRM TRANSACTION — Open Position
  ─────────────────────────────────

  Market:     SOL LONG
  Collateral: $10.00 USDC
  Leverage:   2x
  Size:       $20.00
  Pool:       Crypto.1

  Execute trade?
```

### Portfolio

```
flash [sim] > positions

  Open Positions
  ──────────────────────────────────────────────────────────────

  Market  Side   Lev   Size      Collat    Entry     Mark      PnL        Fees
  ──────────────────────────────────────────────────────────────────────────────
  SOL     LONG   2x    $20.00    $10.00    $148.52   $151.20   +$0.36     $0.02
```

---

## Transaction Preview

The `dryrun` command compiles a transaction and runs Solana simulation without signing or submitting.

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

The transaction is compiled against current on-chain state and simulated through the Solana runtime. The private key is never accessed.

---

## Market Monitor

The `monitor` command displays a live-updating market table that refreshes every 5 seconds.

```
flash [sim] > monitor

  MARKET MONITOR
  12:34:56 PM  |  Refreshing every 5s  |  Press any key to exit
  ──────────────────────────────────────────────────────────────

  Asset         Price    24h Change   Open Interest   Long / Short
  ──────────────────────────────────────────────────────────────────
  SOL         $148.52       +3.20%          $2.14M        62 / 38
  BTC      $63,200.00       -0.40%        $438.00K        48 / 52
  ETH       $3,420.00       +0.70%         $32.00K        61 / 39
  JUP          $1.24       +5.10%         $18.50K        71 / 29
  BONK         $0.00       -1.30%          $8.20K        45 / 55
```

Prices from CoinGecko. Open interest and long/short ratio from fstats.io. Markets sorted by total open interest.

---

## Architecture Overview

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
                    │  Intent Validator    │
                    │  Zod schema check    │
                    └──────────┬──────────┘
                               │
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

Every trade passes through a confirmation gate before signing. The user must explicitly approve each transaction after reviewing the full position summary.

---

## Safety Design

The terminal enforces multiple layers of protection before any transaction reaches the blockchain.

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **Confirmation gate** | Full position summary displayed before every trade | Prevents accidental execution |
| **Trade mutex** | Per-market/side lock on concurrent submissions | Prevents race conditions |
| **Signature cache** | 120-second TTL deduplication | Prevents duplicate transactions |
| **Rate limiter** | Configurable trades-per-minute and minimum delay | Prevents rapid-fire submissions |
| **Trade limits** | Configurable max collateral, position size, leverage | Prevents oversized trades |
| **RPC failover** | Automatic endpoint switching on failure or lag | Prevents stuck transactions |
| **Wallet isolation** | Home-directory restriction, symlink resolution, file size limit | Prevents path traversal |
| **Key protection** | Keys never logged, zeroed after use, import input hidden | Prevents key exposure |
| **HTTPS enforcement** | RPC URLs must use HTTPS (HTTP only for localhost) | Prevents cleartext traffic |
| **Dry run sandbox** | Transaction compiled and simulated, never signed | Prevents accidental sends |

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

## Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

See [.env.example](.env.example) for all available options. At minimum, set `RPC_URL` for a premium Solana RPC provider.

The terminal works without any configuration using the public Solana RPC, but rate limits apply.

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

### Type Check

```bash
npx tsc --noEmit
```

### Run Tests

```bash
npm run test
```

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
