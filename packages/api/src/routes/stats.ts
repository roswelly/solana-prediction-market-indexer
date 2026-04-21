import type { FastifyInstance } from 'fastify';

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats/global', async () => {
    const { rows } = await app.pool.query(
      `SELECT
          (SELECT COUNT(*) FROM markets)                                  AS markets_total,
          (SELECT COUNT(*) FROM markets WHERE state = 'OPEN')             AS markets_open,
          (SELECT COALESCE(SUM(total_volume), 0) FROM markets)            AS volume_total,
          (SELECT COUNT(*) FROM trades WHERE ts > NOW() - INTERVAL '24h') AS trades_24h,
          (SELECT COALESCE(SUM(amount_in), 0) FROM trades WHERE ts > NOW() - INTERVAL '24h') AS volume_24h,
          (SELECT COUNT(DISTINCT trader) FROM trades WHERE ts > NOW() - INTERVAL '24h')       AS unique_traders_24h`,
    );
    return rows[0];
  });

  app.get<{ Params: { trader: string } }>('/stats/trader/:trader', async (req, reply) => {
    const { rows } = await app.pool.query(
      `SELECT trader,
              COUNT(*)                       AS trades,
              SUM(amount_in) FILTER (WHERE side = 'BUY')  AS bought,
              SUM(amount_in) FILTER (WHERE side = 'SELL') AS sold,
              MIN(ts) AS first_trade_at,
              MAX(ts) AS last_trade_at
         FROM trades
        WHERE trader = $1
        GROUP BY trader`,
      [req.params.trader],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'no trades' });
    return rows[0];
  });
}
