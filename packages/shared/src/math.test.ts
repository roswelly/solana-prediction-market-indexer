import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impliedProbability, quoteBuy, quoteSell, reservesForPrice } from './math.js';

test('symmetric reserves => 50/50 probability', () => {
  const { yes, no } = impliedProbability({ yes: 1_000_000n, no: 1_000_000n });
  assert.equal(yes, 0.5);
  assert.equal(no, 0.5);
});

test('buy YES increases YES price', () => {
  const r = { yes: 1_000_000n, no: 1_000_000n };
  const { newReserves, sharesOut } = quoteBuy(r, 'YES', 100_000n, 30);
  assert.ok(sharesOut > 0n);
  const { yes } = impliedProbability(newReserves);
  assert.ok(yes > 0.5);
});

test('buy-then-sell round trip loses ~2*fee', () => {
  const r = { yes: 1_000_000n, no: 1_000_000n };
  const buy = quoteBuy(r, 'YES', 100_000n, 30);
  const sell = quoteSell(buy.newReserves, 'YES', buy.sharesOut, 30);
  const loss = 100_000n - sell.amountOut;
  assert.ok(loss > 0n);
  assert.ok(loss < 1_000n);
});

test('reservesForPrice gives expected probability', () => {
  const r = reservesForPrice(10_000_000n, 0.3);
  const { yes } = impliedProbability(r);
  assert.ok(Math.abs(yes - 0.3) < 0.0001);
});
