import { loadEnv, logger } from '@spmi/shared';
import { createAdapter } from './adapters/index.js';
import { createDb } from './db/client.js';
import { startMetricsServer } from './metrics.js';
import { Pipeline } from './pipeline.js';

async function main() {
  const env = loadEnv();
  const log = logger.child({ svc: 'indexer' });
  log.info({ adapter: env.INDEXER_ADAPTER, programId: env.PREDICTION_MARKET_PROGRAM_ID }, 'booting indexer');

  const db = await createDb(env.DATABASE_URL);
  await db.migrate();

  startMetricsServer(env.METRICS_PORT);

  const adapter = createAdapter(env);
  const pipeline = new Pipeline({ db, log, concurrency: env.INDEXER_CONCURRENCY });

  adapter.on('event', (e) => pipeline.enqueue(e));
  adapter.on('error', (err) => log.error({ err }, 'adapter error'));

  await adapter.start();

  const shutdown = async (sig: string) => {
    log.warn({ sig }, 'shutdown requested');
    await adapter.stop();
    await pipeline.drain();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'indexer crashed');
  process.exit(1);
});
