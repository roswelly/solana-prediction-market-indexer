# Architecture

This document details data flow, ordering guarantees, failure modes, and extension seams. The top-level README covers the *what*; this file covers the *why* and *how*.

## 1. Data flow

```
 on-chain program   ──► ingestion adapter ──► parser ──► pipeline ──► Postgres
                                                                     └──► Redis pub/sub ──► API WebSocket
                                                                                           Trading bot
```

Every write to Postgres publishes a lightweight event to Redis (`spmi:events`). The API's WebSocket layer fans that out to subscribers, and the bot's strategies can react on the next tick without polling the DB as hard.

## 2. Ordering guarantees

The tricky part of any indexer is "what happens when two transactions for the same market land in quick succession?" We want reserves to reflect the *latest* state and we want trades to commit exactly once.

Design:

1. **Per-market serial queue.** The `Pipeline` (`packages/indexer/src/pipeline.ts`) keys a `PQueue` by market address. All writes for the same market execute in submission order, one at a time.
2. **Global concurrency cap.** A second `PQueue` with `INDEXER_CONCURRENCY` workers schedules the per-market queues fairly, so a hot market can't starve others but the total backpressure stays bounded.
3. **Idempotent inserts.** Trades are upserted on `signature` primary key; `MarketInitialized` is a `DO NOTHING` on conflict; claims are unique by `(signature, trader)`. Replaying the same transaction is a no-op.
4. **Monotonic cursor.** `indexer_cursor.last_slot` only advances; the `UPDATE` filters on `EXCLUDED.last_slot >= indexer_cursor.last_slot`, so out-of-order confirmations from a gossipy RPC never rewind us.

## 3. Resumability and backfill

On boot, the WebSocket adapter:

1. Subscribes to `logsSubscribe` for the program (live stream).
2. In parallel, calls `getSignaturesForAddress` for the last `INDEXER_BACKFILL_SLOTS` and replays each through the same pipeline as live events.

Because writes are idempotent, any overlap between backfill and live is benign. If the process crashes and restarts, we simply re-run the backfill window - anything already written gets skipped by the ON CONFLICT clauses.

For deeper history (e.g. after a long outage) point the adapter at a chain-history provider (Helius DAS, BigQuery dataset) and feed signatures into the same pipeline - the parser is pure, so the source is swappable.

## 4. Event parsing

Anchor emits events via `sol_log_data`, which appear in logs as lines prefixed with `Program data: `. The payload is:

```
[ 8-byte discriminator ][ borsh-serialized fields ]
```

The discriminator is the first 8 bytes of `sha256("event:<Name>")`. The parser computes these at module load so it stays in sync with the program without a build step. The borsh decoder is hand-written (see `BorshReader`) to keep the package lean and dependency-free.

If you add a new event, extend `ProgramEvent` in `@spmi/shared/events.ts`, add the name to the discriminator list, and add a case in `decodeEvent`.

## 5. AMM pricing

Constant-product binary market:
- price = `pYes = noReserve / (yesReserve + noReserve)` - always in `[0,1]`.
- 1 collateral can be split into 1 YES + 1 NO share (and merged back), so the AMM's price discovery is equivalent to the FPMM used by other prediction markets.

Swap math follows Uniswap v2 with a fee on the input:

```
fee = amountIn * feeBps / 10_000
net = amountIn - fee
k   = inR * outR
sharesOut = outR - k / (inR + net)
```

All pricing logic lives in `@spmi/shared/math.ts` and is unit-tested. The bot imports the exact same functions used on-chain semantics for quote generation.

## 6. Bot architecture

Each strategy:
1. Loads open markets from Postgres (snapshot with reserves).
2. Computes signal(s).
3. Builds one or more `OrderIntent`s.
4. Passes each intent through the `RiskManager` and `Executor`.

Risk is pre-trade: a position cap per market and a rolling daily loss limit. The executor idempotency-keys by `clientId` so the same intent fired twice in a tick is a single submission.

The execution path has a clean `dry-run` vs. `live` seam. Dry-run logs the intent and returns. Live is a documented stub - drop in your chosen RPC/priority-fee stack without touching strategy or risk code.

## 7. Failure modes considered

| Failure                               | Behavior                                                      |
| ------------------------------------- | ------------------------------------------------------------- |
| RPC WebSocket drops                   | `Connection` auto-reconnects; the next tick backfills recent signatures |
| Malformed `Program data` line         | `decodeEvent` returns null, a `parseFailures` counter increments |
| Postgres unavailable at boot          | `migrate()` fails; crash-loop until DB is up (compose handles this)  |
| Redis unavailable                     | API still serves REST (it only depends on Postgres); WS subscriptions error out explicitly |
| Two concurrent trades on same market  | Per-market serial queue preserves ordering; reserves stay consistent |
| Program upgrade changes event schema  | Parser falls back to skipping unknown discriminators; add new case and deploy |

## 8. Extension points

- **New event**: add to `shared/events.ts`, extend parser, add DB handler.
- **Geyser ingestion**: implement `GeyserAdapter.start()` using `@triton-one/yellowstone-grpc` - the rest of the stack already treats adapters interchangeably.
- **New strategy**: extend `Strategy`, register in `bot/main.ts`, add CSV row to `BOT_STRATEGIES`.
- **GraphQL**: layer on top of the existing Postgres queries - no schema changes needed.
- **TimescaleDB**: drop-in replacement for vanilla Postgres; `trades` is already an append-only wide table that trivially becomes a hypertable.
