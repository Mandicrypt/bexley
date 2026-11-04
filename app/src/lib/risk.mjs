// Personal risk math. Pure functions, so they are easy to test.
//
// The pool is valued as: pool value = tNEAR held x NEAR price. bxUSD is a
// fixed claim of $1 each; xNEAR owns the rest. So for a given NEAR price,
// one xNEAR is worth (pool value - bxUSD) / xNEAR supply.

const toNum = (units) => Number(BigInt(units ?? 0) / 10n ** 18n) / 1e6; // 24-decimal units to a float

/** The pool's numbers as plain floats. */
export function poolNumbers(state) {
  return {
    price: Number(state.price) / 1e6,
    collateral: toNum(state.collateral),
    bx: toNum(state.bx_supply),
    x: toNum(state.x_supply),
  };
}

/** xNEAR price (dollars) if NEAR were at `price`. */
export function xPriceAt(p, price) {
  if (p.x <= 0) return 1;
  return Math.max(0, (p.collateral * price - p.bx) / p.x);
}

/** xNEAR leverage right now. */
export function leverage(p) {
  const tvl = p.collateral * p.price;
  return tvl > p.bx ? tvl / (tvl - p.bx) : Infinity;
}

/**
 * What a holding of `xAmount` xNEAR and `bxAmount` bxUSD would be worth if
 * NEAR moved by `movePct`, and the change from today.
 */
export function scenario(p, xAmount, bxAmount, movePct) {
  const now = xAmount * xPriceAt(p, p.price) + bxAmount;
  const then = xAmount * xPriceAt(p, p.price * (1 + movePct / 100)) + bxAmount;
  return { now, then, change: then - now, changePct: now > 0 ? ((then - now) / now) * 100 : 0 };
}

/**
 * Daily volatility (percent) from a series of [timestampMs, price] points
 * covering about a day: standard deviation of hourly log returns, scaled to
 * 24 hours.
 */
export function dailyVolatility(points) {
  if (!points || points.length < 4) return null;
  const hourly = [];
  let nextHour = points[0][0];
  for (const [t, v] of points) {
    if (t >= nextHour) {
      hourly.push(v);
      nextHour = t + 3_600_000;
    }
  }
  if (hourly.length < 3) return null;
  const rets = [];
  for (let i = 1; i < hourly.length; i++) rets.push(Math.log(hourly[i] / hourly[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  return sd * Math.sqrt(24) * 100;
}

/**
 * A stop price that ordinary daily noise is unlikely to hit: two days' worth
 * of typical moves below today's price, kept between 5% and 25% below.
 * Without volatility data, 10% below.
 */
export function suggestStop(price, dailyVolPct) {
  const gap = dailyVolPct == null ? 10 : Math.min(25, Math.max(5, 2 * dailyVolPct));
  return { price: Math.round(price * (1 - gap / 100) * 1000) / 1000, gapPct: gap };
}

/** Plain-English risk level for a leverage. */
export function riskWord(lev) {
  if (!Number.isFinite(lev)) return 'Very high';
  if (lev < 1.5) return 'Low';
  if (lev < 2.5) return 'Medium';
  if (lev < 4) return 'High';
  return 'Very high';
}
