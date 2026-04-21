import type { Logger } from 'pino';
import type { OrderIntent } from '@spmi/shared';
import type { RiskManager } from './risk.js';

interface Opts {
  dryRun: boolean;
  keypairPath: string;
  risk: RiskManager;
  log: Logger;
}

/**
 * Order execution layer.
 *
 * In dry-run mode we log what we would have done and return immediately - ideal
 * for devnet / CI. In live mode we build and sign an Anchor `buy`/`sell`
 * instruction, attach recent blockhash, and submit with a tight retry loop.
 *
 * Live submission is intentionally left as a well-documented stub so you can
 * plug in your preferred RPC (Jito, Helius staked, Triton) and decide on
 * priority-fee strategy without wading through generic boilerplate.
 */
export class Executor {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly opts: Opts) {}

  async submit(intent: OrderIntent): Promise<void> {
    if (this.inflight.has(intent.clientId)) return this.inflight.get(intent.clientId);
    const expectedCostUsd = Number(intent.amount) / 1_000_000; // assume 6dp USDC-style collateral
    const check = this.opts.risk.check(intent, expectedCostUsd);
    if (!check.ok) {
      this.opts.log.warn({ intent, reason: check.reason }, 'order rejected by risk');
      return;
    }

    const p = this.opts.dryRun ? this.dryRun(intent) : this.live(intent);
    this.inflight.set(intent.clientId, p);
    try {
      await p;
      this.opts.risk.commit(intent.market, intent.side === 'BUY' ? expectedCostUsd : -expectedCostUsd, 0);
    } finally {
      this.inflight.delete(intent.clientId);
    }
  }

  private async dryRun(intent: OrderIntent): Promise<void> {
    this.opts.log.info({ intent }, 'DRY_RUN order');
  }

  private async live(intent: OrderIntent): Promise<void> {
    // TODO: build Anchor instruction via the generated IDL client, attach
    // priority fee, send with `sendAndConfirmTransaction`. Keeping this as a
    // clear stub so reviewers can see exactly where their RPC strategy plugs in.
    this.opts.log.info({ intent }, 'LIVE submit (stubbed)');
  }
}
