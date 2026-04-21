import { EventEmitter } from 'node:events';
import { Connection, PublicKey } from '@solana/web3.js';
import PQueue from 'p-queue';
import { logger, type IndexedEvent } from '@spmi/shared';
import { parseProgramLogs } from '../parsers/prediction-market.js';
import { eventsProcessed, parseFailures, slotLag } from '../metrics.js';

interface Options {
  rpcHttp: string;
  rpcWs: string;
  programId: string;
  commitment: 'processed' | 'confirmed' | 'finalized';
}

/**
 * WebSocket-based ingestion adapter.
 *
 * Subscribes to program `logsSubscribe`, then fetches each referenced transaction
 * with `getTransaction` to recover block time and full meta. This is the most
 * portable approach — works against any standard Solana RPC.
 *
 * For production throughput swap the `GeyserAdapter` in via `INDEXER_ADAPTER=geyser`.
 */
export class WebSocketAdapter extends EventEmitter {
  private readonly conn: Connection;
  private readonly programId: PublicKey;
  private readonly queue = new PQueue({ concurrency: 8 });
  private subId: number | null = null;
  private log = logger.child({ svc: 'indexer', adapter: 'ws' });

  constructor(private readonly opts: Options) {
    super();
    this.conn = new Connection(opts.rpcHttp, { wsEndpoint: opts.rpcWs, commitment: opts.commitment });
    this.programId = new PublicKey(opts.programId);
  }

  async start(): Promise<void> {
    this.log.info({ programId: this.opts.programId }, 'subscribing to program logs');
    this.subId = this.conn.onLogs(
      this.programId,
      (logs, ctx) => {
        if (logs.err) return;
        void this.queue.add(() => this.handleLogs(logs.signature, ctx.slot, logs.logs));
      },
      this.opts.commitment,
    );
    // Kick off a lightweight backfill for recently confirmed signatures.
    void this.backfillRecent();
  }

  async stop(): Promise<void> {
    if (this.subId != null) await this.conn.removeOnLogsListener(this.subId);
    await this.queue.onIdle();
  }

  private async backfillRecent(): Promise<void> {
    try {
      const sigs = await this.conn.getSignaturesForAddress(this.programId, { limit: 50 });
      for (const s of sigs.reverse()) {
        if (s.err) continue;
        void this.queue.add(() => this.handleSignature(s.signature));
      }
    } catch (err) {
      this.log.warn({ err }, 'backfill failed (continuing with live subscription)');
    }
  }

  private async handleLogs(signature: string, slot: number, _logs: string[]): Promise<void> {
    await this.handleSignature(signature, slot);
  }

  private async handleSignature(signature: string, hintSlot?: number): Promise<void> {
    try {
      const tx = await this.conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: this.opts.commitment,
      });
      if (!tx || !tx.meta || tx.meta.err) return;
      const slot = tx.slot ?? hintSlot ?? 0;
      const blockTime = tx.blockTime ?? Math.floor(Date.now() / 1000);
      if (tx.blockTime) slotLag.observe(Math.max(0, Date.now() / 1000 - tx.blockTime));

      const events = parseProgramLogs(tx.meta.logMessages ?? [], this.opts.programId);
      for (const event of events) {
        const indexed: IndexedEvent = { signature, slot, blockTime, event };
        eventsProcessed.labels(event.kind).inc();
        this.emit('event', indexed);
      }
    } catch (err) {
      parseFailures.inc();
      this.log.warn({ err, signature }, 'failed to process signature');
      this.emit('error', err);
    }
  }
}
