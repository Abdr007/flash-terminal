# Flash Terminal — Command Reference

Flash Terminal is a deterministic protocol interaction tool for Flash Trade on Solana.

Every command operates on **live blockchain data**. There are no predictions, no automated strategies, and no AI-driven trade execution. The terminal provides transparent access to protocol state, market data, and trade execution — nothing more.

---

## Philosophy

- **Deterministic execution** — commands produce the same result given the same protocol state.
- **Protocol interaction** — direct access to Flash Trade smart contracts via Solana RPC.
- **Data transparency** — all displayed data comes from on-chain state or verified off-chain APIs (fstats, CoinGecko, Pyth).
- **Risk awareness** — risk metrics are computed from real position data, never estimated or projected.

---

## Command Categories

| # | Category | Purpose |
|---|---|---|
| 1 | **Trading** | Execute and manage leveraged positions |
| 2 | **Market Data & Analytics** | Inspect live market conditions |
| 3 | **Portfolio & Risk** | Assess portfolio state and risk exposure |
| 4 | **Protocol Inspection** | Inspect Flash Trade protocol internals |
| 5 | **Wallet** | Manage wallet connections and balances |
| 6 | **Utilities** | System tools, dry-run, monitoring |

---

## 1. Trading

Commands that interact directly with Flash Trade smart contracts.

| Command | Description | Example |
|---|---|---|
| `open` | Open a leveraged position | `open 5x long SOL $500` |
| `close` | Close an existing position | `close SOL long` |
| `add` | Add collateral to a position | `add $200 to SOL long` |
| `remove` | Remove collateral from a position | `remove $100 from ETH long` |
| `positions` | View all open positions | `positions` |
| `markets` | List all available trading markets | `markets` |
| `trade history` | View recent trade journal | `trade history` |

### Parameters

**open** `<leverage>x <long|short> <market> $<collateral>`
- `leverage` — multiplier (e.g. `2x`, `5x`, `10x`). Per-market limits enforced.
- `long` / `short` — trade direction.
- `market` — asset symbol (e.g. `SOL`, `BTC`, `ETH`, `XAU`).
- `collateral` — USD amount to deposit as collateral.

**close** `<market> <long|short>`
- Closes the position on the specified market and side.

**add** `$<amount> to <market> <long|short>`
- Increases collateral, reducing effective leverage.

**remove** `$<amount> from <market> <long|short>`
- Withdraws collateral, increasing effective leverage.

### Aliases

| Input | Resolves to |
|---|---|
| `position` | `positions` |
| `trades`, `journal`, `history` | `trade history` |
| `market` | `markets` |

---

## 2. Market Data & Analytics

Commands that display live market data. All data sourced from on-chain state, fstats API, CoinGecko, and Pyth oracles.

| Command | Description | Example |
|---|---|---|
| `scan` | Scan all markets for trading opportunities | `scan` |
| `analyze <asset>` | Deep analysis with strategy signals | `analyze SOL` |
| `volume` | Protocol-wide trading volume | `volume` |
| `open interest` | Open interest breakdown by market | `open interest` |
| `leaderboard` | Top traders ranked by PnL or volume | `leaderboard` |
| `whale activity` | Recent large positions across markets | `whale activity` |
| `fees` | Protocol fee data | `fees` |
| `liquidations <asset>` | Liquidation clusters around current price | `liquidations SOL` |
| `funding <asset>` | Funding rate dashboard | `funding SOL` |
| `depth <asset>` | Liquidity depth around current price | `depth SOL` |
| `protocol health` | Protocol-wide health metrics | `protocol health` |

### Details

**scan** — Evaluates all markets using momentum, mean reversion, and whale-follow signals. Returns ranked opportunities with confidence scores and regime labels.

**analyze** — Single-market deep dive. Shows price action, 24h change, open interest, funding rate, and computed strategy signals (momentum, mean reversion, whale follow).

**volume** — Aggregated trading volume with daily breakdown. Supports period filtering (`7d`, `30d`, `all`).

**leaderboard** — Top traders by PnL or volume. Supports metric and period filtering.

**liquidations** — Estimates liquidation price clusters by distributing open interest across leverage bands (2x–50x). Includes whale position liquidation levels when available. Shows distance from current price for each cluster.

**funding** — Single-market view shows current funding rate, projected 1h/4h/24h accumulation, and OI balance with imbalance detection. Without a market argument, shows a funding rate overview table for all markets sorted by absolute rate.

**depth** — Estimates liquidity distribution around the current price using OI and exponential decay modeling. Displays bid/ask depth bands with visual bar chart. Useful for assessing available liquidity at various price levels.

**protocol health** — Aggregated protocol view: active markets, total OI, long/short ratio, 30d activity stats (volume, trades, traders, fees), top markets by OI, and infrastructure metrics (RPC latency, block height).

### Aliases

| Input | Resolves to |
|---|---|
| `oi` | `open interest` |
| `whales` | `whale activity` |
| `fee` | `fees` |
| `rankings` | `leaderboard` |
| `liquidation` | `liquidations` |

---

## 3. Portfolio & Risk

Commands that assess current portfolio state and risk metrics. All calculations use live position data.

| Command | Description | Example |
|---|---|---|
| `portfolio` | Portfolio overview (balance, positions, PnL) | `portfolio` |
| `dashboard` | Full system dashboard (portfolio + markets + risk) | `dashboard` |
| `risk report` | Position-level liquidation risk assessment | `risk report` |
| `exposure` | Portfolio exposure breakdown by market and direction | `exposure` |
| `rebalance` | Analyze portfolio for rebalancing opportunities | `rebalance` |

### Details

**risk report** — For each open position: distance to liquidation, risk level (healthy / warning / critical), and exposure summary (long/short/net).

**exposure** — Breaks down notional exposure by market and direction. Flags concentration risk when a single market exceeds 30% of total capital.

**dashboard** — Combined view: portfolio state, top markets, position table, risk summary.

### Aliases

| Input | Resolves to |
|---|---|
| `balance`, `account` | `portfolio` |
| `dash` | `dashboard` |
| `risk` | `risk report` |
| `capital`, `portfolio state` | Portfolio capital state |
| `portfolio exposure` | `exposure` |
| `portfolio rebalance` | `rebalance` |

---

## 4. Protocol Inspection

Commands for inspecting Flash Trade protocol state on-chain.

| Command | Description | Example |
|---|---|---|
| `inspect protocol` | Flash Trade protocol overview | `inspect protocol` |
| `inspect pool <name>` | Inspect a specific liquidity pool | `inspect pool Crypto.1` |
| `inspect market <asset>` | Deep inspection of a market | `inspect market SOL` |

### Returns

**inspect protocol** — Program ID, pool list, aggregate open interest, long/short ratio, risk metrics.

**inspect pool** — Pool configuration, supported markets, total OI, utilization.

**inspect market** — Market parameters, funding rate, liquidity depth, open interest breakdown, whale positions.

### Aliases

| Input | Resolves to |
|---|---|
| `inspect` | `inspect protocol` |

---

## 5. Wallet

Commands for managing Solana wallet connections.

| Command | Description | Example |
|---|---|---|
| `wallet` | Show wallet connection status | `wallet` |
| `wallet tokens` | View all token balances | `wallet tokens` |
| `wallet balance` | Show SOL balance | `wallet balance` |
| `wallet list` | List saved wallets | `wallet list` |
| `wallet import` | Import and store a wallet | `wallet import main /path/to/key.json` |
| `wallet use <name>` | Switch to a saved wallet | `wallet use main` |
| `wallet connect <path>` | Connect a wallet file directly | `wallet connect /path/to/key.json` |
| `wallet disconnect` | Disconnect the active wallet | `wallet disconnect` |

### Aliases

| Input | Resolves to |
|---|---|
| `wallet status` | `wallet` |
| `wallet address` | Show wallet public key |

---

## 6. Utilities

System tools and operational commands.

| Command | Description | Example |
|---|---|---|
| `dryrun <command>` | Preview a trade without signing or sending | `dryrun open 2x long SOL $10` |
| `monitor` | Live-updating market table (refreshes every 5s) | `monitor` |
| `watch <command>` | Auto-refresh any command on interval | `watch positions` |
| `system status` | System health overview | `system status` |
| `rpc status` | Active RPC endpoint info | `rpc status` |
| `rpc test` | Test all configured RPC endpoints | `rpc test` |
| `tx inspect <sig>` | Inspect a transaction by signature | `tx inspect 4xK...` |
| `doctor` | Run terminal diagnostic checks | `doctor` |
| `degen` | Toggle degen mode (500x leverage on SOL/BTC/ETH) | `degen` |
| `help` | Show command reference | `help` |
| `exit` | Close the terminal | `exit` |

### Details

**dryrun** — Parses the trade command, resolves the market and pool, computes fees, and displays a full transaction preview. No transaction is signed or broadcast. Useful for verifying parameters before execution.

**monitor** — Full-screen live market table showing price, 24h change, open interest, and long/short ratio for all markets. Sorted by OI. Press any key to exit.

**watch** — Wraps any read-only command in a refresh loop. Useful for monitoring positions or portfolio in real time.

**doctor** — Runs connectivity, configuration, and health checks. Reports issues with RPC, wallet, or SDK configuration.

### Aliases

| Input | Resolves to |
|---|---|
| `system` | `system status` |
| `market monitor`, `watch` (bare) | `monitor` |
| `commands`, `?` | `help` |
| `quit` | `exit` |

---

## Natural Language

The terminal also accepts natural language input, parsed via AI or regex patterns.

Examples:
- `what's the price of SOL?` → market data lookup
- `show me BTC analysis` → `analyze BTC`
- `how are my positions doing?` → `positions`

Natural language is a convenience layer. All commands above work deterministically without AI.
