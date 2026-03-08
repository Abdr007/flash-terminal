# Flash AI Terminal

A professional command-line trading terminal for interacting with the Flash Trade protocol.

Flash AI Terminal enables traders and developers to execute leveraged trades, inspect protocol state, analyze markets, and monitor portfolio risk directly from the terminal using real on-chain data.

The system is designed to behave like a deterministic trading workstation rather than a simple CLI wrapper.

---

## Overview

Flash AI Terminal provides a full trading workflow from the command line:

- Execute leveraged trades
- Preview trade risk before execution
- Simulate transactions
- Inspect protocol state
- Monitor portfolio exposure
- Analyze markets using real data
- Interact with Flash pools and markets

The terminal prioritizes:

- Deterministic trading execution
- Infrastructure reliability
- Real-time analytics
- Professional CLI usability

---

## Key Features

### Deterministic Trading Execution

Trade commands are parsed deterministically to ensure predictable execution.

Examples:

```
open 2x long SOL $10
close SOL long
add $5 to SOL long
remove $5 from SOL long
```

Trading pipeline:

```
CLI Parser
↓
Trade Builder
↓
Simulation Guard
↓
Confirmation Step
↓
Signing Guard
↓
RPC Execution
↓
State Reconciliation
```

Trading commands never rely on AI parsing.

---

## Trade Risk Preview

Before executing a trade, the terminal displays a structured risk preview panel.

Example:

```
TRADE PREVIEW
────────────────────────────

Market:        SOL
Side:          LONG
Leverage:      2x
Collateral:    $10.00
Position Size: $20.00

Entry Price:   $81.52
Est. Liq:      $44.80
Distance:      45.0%
Risk:          MEDIUM

Exposure:      $0 → $20
```

Preview data includes:

- Estimated entry price
- Estimated liquidation price
- Liquidation distance
- Risk classification
- Portfolio exposure change

Trade preview is computed instantly using cached market data and never triggers additional RPC calls.

---

## Trading Safety

Flash AI Terminal implements multiple safety mechanisms:

- Transaction simulation (`dryrun`)
- Confirmation step before signing
- RPC health verification
- Position verification before modification
- Reconciliation layer protecting against RPC desync

Live trading requires explicit confirmation.

```
Type "yes" to sign or "no" to cancel
```

---

## Protocol Inspection

Inspect Flash protocol state directly from the terminal.

Commands:

```
inspect protocol
inspect pool <name>
inspect market <asset>
```

Information includes:

- Pools and supported assets
- Open interest distribution
- Protocol statistics
- Market configuration

---

## Market Analytics

The terminal includes built-in analytics powered by real data sources.

Commands:

```
scan
analyze <asset>
volume
open interest
leaderboard
whale activity
```

Data sources include:

- Flash protocol state
- Pyth oracle prices
- Market analytics APIs

If data is unavailable the terminal returns empty results instead of synthetic values.

---

## Infrastructure Reliability

The terminal is designed to operate under real-world RPC conditions.

Features include:

- Automatic RPC failover
- Slot lag detection
- Retry logic for network failures
- Reconciliation system for state consistency
- Background RPC health monitoring

Example status indicator:

```
RPC: Helius (340ms) | Sync: OK | Wallet: ABDR
```

Failover triggers automatically when RPC nodes become unhealthy.

---

## Simulation Mode

Simulation mode allows users to test strategies without executing real transactions.

Example:

```
dryrun open 5x long SOL $100
```

Simulation provides:

- Transaction preview
- Estimated liquidation price
- Estimated fees
- Compute unit usage
- Program logs

Simulation ensures users can verify a trade before executing it on-chain.

---

## Performance

Flash AI Terminal includes several performance optimizations:

- Cached market data
- Bounded analytics caches
- Efficient RPC request batching
- Minimal terminal redraws

Typical command execution time:

```
positions
[153ms]
```

---

## Long Session Stability

The terminal is designed for extended usage.

Reliability features include:

- Bounded caches with eviction
- Timer cleanup using `.unref()`
- Background health monitoring
- Log rotation
- Event listener cleanup

The system remains stable during long trading sessions.

---

## Example Demo

The full trading pipeline can be demonstrated with a short command sequence.

```
flash
markets
inspect protocol
inspect market SOL
dryrun open 2x long SOL $10
open 2x long SOL $10
positions
close SOL long
exit
```

This demonstrates:

- Protocol access
- Trade simulation
- Live trade execution
- Position monitoring
- Closing the position

---

## Installation

Clone the repository:

```bash
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
```

Install dependencies:

```bash
npm install
```

Build the project:

```bash
npm run build
```

Run the terminal:

```bash
flash
```

---

## Requirements

- Node.js 18+
- Solana RPC endpoint
- Flash protocol access

Optional:

- Helius RPC for improved reliability

---

## Logs

Runtime logs are stored locally:

```
~/.flash/logs
```

Logs include:

- Reconciliation events
- RPC health monitoring
- Background services

Debug information is written to log files only and never displayed in the CLI.

---

## Design Philosophy

Flash AI Terminal prioritizes:

- Deterministic execution
- Infrastructure reliability
- Safety in trading operations
- Professional terminal UX

The goal is to provide a stable and reliable command-line interface for interacting with the Flash protocol.

---

## License

MIT License
