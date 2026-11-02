import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount, formatUsd, usdValue, formatRate, parseRate, lengthLabel, grownAmount, timeLeft } from './format.mjs';

const T = 10n ** 24n;

test('parse amounts', () => {
  assert.equal(parseAmount('1'), T);
  assert.equal(parseAmount('0.5'), T / 2n);
  assert.equal(parseAmount('1,000'), 1000n * T);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('-1'), null);
});

test('format amounts', () => {
  assert.equal(formatAmount(T), '1');
  assert.equal(formatAmount(1234n * T + T / 4n), '1,234.25');
  assert.equal(formatAmount(T / 3n, 2), '0.33');
  assert.equal(formatAmount(0n), '0');
});

test('dollars', () => {
  assert.equal(formatUsd(3_905_250n), '$3.91');
  assert.equal(usdValue(10n * T, 3_900_000n), 39_000_000n);
});

test('rates', () => {
  assert.equal(formatRate(1250), '12.5%');
  assert.equal(parseRate('12.5'), 1250);
  assert.equal(parseRate('x'), null);
  assert.equal(parseRate('600'), null);
});

test('lengths', () => {
  assert.equal(lengthLabel(600), '10 minutes');
  assert.equal(lengthLabel(604800, true), '7d');
});

test('growth over a year at 10%', () => {
  assert.equal(grownAmount(100n * T, 1000, 31_536_000), 110n * T);
});

test('time left', () => {
  const now = 1_000_000;
  const ns = (msFromNow) => BigInt(now + msFromNow) * 1_000_000n;
  assert.equal(timeLeft(ns(-1), now), 'ended');
  assert.equal(timeLeft(ns(5 * 60_000 + 1), now), '5m');
  assert.equal(timeLeft(ns(2 * 3600_000 + 5 * 60_000 + 1), now), '2h 05m');
  assert.equal(timeLeft(ns(3 * 86400_000 + 4 * 3600_000 + 1), now), '3d 4h');
});
