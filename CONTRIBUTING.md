# Contributing to Flash AI Terminal

Thank you for your interest in contributing. This guide covers everything you need to get started.

---

## Project Overview

Flash AI Terminal is a CLI trading terminal for the Flash Trade perpetual futures protocol on Solana. It includes an AI command interpreter, market scanner, risk monitor, protocol inspector, and a hardened transaction pipeline.

The codebase is TypeScript (strict mode, ESM modules). The entry point is `src/index.ts`, which initializes `src/cli/terminal.ts`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed system design documentation.

---

## Development Environment Setup

### Prerequisites

- Node.js >= 20.0.0
- npm

### Clone and Install

```bash
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
npm install
```

### Configure

```bash
cp .env.example .env
# Edit .env — at minimum set RPC_URL
```

### Run in Development Mode

```bash
npm run dev
```

Uses `tsx` for TypeScript execution without a compile step.

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/` and makes the CLI executable.

### Run Tests

```bash
npm run test          # Single run
npm run test:watch    # Watch mode
```

### Type Check

```bash
npx tsc --noEmit
```

---

## Project Structure

```
src/
  cli/          Terminal REPL and user interaction
  ai/           Intent parsing and signal aggregation
  tools/        Tool definitions and dispatch engine
  client/       Flash Trade SDK client and simulation client
  agent/        AI-powered analysis, scanner, autopilot, dashboard
  strategies/   Momentum, mean-reversion, whale-follow
  scanner/      Multi-market opportunity scanner
  portfolio/    Allocation, exposure, rebalance
  risk/         Liquidation risk, exposure computation
  monitor/      Real-time risk monitoring engine
  regime/       Market regime detection
  protocol/     Flash Trade protocol inspector
  core/         Execution middleware, state reconciliation
  network/      RPC endpoint management with failover
  system/       System diagnostics and health checks
  security/     Signing guard, rate limiter, audit logging
  plugins/      Plugin loader and user plugins
  wallet/       Keypair management and wallet store
  data/         CoinGecko and fstats.io API clients
  config/       Environment config and pool/market mapping
  types/        All types, enums, interfaces, Zod schemas
  utils/        Logger, retry, formatting, safe math
```

---

## Code Style Guidelines

### Language

- **TypeScript strict mode** -- All code must pass `tsc --strict`
- **ESM modules** -- Use `.js` extensions in imports (`import { x } from './module.js'`)
- **No `any`** -- Use proper types or `unknown` with type guards

### Safety

- **Defensive arithmetic** -- Use `Number.isFinite()` before arithmetic on external data
- **Error handling** -- Wrap external calls in try/catch; never let errors crash the CLI
- **No fabricated data** -- Never hardcode fallback prices or synthetic market data

### Naming Conventions

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Interfaces/Types: `PascalCase`

### Commit Messages

Use conventional commit format:

```
feat: add market depth indicator
fix: handle zero-volume markets in scanner
docs: update quickstart with wallet import steps
refactor: simplify regime detection weights
```

---

## Pull Request Guidelines

1. **Open an issue first** for large changes. Discuss the approach before writing code.
2. **Fork the repository** and create a feature branch from `main`.
3. **Keep changes focused** -- One feature or fix per PR.
4. **Include context** -- Explain what the change does and why.
5. **Test your changes** -- Run `npm run build` and verify the CLI works.
6. **No breaking changes** to the core trading pipeline without prior discussion.

### Safety-Critical Paths

The following areas require extra review and should be discussed in an issue before modification:

- Transaction pipeline (`src/client/flash-client.ts`)
- Signing security (`src/security/signing-guard.ts`)
- Wallet management (`src/wallet/`)
- Risk limits (`src/config/risk-config.ts`)
- Execution middleware (`src/core/execution-middleware.ts`)

---

## Reporting Issues

### Bug Reports

Open an issue using the **Bug Report** template with:

1. **Description** -- What happened vs. what you expected
2. **Steps to reproduce** -- Exact commands you ran
3. **Environment** -- Node.js version, OS, RPC provider
4. **Error output** -- Full error message or terminal output
5. **Mode** -- Simulation or Live

### Security Vulnerabilities

Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

---

## Feature Requests

Open an issue using the **Feature Request** template. Include:

1. **Problem statement** -- What limitation or gap the feature addresses
2. **Proposed solution** -- How you envision the feature working
3. **Alternatives considered** -- Other approaches you evaluated

For features that affect the trading pipeline, risk engine, or wallet security, open an issue to discuss the design before submitting a PR.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
