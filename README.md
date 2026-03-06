# Flash AI Terminal

CLI trading intelligence tool for [Flash Trade](https://www.flash.trade/) perpetuals on Solana.

Analyze markets, detect opportunities, and manage risk using live blockchain data — directly from the terminal.

```
  ⚡ FLASH AI TERMINAL ⚡
  ━━━━━━━━━━━━━━━━━━━━━━━━

  Market Intelligence
  ─────────────────────────────────────────

  Regime:    TRENDING
  Markets:   9 scanned

  Top Opportunities
    1. SOL    LONG   72%
    2. BTC    SHORT  65%
    3. JUP    LONG   58%

flash [sim] >
```

---

## Installation

```bash
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
npm install
npm run build
npm link
```

Then run:

```bash
flash
```

---

## Getting Started

When you run `flash`, a mode selection screen appears:

```
  1 → Live Trading
  2 → Simulation
  3 → Exit
```

**Simulation** starts with a $10,000 paper balance using live market prices. No wallet or API keys needed.

**Live Trading** connects to Flash Trade on Solana. Requires a wallet.

The mode is locked for the entire session after selection.

---

## Commands

| Command | What it does |
|---|---|
| `scan` | Scan markets for opportunities |
| `analyze SOL` | Deep analysis on a specific market |
| `dashboard` | Market + portfolio overview |
| `portfolio` | Portfolio summary |
| `positions` | Open positions with PnL |
| `exposure` | Exposure by market and direction |
| `rebalance` | Portfolio balance suggestions |
| `risk` | Liquidation risk report |
| `suggest trade` | AI-powered trade suggestion |
| `whales` | Large on-chain positions |
| `volume` | Trading volume data |
| `oi` | Open interest across markets |
| `markets` | All available markets |
| `wallet` | Wallet status |
| `help` | List all commands |

### Trading

```
open 3x long SOL $500
close SOL long
add $200 to SOL long
remove $100 from ETH long
```

### Autopilot (Simulation Only)

```
autopilot start
autopilot stop
autopilot status
```

---

## Configuration

Create a `.env` file in the project root:

```env
RPC_URL=https://api.mainnet-beta.solana.com
ANTHROPIC_API_KEY=            # optional — enables AI natural language parsing
GROQ_API_KEY=                 # optional — free AI fallback (console.groq.com)
```

All commands work without API keys using built-in regex parsing. AI keys add natural language understanding for ambiguous inputs.

---

## Data Policy

Flash AI Terminal only uses **live market data**.

No synthetic prices, no fabricated signals, no hardcoded fallbacks. If data is unavailable for a market, that market is excluded — never estimated.

---

## Security

- Wallet keys are never printed or logged
- Wallet files stored with owner-only permissions (`0600`)
- Private key input is hidden during import
- Keys are zeroed from memory after use
- RPC connections require HTTPS

---

## Design Philosophy

- Real data over estimates
- Simple CLI workflows
- Risk-aware trading intelligence

---

## License

[MIT](LICENSE)

---

Flash AI Terminal is designed to provide clear market intelligence directly in the terminal while keeping the workflow simple and transparent.
