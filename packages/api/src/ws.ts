import type { FastifyInstance } from 'fastify';

/**
 * Live feed: clients connect to `/ws` and subscribe to `market:<address>` or
 * `global`. The indexer publishes to a Redis channel after every DB write
 * (`spmi:events`); here we fan out to subscribed sockets.
 *
 * Protocol (JSON over WS):
 *   → { "op": "subscribe", "channels": ["global", "market:Abc..."] }
 *   ← { "channel": "global", "payload": { ... } }
 */
export async function registerWsFeed(app: FastifyInstance): Promise<void> {
  const subs = new Map<string, Set<WebSocket>>();

  // Redis subscriber - lazy connect so we don't block boot if redis is down.
  const sub = app.redis.duplicate();
  await sub.subscribe('spmi:events');
  sub.on('message', (_channel, message) => {
    try {
      const parsed = JSON.parse(message) as { channel: string; payload: unknown };
      const set = subs.get(parsed.channel);
      if (!set) return;
      const out = JSON.stringify(parsed);
      for (const socket of set) {
        if (socket.readyState === 1 /* OPEN */) socket.send(out);
      }
    } catch {
      /* ignore malformed */
    }
  });

  app.get('/ws', { websocket: true }, (conn) => {
    const socket = conn.socket as unknown as WebSocket;
    const mySubs = new Set<string>();

    socket.addEventListener('message', (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as { op: string; channels?: string[] };
        if (msg.op === 'subscribe' && Array.isArray(msg.channels)) {
          for (const ch of msg.channels) {
            mySubs.add(ch);
            let set = subs.get(ch);
            if (!set) {
              set = new Set();
              subs.set(ch, set);
            }
            set.add(socket);
          }
          socket.send(JSON.stringify({ op: 'subscribed', channels: [...mySubs] }));
        } else if (msg.op === 'ping') {
          socket.send(JSON.stringify({ op: 'pong', t: Date.now() }));
        }
      } catch {
        socket.send(JSON.stringify({ error: 'invalid JSON' }));
      }
    });

    socket.addEventListener('close', () => {
      for (const ch of mySubs) subs.get(ch)?.delete(socket);
    });
  });
}
