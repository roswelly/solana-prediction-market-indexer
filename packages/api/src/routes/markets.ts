import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ListQuery = z.object({
  state: z.enum(['OPEN', 'RESOLVED']).optional(),
  sort: z.enum(['volume', 'recent', 'close']).default('volume'),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

export async function registerMarketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/markets', async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const { state, sort, limit, offset } = q.data;
    const orderBy =
      sort === 'recent' ? 'last_trade_at DESC NULLS LAST'
      : sort === 'close' ? 'close_ts ASC'
      : 'total_volume DESC';
    const { rows } = await app.pool.query(
      `SELECT address, question, state, price_yes, yes_reserve, no_reserve,
              total_volume, close_ts, trade_count, last_trade_at
         FROM market_stats
        WHERE ($1::TEXT IS NULL OR state = $1)
        ORDER BY ${orderBy}
        LIMIT $2 OFFSET $3`,
      [state ?? null, limit, offset],
    );
    return { markets: rows };
  });

  app.get<{ Params: { address: string } }>('/markets/:address', async (req, reply) => {
    const { rows } = await app.pool.query(
      `SELECT m.*, ms.price_yes, ms.trade_count, ms.last_trade_at
         FROM markets m
         JOIN market_stats ms ON ms.address = m.address
        WHERE m.address = $1`,
      [req.params.address],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'market not found' });
    return rows[0];
  });

  app.get<{ Params: { address: string }; Querystring: { bucket?: string; limit?: string } }>(
    '/markets/:address/candles',
    async (req) => {
      const bucket = req.query.bucket ?? '5 minutes';
      const limit = Math.min(500, Number(req.query.limit ?? 200));
      const { rows } = await app.pool.query(
        `SELECT time_bucket AS ts,
                MIN(price_yes) AS low,
                MAX(price_yes) AS high,
                (ARRAY_AGG(price_yes ORDER BY ts ASC))[1] AS open,
                (ARRAY_AGG(price_yes ORDER BY ts DESC))[1] AS close,
                SUM(amount_in) AS volume,
                COUNT(*) AS trades
           FROM (
             SELECT ts, price_yes, amount_in,
                    date_trunc('minute', ts) - (EXTRACT(MINUTE FROM ts)::INT % 5) * INTERVAL '1 minute' AS time_bucket
               FROM trades
              WHERE market = $1
           ) t
          GROUP BY time_bucket
          ORDER BY time_bucket DESC
          LIMIT $2`,
        [req.params.address, limit],
      );
      return { bucket, candles: rows.reverse() };
    },
  );
}
