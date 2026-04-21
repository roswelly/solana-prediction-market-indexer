-- ============================================================================
-- Prediction Market Indexer — initial schema
-- ============================================================================
-- Idempotent: safe to run on boot. Use a proper migration runner (e.g. Flyway,
-- node-pg-migrate) once multiple revisions exist; for a single-rev bootstrap
-- this is sufficient and keeps the deploy story trivial.

CREATE TABLE IF NOT EXISTS markets (
    address           TEXT PRIMARY KEY,
    creator           TEXT NOT NULL,
    oracle            TEXT NOT NULL,
    collateral_mint   TEXT NOT NULL,
    yes_reserve       NUMERIC(40, 0) NOT NULL,
    no_reserve        NUMERIC(40, 0) NOT NULL,
    total_volume      NUMERIC(40, 0) NOT NULL DEFAULT 0,
    fee_bps           INTEGER NOT NULL,
    close_ts          TIMESTAMPTZ NOT NULL,
    resolution_ts     TIMESTAMPTZ,
    state             TEXT NOT NULL CHECK (state IN ('OPEN','RESOLVED')),
    winning_outcome   TEXT NOT NULL CHECK (winning_outcome IN ('UNRESOLVED','YES','NO','INVALID')),
    question          TEXT NOT NULL,
    created_slot      BIGINT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS markets_state_close_ts_idx ON markets (state, close_ts);
CREATE INDEX IF NOT EXISTS markets_creator_idx        ON markets (creator);

CREATE TABLE IF NOT EXISTS trades (
    signature          TEXT PRIMARY KEY,
    slot               BIGINT NOT NULL,
    market             TEXT NOT NULL REFERENCES markets(address) ON DELETE CASCADE,
    trader             TEXT NOT NULL,
    side               TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
    outcome            TEXT NOT NULL CHECK (outcome IN ('YES','NO')),
    amount_in          NUMERIC(40, 0) NOT NULL,
    shares             NUMERIC(40, 0) NOT NULL,
    fee                NUMERIC(40, 0) NOT NULL,
    yes_reserve_after  NUMERIC(40, 0) NOT NULL,
    no_reserve_after   NUMERIC(40, 0) NOT NULL,
    price_yes          DOUBLE PRECISION NOT NULL,
    price_no           DOUBLE PRECISION NOT NULL,
    ts                 TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS trades_market_ts_idx ON trades (market, ts DESC);
CREATE INDEX IF NOT EXISTS trades_trader_idx    ON trades (trader);
CREATE INDEX IF NOT EXISTS trades_slot_idx      ON trades (slot);

CREATE TABLE IF NOT EXISTS claims (
    signature   TEXT NOT NULL,
    slot        BIGINT NOT NULL,
    market      TEXT NOT NULL REFERENCES markets(address) ON DELETE CASCADE,
    trader      TEXT NOT NULL,
    payout      NUMERIC(40, 0) NOT NULL,
    ts          TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (signature, trader)
);

CREATE INDEX IF NOT EXISTS claims_market_idx ON claims (market);

CREATE TABLE IF NOT EXISTS indexer_cursor (
    id              SMALLINT PRIMARY KEY,
    last_slot       BIGINT NOT NULL,
    last_signature  TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);

-- Materialized hot stats view — cheap to compute, refreshed on each trade.
CREATE OR REPLACE VIEW market_stats AS
SELECT
    m.address,
    m.question,
    m.state,
    m.yes_reserve,
    m.no_reserve,
    m.total_volume,
    m.close_ts,
    COALESCE(
        m.no_reserve::DOUBLE PRECISION / NULLIF((m.yes_reserve + m.no_reserve)::DOUBLE PRECISION, 0),
        0.5
    ) AS price_yes,
    (SELECT COUNT(*) FROM trades t WHERE t.market = m.address) AS trade_count,
    (SELECT MAX(ts)  FROM trades t WHERE t.market = m.address) AS last_trade_at
FROM markets m;
