import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { logger, type IndexedEvent } from '@spmi/shared';
import { impliedProbability } from '@spmi/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const existsSyncSafe = (p: string): boolean => {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
};

export interface Db {
  migrate(): Promise<void>;
  writeEvent(e: IndexedEvent): Promise<void>;
  close(): Promise<void>;
  pool: Pool;
}

export async function createDb(url: string): Promise<Db> {
  const pool = new Pool({ connectionString: url, max: 10 });
  const log = logger.child({ svc: 'db' });

  return {
    pool,
    async migrate() {
      // When bundled to dist/ the migrations live two levels up; when running
      // with tsx from src/ they live one level up. Try both.
      const candidates = [
        path.join(__dirname, '../../migrations/001_initial.sql'),
        path.join(__dirname, '../migrations/001_initial.sql'),
      ];
      const file = candidates.find(existsSyncSafe);
      if (!file) throw new Error(`migration file not found in: ${candidates.join(', ')}`);
      const sql = readFileSync(file, 'utf8');
      await pool.query(sql);
      log.info({ file }, 'migrations applied');
    },
    async writeEvent(e) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await applyEvent(client, e);
        await client.query(
          `INSERT INTO indexer_cursor (id, last_slot, last_signature, updated_at)
           VALUES (1, $1, $2, NOW())
           ON CONFLICT (id) DO UPDATE SET last_slot=EXCLUDED.last_slot, last_signature=EXCLUDED.last_signature, updated_at=NOW()
           WHERE EXCLUDED.last_slot >= indexer_cursor.last_slot`,
          [e.slot, e.signature],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function applyEvent(c: PoolClient, ie: IndexedEvent): Promise<void> {
  const e = ie.event;
  switch (e.kind) {
    case 'MarketInitialized': {
      await c.query(
        `INSERT INTO markets
           (address, creator, oracle, collateral_mint, yes_reserve, no_reserve, total_volume,
            fee_bps, close_ts, state, winning_outcome, question, created_slot, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,TO_TIMESTAMP($8),'OPEN','UNRESOLVED',$9,$10,TO_TIMESTAMP($11))
         ON CONFLICT (address) DO NOTHING`,
        [
          e.market, e.creator, e.oracle, e.collateralMint,
          e.yesReserve.toString(), e.noReserve.toString(),
          e.feeBps, e.closeTs, e.question, ie.slot, ie.blockTime,
        ],
      );
      break;
    }
    case 'TradeExecuted': {
      const { yes: pYes, no: pNo } = impliedProbability({ yes: e.yesReserveAfter, no: e.noReserveAfter });
      await c.query(
        `INSERT INTO trades
           (signature, slot, market, trader, side, outcome, amount_in, shares, fee,
            yes_reserve_after, no_reserve_after, price_yes, price_no, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TO_TIMESTAMP($14))
         ON CONFLICT (signature) DO NOTHING`,
        [
          ie.signature, ie.slot, e.market, e.trader, e.side, e.outcome,
          e.amountIn.toString(), e.shares.toString(), e.fee.toString(),
          e.yesReserveAfter.toString(), e.noReserveAfter.toString(),
          pYes, pNo, e.ts,
        ],
      );
      await c.query(
        `UPDATE markets
            SET yes_reserve = $1,
                no_reserve  = $2,
                total_volume = total_volume + $3
          WHERE address = $4`,
        [e.yesReserveAfter.toString(), e.noReserveAfter.toString(), e.amountIn.toString(), e.market],
      );
      break;
    }
    case 'MarketResolved': {
      await c.query(
        `UPDATE markets
            SET state = 'RESOLVED',
                winning_outcome = $1,
                resolution_ts = TO_TIMESTAMP($2)
          WHERE address = $3`,
        [e.winningOutcome, e.resolutionTs, e.market],
      );
      break;
    }
    case 'Claimed': {
      await c.query(
        `INSERT INTO claims (signature, slot, market, trader, payout, ts)
         VALUES ($1,$2,$3,$4,$5,TO_TIMESTAMP($6))
         ON CONFLICT (signature, trader) DO NOTHING`,
        [ie.signature, ie.slot, e.market, e.trader, e.payout.toString(), e.ts],
      );
      break;
    }
  }
}
