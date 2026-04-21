import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import type { ProgramEvent } from '@spmi/shared';

/**
 * Anchor emits events via `sol_log_data` which show up in transaction logs as
 *     "Program data: <base64>"
 * The payload is an 8-byte event discriminator followed by the borsh-serialized
 * event fields. This parser extracts those payloads, matches the discriminator
 * against a known set, and decodes the fields.
 *
 * We decode the four prediction_market events without pulling in a full Anchor
 * runtime so this module stays lean and fast.
 */

interface RawEvent {
  kind: ProgramEvent['kind'];
  data: Buffer;
}

export function parseProgramLogs(logs: string[], _programId: string): ProgramEvent[] {
  const events: ProgramEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const b64 = line.slice('Program data: '.length).trim();
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    const raw = decodeDiscriminator(buf);
    if (!raw) continue;
    const parsed = decodeEvent(raw);
    if (parsed) events.push(parsed);
  }
  return events;
}

function decodeDiscriminator(buf: Buffer): RawEvent | null {
  // The event name is encoded via Anchor's discriminator scheme. In production
  // you'd pre-compute `sha256("event:<Name>")[0..8]` for each known event and
  // match buf.subarray(0, 8) against those. For readability and to keep the
  // parser self-contained, we inline a small table.
  const disc = buf.subarray(0, 8).toString('hex');
  const kind = KNOWN_DISCRIMINATORS[disc];
  if (!kind) return null;
  return { kind, data: buf.subarray(8) };
}

/**
 * Anchor event discriminators are `sha256("event:<Name>")[0..8]`. They are
 * populated the first time this module is imported so the values always match
 * the on-chain program without a build step; compare with the IDL's
 * `events[*].name` if you add new events.
 */
const KNOWN_DISCRIMINATORS: Record<string, ProgramEvent['kind']> = buildDiscriminators([
  'MarketInitialized',
  'TradeExecuted',
  'MarketResolved',
  'Claimed',
]);

function buildDiscriminators(names: ProgramEvent['kind'][]): Record<string, ProgramEvent['kind']> {
  const out: Record<string, ProgramEvent['kind']> = {};
  for (const name of names) {
    const disc = createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');
    out[disc] = name;
  }
  return out;
}

function decodeEvent(raw: RawEvent): ProgramEvent | null {
  const r = new BorshReader(raw.data);
  try {
    switch (raw.kind) {
      case 'MarketInitialized':
        return {
          kind: 'MarketInitialized',
          market: r.pubkey(),
          creator: r.pubkey(),
          oracle: r.pubkey(),
          collateralMint: r.pubkey(),
          yesReserve: r.u64(),
          noReserve: r.u64(),
          closeTs: Number(r.i64()),
          feeBps: r.u16(),
          question: r.string(),
        };
      case 'TradeExecuted':
        return {
          kind: 'TradeExecuted',
          market: r.pubkey(),
          trader: r.pubkey(),
          side: r.u8() === 0 ? 'BUY' : 'SELL',
          outcome: r.u8() === 1 ? 'YES' : 'NO',
          amountIn: r.u64(),
          shares: r.u64(),
          fee: r.u64(),
          yesReserveAfter: r.u64(),
          noReserveAfter: r.u64(),
          ts: Number(r.i64()),
        };
      case 'MarketResolved': {
        const market = r.pubkey();
        const w = r.u8();
        return {
          kind: 'MarketResolved',
          market,
          winningOutcome: w === 1 ? 'YES' : w === 2 ? 'NO' : 'INVALID',
          resolutionTs: Number(r.i64()),
        };
      }
      case 'Claimed':
        return {
          kind: 'Claimed',
          market: r.pubkey(),
          trader: r.pubkey(),
          payout: r.u64(),
          ts: Number(r.i64()),
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

class BorshReader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}
  u8(): number {
    return this.buf.readUInt8(this.off++);
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return v;
  }
  pubkey(): string {
    const slice = this.buf.subarray(this.off, this.off + 32);
    this.off += 32;
    return bs58.encode(slice);
  }
  string(): string {
    const len = this.buf.readUInt32LE(this.off);
    this.off += 4;
    const s = this.buf.subarray(this.off, this.off + len).toString('utf8');
    this.off += len;
    return s;
  }
}
