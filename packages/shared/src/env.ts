import { z } from 'zod';

const EnvSchema = z.object({
  SOLANA_RPC_HTTP: z.string().url(),
  SOLANA_RPC_WS: z.string().url(),
  HELIUS_API_KEY: z.string().optional(),
  GEYSER_GRPC_ENDPOINT: z.string().optional(),
  GEYSER_GRPC_TOKEN: z.string().optional(),

  PREDICTION_MARKET_PROGRAM_ID: z.string().min(32),
  COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().default(4000),
  API_CORS_ORIGIN: z.string().default('*'),

  INDEXER_BACKFILL_SLOTS: z.coerce.number().default(5000),
  INDEXER_ADAPTER: z.enum(['websocket', 'geyser']).default('websocket'),
  INDEXER_CONCURRENCY: z.coerce.number().default(8),

  BOT_ENABLED: z.coerce.boolean().default(false),
  BOT_KEYPAIR_PATH: z.string().default('./wallets/bot.json'),
  BOT_STRATEGIES: z.string().default('market_maker,arbitrage'),
  BOT_MAX_POSITION_USD: z.coerce.number().default(250),
  BOT_MAX_DAILY_LOSS_USD: z.coerce.number().default(100),
  BOT_QUOTE_SPREAD_BPS: z.coerce.number().default(80),
  BOT_ARB_MIN_EDGE_BPS: z.coerce.number().default(35),

  LOG_LEVEL: z.string().default('info'),
  METRICS_PORT: z.coerce.number().default(9464),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
