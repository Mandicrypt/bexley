// Bexley Pool Guardian: one run ("tick"). Runs on a schedule.
//
// Each tick it reads the market and the pool, decides (see logic.mjs), acts,
// and explains itself in public notes on the pool contract:
//   1. Price:     median NEAR/USD from CoinGecko, Coinbase and Kraken.
//   2. Fees:      sets the fee level from how much NEAR moved in 24 hours.
//   3. Protect:   below 130% backing, converts Stability Pool bxUSD to xNEAR.
//   4. Vaults:    rebalances Steady 2x/3x vaults that drifted.
//   5. Orders:    executes stop-loss / take-profit orders whose price is hit.
//   6. Report:    posts a plain-English pool check when the mode changes or
//                 every 6 hours.
//
// Env:
//   POOL_ID            default pool.bexley.testnet
//   GUARDIAN_ID        default guardian.bexley.testnet
//   AGENT_PRIVATE_KEY  the Guardian's limited key, or
//   NEAR_PRIVATE_KEY   the owner key, to derive it from
//   DRY_RUN=1          decide but send nothing
//   GITHUB_STEP_SUMMARY  if set, the decision log is written there

import { appendFileSync } from 'node:fs';
import { Account, FailoverRpcProvider, JsonRpcProvider } from 'near-api-js';
import { deriveAgentKey } from './key.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { plan, shouldPostStatus, statusNote, toMicroUsd } from './logic.mjs';
import { askAI, ruleDecision, volatilityFromCandles } from './ai.mjs';

const POOL_ID = process.env.POOL_ID || 'pool.bexley.testnet';
const GUARDIAN_ID = process.env.GUARDIAN_ID || 'guardian.bexley.testnet';
const RPCS = (process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org,https://test.rpc.fastnear.com').split(',');
const DRY_RUN = process.env.DRY_RUN === '1';
const TGAS = 1_000_000_000_000n;

const key =
  process.env.AGENT_PRIVATE_KEY?.trim() ||
  (process.env.NEAR_PRIVATE_KEY ? deriveAgentKey(process.env.NEAR_PRIVATE_KEY).privateKey : null);
if (!key) {
  console.error('Missing AGENT_PRIVATE_KEY or NEAR_PRIVATE_KEY');
  process.exit(1);
}

const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url })));
const guardian = new Account(GUARDIAN_ID, provider, key);
const log = [];
const note = (line) => {
  console.log(line);
  log.push(line);
};

const view = (method, args = {}) => provider.callFunction({ contractId: POOL_ID, method, args });

async function call(methodName, args, gasTgas = 60n) {
  if (DRY_RUN) {
    note(`- (dry run) would call \`${methodName}\` ${JSON.stringify(args)}`);
    return true;
  }
  try {
    await guardian.callFunction({ contractId: POOL_ID, methodName, args, gas: gasTgas * TGAS, deposit: 0n });
    return true;
  } catch (e) {
    note(`- ✗ \`${methodName}\` failed: ${shortError(e)}`);
    return false;
  }
}

function shortError(e) {
  const m = String(e?.message || e);
  const smart = m.match(/Smart contract panicked: ([^"\n]+)/);
  return (smart ? smart[1] : m).slice(0, 200);
}

// ---- Market data ----

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return r.json();
}

async function market() {
  const got = [];
  let change24h = null;
  try {
    const j = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_24hr_change=true');
    if (j?.near?.usd > 0) got.push(['CoinGecko', j.near.usd]);
    if (Number.isFinite(j?.near?.usd_24h_change)) change24h = j.near.usd_24h_change;
  } catch {}
  try {
    const j = await getJson('https://api.coinbase.com/v2/prices/NEAR-USD/spot');
    const v = Number(j?.data?.amount);
    if (v > 0) got.push(['Coinbase', v]);
  } catch {}
  try {
    const j = await getJson('https://api.kraken.com/0/public/Ticker?pair=NEARUSD');
    const t = Object.values(j?.result || {})[0];
    const v = Number(t?.c?.[0]);
    if (v > 0) got.push(['Kraken', v]);
    // Kraken's opening price today, as a fallback for the 24h move.
    const open = Number(t?.o);
    if (change24h == null && v > 0 && open > 0) change24h = ((v - open) / open) * 100;
  } catch {}
  // Hourly candles for the last day, for volatility.
  let vol = { vol24h: null, range24h: null };
  try {
    const j = await getJson('https://api.kraken.com/0/public/OHLC?pair=NEARUSD&interval=60');
    const rows = (Object.entries(j?.result || {}).find(([k]) => k !== 'last')?.[1] || []).slice(-25);
    vol = volatilityFromCandles(rows.map((r) => Number(r[4])), rows.map((r) => Number(r[2])), rows.map((r) => Number(r[3])));
  } catch {}
  if (got.length === 0) return { price: null, change24h, ...vol, sources: 'none answered' };
  const sorted = got.map(([, v]) => v).sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return { price: toMicroUsd(mid), usd: mid, change24h, ...vol, sources: got.map(([n, v]) => `${n} $${v}`).join(', ') };
}

// ---- Tick ----

// The AI is asked at most every 30 minutes (or right away if the pool's mode
// changed), so settings move deliberately instead of flickering. The loop
// runs ticks as separate processes, so this is kept in a small file.
const STATE_FILE = process.env.GUARDIAN_STATE || '/tmp/bexley-guardian-state.json';
const AI_EVERY_MS = 30 * 60_000;
const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const state = readState();

note(`## Pool Guardian tick ${new Date().toISOString()}${DRY_RUN ? ' (dry run)' : ''}`);
const m = await market();
note(
  `**Market:** ${m.price ? `NEAR $${m.usd}` : 'no price'} (${m.sources})` +
    `${m.change24h != null ? `, ${m.change24h.toFixed(2)}% in 24h` : ''}` +
    `${m.vol24h != null ? `, volatility ${m.vol24h.toFixed(2)}%, range ${m.range24h.toFixed(2)}%` : ''}`,
);

let pool = await view('get_pool');
const vaultsBefore = await view('get_vaults');
const triggeredBefore = await view('get_triggered_orders', { limit: 20 });
note(`**Pool:** mode ${pool.mode}, backing ${pool.cr_bps === '0' ? 'n/a' : (Number(pool.cr_bps) / 100).toFixed(1) + '%'}, fee level ${pool.fee_level}, savings rate ${pool.savings_rate_set_bps / 100}%`);
note('**Actions:**');
let acted = 0;

// 1. Price first: everything else needs a fresh one.
for (const a of plan({ pool: { ...pool, savings_rate_set_bps: null }, vaults: [], triggered: [], newPrice: m.price, change24h: null, nowMs: Date.now() })) {
  if (a.type === 'set_price' && (await call('set_price', { price: a.price.toString() }, 10n))) {
    note(`- Posted NEAR price $${m.usd}.`);
    acted++;
  }
}
pool = await view('get_pool');

// 2. Fees and savings rate: the AI decides, within hard limits.
const hasKey = !!process.env.NEARAI_API_KEY;
const aiDue = hasKey && (Date.now() - (state.lastAiAt || 0) >= AI_EVERY_MS || state.lastMode !== pool.mode);
let decision = null;
let source = null;
if (aiDue) {
  try {
    const r = await askAI(pool, m);
    decision = r.decision;
    source = `AI (${r.model})`;
    state.lastAiAt = Date.now();
    note(`- AI read: ${JSON.stringify(r.facts)}`);
    note(`- AI decided: fee level ${decision.level}, rate ${decision.rate / 100}%. "${decision.reason}"`);
  } catch (e) {
    note(`- AI unavailable (${shortError(e)}). Using the fixed rules this time.`);
    decision = ruleDecision(pool, m);
    source = 'rules (fallback)';
  }
} else if (!hasKey) {
  decision = ruleDecision(pool, m);
  source = 'rules (no AI key)';
}
state.lastMode = pool.mode;
if (decision && (decision.level !== pool.fee_level || decision.rate !== pool.savings_rate_set_bps)) {
  if (await call('set_fee_level', { level: decision.level, reason: decision.reason, savings_rate_bps: decision.rate }, 10n)) {
    note(`- Set fee level ${decision.level} and savings rate ${decision.rate / 100}% (${source}).`);
    acted++;
  }
} else if (decision) {
  note(`- Settings unchanged (${source}).`);
}
try {
  writeFileSync(STATE_FILE, JSON.stringify(state));
} catch {}

// 3. Protection, vaults and orders, on the latest state.
pool = await view('get_pool');
const vaults = await view('get_vaults');
const triggered = await view('get_triggered_orders', { limit: 20 });
const rest = plan({ pool: { ...pool, savings_rate_set_bps: null }, vaults, triggered, newPrice: null, change24h: null, nowMs: Date.now() });
for (const a of rest) {
  if (a.type === 'stabilize' && (await call('stabilize', {}))) note('- Stabilized: Stability Pool bxUSD converted to xNEAR to lift backing.');
  if (a.type === 'rebalance' && (await call('rebalance', { vault: a.vault }, 150n))) note(`- Rebalanced vault ${a.vault}.`);
  if (a.type === 'execute_order' && (await call('execute_order', { order_id: a.order_id }, 80n))) note(`- Executed order ${a.order_id}.`);
  acted++;
}
if (acted === 0) note('- Nothing needed.');

// 4. Report.
pool = await view('get_pool');
const notes = await view('get_notes', { limit: 20 });
if (BigInt(pool.price) > 0n && shouldPostStatus(notes, pool.mode, Date.now(), undefined, pool)) {
  const text = statusNote(pool, m.change24h);
  if (await call('post_note', { kind: 'watch', text }, 10n)) note(`- Posted: "${text}"`);
}
note(`_Vaults checked: ${vaultsBefore.length}, orders triggered at start: ${triggeredBefore.length}._`);

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, log.join('\n\n') + '\n');
