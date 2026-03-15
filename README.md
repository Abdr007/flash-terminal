<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="Flash Terminal" />
</p>

<h1 align="center">Flash Terminal</h1>

<p align="center">
  <strong>Production-grade Solana perpetual futures trading CLI</strong>
</p>

<p align="center">
  Execute leveraged trades on <a href="https://www.flash.trade/">Flash Trade</a> from the command line<br/>
  with deterministic execution, automated risk controls, and real-time monitoring.
</p>

<p align="center">
  <a href="https://solana.com"><img src="https://img.shields.io/badge/Solana-Mainnet-9945FF?style=flat-square&logo=solana&logoColor=white" alt="Solana" /></a>&nbsp;
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>&nbsp;
  <a href="https://www.flash.trade"><img src="https://img.shields.io/badge/Flash_SDK-Integrated-26d97f?style=flat-square" alt="Flash SDK" /></a>&nbsp;
  <a href="https://github.com/Abdr007/flash-terminal/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" /></a>&nbsp;
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-%3E%3D20-brightgreen?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>&nbsp;
  <img src="https://img.shields.io/badge/Status-Stable_(v1.x_maintenance)-green?style=flat-square" alt="Stable" />
</p>

<p align="center">
  <a href="https://flash-terminal-docs.vercel.app">Documentation</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://flash-terminal-docs.vercel.app/guide/getting-started">Quick Start</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://flash-terminal-docs.vercel.app/reference/trading-commands">Commands</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## Overview

Flash Terminal is a command line trading interface for the [Flash Trade](https://www.flash.trade/) perpetual futures protocol on Solana. It connects directly to the Flash protocol through the official SDK, executes trades on-chain, and provides real-time position management, risk monitoring, and protocol analytics.

All protocol parameters — fees, leverage limits, maintenance margins, liquidation math — are derived from on-chain state. Prices come from Pyth Hermes, the same oracle feeds used by the protocol. Flash Terminal does not fabricate data, generate predictions, or modify protocol logic.

---

## Key Features

| Feature | Description |
|:--------|:------------|
| **Live Trading** | Open, close, and manage leveraged positions on Flash Trade via Solana mainnet |
| **Simulation Mode** | Paper trading with real oracle prices — no on-chain transactions |
| **TP/SL Automation** | Set take-profit and stop-loss targets with spike protection |
| **Real-Time Monitoring** | Live market tables with Pyth oracle prices refreshed every 5 seconds |
| **Risk Monitor** | Background liquidation monitoring with tiered alerts (SAFE / WARNING / CRITICAL) |
| **Protocol Inspection** | Inspect pools, markets, fees, open interest, and protocol parameters directly from chain |
| **Multi-Pool Support** | Trade across Flash Trade pools including Crypto, Virtual, Governance, and Community |
| **AI Command Parser** | Natural language command interpretation with deterministic regex fallback |
| **Safety Systems** | Signing guard, circuit breaker, kill switch, crash recovery, and RPC failover |

---

## Architecture

Flash Terminal uses a layered architecture where each layer communicates only with its adjacent layers.

```
CLI Interface ─── AI Interpreter ─── Tool Engine ─── Flash Client ─── Solana
```

```
┌────────────────────────────────────────────────────────────────┐
│  CLI INTERFACE                                                  │
│  Interactive REPL · Command registry · Status bar               │
└────────────────────────┬───────────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────────┐
│  COMMAND ENGINE                                                 │
│  Regex parser · NLP fallback · Zod validation · Signing guard   │
└────────────────────────┬───────────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────────┐
│  PROTOCOL TOOLS                                                 │
│  Trading · Wallet · Market data · Dashboard · Risk analysis     │
└────────────────────────┬───────────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────────┐
│  DATA INFRASTRUCTURE                                            │
│  FlashClient (live) · SimulatedFlashClient (paper)              │
│  Pyth Hermes · fstats API · Solana RPC                          │
└────────────────────────┬───────────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────────┐
│  FLASH TRADE PROTOCOL                                           │
│  On-chain program · CustodyAccount · PositionAccount · Pools    │
└────────────────────────────────────────────────────────────────┘
```

---

## Getting Started

### Install

**npm (recommended):**

```bash
npm install -g flash-terminal
```

**Homebrew (macOS):**

```bash
brew tap Abdr007/flash-terminal
brew install flash-terminal
```

**From source:**

```bash
git clone https://github.com/Abdr007/flash-terminal.git
cd flash-terminal
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
```

Set the required variables in `.env`:

| Variable | Required | Description |
|:---------|:---------|:------------|
| `RPC_URL` | Yes | Solana mainnet RPC endpoint |
| `WALLET_PATH` | Yes | Path to Solana keypair file |
| `SIMULATION_MODE` | No | `true` (default) for paper trading, `false` for live |
| `ANTHROPIC_API_KEY` | No | Enables AI-powered natural language commands |

**Requirements:** Node.js >= 20 · Solana RPC endpoint (mainnet-beta)

### Wallet Setup

Flash Terminal loads your wallet from a Solana CLI keypair file:

```bash
# Generate a new keypair (if you don't have one)
solana-keygen new -o ~/.config/solana/id.json

# Or use an existing keypair
export WALLET_PATH=~/.config/solana/id.json
```

For live trading, ensure your wallet has:
- SOL for transaction fees (~0.01 SOL per trade)
- USDC for collateral deposits

### Run

```bash
flash
```

Or from source:

```bash
npm start        # production
npm run dev      # development (tsx)
```

On startup, the terminal presents a mode selection:

```
$ flash

  ⚡ FLASH TERMINAL v1.0.0
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Trading Interface for Flash Trade

  Select Mode

    1) LIVE TRADING
       Execute real transactions on Flash Trade.

    2) SIMULATION
       Test strategies using paper trading.

> 2

flash [sim] >
```

Simulation mode is selected by default. Live trading requires a configured wallet and RPC endpoint.

---

## CLI Overview

Flash Terminal is an interactive REPL. Type commands directly at the prompt. The built-in regex parser handles all commands deterministically. When an AI key is configured, natural language input is also supported as a fallback.

The prompt indicates the current mode:

```
flash [sim] >     # Simulation mode
flash [live] >    # Live trading mode
```

Run `help` at any time to see available commands. Run `doctor` to verify system health.

---

## Basic Commands

| Command | Description |
|:--------|:------------|
| `help` | Show all available commands |
| `dashboard` | Portfolio overview with risk metrics |
| `positions` | View all open positions |
| `markets` | List available trading markets |
| `monitor` | Live market table (refreshes every 5s) |
| `wallet` | Wallet address and SOL balance |
| `wallet tokens` | Token balances (USDC, USDT, etc.) |
| `trade history` | View recent trade journal |
| `fees` | Protocol fee rates |
| `system status` | System health overview |
| `doctor` | Full system diagnostics |
| `exit` | Shut down the terminal |

---

## Trading Commands

Open a leveraged position:

```
open 2x long SOL $100
open 5x short BTC $500
open 10x long ETH $250
```

Close a position:

```
close SOL long
close BTC short
```

Manage collateral:

```
add $50 to SOL long
remove $20 from ETH long
```

Preview a trade without executing:

```
dryrun open 5x long SOL $100
```

**Parameters:**

- **Leverage** — multiplier (e.g. `2x`, `5x`, `10x`). Per-market limits enforced from protocol config.
- **Side** — `long` or `short`.
- **Market** — asset symbol (`SOL`, `BTC`, `ETH`, `XAU`, `NVDA`, etc.).
- **Collateral** — USD amount (e.g. `$100`, `$500`).

---

## TP/SL Automation

Set take-profit and stop-loss targets inline when opening a position:

```
open 2x long SOL $100 tp $160 sl $120
```

Or set targets on an existing position:

```
set tp SOL long $160
set sl SOL long $120
```

Remove targets:

```
remove tp SOL long
remove sl SOL long
```

View active targets:

```
tp status
```

The TP/SL engine evaluates targets every 5 seconds using live Pyth oracle prices. Spike protection requires 2 consecutive confirmation ticks before triggering a close — preventing false triggers on momentary price wicks. The circuit breaker and kill switch override TP/SL execution if active.

---

## Earn (Liquidity)

Provide liquidity to Flash Trade pools and earn yield:

```
earn                          # View all pools with live yield metrics
earn info crypto              # Detailed pool information
earn deposit $100 crypto      # Deposit USDC → mint FLP (auto-compound)
earn withdraw 100% crypto     # Burn FLP → receive USDC
earn stake $200 governance    # Stake FLP tokens for USDC rewards
earn unstake 25% governance   # Unstake FLP tokens
earn claim                    # Claim LP/staking USDC rewards
earn positions                # View your active LP positions
earn best                     # Rank pools by yield + risk
earn simulate $1000 crypto    # Project yield returns for a deposit
earn dashboard                # Liquidity portfolio overview
```

**FLP** — Auto-compounding liquidity token. Fees are reinvested automatically. **sFLP** — Staked FLP where fees are paid out in USDC hourly.

---

## FAF Token Staking

Manage FAF governance token staking, revenue sharing, and VIP tiers:

```
faf                    # FAF staking dashboard
faf stake 1000         # Stake FAF for revenue sharing + VIP
faf unstake 500        # Request unstake (90-day linear unlock)
faf claim              # Claim FAF rewards + USDC revenue
faf tier               # View VIP tier levels and benefits
faf rewards            # Show pending rewards + revenue
faf referral           # Referral status + claimable rebates
faf points             # Voltage points tier + multiplier
```

**VIP Tiers** — Staking FAF unlocks fee discounts, higher referral rebates, and DCA discounts (Level 0–5). **Revenue Sharing** — 50% of protocol revenue distributed to stakers in USDC.

---

## Safety Systems

| Layer | Description |
|:------|:------------|
| **Signing Guard** | Pre-sign confirmation gate with full trade summary. Enforces configurable trade limits and rate limiting (default: 10 trades/min, 3s minimum delay). |
| **Circuit Breaker** | Halts all trading when cumulative session or daily loss exceeds configurable thresholds. Requires manual reset. |
| **Trading Gate (Kill Switch)** | Master switch to disable all trade execution instantly. Blocks all 4 trade operations when active. |
| **Transaction Simulation** | On-chain simulation before broadcast catches program errors before any funds are at risk. |
| **Program Whitelist** | Only approved Solana programs (Flash Trade + system) can be targeted by transaction instructions. |
| **Instruction Freeze** | `Object.freeze()` on the instruction array after validation prevents mutation before signing. |
| **Duplicate Detection** | Signature cache (120s TTL) prevents resubmission of recently broadcast transactions. |
| **Crash Recovery** | Trade journal records pending transactions. On restart, the recovery engine verifies on-chain status and reconciles state. |
| **State Reconciliation** | Periodic sync with blockchain. On-chain state is always authoritative over local state. |
| **RPC Failover** | Automatic endpoint switching on slot lag (>50 slots), high latency, or failure. Supports multiple backup endpoints. |

---

## Data Sources

| Data | Source | Details |
|:-----|:-------|:--------|
| **Prices** | Pyth Hermes | Same oracle feeds used by Flash Trade on-chain. Validated for staleness (<30s), confidence (<2%), and deviation (<50%). |
| **Positions** | Flash SDK | Fetched from on-chain `PositionAccount` via `perpClient.getUserPositions()`. |
| **Wallet Balances** | Solana RPC | `getBalance()` for SOL, `getParsedTokenAccountsByOwner()` for tokens. 30s cache, invalidated post-trade. |
| **Open Interest** | fstats API | Protocol analytics with response size limits (2MB max) and parameter sanitization. |
| **Protocol Parameters** | On-chain `CustodyAccount` | Fees, leverage limits, and maintenance margins read from chain. Liquidation math uses Flash SDK helpers. |

No values are fabricated, estimated, or hardcoded. Unreachable sources degrade gracefully with stale cache fallback.

---

## Testing

```bash
npm test
```

The test suite covers trading execution, simulation, risk monitoring, security gates (signing guard, circuit breaker, trading gate), TP/SL automation, market resolution, protocol fee validation, event monitoring, earn/liquidity, FAF staking, swap validation, and infrastructure. All tests run against strict TypeScript with zero compiler errors.

---

## Security

**Private keys** are loaded from Solana CLI keypair files with path validation, symlink resolution, and file size limits (1KB max). Keys are never logged, never transmitted, and zeroed from memory on wallet disconnect or session timeout (15 minutes idle).

**Keypair integrity** is verified before every signing operation. If the keypair has been zeroed or corrupted, the transaction is rejected with a clear error.

**Log scrubbing** masks API keys (`sk-ant-*`, `gsk_*`), base58 strings, and query parameters in all log output. Log files are created with `0o600` permissions (owner-only access).

**RPC URLs** are validated on startup. HTTPS is enforced (HTTP only for localhost). Private IP ranges and embedded credentials are rejected.

---

## Logs

| Log | Location | Purpose |
|:----|:---------|:--------|
| **Signing audit** | `~/.flash/signing-audit.log` | Records every trade attempt with timestamp, market, side, collateral, leverage, and result. Never logs keys or signatures. |
| **Application log** | Configured via `LOG_FILE` env var | General application logging with auto-rotation at 10MB. Keeps `.old` and `.old.2` backups. |
| **Reconciliation** | `~/.flash/logs/reconcile.log` | State sync events between CLI and blockchain. 2MB rotation. |

---

## Configuration

All configuration is managed via environment variables (see `.env.example` for the full reference).

### Trade Limits & Rate Limiting

```bash
MAX_COLLATERAL_PER_TRADE=0    # Max USD per trade (0 = unlimited)
MAX_POSITION_SIZE=0            # Max USD position size (0 = unlimited)
MAX_LEVERAGE=0                 # Max leverage multiplier (0 = market default)
MAX_TRADES_PER_MINUTE=10       # Rate limit
MIN_DELAY_BETWEEN_TRADES_MS=3000
```

### Risk Controls (Circuit Breaker)

```bash
MAX_SESSION_LOSS_USD=500       # Halt trading after session loss exceeds this
MAX_DAILY_LOSS_USD=1000        # Halt trading after daily loss exceeds this
MAX_PORTFOLIO_EXPOSURE=10000   # Max total portfolio exposure (USD)
```

When cumulative losses exceed these thresholds, the circuit breaker halts all trading until the session is reset.

### RPC Failover

```bash
BACKUP_RPC_1=https://your-backup-rpc-1.example.com
BACKUP_RPC_2=https://your-backup-rpc-2.example.com
```

The RPC manager monitors all endpoints and automatically fails over on connection failure, high latency (>5s), or slot lag (>50 slots behind network tip).

### Dynamic Compute Tuning

```bash
FLASH_DYNAMIC_CU=true          # Enable dynamic compute unit estimation
FLASH_CU_BUFFER_PCT=20         # Buffer % added to simulated CU usage
COMPUTE_UNIT_LIMIT=600000      # Static CU limit (used when dynamic is off)
COMPUTE_UNIT_PRICE=500000      # Priority fee in microLamports
```

When `FLASH_DYNAMIC_CU=true`, the terminal simulates transactions to estimate compute usage and adds a configurable buffer. This reduces costs while ensuring transactions land.

### Alert Webhooks

```bash
ALERT_WEBHOOK_URL=https://your-webhook.example.com/alerts
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx
ALERT_MIN_SEVERITY=warning     # info, warning, or critical
```

Alert consumers dispatch JSON payloads on: trade execution, risk limit triggered, RPC failure, and circuit breaker activation. All webhook requests are fire-and-forget with 5s timeout — they never block the trading pipeline.

### Shadow Trading

```bash
SHADOW_TRADING=false           # Enable shadow risk mirror
```

When enabled, trades are mirrored to a parallel risk engine for comparison analysis without execution. Useful for strategy validation.

### Session & Logging

```bash
SESSION_TIMEOUT_MS=900000      # Wallet idle timeout (15 min default)
LOG_FILE=~/.flash/flash.log    # Log file path (auto-rotates at 10MB)
FLASH_LOG_LEVEL=info           # debug, info, warn, error
FLASH_LOG_FORMAT=text          # text or json (structured logging)
```

JSON log format outputs structured entries with `timestamp`, `level`, `module`, `message`, `request_id`, and `data` fields.

### Protocol Validation

```bash
FLASH_STRICT_PROTOCOL=false    # Throw on liquidation price divergence
```

When enabled, divergence between local and SDK liquidation calculations throws an error instead of logging a warning. Recommended for automated/agent usage.

### Agent Mode (NO_DNA)

```bash
NO_DNA=1                       # Enable non-human operator mode
```

When set, disables TUI elements, outputs structured JSON, auto-confirms trades, and uses plain text prompts. Implements the [no-dna.org](https://no-dna.org) standard for CLI agent integration.

See `.env.example` for the complete configuration reference with types and defaults.

---

## Example Session

```
$ flash

  ⚡ FLASH TERMINAL v1.0.0

  Select Mode
    1) LIVE TRADING
    2) SIMULATION

> 2

flash [sim] > markets

  AVAILABLE MARKETS
  ─────────────────────────────
  SOL  BTC  ETH  BNB  XAU  XAG
  JTO  JUP  PYTH  RAY  BONK  WIF
  NVDA  TSLA  AAPL  AMD  AMZN  ...

flash [sim] > open 2x long SOL $100

  TRADE PREVIEW
  ─────────────────────────────
  Market:      SOL-PERP
  Side:        LONG
  Leverage:    2x
  Collateral:  $100.00
  Size:        $200.00
  Entry:       $148.52

  Confirm? (yes/no) > yes

  ✓ Position opened

flash [sim] > positions

  OPEN POSITIONS
  ─────────────────────────────────────────────────
  Market  Side  Lev  Size     Collateral  Entry    PnL
  SOL     LONG  2x   $200.00  $100.00     $148.52  $0.34

flash [sim] > close SOL long

  ✓ Position closed — PnL: +$0.34

flash [sim] > exit
```

---

## Project Structure

```
src/
├── agent/          Agent tools (analysis, dashboard, observability)
├── ai/             NLP interpreter, intent parsing
├── cli/            Terminal REPL, command registry, status bar, completions
├── client/         FlashClient (live) and SimulatedFlashClient (paper)
├── config/         Config loader, pool mapping, market discovery, env validation
├── core/           TX engine, state reconciliation, execution middleware
├── data/           PriceService (Pyth Hermes), FStatsClient
├── earn/           Liquidity pool registry, yield analytics, pool data
├── journal/        Trade journal, crash recovery engine
├── monitor/        Risk monitor, event monitor
├── network/        RPC manager, TPU client, multi-endpoint failover
├── observability/  Metrics, alert hooks, webhook/Slack consumers
├── orders/         Limit order engine
├── plugins/        Dynamic plugin loader
├── portfolio/      Portfolio manager, rebalance, allocation, risk
├── protocol/       Protocol inspector (pool/market/OI inspection)
├── regime/         Market regime detector, volatility, liquidity, trend
├── risk/           TP/SL engine, exposure analysis, liquidation risk
├── runtime/        Recovery engine
├── scanner/        Market scanner
├── security/       Signing guard, circuit breaker, trading gate
├── shadow/         Risk mirror, shadow engine
├── strategies/     Mean reversion, momentum, whale follow
├── system/         System diagnostics, maintenance
├── token/          FAF token integration, staking, VIP tiers
├── tools/          Tool engine, trading/earn/FAF/swap tools
├── transaction/    ALT resolver, ATA resolver, instruction aggregator
├── types/          Central types, enums, Zod schemas
├── utils/          Logger, formatting, protocol math, market resolver
└── wallet/         Wallet manager, session, store, token balances
```

---

## Docker

```bash
docker build -t flash-terminal .
docker run -it --env-file .env flash-terminal
```

The Docker image uses a multi-stage build (builder + production) with a non-root user for security. Defaults to simulation mode.

---

## Contributing

Contributions are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, code style, and pull request guidelines.

---

## Maintenance

Flash Terminal is in **stable maintenance mode** (v1.x). Future updates are limited to:

- Bug fixes and security patches
- Dependency updates (via Dependabot)
- Minor improvements

No architectural rewrites or new protocol features are planned. The system is production-ready with minimal maintenance overhead.

---

## Disclaimer

Flash Terminal executes real blockchain transactions on Solana mainnet when operating in live mode. Leveraged trading carries significant risk of loss. Users are solely responsible for understanding the risks of perpetual futures trading and for all transactions executed through this terminal.

Flash Terminal is provided as-is. It is not financial advice. Always verify protocol state independently before executing high-value trades.

---

## License

MIT — see **[LICENSE](LICENSE)** for details.

---

<p align="center">
  <strong>Flash Terminal v1.0.0</strong><br/>
  A production-grade Solana perpetual futures trading CLI.<br/>
  Built with strict TypeScript. Shipped with zero critical issues.
</p>
