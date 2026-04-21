/**
 * Pricing and sizing math for the constant-product prediction market AMM.
 *
 * Binary outcome shares are bounded to [0, 1] in price, where
 *   priceYes = noReserve / (yesReserve + noReserve)
 *   priceNo  = 1 - priceYes
 *
 * Trade quote uses the standard Uniswap v2 formula with a fee taken on the input.
 */

export const BPS_DENOM = 10_000n;

export interface Reserves {
  yes: bigint;
  no: bigint;
}

export function impliedProbability(r: Reserves): { yes: number; no: number } {
  const total = r.yes + r.no;
  if (total === 0n) return { yes: 0.5, no: 0.5 };
  const yes = Number(r.no) / Number(total);
  return { yes, no: 1 - yes };
}

/** Amount of outcome shares received for `amountIn` collateral. */
export function quoteBuy(r: Reserves, outcome: 'YES' | 'NO', amountIn: bigint, feeBps: number): {
  sharesOut: bigint;
  fee: bigint;
  newReserves: Reserves;
  avgPrice: number;
} {
  if (amountIn <= 0n) throw new Error('amountIn must be positive');
  const fee = (amountIn * BigInt(feeBps)) / BPS_DENOM;
  const net = amountIn - fee;
  const { inR, outR } = pickReserves(r, outcome, 'BUY');
  const k = inR * outR;
  const newIn = inR + net;
  const newOut = k / newIn;
  const sharesOut = outR - newOut;
  const newReserves = setReserves(r, outcome, 'BUY', newIn, newOut);
  const avgPrice = sharesOut === 0n ? 0 : Number(amountIn) / Number(sharesOut);
  return { sharesOut, fee, newReserves, avgPrice };
}

/** Collateral received for `sharesIn` outcome shares. */
export function quoteSell(r: Reserves, outcome: 'YES' | 'NO', sharesIn: bigint, feeBps: number): {
  amountOut: bigint;
  fee: bigint;
  newReserves: Reserves;
  avgPrice: number;
} {
  if (sharesIn <= 0n) throw new Error('sharesIn must be positive');
  const { inR, outR } = pickReserves(r, outcome, 'SELL');
  const k = inR * outR;
  const newIn = inR + sharesIn;
  const newOut = k / newIn;
  const gross = outR - newOut;
  const fee = (gross * BigInt(feeBps)) / BPS_DENOM;
  const amountOut = gross - fee;
  const newReserves = setReserves(r, outcome, 'SELL', newIn, newOut);
  const avgPrice = sharesIn === 0n ? 0 : Number(amountOut) / Number(sharesIn);
  return { amountOut, fee, newReserves, avgPrice };
}

/**
 * Given a target mid-price `p` in [0,1] and total liquidity L (yes+no), return
 * the reserves that realize that price. Useful for sizing market-maker quotes.
 */
export function reservesForPrice(totalLiquidity: bigint, pYes: number): Reserves {
  if (pYes <= 0 || pYes >= 1) throw new Error('price must be in (0,1)');
  const yes = BigInt(Math.max(1, Math.floor(Number(totalLiquidity) * (1 - pYes))));
  const no = totalLiquidity - yes;
  return { yes, no };
}

/**
 * Compute the collateral cost to move the YES price from current to `targetPYes`.
 * Positive return => buy YES; negative => buy NO.
 */
export function costToMovePrice(r: Reserves, targetPYes: number, feeBps: number): {
  side: 'YES' | 'NO';
  amountIn: bigint;
} {
  const { yes } = impliedProbability(r);
  if (Math.abs(targetPYes - yes) < 1e-9) return { side: 'YES', amountIn: 0n };
  const side: 'YES' | 'NO' = targetPYes > yes ? 'YES' : 'NO';
  // Analytic inverse is messy with fees; binary search over amountIn.
  let lo = 0n;
  let hi = (r.yes + r.no) * 10n;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2n;
    if (mid === 0n) {
      lo = 1n;
      continue;
    }
    const { newReserves } = quoteBuy(r, side, mid, feeBps);
    const { yes: p } = impliedProbability(newReserves);
    const cmp = side === 'YES' ? p < targetPYes : 1 - p < 1 - targetPYes;
    if (cmp) lo = mid;
    else hi = mid;
  }
  return { side, amountIn: lo };
}

function pickReserves(r: Reserves, outcome: 'YES' | 'NO', side: 'BUY' | 'SELL') {
  if (side === 'BUY') {
    return outcome === 'YES' ? { inR: r.no, outR: r.yes } : { inR: r.yes, outR: r.no };
  }
  return outcome === 'YES' ? { inR: r.yes, outR: r.no } : { inR: r.no, outR: r.yes };
}

function setReserves(
  r: Reserves,
  outcome: 'YES' | 'NO',
  side: 'BUY' | 'SELL',
  newIn: bigint,
  newOut: bigint,
): Reserves {
  if (side === 'BUY') {
    return outcome === 'YES' ? { yes: newOut, no: newIn } : { yes: newIn, no: newOut };
  }
  return outcome === 'YES' ? { yes: newIn, no: newOut } : { yes: newOut, no: newIn };
}
