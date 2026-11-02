import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredMargin, planMatches, shouldPostPrice, toMicroUsd } from './logic.mjs';

const T = 10n ** 24n;
const DAY = 86400;

const save = (id, owner, amount, dur = DAY, minRate = 0, createdAt = id) => ({
  id, owner, amount: String(amount), duration_secs: dur, min_rate_bps: minRate, created_at: String(createdAt),
});
const offer = (id, owner, margin, rate, durs = [DAY], cover = 3, createdAt = id) => ({
  id, owner, margin_available: String(margin), rate_bps: rate, durations: durs, max_cover: cover, created_at: String(createdAt),
});

test('margin rounds up', () => {
  assert.equal(requiredMargin(10, 3), 4n);
  assert.equal(requiredMargin(9, 3), 3n);
});

test('picks the highest rate', () => {
  const { matches } = planMatches(
    [save(0, 'saver', 30n * T)],
    [offer(0, 'a', 100n * T, 800), offer(1, 'b', 100n * T, 1200), offer(2, 'c', 100n * T, 1000)],
  );
  assert.deepEqual(matches.map((m) => m.offerId), [1]);
  assert.equal(matches[0].alternatives, 2);
});

test('on equal rate, prefers more margin (lower cover)', () => {
  const { matches } = planMatches(
    [save(0, 'saver', 30n * T)],
    [offer(0, 'a', 100n * T, 1000, [DAY], 5), offer(1, 'b', 100n * T, 1000, [DAY], 2)],
  );
  assert.equal(matches[0].offerId, 1);
});

test('respects the saver minimum rate and deal length', () => {
  const { matches, unmatched } = planMatches(
    [save(0, 'saver', 30n * T, DAY, 1500), save(1, 'saver2', 30n * T, 600)],
    [offer(0, 'a', 100n * T, 1000, [DAY])],
  );
  assert.equal(matches.length, 0);
  assert.match(unmatched.find((u) => u.saveId === 0).reason, /minimum rate/);
  assert.match(unmatched.find((u) => u.saveId === 1).reason, /deal length/);
});

test('never matches someone with themselves', () => {
  const { matches, unmatched } = planMatches([save(0, 'same', 30n * T)], [offer(0, 'same', 100n * T, 1000)]);
  assert.equal(matches.length, 0);
  assert.match(unmatched[0].reason, /other people/);
});

test('does not over-commit an offer across several savings', () => {
  // Offer has 15 margin, cover 3: enough for 45 of deposits in total.
  const { matches, unmatched } = planMatches(
    [save(0, 's1', 30n * T), save(1, 's2', 30n * T)],
    [offer(0, 'a', 15n * T, 1000)],
  );
  assert.deepEqual(matches.map((m) => m.saveId), [0]);
  assert.match(unmatched[0].reason, /free margin/);
});

test('oldest saving goes first', () => {
  const { matches } = planMatches(
    [save(5, 'new', 30n * T, DAY, 0, 200), save(6, 'old', 30n * T, DAY, 0, 100)],
    [offer(0, 'a', 10n * T, 1000)],
  );
  assert.deepEqual(matches.map((m) => m.saveId), [6]);
});

test('price posting rules', () => {
  const now = 1_000_000_000;
  const at = (msAgo) => String(BigInt(now - msAgo) * 1_000_000n);
  assert.equal(shouldPostPrice({ price: '0', updated_at: '0' }, 5_000_000n, now), true);
  assert.equal(shouldPostPrice({ price: '5000000', updated_at: at(60_000) }, 5_001_000n, now), false); // 0.02%
  assert.equal(shouldPostPrice({ price: '5000000', updated_at: at(60_000) }, 5_010_000n, now), true); // 0.2%
  assert.equal(shouldPostPrice({ price: '5000000', updated_at: at(25 * 60_000) }, 5_000_000n, now), true); // old
});

test('dollars to micro-dollars', () => {
  assert.equal(toMicroUsd(4.25), 4_250_000n);
  assert.throws(() => toMicroUsd(0));
  assert.throws(() => toMicroUsd(NaN));
});
