import { EventEmitter } from 'node:events';
import type { Env, IndexedEvent } from '@spmi/shared';
import { WebSocketAdapter } from './rpc-websocket.js';
import { GeyserAdapter } from './geyser-grpc.js';

export interface IngestionAdapter extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createAdapter(env: Env): IngestionAdapter {
  if (env.INDEXER_ADAPTER === 'geyser') {
    if (!env.GEYSER_GRPC_ENDPOINT) {
      throw new Error('INDEXER_ADAPTER=geyser but GEYSER_GRPC_ENDPOINT is unset');
    }
    return new GeyserAdapter({
      endpoint: env.GEYSER_GRPC_ENDPOINT,
      token: env.GEYSER_GRPC_TOKEN ?? '',
      programId: env.PREDICTION_MARKET_PROGRAM_ID,
    });
  }
  return new WebSocketAdapter({
    rpcHttp: env.SOLANA_RPC_HTTP,
    rpcWs: env.SOLANA_RPC_WS,
    programId: env.PREDICTION_MARKET_PROGRAM_ID,
    commitment: env.COMMITMENT,
  });
}

export type { IndexedEvent };
