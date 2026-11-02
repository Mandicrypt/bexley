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
  if (change24h != null) {
    const level = feeLevelFor(change24h);
    if (level !== pool.fee_level) actions.push({ type: 'set_fee_level', level, reason: feeReason(level, change24h) });
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
  const state = {
    Healthy: 'All healthy.',
    Caution: 'Caution: fees now favor minting xNEAR and redeeming bxUSD to rebuild backing.',
    Stabilize: 'Protecting bxUSD: new bxUSD and xNEAR exits are paused, and the Stability Pool is absorbing risk.',
  }[pool.mode];
  return `Pool check: ${price}, ${backing}, ${lev}. ${state}`;
}

/** Post a status note if the mode changed since the last one, or it is old. */
export function shouldPostStatus(notes, mode, nowMs, everyMs = 6 * 3600_000) {
  const last = notes.find((n) => n.kind === 'watch');
  if (!last) return true;
  const ageMs = nowMs - Number(BigInt(last.at) / 1_000_000n);
  if (ageMs >= everyMs) return true;
  return !last.text.includes(modeWord(mode));
}

function modeWord(mode) {
  return { Healthy: 'All healthy', Caution: 'Caution', Stabilize: 'Protecting bxUSD' }[mode];
}
