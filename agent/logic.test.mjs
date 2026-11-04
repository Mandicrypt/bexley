import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPostPrice, toMicroUsd, feeLevelFor, feeReason, plan, statusNote, shouldPostStatus, savingsRateFor, rateReason } from './logic.mjs';

const NOW = 1_000_000_000;
const nsAgo = (ms) => String(BigInt(NOW - ms) * 1_000_000n);

const pool = (over = {}) => ({
  price: '4000000',
  price_updated_at: nsAgo(60_000),
  mode: 'Healthy',
  fee_level: 0,
  cr_bps: '16700',
  leverage_bps: '25000',
  x_supply: '1',
  stability_pool: { bx: '0' },
  savings_rate_bps: 500,
  savings_rate_set_bps: 500,
  ...over,
});

test('price posting rules', () => {
  assert.equal(shouldPostPrice({ price: '0', price_updated_at: '0' }, 4_000_000n, NOW), true);
  assert.equal(shouldPostPrice(pool(), 4_001_000n, NOW), false);
  assert.equal(shouldPostPrice(pool(), 4_010_000n, NOW), true);
  assert.equal(shouldPostPrice(pool({ price_updated_at: nsAgo(25 * 60_000) }), 4_000_000n, NOW), true);
});

test('dollars to micro-dollars', () => {
  assert.equal(toMicroUsd(3.905), 3_905_000n);
  assert.throws(() => toMicroUsd(0));
});

test('fee level follows the 24h move', () => {
  assert.equal(feeLevelFor(2), 0);
  assert.equal(feeLevelFor(-6), 1);
  assert.equal(feeLevelFor(12.5), 2);
  assert.match(feeReason(2, -12.5), /3x/);
  assert.match(feeReason(0, 1), /back to normal/);
});

test('calm healthy pool: only a price post when needed', () => {
  const a = plan({ pool: pool(), vaults: [], triggered: [], newPrice: 4_001_000n, change24h: 1, nowMs: NOW });
  assert.deepEqual(a, []);
});

test('stormy market raises fees', () => {
  const a = plan({ pool: pool(), vaults: [], triggered: [], newPrice: null, change24h: -11, nowMs: NOW });
  assert.equal(a[0].type, 'set_fee_level');
  assert.equal(a[0].level, 2);
});

test('stabilize only when needed and possible', () => {
  const p = pool({ mode: 'Stabilize', stability_pool: { bx: '100' } });
  assert.ok(plan({ pool: p, vaults: [], triggered: [], nowMs: NOW }).some((x) => x.type === 'stabilize'));
  const empty = pool({ mode: 'Stabilize', stability_pool: { bx: '0' } });
  assert.ok(!plan({ pool: empty, vaults: [], triggered: [], nowMs: NOW }).some((x) => x.type === 'stabilize'));
});

test('price first, then protection, vaults and orders', () => {
  const p = pool({ mode: 'Stabilize', stability_pool: { bx: '5' }, price: '0', price_updated_at: '0' });
  const a = plan({
    pool: p,
    vaults: [{ id: 0, needs_rebalance: true }, { id: 1, needs_rebalance: false }],
    triggered: [{ id: 7 }],
    newPrice: 3_000_000n,
    change24h: 0,
    nowMs: NOW,
  });
  // In Stabilize mode the Guardian also drops the savings rate to 0%.
  assert.deepEqual(a.map((x) => x.type), ['set_price', 'set_fee_level', 'stabilize', 'rebalance', 'execute_order']);
  assert.equal(a[1].rate, 0);
  assert.equal(a[3].vault, 0);
  assert.equal(a[4].order_id, 7);
});

test('status notes read plainly', () => {
  const t = statusNote(pool(), -2.13);
  assert.match(t, /NEAR \$4\.000 \(-2\.1% today\)/);
  assert.match(t, /backing 167%/);
  assert.match(t, /xNEAR at 2\.50x/);
  assert.match(t, /All healthy/);
});

test('status note when mode changes or every 6 hours', () => {
  const recent = [{ kind: 'watch', at: nsAgo(60_000), text: 'Pool check: ... All healthy.' }];
  assert.equal(shouldPostStatus(recent, 'Healthy', NOW), false);
  assert.equal(shouldPostStatus(recent, 'Caution', NOW), true);
  const old = [{ kind: 'watch', at: nsAgo(7 * 3600_000), text: 'All healthy.' }];
  assert.equal(shouldPostStatus(old, 'Healthy', NOW), true);
  assert.equal(shouldPostStatus([], 'Healthy', NOW), true);
});

test('status note when the pool changed a lot', () => {
  const last = [{ kind: 'watch', at: nsAgo(60_000), text: 'Pool check: NEAR $3.826, no bxUSD yet, no xNEAR yet. All healthy.' }];
  assert.equal(shouldPostStatus(last, 'Healthy', NOW, undefined, pool({ x_supply: '5', cr_bps: '0' })), true);
  const b = [{ kind: 'watch', at: nsAgo(60_000), text: 'Pool check: backing 341%, xNEAR at 1.41x. All healthy.' }];
  assert.equal(shouldPostStatus(b, 'Healthy', NOW, undefined, pool({ cr_bps: '33500' })), false);
  assert.equal(shouldPostStatus(b, 'Healthy', NOW, undefined, pool({ cr_bps: '30000' })), true);
});

test('savings rate follows demand for leverage', () => {
  assert.equal(savingsRateFor(pool({ cr_bps: '34100' })), 1200);
  assert.equal(savingsRateFor(pool({ cr_bps: '25000' })), 800);
  assert.equal(savingsRateFor(pool({ cr_bps: '16700' })), 500);
  assert.equal(savingsRateFor(pool({ cr_bps: '0' })), 800);
  assert.equal(savingsRateFor(pool({ mode: 'Caution', cr_bps: '14000' })), 0);
  assert.match(rateReason(1200, pool({ cr_bps: '34100', leverage_bps: '14100' })), /backing is 341%/i);
});

test('rate change goes out with the fee level in one call', () => {
  const a = plan({ pool: pool({ cr_bps: '34100' }), vaults: [], triggered: [], newPrice: null, change24h: -6, nowMs: NOW });
  assert.equal(a.length, 1);
  assert.equal(a[0].type, 'set_fee_level');
  assert.equal(a[0].level, 1);
  assert.equal(a[0].rate, 1200);
  assert.match(a[0].reason, /12%/);
  assert.match(a[0].reason, /2x/);
});
