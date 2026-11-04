import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xPriceAt, leverage, scenario, dailyVolatility, suggestStop, riskWord } from './risk.mjs';

// $1000 pool at $4, $600 of bxUSD, 400 xNEAR at $1.
const p = { price: 4, collateral: 250, bx: 600, x: 400 };

test('xNEAR price and leverage', () => {
  assert.equal(xPriceAt(p, 4), 1);
  assert.equal(leverage(p), 2.5);
  assert.equal(xPriceAt(p, 2), 0); // pool worth $500 < $600 owed
});

test('a 10% NEAR drop costs about leverage x 10% on xNEAR', () => {
  const s = scenario(p, 100, 0, -10);
  assert.ok(Math.abs(s.changePct - -25) < 1e-9);
  assert.ok(Math.abs(s.change - -25) < 1e-9);
});

test('bxUSD in the mix softens the move', () => {
  const s = scenario(p, 100, 100, -10);
  assert.ok(Math.abs(s.changePct - -12.5) < 1e-9);
});

test('volatility from a day of prices', () => {
  const flat = Array.from({ length: 30 }, (_, i) => [i * 3_600_000, 4]);
  assert.equal(dailyVolatility(flat), 0);
  const wavy = Array.from({ length: 30 }, (_, i) => [i * 3_600_000, 4 + (i % 2 ? 0.05 : -0.05)]);
  assert.ok(dailyVolatility(wavy) > 0);
  assert.equal(dailyVolatility([]), null);
});

test('stop suggestions stay between 5% and 25% below', () => {
  assert.deepEqual(suggestStop(4, 3), { price: 3.76, gapPct: 6 });
  assert.equal(suggestStop(4, 1).gapPct, 5);
  assert.equal(suggestStop(4, 40).gapPct, 25);
  assert.equal(suggestStop(4, null).gapPct, 10);
});

test('risk words', () => {
  assert.equal(riskWord(1.4), 'Low');
  assert.equal(riskWord(3), 'High');
});
