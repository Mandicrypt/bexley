// The Guardian's AI brain.
//
// An AI model (on NEAR AI Cloud) reads the market and the pool and decides
// the fee level and the savings rate, then explains why in plain English.
// It works inside hard limits that are checked twice: here (`checkDecision`)
// and again by the pool contract. If the AI is unreachable or answers
// badly, the Guardian falls back to its fixed rules (logic.mjs).

import { feeLevelFor, savingsRateFor, feeReason, rateReason, statusNote } from './logic.mjs';

export const NEARAI_URL = process.env.NEARAI_URL || 'https://cloud-api.near.ai/v1';
export const MODELS = (process.env.NEARAI_MODEL || 'deepseek-ai/DeepSeek-V4-Flash,z-ai/glm-5.2').split(',');

/** Hard limits. The pool contract enforces the first two itself as well. */
export const LIMITS = {
  feeLevels: [0, 1, 2],
  rateMin: 0,
  rateMax: 2000,
  /** Largest rate change in one decision, so the rate moves in steps. */
  rateStepMax: 400,
};

export const SYSTEM_PROMPT = `You are the Pool Guardian of Bexley, a protocol on NEAR that splits one pool of NEAR into two tokens:
- bxUSD, a stablecoin worth $1. Savers who put bxUSD in the Stability Pool earn a savings rate paid by xNEAR holders, plus 80% of fees.
- xNEAR, leveraged NEAR. It owns everything the pool is worth above the bxUSD it owes. Its leverage = pool value / (pool value - bxUSD).
Backing = pool value / bxUSD. Modes: Healthy at 150% or more, Caution 130-150%, Stabilize under 130%.

Every few minutes you decide two settings:
1. fee_level: 0 (normal fees), 1 (2x fees) or 2 (3x fees). Raise fees when NEAR is volatile, to slow churn and pay the Stability Pool for extra risk. Lower them when markets calm down.
2. savings_rate_bps: yearly rate for savers in basis points, 0 to 2000 (20%). It is the price of leverage. When bxUSD is scarce (high backing, xNEAR barely levered) a higher rate attracts savers, which adds bxUSD and gives xNEAR more leverage. When xNEAR is already well levered (backing near 150%) a lower rate eases its cost and avoids pushing backing down. Outside Healthy mode it must be 0.

Rules you must follow:
- Change the rate by at most 400 bps from the current rate in one decision.
- Prefer stability: do not change settings for small moves. Only change when the evidence is clear.
- Never invent numbers. Use only the data given.

Answer with JSON only, no other text:
{"fee_level": 0|1|2, "savings_rate_bps": integer, "reason": "one or two plain sentences for users explaining any change, citing the numbers that drove it", "status": "one short plain sentence summarizing the pool right now"}
Write for ordinary users: short sentences, no jargon, no exclamation marks.`;

/** The facts the AI sees. Small, numeric, and all from real sources. */
export function buildFacts(pool, market) {
  const n = (v, d = 2) => (v == null ? null : Number(Number(v).toFixed(d)));
  const cr = BigInt(pool.cr_bps);
  return {
    near_price_usd: n(Number(BigInt(pool.price)) / 1e6, 4),
    near_change_24h_pct: n(market.change24h),
    near_volatility_24h_pct: n(market.vol24h),
    near_range_24h_pct: n(market.range24h),
    pool_mode: pool.mode,
    backing_pct: cr === 0n ? null : n(Number(cr) / 100, 1),
    xnear_leverage: BigInt(pool.x_supply) === 0n ? null : n(Number(BigInt(pool.leverage_bps)) / 10000),
    pool_value_usd: n(Number(BigInt(pool.tvl) / 10n ** 18n) / 1e6),
    bxusd_supply: n(Number(BigInt(pool.bx_supply) / 10n ** 18n) / 1e6),
    stability_pool_usd: n(Number(BigInt(pool.stability_pool.value) / 10n ** 18n) / 1e6),
    current_fee_level: pool.fee_level,
    current_savings_rate_bps: pool.savings_rate_set_bps,
  };
}

/** Pull the first JSON object out of a model reply. */
export function parseReply(text) {
  if (!text) throw new Error('Empty reply');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON in reply');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Check an AI decision against the hard limits. Returns a safe decision, or
 * throws if it is unusable. Out-of-range values are clamped rather than
 * trusted; a non-Healthy pool always gets a 0% rate.
 */
export function checkDecision(d, pool) {
  if (!d || typeof d !== 'object') throw new Error('Decision is not an object');
  const level = Number(d.fee_level);
  if (!LIMITS.feeLevels.includes(level)) throw new Error(`Bad fee level: ${d.fee_level}`);
  let rate = Math.round(Number(d.savings_rate_bps));
  if (!Number.isFinite(rate)) throw new Error(`Bad rate: ${d.savings_rate_bps}`);
  const cur = Number(pool.savings_rate_set_bps ?? 800);
  rate = Math.max(LIMITS.rateMin, Math.min(LIMITS.rateMax, rate));
  rate = Math.max(cur - LIMITS.rateStepMax, Math.min(cur + LIMITS.rateStepMax, rate));
  if (pool.mode !== 'Healthy') rate = 0;
  const reason = String(d.reason || '').replace(/\s+/g, ' ').trim().slice(0, 270);
  const status = String(d.status || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (reason.length < 10) throw new Error('Reason missing');
  return { level, rate, reason, status };
}

/** What the fixed rules would decide (the fallback). */
export function ruleDecision(pool, market) {
  const level = market.change24h != null ? feeLevelFor(market.change24h) : pool.fee_level;
  const rate = savingsRateFor(pool);
  const parts = [];
  if (rate !== pool.savings_rate_set_bps) parts.push(rateReason(rate, pool));
  if (level !== pool.fee_level) parts.push(feeReason(level, market.change24h));
  return { level, rate, reason: parts.join(' ') || 'No change needed.', status: statusNote(pool, market.change24h) };
}

/** Ask the model. Tries each model in turn. Returns {decision, model} or throws. */
export async function askAI(pool, market, { apiKey = process.env.NEARAI_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('No NEARAI_API_KEY');
  const facts = buildFacts(pool, market);
  const errs = [];
  for (const model of MODELS) {
    try {
      const r = await fetchImpl(`${NEARAI_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Pool and market data:\n${JSON.stringify(facts, null, 2)}` },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!r.ok) throw new Error(`${model}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      const j = await r.json();
      const c = j?.choices?.[0];
      // Some models put their answer in reasoning fields when content is empty.
      const text = c?.message?.content || c?.message?.reasoning_content || c?.message?.reasoning || '';
      if (!text) throw new Error(`${model}: empty reply (finish: ${c?.finish_reason || 'none'})`);
      return { decision: checkDecision(parseReply(text), pool), model, facts };
    } catch (e) {
      errs.push(String(e?.message || e).includes(model) ? String(e.message) : `${model}: ${e?.message || e}`);
    }
  }
  throw new Error(errs.join(' | '));
}

/**
 * Volatility from hourly candles: standard deviation of hourly returns,
 * scaled to 24 hours, plus the high-low range, both in percent.
 */
export function volatilityFromCandles(closes, highs, lows) {
  if (!closes || closes.length < 3) return { vol24h: null, range24h: null };
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  return { vol24h: sd * Math.sqrt(24) * 100, range24h: ((hi - lo) / lo) * 100 };
}
