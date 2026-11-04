import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDecision, parseReply, ruleDecision, askAI, buildFacts, volatilityFromCandles } from './ai.mjs';

const T = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();
const pool = (over = {}) => ({
  price: '3905000', mode: 'Healthy', fee_level: 0, cr_bps: '34800', leverage_bps: '14000', x_supply: T(189),
  tvl: T(273), bx_supply: T(78), stability_pool: { value: T(10) }, savings_rate_bps: 800, savings_rate_set_bps: 800, ...over,
});

test('reads JSON even with extra text around it', () => {
  assert.deepEqual(parseReply('Sure:\n{"fee_level":1}\nDone'), { fee_level: 1 });
  assert.throws(() => parseReply('no json'));
});

test('clamps the rate to the step limit and the 0-20% range', () => {
  const d = checkDecision({ fee_level: 0, savings_rate_bps: 5000, reason: 'Backing is high, raise the rate.' }, pool());
  assert.equal(d.rate, 1200); // 800 + max step 400
  const d2 = checkDecision({ fee_level: 0, savings_rate_bps: -50, reason: 'Lower the rate a lot please.' }, pool({ savings_rate_set_bps: 200 }));
  assert.equal(d2.rate, 0);
});

test('forces a 0% rate outside Healthy mode', () => {
  const d = checkDecision({ fee_level: 2, savings_rate_bps: 900, reason: 'Backing is under 150 percent now.' }, pool({ mode: 'Caution' }));
  assert.equal(d.rate, 0);
});

test('rejects unusable answers', () => {
  assert.throws(() => checkDecision({ fee_level: 5, savings_rate_bps: 800, reason: 'xxxxxxxxxxxx' }, pool()));
  assert.throws(() => checkDecision({ fee_level: 1, savings_rate_bps: 'lots', reason: 'xxxxxxxxxxxx' }, pool()));
  assert.throws(() => checkDecision({ fee_level: 1, savings_rate_bps: 800, reason: '' }, pool()));
});

test('rules fallback gives a full decision', () => {
  const d = ruleDecision(pool(), { change24h: -6 });
  assert.equal(d.level, 1);
  assert.equal(d.rate, 1200);
  assert.match(d.reason, /12%/);
});

test('askAI uses the model reply and checks it', async () => {
  const fake = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.match(url, /chat\/completions$/);
    assert.match(opts.headers.Authorization, /^Bearer k$/);
    assert.equal(body.messages.length, 2);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"fee_level":1,"savings_rate_bps":1100,"reason":"NEAR swung 6% today, so fees go to 2x. Backing is 348%, so the rate rises to 11%.","status":"Healthy at 348% backing."}' } }] }),
    };
  };
  const r = await askAI(pool(), { change24h: -6, vol24h: 3.1, range24h: 7 }, { apiKey: 'k', fetchImpl: fake });
  assert.equal(r.decision.level, 1);
  assert.equal(r.decision.rate, 1100);
});

test('askAI tries the next model when one fails', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 404, text: async () => 'no model' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"fee_level":0,"savings_rate_bps":800,"reason":"Markets are calm, nothing to change."}' } }] }) };
  };
  const r = await askAI(pool(), { change24h: 1 }, { apiKey: 'k', fetchImpl: fake });
  assert.equal(calls, 2);
  assert.equal(r.decision.rate, 800);
});

test('facts are plain numbers', () => {
  const f = buildFacts(pool(), { change24h: -2.345, vol24h: 3.21, range24h: 5 });
  assert.equal(f.near_price_usd, 3.905);
  assert.equal(f.backing_pct, 348);
  assert.equal(f.xnear_leverage, 1.4);
  assert.equal(f.near_change_24h_pct, -2.35);
});

test('volatility from candles', () => {
  const flat = volatilityFromCandles([4, 4, 4, 4], [4, 4, 4, 4], [4, 4, 4, 4]);
  assert.equal(flat.vol24h, 0);
  const moving = volatilityFromCandles([4, 4.2, 3.9, 4.1], [4.1, 4.3, 4.2, 4.2], [3.9, 4, 3.8, 3.9]);
  assert.ok(moving.vol24h > 0);
  assert.ok(Math.abs(moving.range24h - ((4.3 - 3.8) / 3.8) * 100) < 1e-9);
});
