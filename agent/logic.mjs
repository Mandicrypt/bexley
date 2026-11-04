// Pool Guardian: decision logic. Pure functions, no network, so they can be
// tested on their own. The contract re-checks everything the Guardian does,
// so a mistake here can only cause a refused call, never a loss.

/**
 * Post a new price when there is none, it moved by at least `moveBps`, or the
 * last post is older than `maxAgeMs` (the pool refuses prices over an hour old).
 */
export function shouldPostPrice(onchain, newPrice, nowMs, { moveBps = 10, maxAgeMs = 20 * 60_000 } = {}) {
  const current = BigInt(onchain.price);
  if (current === 0n) return true;
  const ageMs = nowMs - Number(BigInt(onchain.price_updated_at ?? onchain.updated_at) / 1_000_000n);
  if (ageMs >= maxAgeMs) return true;
  const diff = newPrice > current ? newPrice - current : current - newPrice;
  return diff * 10_000n >= current * BigInt(moveBps);
}

/** Dollars (number) to micro-dollars (bigint). */
export function toMicroUsd(usd) {
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error(`Bad price: ${usd}`);
  return BigInt(Math.round(usd * 1_000_000));
}

/**
 * Fee level from how much NEAR moved in the last 24 hours:
 * under 5% calm (normal fees), 5-10% volatile (2x), over 10% stormy (3x).
 * Higher fees in rough markets slow down churn and pay the Stability Pool
 * more for the extra risk it carries.
 */
export function feeLevelFor(change24hPct) {
  const m = Math.abs(Number(change24hPct) || 0);
  if (m >= 10) return 2;
  if (m >= 5) return 1;
  return 0;
}

const LEVEL_WORDS = ['calm', 'volatile', 'stormy'];

export function feeReason(level, change24hPct) {
  const c = Number(change24hPct || 0).toFixed(1);
  if (level === 0) return `NEAR moved ${c}% in 24h. Markets are calm, so fees are back to normal.`;
  return `NEAR moved ${c}% in 24h, so the market is ${LEVEL_WORDS[level]}. Fees are now ${level + 1}x to slow churn and pay the Stability Pool more for the extra risk.`;
}

/**
 * Savings rate (basis points a year) from how much leverage people want.
 * xNEAR pays it to bxUSD savers.
 * - Backing over 300%: bxUSD is scarce and xNEAR barely levered, so pay
 *   savers more to attract bxUSD (12%).
 * - 200-300%: balanced (8%).
 * - Under 200%: plenty of bxUSD and xNEAR already levered, so ease the cost
 *   on xNEAR (5%).
 * - Not Healthy: the pool pays nothing (0%).
 * - No bxUSD yet: the standard 8%, to attract the first savers.
 */
export function savingsRateFor(pool) {
  if (pool.mode !== 'Healthy') return 0;
  const cr = Number(BigInt(pool.cr_bps));
  if (cr === 0) return 800;
  if (cr >= 30_000) return 1200;
  if (cr >= 20_000) return 800;
  return 500;
}

export function rateReason(rate, pool) {
  const r = `${(rate / 100).toFixed(0)}%`;
  if (pool.mode !== 'Healthy') return `The pool is in ${pool.mode} mode, so savers' interest is paused to protect xNEAR. Savings rate set to 0% until it is healthy again.`;
  const cr = Number(BigInt(pool.cr_bps));
  if (cr === 0) return `No bxUSD yet. Savings rate set to ${r} a year to attract the first savers.`;
  const b = `Backing is ${pct(pool.cr_bps)} and xNEAR is at ${times(pool.leverage_bps)}`;
  if (rate >= 1200) return `${b}, so bxUSD is scarce. Raised the savings rate to ${r} a year to attract savers, which gives xNEAR more leverage.`;
  if (rate >= 800) return `${b}, a good balance. Savings rate set to ${r} a year.`;
  return `${b}, so xNEAR is already well levered. Lowered the savings rate to ${r} a year to ease the cost on xNEAR holders.`;
}

/** "167%" from basis points (string or bigint). */
export function pct(bps) {
  return `${(Number(BigInt(bps)) / 100).toFixed(0)}%`;
}

export function times(bps) {
  return `${(Number(BigInt(bps)) / 10_000).toFixed(2)}x`;
}

/**
 * What to do this tick, from the pool's state. Returns a list of actions in
 * order: price first (everything else needs a fresh price), then protection,
 * then vaults and orders.
 */
export function plan({ pool, vaults, triggered, newPrice, change24h, nowMs }) {
  const actions = [];
  if (newPrice != null && shouldPostPrice(pool, newPrice, nowMs)) {
    actions.push({ type: 'set_price', price: newPrice });
  }
  // Fee level and savings rate go out in one call (set_fee_level).
  const level = change24h != null ? feeLevelFor(change24h) : pool.fee_level;
  const rate = savingsRateFor(pool);
  const levelChanged = level !== pool.fee_level;
  const rateChanged = pool.savings_rate_set_bps != null && rate !== pool.savings_rate_set_bps;
  if (levelChanged || rateChanged) {
    const reasons = [];
    if (rateChanged) reasons.push(rateReason(rate, pool));
    if (levelChanged) reasons.push(feeReason(level, change24h));
    actions.push({ type: 'set_fee_level', level, rate, reason: reasons.join(' ') });
  }
  if (pool.mode === 'Stabilize' && BigInt(pool.stability_pool.bx) > 0n) {
    actions.push({ type: 'stabilize' });
  }
  for (const v of vaults) {
    if (v.needs_rebalance) actions.push({ type: 'rebalance', vault: v.id });
  }
  for (const o of triggered) actions.push({ type: 'execute_order', order_id: o.id });
  return actions;
}

/** A plain-English pool check, posted when the mode changes or every few hours. */
export function statusNote(pool, change24h) {
  const backing = BigInt(pool.cr_bps) === 0n ? 'no bxUSD yet' : `backing ${pct(pool.cr_bps)}`;
  const lev = BigInt(pool.x_supply) === 0n ? 'no xNEAR yet' : `xNEAR at ${times(pool.leverage_bps)}`;
  const price = `NEAR $${(Number(BigInt(pool.price)) / 1e6).toFixed(3)}${change24h != null ? ` (${change24h >= 0 ? '+' : ''}${Number(change24h).toFixed(1)}% today)` : ''}`;
  const rate = pool.savings_rate_bps != null && BigInt(pool.cr_bps) > 0n ? ` Savers earn ${(Number(pool.savings_rate_bps) / 100).toFixed(0)}% a year.` : '';
  const state = {
    Healthy: `All healthy.${rate}`,
    Caution: 'Caution: fees now favor minting xNEAR and redeeming bxUSD to rebuild backing.',
    Stabilize: 'Protecting bxUSD: new bxUSD and xNEAR exits are paused, and the Stability Pool is absorbing risk.',
  }[pool.mode];
  return `Pool check: ${price}, ${backing}, ${lev}. ${state}`;
}

/**
 * Post a pool check when the mode changed, the pool changed a lot since the
 * last check (first bxUSD or xNEAR, or backing moved 20+ points), or the
 * last check is older than `everyMs`.
 */
export function shouldPostStatus(notes, mode, nowMs, everyMs = 6 * 3600_000, pool = null) {
  const last = notes.find((n) => n.kind === 'watch');
  if (!last) return true;
  const ageMs = nowMs - Number(BigInt(last.at) / 1_000_000n);
  if (ageMs >= everyMs) return true;
  if (!last.text.includes(modeWord(mode))) return true;
  if (pool) {
    if (last.text.includes('no xNEAR yet') && BigInt(pool.x_supply) > 0n) return true;
    if (last.text.includes('no bxUSD yet') && BigInt(pool.cr_bps) > 0n) return true;
    const m = last.text.match(/backing (\d+)%/);
    if (m && BigInt(pool.cr_bps) > 0n && Math.abs(Number(m[1]) - Number(BigInt(pool.cr_bps)) / 100) >= 20) return true;
  }
  return false;
}

function modeWord(mode) {
  return { Healthy: 'All healthy', Caution: 'Caution', Stabilize: 'Protecting bxUSD' }[mode];
}
