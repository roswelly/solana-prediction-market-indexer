import { EventEmitter } from 'node:events';
import { logger } from '@spmi/shared';

interface Options {
  endpoint: string;
  token: string;
  programId: string;
}

/**
 * Yellowstone Geyser gRPC adapter (stubbed).
 *
 * Wiring up the real implementation requires the `@triton-one/yellowstone-grpc`
 * client. We define the interface here so the rest of the system is agnostic
 * to the ingestion source; flip `INDEXER_ADAPTER=geyser` once your provider
 * is configured.
 *
 * The expected implementation:
 *   const client = new Client(endpoint, token);
 *   const stream = await client.subscribe();
 *   await stream.write({ transactions: { predMkt: { accountInclude: [programId] } } });
 *   stream.on('data', (msg) => { ... parseProgramLogs(msg.transaction.meta.logMessages) ... });
 */
export class GeyserAdapter extends EventEmitter {
  private log = logger.child({ svc: 'indexer', adapter: 'geyser' });

  constructor(private readonly opts: Options) {
    super();
  }

  async start(): Promise<void> {
    this.log.warn(
      { endpoint: this.opts.endpoint },
      'GeyserAdapter is a stub — add @triton-one/yellowstone-grpc and implement the stream handler here',
    );
    throw new Error('GeyserAdapter not implemented. Use INDEXER_ADAPTER=websocket or finish the implementation.');
  }

  async stop(): Promise<void> {
    /* no-op */
  }
}
