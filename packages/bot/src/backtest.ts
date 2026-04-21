/**
 * Simple replay backtester.
 *
 * Streams trades from Postgres in chronological order and replays them through
 * a strategy to measure PnL and fill rate. Lets you iterate on `market-maker`
 * and `arbitrage` parameters without touching the chain.
 *
 * Usage:
 *   DATABASE_URL=... npm run backtest --workspace @spmi/bot -- --market=<addr>
 */
import { Pool } from 'pg';
import { loadEnv, logger, impliedProbability, quoteBuy, quoteSell } from '@spmi/shared';

async function main() {
  const env = loadEnv();
  const log = logger.child({ svc: 'backtest' });
  const market = process.argv.find((a) => a.startsWith('--market='))?.split('=')[1];
  if (!market) throw new Error('pass --market=<address>');
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  const { rows } = await pool.query(
    `SELECT side, outcome, amount_in::TEXT AS amount_in, shares::TEXT AS shares,
            yes_reserve_after::TEXT AS y, no_reserve_after::TEXT AS n, price_yes, ts
       FROM trades WHERE market = $1 ORDER BY ts ASC`,
    [market],
  );

  let pnl = 0;
  let position = 0n;
  for (const t of rows) {
    const r = { yes: BigInt(t.y), no: BigInt(t.n) };
    const { yes: mid } = impliedProbability(r);
    const halfSpread = 0.005;
    const bid = mid - halfSpread;
    const ask = mid + halfSpread;
    if (t.side === 'BUY' && Number(t.price_yes) > ask) {
      const q = quoteSell(r, 'YES', BigInt(t.amount_in) / 10n, 30);
      pnl += Number(q.amountOut) / 1e6;
      position -= BigInt(t.amount_in) / 10n;
    } else if (t.side === 'SELL' && Number(t.price_yes) < bid) {
      const q = quoteBuy(r, 'YES', BigInt(t.amount_in) / 10n, 30);
      pnl -= Number(t.amount_in) / 10 / 1e6;
      position += q.sharesOut;
    }
  }
  log.info({ market, trades: rows.length, pnl_usd: pnl.toFixed(4), position: position.toString() }, 'backtest done');
  await pool.end();
}

main().catch((err) => {
  logger.fatal({ err }, 'backtest crashed');
  process.exit(1);
});
