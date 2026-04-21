import PQueue from 'p-queue';
import type { Logger } from 'pino';
import type { IndexedEvent } from '@spmi/shared';
import type { Db } from './db/client.js';

interface Options {
  db: Db;
  log: Logger;
  concurrency: number;
}

/**
 * Serializes event writes per-market while keeping throughput up across markets.
 * Events for the same market are guaranteed to be applied in (slot, signature)
 * order; events across markets can commit in parallel up to `concurrency`.
 */
export class Pipeline {
  private readonly perMarket = new Map<string, PQueue>();
  private readonly global: PQueue;

  constructor(private readonly opts: Options) {
    this.global = new PQueue({ concurrency: opts.concurrency });
  }

  enqueue(e: IndexedEvent): void {
    const key = keyForEvent(e);
    let q = this.perMarket.get(key);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.perMarket.set(key, q);
    }
    void this.global.add(() =>
      q!.add(async () => {
        try {
          await this.opts.db.writeEvent(e);
        } catch (err) {
          this.opts.log.error({ err, sig: e.signature, kind: e.event.kind }, 'write failed');
        }
      }),
    );
  }

  async drain(): Promise<void> {
    await this.global.onIdle();
    await Promise.all(Array.from(this.perMarket.values(), (q) => q.onIdle()));
  }
}

function keyForEvent(e: IndexedEvent): string {
  const ev = e.event;
  return 'market' in ev ? ev.market : 'global';
}
