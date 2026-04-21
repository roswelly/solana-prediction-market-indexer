# Solana Prediction Market - Indexer, API, and Trading Bot

End-to-end prediction-market stack on Solana. One repo covers the whole pipeline a serious prediction-market operator needs:

- **On-chain AMM program** - Anchor/Rust, constant-product binary-outcome market with oracle resolution.
- **Chain indexer** - parses program events, writes to Postgres, publishes a live Redis feed. Pluggable ingestion (WebSocket today, Yellowstone gRPC tomorrow).
- **REST + WebSocket API** - Fastify service for markets, trades, candles, global stats, and live feeds.
- **Trading bot** - market-maker and statistical-arbitrage strategies behind a common `Strategy` interface, with a pre-trade risk manager and a replay backtester.
- **Ops** - Docker Compose for local bring-up, GitHub Actions CI, Prometheus metrics.

Built to showcase production patterns for a *smart contract + backend dev specializing in trading automation and prediction markets* - it isn't a toy.

---

## Architecture

```
                     ┌───────────────────────────┐
                     │  prediction_market.so     │   Anchor program
                     │  (Rust, CPMM AMM, oracle) │
                     └──────────────┬────────────┘
                                    │ events (Program data)
                                    ▼
        ┌───────────────────────────────────────────────┐
        │  Ingestion Adapter                            │
        │   ├── RpcWebSocketAdapter   (logsSubscribe)   │
        │   └── GeyserGrpcAdapter     (Yellowstone)     │
        └──────────────┬────────────────────────────────┘
                       ▼
              ┌─────────────────────┐
              │  Event Parser       │  Anchor event discriminators
              │  (Borsh, per-market │  decoded into typed events
              │   ordered pipeline) │
              └─────────┬───────────┘
                        ▼
              ┌──────────────────┐      ┌─────────────────────┐
              │  Postgres        │◄────►│  Redis pub/sub      │
              │  markets/trades  │      │  spmi:events        │
              └─────────┬────────┘      └──────────┬──────────┘
                        │                          │
           ┌────────────┴────────────┐      ┌──────┴────────┐
           ▼                         ▼      ▼               ▼
    ┌─────────────┐           ┌──────────────┐      ┌──────────────┐
    │  REST API   │           │  Trading Bot │      │  WebSocket   │
    │  /markets   │           │  mm + arb    │      │  live feed   │
    │  /trades    │           │  risk/exec   │      │  /ws         │
    │  /stats     │           └──────┬───────┘      └──────────────┘
    └─────────────┘                  │
                                     ▼
                             on-chain submit
```

See [`docs/architecture.md`](docs/architecture.md) for data flow, ordering guarantees, and failure semantics.

---

## Quick start

```bash
# 1. Install deps
npm install

# 2. Bring up Postgres + Redis + services
cp .env.example .env
docker compose up -d postgres redis
npm run db:migrate
npm run db:seed        # synthetic markets for local dev

# 3. Run off-chain services
npm run indexer:dev    # ingests from devnet by default
npm run api:dev        # http://localhost:4000
npm run bot:dev        # dry-run until BOT_ENABLED=true

# 4. Build the Anchor program (separate toolchain)
anchor build
anchor test
```

Hit a few endpoints:

```bash
curl localhost:4000/stats/global
curl 'localhost:4000/markets?state=OPEN&sort=volume&limit=10'
curl 'localhost:4000/markets/<address>/candles?bucket=5%20minutes'
```

Subscribe to the live feed:

```js
const ws = new WebSocket('ws://localhost:4000/ws');
ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', channels: ['global'] }));
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

---

## Repo layout

```
programs/prediction-market/        Anchor program (Rust)
packages/
  shared/                          Types, pricing math, env/logger/events
  indexer/                         Ingestion + parser + Postgres pipeline
  api/                             Fastify REST + WebSocket service
  bot/                             Strategies, executor, risk, backtester
docker/                            Dockerfile for off-chain services
.github/workflows/                 CI (TypeScript + anchor build)
scripts/                           seed-mock, migrate
docs/                              architecture + design notes
```

---

## On-chain program

Constant-product AMM over binary outcome shares. Buying YES decreases the YES reserve and increases the NO reserve; price is always `pYes = noReserve / (yesReserve + noReserve)`. Fees are configurable up to 5% and taken on the input side. Resolution is oracle-driven; winners redeem 1:1 against the collateral vault.

Events emitted (decoded by the indexer):

| Event               | Fields                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `MarketInitialized` | market, creator, oracle, collateral_mint, reserves, close_ts, fee_bps |
| `TradeExecuted`     | market, trader, side, outcome, amount_in, shares, fee, reserves_after |
| `MarketResolved`    | market, winning_outcome, resolution_ts                                |
| `Claimed`           | market, trader, payout                                                |

Source: `programs/prediction-market/src/lib.rs`.

---

## Indexer

- **Ordering**: events are serialized per-market (a `PQueue` keyed by market address) while writes across markets run up to `INDEXER_CONCURRENCY` deep. This preserves causal ordering without gating global throughput.
- **Resumability**: an `indexer_cursor` row tracks the last applied `(slot, signature)`; on boot the adapter backfills the last `INDEXER_BACKFILL_SLOTS` signatures before switching to live subscription.
- **Pluggable source**: switch `INDEXER_ADAPTER=geyser` and set `GEYSER_GRPC_ENDPOINT` to move from public RPC to a Yellowstone stream without touching the parser or pipeline.
- **Observability**: Prometheus counters on `spmi_indexer_events_processed_total{kind}`, parse failures, and block-time lag histogram exposed on `METRICS_PORT`.

---

## API

| Method | Path                          | Description                                                 |
| ------ | ----------------------------- | ----------------------------------------------------------- |
| GET    | `/health`                     | Liveness                                                    |
| GET    | `/markets`                    | List/filter/sort markets (`state`, `sort`, `limit`, `offset`) |
| GET    | `/markets/:address`           | Market detail + stats                                       |
| GET    | `/markets/:address/candles`   | OHLCV candles bucketed in 5-minute intervals                |
| GET    | `/trades`                     | Trade history with market/trader filters                    |
| GET    | `/stats/global`               | Totals + 24h activity                                       |
| GET    | `/stats/trader/:trader`       | Per-trader aggregates                                       |
| WS     | `/ws`                         | Live feed; subscribe to `global` or `market:<address>`      |

---

## Trading bot

Two strategies plug into a common `Strategy` interface and share a risk manager + executor:

- **Market maker** (`strategies/market-maker.ts`): quotes symmetric bid/ask around a short-window fair-value estimate, with a `tanh`-bounded inventory skew so we naturally bleed risk instead of needing an explicit flatten loop.
- **Arbitrage** (`strategies/arbitrage.ts`): two signals - sum-of-prices dislocation (`pYes + pNo < 1` after fees) and stale-mid-vs-VWAP. The strategy probes with size scaled to reserve depth and only fires when post-fee edge clears `BOT_ARB_MIN_EDGE_BPS`.

The executor runs in **dry-run** by default (`BOT_ENABLED=false`) - ideal for CI, devnet, and reviewers. Flip it to live and the `Executor.live()` path is the single documented seam where you plug in priority fees, Jito/Helius staked endpoints, or your preferred submission stack.

Pre-trade risk enforces a per-market USD position cap and a rolling daily loss limit. A replay backtester (`npm run backtest --workspace @spmi/bot -- --market=<addr>`) lets you tune parameters against historical reserves from Postgres.

---

## Tech choices & why

| Area             | Choice                                      | Reason                                                                        |
| ---------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| AMM              | Constant-product over binary shares         | Simplest pricing that bounds prices to [0,1] and is well-understood           |
| Anchor 0.30      | Standard IDL, events via `#[event]`         | Safe, easy to verify; discriminators computed at runtime, no build step       |
| Postgres         | Single-writer, NUMERIC(40,0) for token amts | Avoids BigInt rounding; candles trivially expressible in SQL                  |
| Redis            | Pub/sub for live feed + cross-service events | Decouples API WebSocket fanout from indexer writes                           |
| Fastify          | HTTP + WS API                               | Low overhead, first-class WebSocket plugin, schema-friendly                   |
| Prom-client      | Metrics exposition                          | Standard scrape format, ships with Node                                       |
| pino             | Structured JSON logs                        | Fast, cheap in tight loops, pretty-printed in dev                             |

---

## What this showcases

- **Solana smart contract** skills (Anchor, PDAs, token vaults, CPIs, event emission).
- **Backend architecture** skills (ordered streaming pipelines, pluggable adapters, idempotent writes, resumable cursors, pub/sub fan-out).
- **Trading automation** skills (AMM pricing math, MM inventory skew, statistical arbitrage signals, pre-trade risk, replay backtesting).
- **Ops / delivery** skills (multi-stage Docker, GitHub Actions CI, Prometheus metrics, typed env validation).

---

## License

MIT
