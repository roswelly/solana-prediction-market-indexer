import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const Query = z.object({
  market: z.string().optional(),
  trader: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(100),
  before: z.string().datetime().optional(),
});

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/trades', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const { market, trader, limit, before } = q.data;
    const { rows } = await app.pool.query(
      `SELECT signature, slot, market, trader, side, outcome,
              amount_in, shares, fee, price_yes, price_no, ts
         FROM trades
        WHERE ($1::TEXT IS NULL OR market = $1)
          AND ($2::TEXT IS NULL OR trader = $2)
          AND ($3::TIMESTAMPTZ IS NULL OR ts < $3)
        ORDER BY ts DESC
        LIMIT $4`,
      [market ?? null, trader ?? null, before ?? null, limit],
    );
    return { trades: rows };
  });
}
