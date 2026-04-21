/**
 * Seeds the database with synthetic markets + trades so the API and bot have
 * realistic data to chew on without needing a live on-chain feed. Useful for
 * dashboards screenshots, backtests, and local dev.
 *
 *   npm run db:seed
 */
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://spmi:spmi@localhost:5432/spmi' });

const pubkey = () => bs58.encode(randomBytes(32));

const QUESTIONS = [
  'Will BTC close above $100k on Dec 31?',
  'Will SOL ETF be approved by Q3?',
  'Will US CPI print below 3.0% next release?',
  'Will Solana TPS exceed 10,000 sustained this month?',
  'Will Fed cut rates at the next meeting?',
];

async function main() {
  console.log('seeding...');
  for (const q of QUESTIONS) {
    const address = pubkey();
    const yes = BigInt(500_000 + Math.floor(Math.random() * 500_000));
    const no = BigInt(500_000 + Math.floor(Math.random() * 500_000));
    await pool.query(
      `INSERT INTO markets
         (address, creator, oracle, collateral_mint, yes_reserve, no_reserve, total_volume,
          fee_bps, close_ts, state, winning_outcome, question, created_slot, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,0,30,NOW()+INTERVAL '14 days','OPEN','UNRESOLVED',$7,$8,NOW())
       ON CONFLICT (address) DO NOTHING`,
      [address, pubkey(), pubkey(), pubkey(), yes.toString(), no.toString(), 100, q],
    );
    let y = yes, n = no;
    for (let i = 0; i < 120; i++) {
      const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
      const outcome = Math.random() > 0.5 ? 'YES' : 'NO';
      const amount = BigInt(1_000 + Math.floor(Math.random() * 10_000));
      // Crude reserve walk so the seed looks plausible in candles.
      if (outcome === 'YES') {
        if (side === 'BUY') { n += amount; y = (y * n) / n - amount; } else { y += amount; n -= amount / 2n; }
      } else {
        if (side === 'BUY') { y += amount; n = (y * n) / y - amount; } else { n += amount; y -= amount / 2n; }
      }
      if (y < 1n) y = 1n;
      if (n < 1n) n = 1n;
      const pYes = Number(n) / Number(y + n);
      await pool.query(
        `INSERT INTO trades (signature, slot, market, trader, side, outcome, amount_in, shares, fee,
                             yes_reserve_after, no_reserve_after, price_yes, price_no, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,30,$8,$9,$10,$11,NOW() - ($12 || ' minutes')::INTERVAL)
         ON CONFLICT (signature) DO NOTHING`,
        [
          bs58.encode(randomBytes(64)), 1000 + i, address, pubkey(), side, outcome,
          amount.toString(), y.toString(), n.toString(), pYes, 1 - pYes, (120 - i) * 5,
        ],
      );
    }
    await pool.query(
      `UPDATE markets SET yes_reserve = $1, no_reserve = $2, total_volume = total_volume + 100000
        WHERE address = $3`,
      [y.toString(), n.toString(), address],
    );
    console.log(`  seeded market: ${q}`);
  }
  await pool.end();
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
