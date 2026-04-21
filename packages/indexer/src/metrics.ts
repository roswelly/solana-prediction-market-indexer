import http from 'node:http';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { logger } from '@spmi/shared';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const eventsProcessed = new Counter({
  name: 'spmi_indexer_events_processed_total',
  help: 'Events processed by kind',
  labelNames: ['kind'],
  registers: [registry],
});

export const parseFailures = new Counter({
  name: 'spmi_indexer_parse_failures_total',
  help: 'Transactions that failed to parse',
  registers: [registry],
});

export const slotLag = new Histogram({
  name: 'spmi_indexer_slot_lag_seconds',
  help: 'Wall-clock lag from block_time to ingestion',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export function startMetricsServer(port: number) {
  const server = http.createServer(async (_req, res) => {
    res.setHeader('content-type', registry.contentType);
    res.end(await registry.metrics());
  });
  server.listen(port, () => logger.info({ port }, 'metrics server listening'));
  return server;
}
