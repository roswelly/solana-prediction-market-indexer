import type { OrderIntent } from '@spmi/shared';

interface Opts {
  maxPositionUsd: number;
  maxDailyLossUsd: number;
}

/**
 * Minimal pre-trade risk checks. Real systems would plug in position & PnL
 * services, kill-switches, per-market limits, circuit breakers, etc.
 */
export class RiskManager {
  private positionUsd = new Map<string, number>();
  private dailyPnlUsd = 0;
  private dayStart = new Date().toDateString();

  constructor(private readonly opts: Opts) {}

  check(intent: OrderIntent, expectedCostUsd: number): { ok: true } | { ok: false; reason: string } {
    this.rolloverIfNeeded();
    if (this.dailyPnlUsd <= -this.opts.maxDailyLossUsd) {
      return { ok: false, reason: `daily loss limit hit (${this.dailyPnlUsd.toFixed(2)})` };
    }
    const pos = this.positionUsd.get(intent.market) ?? 0;
    const delta = intent.side === 'BUY' ? expectedCostUsd : -expectedCostUsd;
    const next = pos + delta;
    if (Math.abs(next) > this.opts.maxPositionUsd) {
      return { ok: false, reason: `position cap ${this.opts.maxPositionUsd} exceeded (would be ${next.toFixed(2)})` };
    }
    return { ok: true };
  }

  commit(market: string, deltaPositionUsd: number, realizedPnlUsd: number): void {
    this.positionUsd.set(market, (this.positionUsd.get(market) ?? 0) + deltaPositionUsd);
    this.dailyPnlUsd += realizedPnlUsd;
  }

  private rolloverIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.dayStart) {
      this.dayStart = today;
      this.dailyPnlUsd = 0;
    }
  }
}
