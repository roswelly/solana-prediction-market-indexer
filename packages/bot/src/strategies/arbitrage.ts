import { impliedProbability, quoteBuy } from '@spmi/shared';
import { Strategy, type StrategyContext } from './base.js';

interface Opts extends StrategyContext {
  minEdgeBps: number;
}

/**
 * Two arbitrage signals:
 *
 * 1. `split-arb`: buying 1 YES + 1 NO costs < 1 collateral. In a well-priced
 *    market `pYes + pNo ≈ 1`; AMM slippage can momentarily push the pair below 1
 *    after large one-sided flow. We size to consume the dislocation while
 *    keeping post-trade edge above the configured floor.
 *
 * 2. `stale-mid`: compare AMM mid vs. 30s rolling VWAP. If VWAP is persistently
 *    above (below) mid by more than `minEdgeBps`, take the other side — a
 *    simple but surprisingly effective signal on thin markets.
 */
export class ArbitrageStrategy extends Strategy {
  readonly name = 'arbitrage';
  private readonly minEdge: number;

  constructor(opts: Opts) {
    super(opts);
    this.minEdge = opts.minEdgeBps / 10_000;
  }

  async tick(): Promise<void> {
    const markets = await this.loadOpenMarkets();
    for (const m of markets) {
      const r = { yes: m.yesReserve, no: m.noReserve };
      const { yes } = impliedProbability(r);
      const sumPrice = yes + (1 - yes);

      // Signal 1: sum-of-prices vs 1.0 (bounded by fee), captured by small
      // probes that buy both outcomes in size.
      if (sumPrice < 1 - this.minEdge - m.feeBps / 10_000) {
        const probe = BigInt(Math.max(1, Number(r.yes + r.no) / 2000));
        const yQuote = quoteBuy(r, 'YES', probe, m.feeBps);
        const nQuote = quoteBuy(r, 'NO', probe, m.feeBps);
        const cost = Number(probe) * 2;
        const payoutIfAny = Number(yQuote.sharesOut > nQuote.sharesOut ? yQuote.sharesOut : nQuote.sharesOut);
        if (payoutIfAny > cost * (1 + this.minEdge)) {
          await this.ctx.executor.submit({
            market: m.address, side: 'BUY', outcome: 'YES', amount: probe, limitPrice: yes + this.minEdge,
            clientId: `arb:split:${m.address}:${Date.now()}`,
          });
        }
      }

      // Signal 2: stale-mid.
      const vwap = await this.vwap30s(m.address);
      if (vwap != null) {
        if (vwap > yes + this.minEdge) {
          await this.ctx.executor.submit({
            market: m.address, side: 'BUY', outcome: 'YES',
            amount: BigInt(Math.max(1, Number(r.no) / 1000)),
            limitPrice: vwap, clientId: `arb:vwap:yes:${m.address}:${Date.now()}`,
          });
        } else if (vwap < yes - this.minEdge) {
          await this.ctx.executor.submit({
            market: m.address, side: 'BUY', outcome: 'NO',
            amount: BigInt(Math.max(1, Number(r.yes) / 1000)),
            limitPrice: 1 - vwap, clientId: `arb:vwap:no:${m.address}:${Date.now()}`,
          });
        }
      }
    }
  }

  private async vwap30s(market: string): Promise<number | null> {
    const { rows } = await this.ctx.pool.query(
      `SELECT SUM(price_yes * amount_in) / NULLIF(SUM(amount_in), 0) AS vwap
         FROM trades
        WHERE market = $1 AND ts > NOW() - INTERVAL '30 seconds'`,
      [market],
    );
    const v = rows[0]?.vwap;
    return v != null ? Number(v) : null;
  }
}
