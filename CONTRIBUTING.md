# Contributing to Flash AI Terminal

Thank you for your interest in contributing. This guide covers everything you need to get started.

---

## Development Setup

```bash
git clone https://github.com/Abdr007/flash-ai-terminal.git
cd flash-ai-terminal
npm install
```

### Run in Development Mode

```bash
npm run dev
```

This uses `tsx` for TypeScript execution without a compile step.

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

---

## Project Structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for a complete module reference.

Key directories:

```
src/
├── cli/          Terminal REPL and user interaction
├── ai/           Intent parsing and signal aggregation
├── tools/        Tool definitions and dispatch engine
├── client/       Flash Trade SDK client and simulation client
├── strategies/   Momentum, mean-reversion, whale-follow
├── portfolio/    Allocation, exposure, rebalance
├── risk/         Liquidation risk, exposure computation
├── regime/       Market regime detection
├── scanner/      Multi-market opportunity scanner
├── wallet/       Keypair management and wallet store
├── data/         CoinGecko and fstats.io API clients
├── config/       Environment config and pool/market mapping
└── utils/        Logger, retry, formatting, safe math
```

---

## Coding Style

- **TypeScript strict mode** — All code must pass `tsc --strict`
- **ESM modules** — Use `.js` extensions in imports (`import { x } from './module.js'`)
- **No `any`** — Use proper types or `unknown` with type guards
- **Defensive arithmetic** — Use `Number.isFinite()` before arithmetic on external data
- **Error handling** — Wrap external calls in try/catch; never let errors crash the CLI
- **No fabricated data** — Never hardcode fallback prices or synthetic market data

### Naming Conventions

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Interfaces/Types: `PascalCase`

---

## Pull Request Guidelines

1. **Fork the repository** and create a feature branch from `main`
2. **Keep changes focused** — One feature or fix per PR
3. **Include context** — Explain what the change does and why
4. **Test your changes** — Run `npm run build` and verify the CLI works
5. **No breaking changes** to the core trading pipeline without discussion

### PR Title Format

```
feat: add market depth indicator
fix: handle zero-volume markets in scanner
docs: update quickstart with wallet import steps
refactor: simplify regime detection weights
```

---

## Bug Reports

Open an issue with:

1. **Description** — What happened vs what you expected
2. **Steps to reproduce** — Exact commands you ran
3. **Environment** — Node.js version, OS, RPC provider
4. **Error output** — Full error message or screenshot
5. **Mode** — Simulation or Live

Use `flash doctor` output to include environment diagnostics.

---

## Architecture Decisions

Before making significant changes to:

- Transaction pipeline (`src/client/flash-client.ts`)
- Risk limits (`src/config/risk-config.ts`)
- Wallet security (`src/wallet/`)

Please open an issue to discuss the approach first. These are safety-critical paths.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
