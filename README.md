# Flash AI Terminal

**AI-powered trading terminal for Flash Trade on Solana.**

Trade perpetual futures using natural language commands. Scan markets, manage positions, analyze risk, and execute on-chain — all from your terminal.

```
  ⚡ FLASH AI TERMINAL ⚡
  ━━━━━━━━━━━━━━━━━━━━━━━━

  LIVE TRADING MODE

  Wallet:  ABDR
  Network: mainnet-beta
  Balance: 0.2586 SOL

  Market Intelligence
  ─────────────────────────────────────────

  Regime:    TRENDING
  Markets:   9 scanned

  Top Opportunities
    1. SOL    LONG   72%
    2. BTC    SHORT  65%
    3. JUP    LONG   58%

flash [live] > open 2x long SOL $50
```

---

## Overview

Flash AI Terminal is an intelligent command-line trading interface for decentralized derivatives markets. It connects directly to the [Flash Trade](https://www.flash.trade/) protocol on Solana, enabling traders to open and close leveraged positions using simple commands or natural language.

The system combines an AI interpreter, a multi-strategy market scanner, a regime-aware risk engine, and a hardened transaction pipeline into a single CLI tool. Every piece of market data is live — no synthetic prices, no fabricated signals.

**Example commands:**

```
open 2x long SOL $10
scan market
show my portfolio
close sol long

# Natural language
open a 2x long sol position with ten dollars
scan the market for opportunities
how is my portfolio doing
```

---

## Key Features

- **AI Natural Language Trading** — Parse commands like "open a 2x long sol with ten dollars" via AI or Groq
- **Real-Time Market Scanning** — Scan all Flash Trade markets and rank opportunities by confidence score
- **Portfolio Analytics** — Exposure analysis, directional bias detection, correlation-aware allocation
- **Risk Management Engine** — Liquidation risk, position sizing limits, regime-adjusted leverage
- **Secure Wallet Integration** — Encrypted key storage, memory zeroing, path traversal prevention
- **Reliable Transaction Pipeline** — Manual tx building, retry with fresh blockhash, confirmation polling
- **CLI Optimized for Traders** — Fast command dispatch, command history, timeout protection
- **Flash Trade Protocol Integration** — Direct smart contract execution via Flash SDK + Pyth oracles
- **Built on Solana** — Sub-second finality, low fees, on-chain position management

---

## Flash Trade Integration

Flash AI Terminal demonstrates a complete trading pipeline interacting with the Flash Trade perpetual futures protocol. This section explains how the integration works for developers building on Flash Trade.

### Position Opening

The system uses Flash SDK's `swapAndOpen` for USDC-collateralized positions. The flow:

1. Resolve the target market to a Flash Trade pool (e.g., SOL → `Crypto.1`)
2. Fetch live oracle prices from Pyth Network with the correct exponent
3. Compute position size via `getSizeAmountFromLeverageAndCollateral`
4. Build the swap-and-open instruction set
5. Submit with compute budget and priority fee instructions

### Position Closing

Closing uses the Flash SDK `closePosition` flow:

1. Look up the user's on-chain position via `getUserPositions`
2. Match by target mint and side (Long/Short)
3. Fetch current Pyth oracle price for slippage calculation
4. Build and submit the close instruction

### Oracle Price Usage

Flash Trade requires oracle prices with the **native Pyth exponent** (e.g., `-8` for SOL). The system fetches prices via `PythHttpClient` from Pythnet and passes `priceData.price` and `priceData.exponent` directly to the SDK — never rescaling.

### Collateral Validation

Before any trade, the system checks:

- Minimum collateral: $10
- USDC token balance sufficient for the collateral amount
- SOL balance sufficient for transaction fees (>0.01 SOL)
- Leverage within market limits (e.g., 1.1x–100x for SOL/BTC/ETH)
- No duplicate position on the same market/side

### Transaction Submission

Transactions are built manually using `MessageV0.compile` and signed with the wallet keypair. The system does not use the SDK's `sendTransactionV3` — it handles submission directly for reliability:

- Fresh blockhash per attempt
- `sendRawTransaction` with `maxRetries: 3`
- Confirmation polling every 2 seconds with periodic resends
- 45-second timeout per attempt, 2 attempts total
- On-chain error detection via `getSignatureStatuses`

### Developer Reference

This project can serve as an example integration for developers building on Flash Trade. Key files:

| File | Purpose |
|------|---------|
| `src/client/flash-client.ts` | Full FlashClient with open/close/collateral/positions |
| `src/config/index.ts` | Pool-to-market mapping and configuration |
| `src/wallet/walletManager.ts` | Keypair loading with security hardening |
| `src/wallet/connection.ts` | Solana connection factory with HTTPS validation |

---

## Architecture

```
User Command
     │
     ▼
┌─────────────────────────────────────────────┐
│           AI Interpreter                    │
│  Fast dispatch → Regex parser → AI fallback  │
└──────────────────┬──────────────────────────┘
                   │ ParsedIntent
                   ▼
┌─────────────────────────────────────────────┐
│           Tool Dispatcher                   │
│  ActionType → Tool lookup → Execute         │
└───────┬──────────┬──────────┬───────────────┘
        │          │          │
        ▼          ▼          ▼
   ┌────────┐ ┌────────┐ ┌──────────┐
   │Scanner │ │Portfolio│ │ Trading  │
   │        │ │ Engine  │ │  Tools   │
   └───┬────┘ └───┬────┘ └────┬─────┘
       │          │            │
       ▼          ▼            ▼
┌─────────────────────────────────────────────┐
│           Risk Engine                       │
│  Leverage limits · Position sizing ·        │
│  Exposure caps · Correlation checks         │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│          Execution Engine                   │
│  SimulatedFlashClient │ FlashClient (live)  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│         Flash Trade Protocol                │
│  Flash SDK · Pyth Oracles · Solana RPC      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
            Solana Blockchain
```

### Layer Descriptions

| Layer | Responsibility |
|-------|---------------|
| **AI Interpreter** | Converts user input to structured intents. Tries exact-match dispatch first, then regex parsing, then AI for natural language. |
| **Tool Dispatcher** | Maps each `ActionType` to a registered tool function. Executes with error isolation and timeout protection. |
| **Scanner** | Runs three strategies (momentum, mean reversion, whale follow) across all markets. Regime detection adjusts strategy weights dynamically. |
| **Portfolio Engine** | Tracks exposure, directional bias, and capital allocation. Produces rebalance suggestions based on risk constraints. |
| **Risk Engine** | Enforces position limits, leverage bounds, directional caps, and correlation-aware exposure limits before any trade. |
| **Execution Engine** | Builds, signs, and submits Solana transactions. Handles confirmation polling, retry logic, and trade mutex. |
| **Flash Trade Protocol** | The on-chain perpetual futures program. Manages positions, collateral, and liquidations via smart contracts. |

See [docs/architecture.md](docs/architecture.md) for the complete system architecture with data flow diagrams.

---

## Installation

```bash
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
npm install
npm run build
npm link
```

Start the terminal:

```bash
flash
```

Verify your environment:

```bash
flash doctor
```

### Environment Configuration

```bash
cp .env.example .env
```

**Required:**

```env
RPC_URL=https://api.mainnet-beta.solana.com
```

**Optional (AI features):**

```env
ANTHROPIC_API_KEY=sk-ant-...     # AI natural language parsing
GROQ_API_KEY=gsk_...             # Groq — AI fallback
```

**Trading defaults:**

```env
SIMULATION_MODE=true             # true = paper trading, false = real transactions
DEFAULT_POOL=Crypto.1
DEFAULT_SLIPPAGE_BPS=150         # 1.5%
COMPUTE_UNIT_PRICE=50000         # Priority fee in microLamports
```

All commands work without AI API keys. The built-in regex parser handles standard commands. AI keys add natural language support for complex or conversational inputs.

> **Note:** Use a premium RPC provider (Helius, Triton, QuickNode) for reliable live trading. The default public RPC is rate-limited.

---

## Usage

### Mode Selection

When you run `flash`, you select a mode:

```
  1 → Live Trading     (real transactions, requires wallet + SOL + USDC)
  2 → Simulation       (paper trading, $10K balance)
  3 → Exit
```

**Simulation mode** uses live market prices but executes trades against a local paper balance. No wallet required.

**Live trading mode** signs and submits real transactions to the Solana blockchain. Requires a funded wallet.

The mode is locked for the entire session.

### Standard Commands

| Command | Description |
|---------|-------------|
| `scan` | Scan all markets for trade opportunities |
| `analyze SOL` | Deep analysis of a specific market |
| `dashboard` | Combined market and portfolio overview |
| `portfolio` | Portfolio summary with capital allocation |
| `positions` | Open positions with unrealized PnL |
| `risk` | Liquidation risk report |
| `markets` | Available trading markets by pool |
| `wallet tokens` | All token balances in wallet |
| `help` | Full command reference |

### Trading Commands

```
open 2x long SOL $50
open 5x short BTC $200
close SOL long
add $100 to SOL long
remove $50 from ETH short
```

### Natural Language Commands

```
open a 2x long sol position with ten dollars
scan the market for opportunities
show me my positions
how is my portfolio doing
close my sol long position
```

### Autopilot (Simulation Only)

```
autopilot start       Start automated scan-and-trade loop
autopilot stop        Stop autopilot
autopilot status      Current autopilot state and signals
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

## Safety Features

- **Minimum Collateral Validation** — Rejects trades below $10 at the tool layer, before any on-chain interaction
- **Trade Confirmation Prompts** — Every trade requires explicit "yes" confirmation before execution
- **Duplicate Trade Protection** — Checks for existing positions on the same market/side before opening
- **Risk Warnings** — Extreme leverage (20x+, 50x+) triggers visible warnings with liquidation distance
- **Input Validation** — Anchored regex patterns, control character sanitization, 1000-char input limit
- **Secure Key Management** — Keys zeroed after loading, wallet files stored with 0600 permissions

## Security

- **Anchored Command Parsing** — All trade regex patterns anchored with `^...$` to prevent injection via trailing commands
- **Shell Injection Prevention** — No user input is ever passed to shell execution; all parsing is regex-based
- **Sanitized Input Handling** — Control characters (null bytes, tabs, newlines) stripped and collapsed before parsing
- **Secure Wallet Storage** — `~/.flash/wallets/` with 0700 directory, 0600 files, symlink traversal prevention
- **API Key Scrubbing** — Logger automatically redacts API keys, private keys are never logged
- **HTTPS Enforcement** — RPC connection factory validates HTTPS protocol on all endpoints

See [SECURITY.md](SECURITY.md) for the complete security policy.

---

## Performance

- **Fast Command Dispatch** — Single-token commands bypass the AI interpreter entirely via `FAST_DISPATCH` lookup table
- **Parallel Market Data** — `Promise.allSettled` fetches prices, volume, OI, and whale data concurrently
- **Bounded Memory Caches** — All caches have max entry counts (50–100) and TTL eviction (5–60s)
- **Transaction Retry** — 2-attempt pipeline with fresh blockhash, periodic resends during confirmation polling
- **RPC Latency Detection** — Startup health check warns if average RPC latency exceeds 600ms

---

## Strategy Engine

Three independent strategies produce signals that are aggregated with regime-weighted scoring:

| Strategy | Detects | Data Source |
|----------|---------|-------------|
| Momentum | Strong directional moves | Price changes, volume trends |
| Mean Reversion | Oversold/overbought conditions | Price deviation, open interest |
| Whale Follow | Large position clustering | On-chain whale activity |

The market regime (trending, ranging, volatile, whale-dominated, low-liquidity) dynamically adjusts strategy weights. High-volatility regimes reduce leverage. Low-liquidity regimes reduce position sizes.

---

## Wallet Management

Import a wallet:

```
wallet import main ~/.config/solana/id.json
```

Switch between wallets:

```
wallet list
wallet use main
```

Check balances:

```
wallet balance
wallet tokens
```

Wallet files are stored in `~/.flash/wallets/` with owner-only permissions.

---

## Developer Extension

Flash AI Terminal is designed for extension. Developers can:

**Add Trading Strategies** — Implement the strategy interface in `src/strategies/` and register in the signal aggregator. Each strategy receives market data and returns a directional signal with confidence.

**Add New Tools** — Define a tool in `src/tools/flash-tools.ts` or `src/agent/agent-tools.ts` with a Zod parameter schema, register it in the tool registry, and map a new `ActionType` in the engine.

**Extend the Risk Engine** — Add new risk checks in `src/config/risk-config.ts`. The `checkTradeRisk` function runs before every trade and can block execution with a reason.

**Integrate New Protocols** — Implement the `IFlashClient` interface for a new DEX or protocol. The tool layer and AI layer are protocol-agnostic — only the execution engine needs to change.

**Custom AI Prompts** — Modify the system prompt in `src/ai/interpreter.ts` to add new action types or change how natural language maps to intents.

---

## Data Policy

Flash AI Terminal uses **live market data only**. No hardcoded fallback prices. No synthetic signals. Markets without reliable live data are excluded from analysis. Trading decisions are never based on stale or fabricated data.

---

## Why This Project Matters

DeFi trading today requires navigating complex UIs, managing multiple browser tabs, and understanding raw blockchain data. Flash AI Terminal demonstrates how AI interfaces can simplify this:

- **AI meets on-chain trading** — Natural language removes the learning curve for position management
- **CLI for power users** — Terminal-native workflow for developers and algorithmic traders
- **Open integration reference** — A working example of how to build on Flash Trade, from oracle prices to transaction submission

This project bridges AI interfaces, on-chain trading execution, and CLI developer tooling into a single coherent system.

---

## Roadmap

- [ ] Autopilot in live mode with configurable risk limits
- [ ] Advanced strategies with technical indicators
- [ ] Web dashboard for visual portfolio monitoring
- [ ] Historical analytics and trade journaling
- [ ] Multi-protocol support (additional Solana DEXs)

---

## Development

```bash
npm run dev          # Run with tsx (hot reload)
npm run build        # Compile TypeScript
npm run test         # Run test suite
npm run test:watch   # Watch mode
npm start            # Run compiled output
```

See [docs/project-structure.md](docs/project-structure.md) for module documentation and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

---

## Disclaimer

Flash AI Terminal is a tool for interacting with DeFi protocols. It does **not** provide financial advice. All strategy signals, confidence scores, and trade suggestions are algorithmic computations, not recommendations.

**Trading perpetual futures involves substantial risk of loss.** Leveraged positions can be liquidated rapidly. You can lose your entire collateral. Past performance of any strategy signal does not indicate future results.

- Start with simulation mode to understand the system
- Use small positions when transitioning to live trading
- Never trade with funds you cannot afford to lose
- Verify all transactions on [Solscan](https://solscan.io) before and after execution

By using this software, you accept full responsibility for your trading decisions and outcomes.

---

## License

[MIT](LICENSE)
