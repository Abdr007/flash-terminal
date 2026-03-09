<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="Flash Terminal" />
</p>

<h1 align="center">Flash Terminal</h1>

<p align="center">
  <em>Deterministic Protocol Trading Terminal</em>
</p>

<p align="center">
  Professional CLI workstation for the <a href="https://www.flash.trade/">Flash Trade</a> perpetual futures protocol on Solana.<br/>
  Execute trades, inspect protocol state, monitor risk, and observe markets — all from the command line.
</p>

<p align="center">
  <a href="https://flash-terminal-docs.vercel.app"><img src="https://img.shields.io/badge/docs-flash--terminal-26d97f?style=flat-square" alt="Documentation" /></a>&nbsp;
  <a href="https://github.com/Abdr007/flash-terminal/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>&nbsp;
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square" alt="Node.js" /></a>&nbsp;
  <a href="https://solana.com"><img src="https://img.shields.io/badge/network-Solana-9945FF?style=flat-square" alt="Solana" /></a>
</p>

<p align="center">
  <a href="https://flash-terminal-docs.vercel.app">Documentation</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="https://flash-terminal-docs.vercel.app/guide/getting-started">Quick Start</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="https://flash-terminal-docs.vercel.app/reference/trading-commands">Commands</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="CONTRIBUTING.md">Contributing</a>
</p>

<br/>

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
flash [sim] > liquidations SOL
flash [sim] > funding SOL
flash [sim] > inspect protocol
flash [sim] > exit
```

<br/>

## Why Flash Terminal

- **Deterministic** — Trade commands parsed with structured regex. Same input, same action. Always.
- **Observable** — Liquidation clusters, funding rates, liquidity depth, protocol health — live on-chain data.
- **Auditable** — Every trade attempt logged. State reconciliation verifies positions on-chain.
- **Safe** — 9-layer signing pipeline: parsing → validation → limits → rate limiter → confirmation → audit → simulation → RPC health → reconciliation.
- **Reliable** — Multi-endpoint RPC failover, slot lag detection, 60s cooldown, connection pinning.

<br/>

## Features

<table>
<tr>
<td width="50%" valign="top">

#### Trade Execution
```
open 5x long SOL $500
close SOL long
add $200 to BTC short
remove $100 from ETH long
```
Deterministic regex parsing. Full confirmation panel with risk preview before signing.

</td>
<td width="50%" valign="top">

#### Risk Preview
```
CONFIRM TRANSACTION
──────────────────────────────
  Market:      SOL LONG
  Leverage:    5x
  Collateral:  $500.00
  Size:        $2,500.00
  Est. Fee:    $2.00

  Est. Entry:  $148.52
  Est. Liq:    $121.79
  Distance:    18.0%
  Risk:        HIGH
```

</td>
</tr>
<tr>
<td width="50%" valign="top">

#### Protocol Inspection
```
inspect protocol    → program ID, pools, OI, volume
inspect pool Crypto.1   → pool config, utilization
inspect market SOL  → OI breakdown, whale positions
```
Direct read of Flash Trade on-chain state.

</td>
<td width="50%" valign="top">

#### Market Observability
```
liquidations SOL    → clusters by price zone
funding SOL         → OI imbalance & fee dashboard
depth SOL           → liquidity around current price
protocol health     → protocol-wide metrics
protocol status     → connection & SDK health overview
```
Live data from Pyth, fstats, and on-chain state.

</td>
</tr>
<tr>
<td width="50%" valign="top">

#### Infrastructure
```
RPC: Helius (340ms) | Sync: OK
```
Multi-endpoint failover, slot lag detection, background health monitoring, state reconciliation every 60s.

</td>
<td width="50%" valign="top">

#### Simulation
```
dryrun open 5x long SOL $100
```
Paper trading with real oracle prices. Preview transactions without signing. Mode locked at startup.

</td>
</tr>
</table>

<br/>

## Commands

| Category | Commands |
|:---------|:---------|
| **Trading** | `open` · `close` · `add` · `remove` · `positions` · `position debug` · `markets` · `trade history` |
| **Analytics** | `scan` · `analyze` · `volume` · `open interest` · `leaderboard` · `whale activity` · `fees` |
| **Observability** | `liquidations` · `funding` · `depth` · `protocol health` |
| **Portfolio** | `portfolio` · `dashboard` · `risk report` · `exposure` · `rebalance` |
| **Protocol** | `inspect protocol` · `inspect pool` · `inspect market` |
| **Wallet** | `wallet` · `wallet tokens` · `wallet balance` · `wallet list` · `wallet import` · `wallet use` · `wallet connect` · `wallet disconnect` |
| **System** | `dryrun` · `monitor` · `watch` · `system status` · `rpc status` · `rpc test` · `tx inspect` · `doctor` · `degen` |

> **50+ commands** — [Full reference](https://flash-terminal-docs.vercel.app/reference/trading-commands)

<br/>

## Architecture

Flash Terminal acts as a deterministic interface to the Flash protocol. User commands are parsed and routed through the tool engine. The tool engine interacts with the Flash SDK, which communicates with the Flash program through Solana RPC. Market prices are retrieved from the same Pyth Hermes oracle feeds used by the protocol. All calculations — liquidation prices, fees, leverage limits — use the same logic as the Flash protocol. This ensures Flash Terminal always reflects the true state of the protocol.

```
User
  │
  ▼
Flash Terminal CLI
  │
  ├─ FAST_DISPATCH ─── single-token commands (instant)
  ├─ Regex Parser ──── structured trade commands (deterministic)
  └─ NLP Fallback ──── natural language queries (read-only)
          │
      ParsedIntent
          │
      Market Resolver ── resolveMarket() → canonical market ID
          │
      Execution Middleware ── logging → wallet check → readOnly guard
          │
      Tool Engine
          │
          ├── flash-tools ─── trading, wallet, market data
          ├── agent-tools ─── analysis, dashboard, observability
          └── plugin-tools ── dynamically loaded at startup
                  │
            IFlashClient
                  ├── FlashClient ──────────── live (Flash SDK → Solana RPC → Flash Protocol)
                  └── SimulatedFlashClient ─── paper trading (in-memory)

Data Sources:
  Prices ──────── Pyth Hermes (same oracle as Flash protocol)
  Positions ───── Flash SDK perpClient.getUserPositions()
  Liquidation ─── Flash SDK getLiquidationPriceContractHelper()
  Fees ────────── Flash SDK CustodyAccount (on-chain)
  Leverage ────── Flash SDK PoolConfig MarketConfig
  OI / Volume ─── fstats API (aggregated protocol state)
```

<br/>

## Security

| Layer | Description |
|:------|:------------|
| **Regex Parsing** | Deterministic intent extraction — no model inference on trade paths |
| **Zod Validation** | Parameter type and range enforcement at parse boundary |
| **Trade Limits** | Configurable caps: collateral, position size, leverage |
| **Rate Limiter** | Max trades/minute + minimum delay between submissions |
| **Confirmation Gate** | Full summary with risk preview — requires explicit `yes` |
| **Signing Audit** | Every attempt logged to `~/.flash/signing-audit.log` |
| **Pre-Send Simulation** | On-chain simulation before broadcast catches program errors |
| **RPC Health Check** | Latency, slot lag, and reachability verified before signing |
| **State Reconciliation** | Post-trade on-chain verification — blockchain is authoritative |

> [Full security model →](SECURITY.md)

<br/>

## Quick Start

```bash
# Clone and build
git clone https://github.com/Abdr007/flash-terminal.git
cd flash-terminal
npm install
npm run build

# Configure
cp .env.example .env
# → Set RPC_URL (required)
# → Set ANTHROPIC_API_KEY or GROQ_API_KEY (optional, enables NLP)

# Run
flash                    # interactive terminal (select mode on startup)
flash markets            # list markets (non-interactive)
flash doctor             # system diagnostics
```

> **Requirements:** Node.js >= 20 · Solana RPC endpoint (mainnet)

<br/>

## Data Sources

| Source | Data | Cache |
|:-------|:-----|:------|
| **Flash SDK** | Position state, pool config, fees, liquidation math, leverage limits | Real-time |
| **Pyth Hermes** | Oracle prices (same feeds used by Flash protocol) | 5s |
| **Solana RPC** | Transaction submission, confirmation, on-chain state | Real-time |
| **fstats API** | Volume, OI, leaderboards, whale positions | Per-request |

Flash Terminal is a deterministic protocol interface.

All market data, liquidation calculations, fees, and risk metrics are derived directly from Flash protocol state, on-chain accounts, or official oracle feeds. Liquidation prices use `getLiquidationPriceContractHelper()`. Fees and maintenance margin are read from `CustodyAccount`. Leverage limits from `PoolConfig`.

The terminal does not generate trading signals, predictions, or synthetic analytics. Unreachable sources degrade gracefully with stale cache fallback.

<br/>

## Documentation

Full documentation at **[flash-terminal-docs.vercel.app](https://flash-terminal-docs.vercel.app)**

| | |
|:--|:--|
| **[Guide](https://flash-terminal-docs.vercel.app/guide/introduction)** | Introduction · Architecture · Trading · Risk Preview · Simulation · Analytics · Infrastructure · Security |
| **[Reference](https://flash-terminal-docs.vercel.app/reference/trading-commands)** | Complete command reference for all 50+ commands |

<br/>

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, code style, and pull request guidelines.

## License

MIT — **[LICENSE](LICENSE)**
