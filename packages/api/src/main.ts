import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { loadEnv, logger } from '@spmi/shared';
import { registerMarketRoutes } from './routes/markets.js';
import { registerTradeRoutes } from './routes/trades.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerWsFeed } from './ws.js';

async function main() {
  const env = loadEnv();
  const app = Fastify({ logger: logger.child({ svc: 'api' }) as never, trustProxy: true });

  await app.register(cors, { origin: env.API_CORS_ORIGIN === '*' ? true : env.API_CORS_ORIGIN.split(',') });
  await app.register(websocket);

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 20 });
  const redis = new Redis(env.REDIS_URL);
  app.decorate('pool', pool);
  app.decorate('redis', redis);

  app.get('/health', async () => ({ ok: true, uptime: process.uptime() }));

  await registerMarketRoutes(app);
  await registerTradeRoutes(app);
  await registerStatsRoutes(app);
  await registerWsFeed(app);

  const shutdown = async () => {
    app.log.warn('shutting down');
    await app.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((err) => {
  logger.fatal({ err }, 'api crashed');
  process.exit(1);
});

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    redis: Redis;
  }
}
