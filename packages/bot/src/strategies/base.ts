import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Executor } from '../execution/executor.js';

export interface StrategyContext {
  pool: Pool;
  executor: Executor;
  log: Logger;
}

export interface MarketSnapshot {
  address: string;
  question: string;
  state: 'OPEN' | 'RESOLVED';
  yesReserve: bigint;
  noReserve: bigint;
  feeBps: number;
  closeTs: Date;
  priceYes: number;
}

export abstract class Strategy {
  abstract readonly name: string;
  constructor(protected readonly ctx: StrategyContext) {}
  abstract tick(): Promise<void>;

  protected async loadOpenMarkets(): Promise<MarketSnapshot[]> {
    const { rows } = await this.ctx.pool.query(
      `SELECT address, question, state, yes_reserve, no_reserve, fee_bps, close_ts,
              no_reserve::float / NULLIF((yes_reserve + no_reserve)::float, 0) AS price_yes
         FROM markets
        WHERE state = 'OPEN' AND close_ts > NOW()
        ORDER BY total_volume DESC
        LIMIT 100`,
    );
    return rows.map((r) => ({
      address: r.address,
      question: r.question,
      state: r.state,
      yesReserve: BigInt(r.yes_reserve),
      noReserve: BigInt(r.no_reserve),
      feeBps: r.fee_bps,
      closeTs: r.close_ts,
      priceYes: Number(r.price_yes ?? 0.5),
    }));
  }
}
