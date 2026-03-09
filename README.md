<p align="center">
  <img src="docs-site/public/logo.svg" width="80" height="80" alt="Flash Terminal" />
</p>

<h1 align="center">Flash Terminal</h1>

<p align="center">
  <strong>Deterministic Protocol Trading Terminal</strong>
</p>

<p align="center">
  A professional CLI trading workstation for the <a href="https://www.flash.trade/">Flash Trade</a> perpetual futures protocol on Solana.
</p>

<p align="center">
  <a href="https://flash-terminal-docs.vercel.app">Documentation</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="https://flash-terminal-docs.vercel.app/guide/getting-started">Getting Started</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="https://flash-terminal-docs.vercel.app/reference/trading-commands">Command Reference</a>
</p>

---

## Overview

Flash Terminal provides deterministic trade execution, protocol inspection, market observability, and portfolio risk management — directly from the terminal using live on-chain data.

```
$ flash

  FLASH TERMINAL
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Select Mode
    1) LIVE TRADING
    2) SIMULATION

> 2

flash [sim] > open 5x long SOL $500
flash [sim] > positions
flash [sim] > liquidations SOL
flash [sim] > inspect protocol
flash [sim] > exit
```

---

## Features

<table>
<tr>
<td width="50%">

### Deterministic Execution
Trade commands are parsed with structured regex patterns. Every command maps to exactly one action. No inference on critical paths.

```
open 5x long SOL $500
close SOL long
add $200 to BTC short
```

</td>
<td width="50%">

### Trade Risk Preview
Full position summary before signing — entry price, liquidation distance, risk classification, exposure impact, estimated fees.

```
Est. Entry:   $148.52
Est. Liq:     $81.69
Distance:     45.0%
Risk:         MEDIUM
```

</td>
</tr>
<tr>
<td width="50%">

### Protocol Inspection
Query Flash Trade protocol state directly — pools, markets, open interest, utilization, whale positions.

```
inspect protocol
inspect pool Crypto.1
inspect market SOL
```

</td>
<td width="50%">

### Market Observability
Liquidation clusters, funding rates, liquidity depth, protocol health — all from live on-chain data.

```
liquidations SOL
funding SOL
depth SOL
protocol health
```

</td>
</tr>
<tr>
<td width="50%">

### RPC Failover
Automatic endpoint switching on failure, slot lag detection, background health monitoring, connection pinning with 60s cooldown.

```
RPC: Helius (340ms) | Sync: OK
```

</td>
<td width="50%">

### Simulation Mode
Paper trade with real oracle prices. Simulate transactions on-chain without signing.

```
dryrun open 5x long SOL $100
```

</td>
</tr>
</table>

---

## Commands

| Category | Commands |
|----------|----------|
| **Trading** | `open`, `close`, `add`, `remove`, `positions`, `markets`, `trade history` |
| **Market Data** | `scan`, `analyze`, `volume`, `open interest`, `leaderboard`, `whale activity`, `fees` |
| **Observability** | `liquidations`, `funding`, `depth`, `protocol health` |
| **Portfolio** | `portfolio`, `dashboard`, `risk report`, `exposure`, `rebalance` |
| **Protocol** | `inspect protocol`, `inspect pool`, `inspect market` |
| **Wallet** | `wallet`, `wallet tokens`, `wallet balance`, `wallet list`, `wallet import`, `wallet use`, `wallet connect`, `wallet disconnect` |
| **Utilities** | `dryrun`, `monitor`, `watch`, `system status`, `rpc status`, `rpc test`, `tx inspect`, `doctor`, `degen` |

Full reference: **[COMMANDS.md](COMMANDS.md)** | **[Documentation](https://flash-terminal-docs.vercel.app/reference/trading-commands)**

---

## Architecture

```
User Input
    │
    ├── FAST_DISPATCH ─── single-token commands (instant)
    ├── Regex Parser ──── structured commands (deterministic)
    └── LLM Engine ────── natural language (read-only fallback)
            │
        ParsedIntent
            │
        ExecutionMiddleware
            │  logging → wallet check → readOnly guard
            │
        ToolEngine.dispatch()
            │
            ├── flash-tools ─── trading, wallet, market data
            ├── agent-tools ─── analysis, scanner, dashboard
            └── plugin-tools ── dynamically loaded
                    │
              IFlashClient
                    ├── FlashClient ──────── live (Flash SDK + Solana)
                    └── SimulatedFlashClient ─ paper trading (in-memory)
```

---

## Security

| Layer | Protection |
|-------|------------|
| **Signing Gate** | Full position summary + explicit confirmation before every trade |
| **Trade Limits** | Configurable caps on collateral, position size, and leverage |
| **Rate Limiter** | Max trades per minute + minimum delay between trades |
| **Audit Log** | Every trade attempt logged to disk (never includes key material) |
| **Wallet Security** | `0600` file permissions, path validation, symlink resolution |
| **RPC Validation** | HTTPS enforced, credential rejection, SSRF protection |
| **Program Whitelist** | Only approved Solana programs can be targeted |
| **Instruction Freeze** | Transaction instructions frozen after validation, before signing |
| **Key Scrubbing** | API keys masked in all log output |

Full security model: **[SECURITY.md](SECURITY.md)**

---

## Quick Start

```bash
git clone https://github.com/Abdr007/flash-terminal.git
cd flash-terminal
npm install
npm run build
```

**Configure:**

```bash
cp .env.example .env
# Set RPC_URL (required)
# Set ANTHROPIC_API_KEY or GROQ_API_KEY (optional — enables NLP)
```

**Run:**

```bash
flash                    # interactive terminal
flash markets            # list markets (non-interactive)
flash doctor             # run diagnostics
```

**Requirements:** Node.js >= 20 &nbsp;|&nbsp; Solana RPC endpoint (mainnet)

---

## Data Sources

| Source | Data |
|--------|------|
| **Flash SDK** | Position state, pool config, instruction building |
| **Pyth Network** | Real-time oracle prices |
| **Solana RPC** | Transaction submission and confirmation |
| **fstats API** | Volume, open interest, leaderboards, whale activity |
| **CoinGecko** | Market prices with 24h change |

All data is live. No hardcoded prices, no synthetic signals. Sources that are unreachable degrade gracefully.

---

## Documentation

Full documentation available at **[flash-terminal-docs.vercel.app](https://flash-terminal-docs.vercel.app)**

| Section | Content |
|---------|---------|
| **[Guide](https://flash-terminal-docs.vercel.app/guide/introduction)** | Introduction, architecture, trading, risk preview, simulation, analytics, infrastructure, security |
| **[Reference](https://flash-terminal-docs.vercel.app/reference/trading-commands)** | Complete command reference for all 50+ commands |

---

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, code style, and pull request guidelines.

## License

MIT — see **[LICENSE](LICENSE)**
