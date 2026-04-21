import { loadEnv, logger } from '@spmi/shared';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { MarketMakerStrategy } from './strategies/market-maker.js';
import { ArbitrageStrategy } from './strategies/arbitrage.js';
import { Executor } from './execution/executor.js';
import { RiskManager } from './execution/risk.js';
import type { Strategy } from './strategies/base.js';

async function main() {
  const env = loadEnv();
  const log = logger.child({ svc: 'bot' });
  if (!env.BOT_ENABLED) {
    log.warn('BOT_ENABLED=false - running in dry-run observation mode (no orders will be sent)');
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const redis = new Redis(env.REDIS_URL);
  const risk = new RiskManager({
    maxPositionUsd: env.BOT_MAX_POSITION_USD,
    maxDailyLossUsd: env.BOT_MAX_DAILY_LOSS_USD,
  });
  const executor = new Executor({ dryRun: !env.BOT_ENABLED, keypairPath: env.BOT_KEYPAIR_PATH, risk, log });

  const enabled = env.BOT_STRATEGIES.split(',').map((s) => s.trim());
  const strategies: Strategy[] = [];
  if (enabled.includes('market_maker')) {
    strategies.push(new MarketMakerStrategy({ pool, executor, halfSpreadBps: env.BOT_QUOTE_SPREAD_BPS, log }));
  }
  if (enabled.includes('arbitrage')) {
    strategies.push(new ArbitrageStrategy({ pool, executor, minEdgeBps: env.BOT_ARB_MIN_EDGE_BPS, log }));
  }

  log.info({ strategies: strategies.map((s) => s.name) }, 'bot running');

  // Tick loop: each strategy polls DB + redis pubsub and emits OrderIntents.
  // 250ms cadence is aggressive enough for AMM reaction without hammering RPC.
  const interval = setInterval(
    () => void Promise.all(strategies.map((s) => s.tick().catch((err) => log.error({ err, s: s.name }, 'tick err')))),
    250,
  );

  const shutdown = async () => {
    clearInterval(interval);
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'bot crashed');
  process.exit(1);
});
