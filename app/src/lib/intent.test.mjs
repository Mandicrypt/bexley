import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan, parseJson, systemPrompt, MAX_STEPS } from './intent.mjs';

test('keeps valid steps and labels them', () => {
  const p = checkPlan(
    { reply: 'Minting xNEAR, then a stop.', steps: [{ action: 'mint_x', amount: 50 }, { action: 'place_order', amount: 'all', stop_price: 3.5 }] },
    { price: 3.9 },
  );
  assert.equal(p.steps.length, 2);
  assert.equal(p.steps[0].label, 'Mint xNEAR with 50 tNEAR');
  assert.match(p.steps[1].label, /sell if NEAR falls to \$3.5/);
});

test('drops unknown or broken steps', () => {
  const p = checkPlan(
    {
      reply: 'x',
      steps: [
        { action: 'transfer_to', amount: 10 },
        { action: 'mint_x', amount: -5 },
        { action: 'vault_deposit', vault: 5, amount: 10 },
        { action: 'place_order', amount: 10 },
        { action: 'place_order', amount: 10, stop_price: 4.5 }, // stop above price
        { action: 'redeem_bx', amount: '12' },
      ],
    },
    { price: 3.9 },
  );
  assert.deepEqual(p.steps.map((s) => s.action), ['redeem_bx']);
  assert.equal(p.steps[0].amount, 12);
});

test('caps the number of steps', () => {
  const many = Array.from({ length: 9 }, () => ({ action: 'mint_x', amount: 1 }));
  assert.equal(checkPlan({ reply: 'ok', steps: many }).steps.length, MAX_STEPS);
});

test('a question with no steps is fine; an empty plan is not', () => {
  assert.equal(checkPlan({ reply: 'How much tNEAR do you want to use?', steps: [] }).steps.length, 0);
  assert.throws(() => checkPlan({ reply: '', steps: [] }));
});

test('parses JSON wrapped in text', () => {
  assert.deepEqual(parseJson('Here:\n{"reply":"hi","steps":[]}'), { reply: 'hi', steps: [] });
});

test('prompt carries the facts', () => {
  assert.match(systemPrompt({ near_price_usd: 3.9 }), /"near_price_usd": 3.9/);
});
