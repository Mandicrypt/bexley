// Live check: does everything the README promises work right now?
// Runs daily in GitHub Actions (.github/workflows/smoke.yml). Exit code 1 if
// any check fails, so a broken promise shows up as a red run.

import { JsonRpcProvider } from 'near-api-js';

const SITE = process.env.SITE || 'https://bexley-sigma.vercel.app';
const POOL = 'pool.bexley.testnet';
const rpc = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const view = (contractId, method, args = {}) => rpc.callFunction({ contractId, method, args });
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await check('Website loads', async () => {
  const r = await fetch(SITE);
  const html = await r.text();
  must(r.ok && /bexley/i.test(html), `HTTP ${r.status}`);
  return `HTTP ${r.status}`;
});

let pool;
await check('Pool has a fresh price', async () => {
  pool = await view(POOL, 'get_pool');
  must(pool.price_fresh, 'price is stale');
  return `NEAR $${Number(pool.price) / 1e6}, ${pool.mode}, backing ${Number(pool.cr_bps) / 100}%`;
});

await check('Guardian posted recently', async () => {
  const notes = await view(POOL, 'get_notes', { limit: 1 });
  const ageMin = (Date.now() - Number(BigInt(notes[0].at) / 1_000_000n)) / 60000;
  const priceAgeMin = (Date.now() - Number(BigInt(pool.price_updated_at) / 1_000_000n)) / 60000;
  must(priceAgeMin < 60, `last price post ${Math.round(priceAgeMin)} min ago`);
  return `price posted ${Math.round(priceAgeMin)} min ago, last note ${Math.round(ageMin)} min ago`;
});

await check('AI decisions have public proofs', async () => {
  const r = await fetch('https://raw.githubusercontent.com/Mandicrypt/bexley/proofs/index.json');
  const idx = await r.json();
  must(idx.length > 0, 'no proofs');
  const hours = (Date.now() - idx[0].at) / 3600_000;
  must(hours < 3, `newest proof is ${hours.toFixed(1)} h old`);
  return `${idx.filter((p) => p.verified).length} verified, newest ${Math.round(hours * 60)} min ago`;
});

await check('Steady vaults and Stability Pool views answer', async () => {
  const v = await view(POOL, 'get_vaults');
  must(Array.isArray(v) && v.length === 2, 'expected 2 vaults');
  return `${v.length} vaults`;
});

await check('Ask Bexley turns a message into a plan', async () => {
  const r = await fetch(`${SITE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Make me 2x long with 50 tNEAR',
      context: { near_price_usd: Number(pool?.price || 4e6) / 1e6, xnear_leverage: 2, pool_mode: 'Healthy', mint_bx_open: true, redeem_x_open: true, wallet: { tNEAR: 100 } },
    }),
  });
  const j = await r.json();
  must(r.ok, j.error || `HTTP ${r.status}`);
  must(Array.isArray(j.steps) && j.steps.length > 0, 'no steps in the plan');
  return `${j.steps.map((s) => s.action).join(', ')} (model ${j.model})`;
});

await check('NEAR Intents quotes work', async () => {
  const t = await (await fetch(`${SITE}/api/intents?action=tokens`)).json();
  must(Array.isArray(t) && t.length > 0, 'no tokens');
  const usdc = t.find((x) => x.symbol === 'USDC') || t[0];
  const r = await fetch(`${SITE}/api/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'quote', dry: true, originAsset: usdc.assetId, amount: '25', recipient: 'bexley.near' }),
  });
  const q = await r.json();
  must(r.ok, q.error || `HTTP ${r.status}`);
  return `25 ${usdc.symbol} on ${usdc.chainName} -> ${q.amountOutFormatted} NEAR`;
});

await check('Crash test replay is published', async () => {
  const r = await fetch('https://raw.githubusercontent.com/Mandicrypt/bexley/proofs/crashtest/timeline.json');
  const t = await r.json();
  must(t.result === 'protected', `result: ${t.result}`);
  return `${t.events.length} steps, ${t.result}`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
