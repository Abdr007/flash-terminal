# Changelog

All notable changes to Flash Terminal are documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-03-15

### Initial Release

Flash Terminal is a production-grade Solana perpetual futures trading CLI for the [Flash Trade](https://www.flash.trade/) protocol.

### Core Features

- **Live Trading** — Open, close, and manage leveraged positions on Flash Trade via Solana mainnet
- **Simulation Mode** — Paper trading with real Pyth oracle prices, no on-chain transactions
- **TP/SL Automation** — Take-profit and stop-loss targets with spike protection (2-tick confirmation)
- **Limit Orders** — Conditional order engine with oracle price constraints
- **Real-Time Monitoring** — Live market tables refreshed every 5 seconds
- **AI Command Parser** — Natural language interpretation with deterministic regex fallback
- **Multi-Pool Support** — Crypto, Virtual, Governance, and Community pools

### Earn System

- **Liquidity Provision** — Deposit USDC to mint FLP (auto-compounding) across all pools
- **FLP Staking** — Stake FLP tokens for USDC rewards (hourly distribution)
- **Yield Analytics** — Pool comparison, yield simulation, demand analysis, rotation suggestions
- **Portfolio Dashboard** — Track LP positions, PnL, and historical APY

### FAF Token Integration

- **Governance Staking** — Stake FAF tokens for VIP tier benefits and revenue sharing
- **Revenue Sharing** — 50% of protocol revenue distributed to stakers in USDC
- **VIP Tiers** — Level 0–5 with fee discounts, referral rebates, and DCA discounts
- **Unstake Management** — 90-day linear unlock with progress tracking

### Safety Systems

- **Signing Guard** — Pre-sign confirmation gate with full trade summary and configurable limits
- **Circuit Breaker** — Automatic trading halt on session/daily loss thresholds
- **Trading Gate (Kill Switch)** — Master switch to disable all trade execution
- **Transaction Simulation** — On-chain simulation before broadcast
- **Program Whitelist** — Only approved Solana programs can be targeted
- **Instruction Freeze** — `Object.freeze()` prevents mutation after validation
- **Duplicate Detection** — Signature cache (120s TTL) prevents resubmission
- **Rate Limiting** — Configurable max trades/min and minimum delay between trades

### Infrastructure

- **RPC Failover** — Multi-endpoint monitoring with automatic switching on slot lag, latency, or failure
- **Crash Recovery** — Trade journal records pending transactions; recovery engine verifies on-chain status on restart
- **State Reconciliation** — Periodic sync with blockchain; on-chain state is always authoritative
- **Dynamic Compute Tuning** — Simulate transactions to estimate CU usage with configurable buffer
- **Structured Logging** — JSON or text format with auto-rotation (10MB), API key scrubbing
- **Alert Webhooks** — Slack and HTTP webhook support for trade events, risk alerts, and system events
- **Shadow Trading** — Mirror trades to parallel risk engine for strategy validation

### Risk Management

- **Risk Monitor** — Background liquidation monitoring with tiered alerts (SAFE / WARNING / CRITICAL)
- **Portfolio Exposure** — Configurable max portfolio exposure limits
- **Liquidation Analysis** — On-chain liquidation price computation with protocol math
- **Market Regime Detection** — Volatility, trend, and liquidity regime classification

### Developer Tooling

- **Plugin System** — Dynamic plugin loading with core tool protection
- **Performance Profiling** — `FLASH_PROFILE=1` enables command/RPC/TX latency tracking
- **Test Suite** — 1505 automated tests covering all systems
- **Coverage Reporting** — V8 coverage with text, LCOV, and HTML reports
- **Pre-Commit Hooks** — Husky + lint-staged enforcing lint, build, and tests
- **CI Pipeline** — GitHub Actions running lint, build, coverage on every push/PR
- **ESLint** — Zero warnings with strict TypeScript rules (no-explicit-any, no-unused-vars)

### Protocol Integration

- **Flash SDK** — Direct integration with Flash Trade on-chain program
- **Pyth Hermes** — Real-time oracle prices with staleness, confidence, and deviation validation
- **fstats API** — Protocol analytics (OI, volume, leaderboard, fees) with response size limits
- **CoinGecko** — Market data for monitoring and regime detection
- **Solana RPC** — Direct blockchain interaction with retry logic and timeout handling

### Documentation

- **README** — Installation, configuration, commands, architecture, security
- **COMMANDS.md** — Complete command reference with examples and aliases
- **ARCHITECTURE.md** — System design, data flow, and subsystem documentation
- **SECURITY.md** — Security policy, threat model, and vulnerability reporting
- **CONTRIBUTING.md** — Development setup, code style, and PR guidelines
- **Plugin API** — Plugin development guide with example plugin
