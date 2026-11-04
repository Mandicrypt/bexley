// Crash test: a real, on-chain stress test of Bexley on NEAR testnet.
//
// Runs on a SEPARATE test pool (crash.bexley.testnet with its own xNEAR,
// xcrash.bexley.testnet), never the live pool. The owner is that pool's
// price feeder and Guardian for the test.
//
//   1. Seed the pool: some xNEAR, some bxUSD, all bxUSD in the Stability Pool
//      (about 200% backing).
//   2. Post a falling NEAR price, aiming 40% down. The pool's safety rails
//      only accept 5% per post (with 4 minutes between posts), so it falls in
//      steps, in public.
//   3. On every mode change, ask the AI (NEAR AI Cloud, with its signed
//      proof) to set fees and the savings rate, and apply its decision.
//   4. When backing drops under 130%, call `stabilize`: the Stability Pool
//      turns bxUSD into xNEAR and backing goes back to 140%. bxUSD stays $1.
//
// Every step is a real transaction. The timeline (states, tx hashes, AI
// decisions with proofs) is written to $PROOF_DIR/crashtest/ and replayed in
// the app at #crash-test.
//
// Env: NEAR_PRIVATE_KEY (owner), NEARAI_API_KEY, PROOF_DIR,
//      CRASH_POOL, CRASH_XNEAR, TNEAR_ID, optional STEP_WAIT_S, DROP_PCT.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider } from 'near-api-js';
import { askAI } from './ai.mjs';
import { saveProof } from './proofs.mjs';

const OWNER = process.env.NEAR_ACCOUNT_ID || 'bexley.testnet';
const POOL = process.env.CRASH_POOL || 'crash.bexley.testnet';
const XNEAR = process.env.CRASH_XNEAR || 'xcrash.bexley.testnet';
const TNEAR = process.env.TNEAR_ID || 'tnear.bexley.testnet';
const WAIT_S = Number(process.env.STEP_WAIT_S || 250);
const DROP = Number(process.env.DROP_PCT || 40) / 100;
const OUT = join(process.env.PROOF_DIR || '/tmp/proofs', 'crashtest');
const ONE = 10n ** 24n;
const TGAS = 1_000_000_000_000n;

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com' });
const owner = new Account(OWNER, provider, process.env.NEAR_PRIVATE_KEY.trim());
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const timeline = { started_at: Date.now(), pool: POOL, xnear: XNEAR, drop_target_pct: DROP * 100, events: [] };
const save = () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 1));
};

async function tx(contractId, methodName, args, { deposit = 0n, gas = 100n } = {}) {
  const r = await owner.callFunctionRaw({ contractId, methodName, args, deposit, gas: gas * TGAS });
  const hash = r?.transaction?.hash || r?.transaction_outcome?.id || null;
  return hash;
}

async function snapshot(kind, text, extra = {}) {
  const p = await view(POOL, 'get_pool');
  const e = {
    at: Date.now(),
    kind,
    text,
    price: Number(p.price) / 1e6,
    backing_pct: Number(p.cr_bps) / 100,
    mode: p.mode,
    x_price: Number(p.x_price) / 1e6,
    leverage: Number(p.leverage_bps) / 10000,
    bx_supply: Number(BigInt(p.bx_supply) / 10n ** 18n) / 1e6,
    pool_value: Number(BigInt(p.tvl) / 10n ** 18n) / 1e6,
    sp_bx: Number(BigInt(p.stability_pool.bx) / 10n ** 18n) / 1e6,
    sp_x: Number(BigInt(p.stability_pool.x) / 10n ** 18n) / 1e6,
    fee_level: p.fee_level,
    savings_rate_pct: p.savings_rate_bps / 100,
    ...extra,
  };
  timeline.events.push(e);
  console.log(`[${kind}] $${e.price} backing ${e.backing_pct}% ${e.mode} xNEAR $${e.x_price} ${text || ''}`);
  save();
  return p;
}

async function aiStep(p0, poolNow, why) {
  const change = ((Number(poolNow.price) / 1e6) / p0 - 1) * 100;
  try {
    const r = await askAI(poolNow, { change24h: change, vol24h: Math.abs(change) / 2, range24h: Math.abs(change) });
    let file = null;
    if (r.proof) file = saveProof(OUT, r.proof, r.attestation);
    const hash = await tx(POOL, 'set_fee_level', { level: r.decision.level, reason: r.decision.reason, savings_rate_bps: r.decision.rate }, { gas: 30n });
    await snapshot('ai', r.decision.reason, { tx: hash, why, model: r.model, proof_file: file ? `crashtest/${file}` : null, verified: !!r.proof?.check?.ok });
  } catch (e) {
    console.log(`AI step skipped: ${e.message}`);
    timeline.events.push({ at: Date.now(), kind: 'note', text: `AI unavailable (${String(e.message).slice(0, 120)}); fixed rules apply.` });
    save();
  }
}

// --- Market price to start from ---
async function nearPrice() {
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/NEAR-USD/spot', { signal: AbortSignal.timeout(8000) });
    return Number((await r.json()).data.amount);
  } catch {
    return 4;
  }
}

// --- 1. Seed ---
const p0 = await nearPrice();
await tx(POOL, 'set_price', { price: String(Math.round(p0 * 1e6)) }, { gas: 10n });
let bal = BigInt(await view(TNEAR, 'ft_balance_of', { account_id: OWNER }));
if (bal < 80n * ONE) {
  try {
    await tx(TNEAR, 'claim', {}, { gas: 30n });
    bal = BigInt(await view(TNEAR, 'ft_balance_of', { account_id: OWNER }));
  } catch (e) {
    console.log(`Could not claim tNEAR: ${e.message}`);
  }
}
if (bal < 40n * ONE) throw new Error(`Owner has only ${bal / ONE} tNEAR; need 40.`);
const each = bal >= 80n * ONE ? 40n * ONE : bal / 2n;
const p = await view(POOL, 'get_pool');
if (BigInt(p.x_supply) === 0n) {
  const send = (amount, msg) => tx(TNEAR, 'ft_transfer_call', { receiver_id: POOL, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: 1n, gas: 200n });
  await send(each, { type: 'mint_x' });
  await send(each, { type: 'mint_bx' });
  const bx = await view(POOL, 'ft_balance_of', { account_id: OWNER });
  await tx(POOL, 'sp_deposit', { amount: bx }, { deposit: 1n });
}
await tx(POOL, 'set_fee_level', { level: 0, reason: 'Crash test starting: normal fees.', savings_rate_bps: 800 }, { gas: 30n }).catch(() => {});
let pool = await snapshot('start', `Test pool seeded. NEAR at $${p0.toFixed(4)}.`, { p0 });
await aiStep(p0, pool, 'start');

// --- 2. The crash ---
const target = Math.round(p0 * (1 - DROP) * 1e6);
let mode = pool.mode;
let stabilized = false;
for (let i = 0; i < 20 && !stabilized; i++) {
  await sleep(WAIT_S);
  const hash = await tx(POOL, 'set_price', { price: String(target) }, { gas: 10n });
  pool = await snapshot('price', `Posted $${(target / 1e6).toFixed(4)}; the safety rail let the price move at most 5%.`, { tx: hash, asked: target / 1e6 });
  if (pool.mode !== mode) {
    timeline.events.push({ at: Date.now(), kind: 'mode', text: `Mode changed: ${mode} → ${pool.mode}.`, mode: pool.mode });
    mode = pool.mode;
    await aiStep(p0, pool, `mode ${mode}`);
  }
  if (pool.mode === 'Stabilize') {
    const h = await tx(POOL, 'stabilize', {}, { gas: 100n });
    pool = await snapshot('protect', 'Stability Pool turned bxUSD into xNEAR to lift backing back to 140%.', { tx: h });
    stabilized = true;
    if (pool.mode !== mode) {
      mode = pool.mode;
      await aiStep(p0, pool, `after protection, mode ${mode}`);
    }
  }
  if (Number(pool.price) <= target) break;
}

timeline.finished_at = Date.now();
timeline.result = stabilized ? 'protected' : 'no protection needed';
save();
console.log(`Done: ${timeline.result}. ${timeline.events.length} events.`);
