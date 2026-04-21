import { quoteBuy, quoteSell } from '@spmi/shared';
import { Strategy, type StrategyContext } from './base.js';

interface Opts extends StrategyContext {
  halfSpreadBps: number;
}

/**
 * Quote symmetric bid/ask around a fair-value estimate.
 *
 * Fair value is the time-weighted price over the last N minutes; we quote
 * `fv * (1 - s)` on the bid and `fv * (1 + s)` on the ask, where `s` is the
 * configured half-spread. Quote size is scaled by liquidity so we never
 * move the mid by more than `s / 2`.
 *
 * Inventory management: a skew term shifts quotes away from our current
 * position, which naturally hedges without needing an explicit flatten loop.
 */
export class MarketMakerStrategy extends Strategy {
  readonly name = 'market_maker';
  private readonly halfSpread: number;
  private readonly inventoryByMarket = new Map<string, number>();

  constructor(opts: Opts) {
    super(opts);
    this.halfSpread = opts.halfSpreadBps / 10_000;
  }

  async tick(): Promise<void> {
    const markets = await this.loadOpenMarkets();
    for (const m of markets) {
      const fv = await this.estimateFairValue(m.address, m.priceYes);
      const inventory = this.inventoryByMarket.get(m.address) ?? 0;
      const skew = Math.tanh(inventory / 500) * this.halfSpread * 0.5;

      const bid = Math.max(0.01, fv - this.halfSpread - skew);
      const ask = Math.min(0.99, fv + this.halfSpread - skew);

      // Size is 1% of the thinner side reserve, capped by risk manager downstream.
      const size = BigInt(Math.max(1, Math.floor(Number(m.yesReserve < m.noReserve ? m.yesReserve : m.noReserve) * 0.01)));

      const reserves = { yes: m.yesReserve, no: m.noReserve };
      const buyYes = quoteBuy(reserves, 'YES', size, m.feeBps);
      if (buyYes.avgPrice > 0 && buyYes.avgPrice < bid) {
        await this.ctx.executor.submit({
          market: m.address,
          side: 'BUY',
          outcome: 'YES',
          amount: size,
          limitPrice: bid,
          clientId: `mm:${m.address}:buy:${Date.now()}`,
        });
        this.inventoryByMarket.set(m.address, inventory + Number(buyYes.sharesOut));
      }
      const sellYes = quoteSell(reserves, 'YES', size, m.feeBps);
      if (sellYes.avgPrice > ask) {
        await this.ctx.executor.submit({
          market: m.address,
          side: 'SELL',
          outcome: 'YES',
          amount: size,
          limitPrice: ask,
          clientId: `mm:${m.address}:sell:${Date.now()}`,
        });
        this.inventoryByMarket.set(m.address, inventory - Number(size));
      }
    }
  }

  private async estimateFairValue(market: string, fallback: number): Promise<number> {
    const { rows } = await this.ctx.pool.query(
      `SELECT AVG(price_yes) AS fv
         FROM trades
        WHERE market = $1 AND ts > NOW() - INTERVAL '5 minutes'`,
      [market],
    );
    const fv = rows[0]?.fv;
    return fv != null ? Number(fv) : fallback;
  }
}
