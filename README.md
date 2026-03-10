<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="Flash Terminal" />
</p>

<h1 align="center">FLASH TERMINAL</h1>

<p align="center">
  <strong>Deterministic CLI Trading Interface for Flash Trade</strong>
</p>

<p align="center">
  A protocol-aligned command line terminal for analyzing and executing trades<br/>
  on <a href="https://www.flash.trade/">Flash Trade</a> using live on-chain data.
</p>

<p align="center">
  <a href="https://solana.com"><img src="https://img.shields.io/badge/Solana-Mainnet-9945FF?style=flat-square&logo=solana&logoColor=white" alt="Solana" /></a>&nbsp;
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>&nbsp;
  <a href="https://www.flash.trade"><img src="https://img.shields.io/badge/Flash_SDK-Integrated-26d97f?style=flat-square" alt="Flash SDK" /></a>&nbsp;
  <a href="https://github.com/Abdr007/flash-terminal/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" /></a>&nbsp;
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-%3E%3D20-brightgreen?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
</p>

<p align="center">
  <a href="https://flash-terminal-docs.vercel.app">Documentation</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://flash-terminal-docs.vercel.app/guide/getting-started">Quick Start</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://flash-terminal-docs.vercel.app/reference/trading-commands">Commands</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## Overview

Flash Terminal is a deterministic command line interface for the [Flash Trade](https://www.flash.trade/) perpetual futures protocol on Solana.

It interacts directly with the Flash protocol using the official SDK and live data sources. Every protocol parameter — fees, leverage limits, maintenance margins, liquidation math — is derived from on-chain state or official SDK helpers.

Flash Terminal does not generate synthetic analytics, modify protocol logic, or fabricate data. It acts as a transparent, protocol-aligned interface to Flash Trade.

**Core principles:**

- **Protocol parameters** come from on-chain `CustodyAccount` state
- **Liquidation math** uses the Flash SDK `getLiquidationPriceContractHelper()`
- **Fees and leverage** are read from `CustodyAccount.fees` and `CustodyAccount.pricing`
- **Oracle prices** come from [Pyth Hermes](https://hermes.pyth.network) — the same feeds used by the Flash protocol on-chain
- **Trade execution** delegates entirely to Flash SDK `PerpetualsClient` — no custom instruction building

---

## Terminal Preview

```
$ flash

  ⚡ FLASH TERMINAL
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Trading Interface for Flash Trade

  Select Mode

    1) LIVE TRADING
       Execute real transactions on Flash Trade.

    2) SIMULATION
       Test strategies using paper trading.

> 2

flash [sim] > open 5x long SOL $500
flash [sim] > positions
flash [sim] > protocol verify
flash [sim] > monitor
flash [sim] > exit
```

---

## Key Features

| Feature | Description |
|:--------|:------------|
| **Deterministic Protocol Interface** | All calculations derived from Flash SDK and on-chain `CustodyAccount` state |
| **CLI Trading** | Open, close, and manage leveraged positions with deterministic command parsing |
| **Protocol Inspection** | Inspect pools, markets, fees, OI, and protocol parameters directly from chain |
| **Real-Time Monitoring** | Live market monitoring with Pyth Hermes oracle prices (5s refresh) |
| **Risk Analysis** | Liquidation monitoring with hysteresis alerts (SAFE / WARNING / CRITICAL) |
| **Protocol Verification** | Built-in `protocol verify` command performs a 6-check alignment audit |
| **Infrastructure Telemetry** | RPC health, oracle latency, slot lag, divergence status in status bar |
| **Simulation Mode** | Paper trading with real oracle prices — no on-chain transactions |
| **Multi-Pool Support** | Trades across 8 Flash Trade pools (Crypto, Virtual, Governance, Community) |

---

## System Architecture

Flash Terminal follows a layered architecture. Each layer has a single responsibility and communicates only with adjacent layers.

```
┌─────────────────────────────────────────────────────────────────┐
│  USER                                                           │
│  CLI input / Interactive REPL                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  CLI INTERFACE                                                  │
│  Regex parser · FAST_DISPATCH · NLP fallback · Command registry │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  COMMAND ENGINE                                                 │
│  Tool engine · Market resolver · Execution middleware            │
│  Signing guard · Rate limiter · Confirmation gate               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  PROTOCOL TOOLS                                                 │
│  flash-tools (trading, wallet, market data)                     │
│  agent-tools (analysis, dashboard, observability)               │
│  plugin-tools (dynamically loaded at startup)                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  DATA INFRASTRUCTURE                                            │
│  IFlashClient interface                                         │
│    ├── FlashClient ────── Flash SDK → Solana RPC → Flash Trade  │
│    └── SimulatedFlashClient ── Paper trading (in-memory)        │
│                                                                 │
│  Pyth Hermes ── Oracle prices (same feeds as protocol)          │
│  fstats API ─── OI, volume, leaderboards, whale positions       │
│  Solana RPC ─── Wallet balances, transaction broadcast          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  FLASH TRADE PROTOCOL                                           │
│  On-chain program · CustodyAccount · PositionAccount · Pools    │
└─────────────────────────────────────────────────────────────────┘
```

| Layer | Responsibility |
|:------|:---------------|
| **CLI Interface** | Parses user input into structured `ParsedIntent` objects using deterministic regex |
| **Command Engine** | Routes intents through validation, rate limiting, signing guards, and confirmation |
| **Protocol Tools** | Implements 50+ commands for trading, analysis, and protocol inspection |
| **Data Infrastructure** | Fetches live data from Flash SDK, Pyth, Solana RPC, and fstats |
| **Flash Trade Protocol** | On-chain program — the source of truth for all protocol state |

---

## Data Sources

| Data | Source | Cache | Validation |
|:-----|:-------|:------|:-----------|
| **Prices** | Pyth Hermes oracle | 5s TTL | Staleness <30s, confidence <2%, deviation <50% |
| **Open Interest** | fstats analytics API | 15s TTL | Response size <2MB, streaming abort |
| **Fees** | `CustodyAccount.fees` (on-chain) | ~60s (slot-based) | `ProtocolParameterError` on corruption |
| **Leverage** | `CustodyAccount.pricing.maxLeverage` (on-chain) | ~60s (slot-based) | Invariant validation |
| **Wallet Balances** | Solana RPC | 30s TTL | Numeric guards |
| **Liquidation** | Flash SDK `getLiquidationPriceContractHelper()` | Real-time | Divergence detection (0.5% threshold) |
| **Positions** | Flash SDK `perpClient.getUserPositions()` | Real-time | `Number.isFinite()` on all fields |

Flash Terminal does not generate trading signals, predictions, or synthetic analytics. All data originates from on-chain state, official SDK helpers, or authorized oracle feeds. Unreachable sources degrade gracefully with stale cache fallback.

---

## Protocol Alignment

Flash Terminal ensures correctness through direct protocol integration:

**Fee rates** are read from `CustodyAccount.fees.openPosition` and `CustodyAccount.fees.closePosition`, decoded with `RATE_POWER = 1e9` (Flash SDK `RATE_DECIMALS = 9`).

**Leverage** is read from `CustodyAccount.pricing.maxLeverage`, decoded with `BPS_POWER = 1e4` (Flash SDK `BPS_DECIMALS = 4`).

**Maintenance margin** is derived as `1 / maxLeverage` — matching the Flash protocol definition.

**Liquidation prices** in live mode use the SDK's `getLiquidationPriceContractHelper()`. A divergence check compares CLI calculations against the SDK result with a 0.5% threshold. Optional strict mode (`FLASH_STRICT_PROTOCOL=true`) will reject trades on divergence.

**Protocol invariants** are validated before every trade: fee rates must be finite, non-negative, and below 10%. Maintenance margin must be below 100%. Invalid `CustodyAccount` data throws `ProtocolParameterError` — never silently falls back.

### `protocol verify`

The built-in verification command performs 6 real-time checks against the protocol:

```
flash > protocol verify

  PROTOCOL VERIFICATION
  ─────────────────────────────
  ✓ RPC Health         Slot 312847291 · 142ms latency
  ✓ Oracle Freshness   SOL $148.52 · 2s age
  ✓ CustodyAccount     SOL/BTC/ETH fees loaded (on-chain)
  ✓ Fee Engine         Open/close rates match CustodyAccount
  ✓ Liquidation Engine Long/short symmetry verified
  ✓ Protocol Params    Leverage, margin, fees within bounds

  Status: HEALTHY
```

All checks use real protocol data. Zero synthetic validation.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/Abdr007/flash-terminal.git
cd flash-terminal

# Install dependencies
npm install

# Build
npm run build

# Configure environment
cp .env.example .env
# → Set RPC_URL (required — Solana mainnet RPC endpoint)
# → Set ANTHROPIC_API_KEY or GROQ_API_KEY (optional — enables NLP fallback)

# Run
npm start
```

**Requirements:** Node.js >= 20 · Solana RPC endpoint (mainnet-beta)

**Alternative:**

```bash
# Development mode (no build step)
npm run dev

# Run diagnostics
flash doctor
```

---

## Commands

### Trading

```bash
open 5x long SOL $500          # Open a leveraged position
close SOL long                  # Close a position
add $200 to BTC short           # Add collateral to reduce leverage
remove $100 from ETH long       # Remove excess collateral
positions                       # View all open positions
trade history                   # View trade journal
markets                         # List available markets
dryrun open 5x long SOL $100   # Preview without executing
```

### Protocol Inspection

```bash
protocol verify                 # Run protocol alignment audit
inspect protocol                # Program ID, pools, OI, volume
inspect pool Crypto.1           # Pool configuration and markets
inspect market SOL              # OI breakdown, whale positions
fees                            # Protocol fee data and distribution
```

### Monitoring & Analysis

```bash
monitor                         # Live market table (5s refresh)
dashboard                       # Portfolio dashboard with risk metrics
risk report                     # Liquidation risk assessment
exposure                        # Portfolio exposure breakdown
scan                            # Market scanner across all assets
volume                          # Protocol volume data
open interest                   # OI across markets
```

### Infrastructure

```bash
system status                   # System health overview
rpc status                      # RPC endpoint health and slot lag
rpc test                        # Latency test across endpoints
doctor                          # Full system diagnostics
wallet                          # Wallet info and balances
wallet tokens                   # Token balances
```

> **50+ commands** — [Full reference →](https://flash-terminal-docs.vercel.app/reference/trading-commands)

---

## Security & Safety

| Layer | Description |
|:------|:------------|
| **Deterministic Parsing** | Trade commands parsed with structured regex — no model inference on execution paths |
| **Zod Schema Validation** | Parameter type and range enforcement at parse boundary (leverage ≤100x, collateral ≤$10M) |
| **Program ID Whitelist** | Only approved Solana programs (Flash Trade + system) can be targeted by instructions |
| **Instruction Freeze** | `Object.freeze()` on instruction array after validation — prevents mutation before signing |
| **Pre-Send Simulation** | On-chain transaction simulation before broadcast catches program errors in ~200ms |
| **Trade Limits** | Configurable caps: `MAX_COLLATERAL_PER_TRADE`, `MAX_POSITION_SIZE`, `MAX_LEVERAGE` |
| **Rate Limiter** | Max trades per minute + minimum delay between submissions (default 10/min, 3s gap) |
| **Confirmation Gate** | Full trade summary with risk preview — requires explicit `yes` before signing |
| **Signing Audit Log** | Every trade attempt logged to `~/.flash/signing-audit.log` (never logs keys) |
| **RPC Health Verification** | Latency, slot lag, and reachability verified before signing |
| **State Reconciliation** | Post-trade on-chain verification — blockchain state is authoritative |
| **Protocol Parameter Validation** | NaN, Infinity, negative rates, >10% fees → `ProtocolParameterError` (never silently continues) |
| **Numeric Guardrails** | 122 `Number.isFinite()` checks across the codebase prevent NaN/Infinity propagation |

---

## Protocol Alignment Audit

A full 12-section protocol alignment audit has been performed.

**Result: `PROTOCOL ALIGNED`**

| Section | Status |
|:--------|:-------|
| SDK Integration (PerpetualsClient, PoolConfig, CustodyAccount) | Aligned |
| On-Chain Account Parsing (RATE_POWER, BPS_POWER, USD_DECIMALS) | Aligned |
| Live Data Pipeline (Pyth, fstats, RPC) | Aligned |
| Fee Engine (CustodyAccount fee extraction and calculation) | Aligned |
| Leverage & Margin Model (maxLeverage, maintenanceMarginRate) | Aligned |
| Liquidation Engine (SDK helper + divergence detection) | Aligned |
| Trade Execution Pipeline (SDK → sign → simulate → broadcast) | Aligned |
| Telemetry & Infrastructure (real metrics, no synthetic data) | Aligned |
| Protocol Verify Command (6 real-time checks) | Aligned |
| Live Update Validation (5s–20s refresh intervals) | Aligned |
| Error Handling (122 numeric guards, ProtocolParameterError) | Aligned |

**Key findings:**
- All protocol math flows through Flash SDK — no reimplementation
- On-chain `CustodyAccount` is the single source of truth for fees, leverage, and margins
- Liquidation divergence detection with 0.5% threshold and optional strict mode
- Program ID whitelist + instruction freeze prevents transaction tampering
- Zero critical silent failures — all corrupted data throws immediately

---

## Project Structure

```
src/
├── cli/                 # Terminal REPL, command registry, status bar, renderer
├── client/              # FlashClient (live) and SimulatedFlashClient (paper trading)
├── tools/               # Tool engine, flash-tools (trading), doctor diagnostics
├── agent/               # Agent tools (analysis, dashboard, observability)
├── config/              # Pool config, market mapping, leverage discovery
├── data/                # PriceService (Pyth), FStatsClient, market hours
├── network/             # RPC manager, multi-endpoint failover, slot lag detection
├── monitor/             # Risk monitor, event monitor
├── protocol/            # Protocol inspector (pool/market/OI inspection)
├── security/            # Signing guard, trade limits, rate limiter, audit log
├── wallet/              # Wallet manager, keypair loading, token balances
├── risk/                # Exposure analysis, liquidation risk assessment
├── core/                # Execution middleware, state reconciliation
├── plugins/             # Dynamic plugin loader
├── utils/               # Protocol fees, liquidation math, formatting, logger
└── types/               # All types, enums, Zod schemas, interfaces
```

---

## Contributing

Contributions are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, code style, and pull request guidelines.

Areas of interest:
- New protocol inspection tools
- Additional market analytics
- Performance improvements
- Test coverage

---

## Disclaimer

Flash Terminal executes real blockchain transactions on Solana mainnet when operating in live mode. Leveraged trading carries significant risk of loss. Users are solely responsible for understanding the risks of perpetual futures trading and for all transactions executed through this terminal.

Flash Terminal is provided as-is. It is not financial advice. Always verify protocol state independently before executing high-value trades.

---

## License

MIT — **[LICENSE](LICENSE)**
