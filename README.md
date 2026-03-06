# Flash AI Terminal

CLI trading intelligence tool for [Flash Trade](https://www.flash.trade/) perpetuals on Solana.

Analyze markets, detect opportunities, and manage risk using live blockchain data.

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

Run the terminal:

```bash
flash
```

Verify your environment:

```bash
flash doctor
```

---

## Modes

When you run `flash`, you choose a mode:

```
  1 → Live Trading
  2 → Simulation
  3 → Exit
```

**Simulation** — $10,000 paper balance with live market prices. No wallet needed.

**Live Trading** — Real transactions on Flash Trade. Requires a wallet.

The mode is locked for the entire session.

---

## Commands

| Command | Description |
|---|---|
| `scan` | Scan markets for opportunities |
| `analyze SOL` | Deep analysis on a specific market |
| `dashboard` | Market + portfolio overview |
| `portfolio` | Portfolio summary |
| `positions` | Open positions with PnL |
| `exposure` | Exposure by market and direction |
| `risk` | Liquidation risk report |
| `suggest trade` | AI-powered trade suggestion |
| `whales` | Large on-chain positions |
| `markets` | All available markets |
| `wallet` | Wallet status |
| `help` | All commands |

### Trading

```
open 3x long SOL $500
close SOL long
add $200 to SOL long
```

### Autopilot (Simulation Only)

```
autopilot start
autopilot stop
autopilot status
```

---

## Architecture

```
CLI Terminal
     │
     ▼
AI Command Interpreter
     │
     ├── Market Scanner ── Strategy Engine ── Regime Detection
     │
     ├── Portfolio Engine ── Risk Analysis
     │
     └── Trading Client
              │
              ▼
       Flash Trade + Solana
```

User commands are parsed by the AI interpreter, routed to the intelligence layer for market analysis and risk checks, then executed through the Flash Trade client on Solana.

---

## Configuration

Create a `.env` file in the project root:

```env
RPC_URL=https://api.mainnet-beta.solana.com
ANTHROPIC_API_KEY=            # optional — AI natural language parsing
GROQ_API_KEY=                 # optional — free AI fallback (console.groq.com)
```

All commands work without API keys using built-in parsing. AI keys add natural language support for complex inputs.

---

## Data Policy

Flash AI Terminal only uses **live market data**.

No synthetic prices or fabricated signals. Markets without reliable data are excluded from analysis.

---

## Security

- Wallet keys are never printed or logged
- Wallet files stored with owner-only permissions
- Private key input is hidden during import
- Keys zeroed from memory after use
- RPC connections require HTTPS

---

## License

[MIT](LICENSE)

---

Flash AI Terminal is designed to provide clear market intelligence directly in the terminal while keeping the workflow simple and transparent.
