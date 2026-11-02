// Bexley agent: one run ("tick"). Run it on a schedule.
//
// Each tick:
//   1. Price:  read NEAR/USD from public sources, post it if it moved or is
//              getting old (deals can only open or settle with a fresh price).
//   2. Settle: settle every deal that has ended, or whose saver needs
//              protecting after a price crash.
//   3. Match:  pair each open saving with its best offer.
//
// Env:
//   APP_ID             Bexley contract (default app.bexley.testnet)
//   AGENT_ID           agent account (default agent.bexley.testnet)
//   AGENT_PRIVATE_KEY  the agent's limited key, or
//   NEAR_PRIVATE_KEY   the owner key, to derive the agent key from
//   NEAR_RPC_URL       optional
//   DRY_RUN=1          decide but send nothing
//   GITHUB_STEP_SUMMARY  if set, a readable decision log is written there

import { appendFileSync } from 'node:fs';
import { Account, JsonRpcProvider } from 'near-api-js';
import { deriveAgentKey } from './key.mjs';
import { planMatches, shouldPostPrice, toMicroUsd } from './logic.mjs';

const APP_ID = process.env.APP_ID || 'app.bexley.testnet';
const AGENT_ID = process.env.AGENT_ID || 'agent.bexley.testnet';
const RPC = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
const DRY_RUN = process.env.DRY_RUN === '1';
const TGAS = 1_000_000_000_000n;

const key =
  process.env.AGENT_PRIVATE_KEY?.trim() ||
  (process.env.NEAR_PRIVATE_KEY ? deriveAgentKey(process.env.NEAR_PRIVATE_KEY).privateKey : null);
if (!key) {
  console.error('Missing AGENT_PRIVATE_KEY or NEAR_PRIVATE_KEY');
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: RPC });
const agent = new Account(AGENT_ID, provider, key);
const log = [];
const note = (line) => {
  console.log(line);
  log.push(line);
};

const view = (method, args = {}) => provider.callFunction({ contractId: APP_ID, method, args });

async function call(methodName, args, gasTgas = 50n) {
  if (DRY_RUN) {
    note(`  (dry run) would call ${methodName} ${JSON.stringify(args)}`);
    return true;
  }
  try {
    await agent.callFunction({ contractId: APP_ID, methodName, args, gas: gasTgas * TGAS, deposit: 0n });
    return true;
  } catch (e) {
    note(`  ✗ ${methodName} ${JSON.stringify(args)} failed: ${shortError(e)}`);
    return false;
  }
}

function shortError(e) {
  const m = String(e?.message || e);
  const smart = m.match(/Smart contract panicked: ([^"\n]+)/);
  return (smart ? smart[1] : m).slice(0, 200);
}

// ---- 1. Price ----

const SOURCES = [
  ['CoinGecko', 'https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', (j) => j?.near?.usd],
  ['Coinbase', 'https://api.coinbase.com/v2/prices/NEAR-USD/spot', (j) => Number(j?.data?.amount)],
  ['Kraken', 'https://api.kraken.com/0/public/Ticker?pair=NEARUSD', (j) => Number(Object.values(j?.result || {})[0]?.c?.[0])],
];

async function fetchPrice() {
  const got = [];
  for (const [name, url, pick] of SOURCES) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const v = pick(await r.json());
      if (v > 0 && Number.isFinite(v)) got.push([name, v]);
    } catch {
      // try the next source
    }
  }
  if (got.length === 0) return null;
  // Median of what answered, so one bad source cannot move the price.
  const sorted = got.map(([, v]) => v).sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return { usd: mid, sources: got.map(([n, v]) => `${n} $${v}`).join(', ') };
}

async function stepPrice() {
  note('## 1. Price');
  const onchain = await view('get_price');
  const p = await fetchPrice();
  if (!p) {
    note('No price source answered. Keeping the current on-chain price.');
    return;
  }
  const micro = toMicroUsd(p.usd);
  note(`NEAR/USD: $${p.usd} (${p.sources})`);
  if (shouldPostPrice(onchain, micro, Date.now())) {
    if (await call('set_price', { price: micro.toString() }, 10n)) note(`Posted $${p.usd}.`);
  } else {
    note('On-chain price is fresh and close enough. Not posting.');
  }
}

// ---- 2. Settle ----

async function stepSettle() {
  note('## 2. Settle');
  const deals = await view('get_active_deals', { limit: 100 });
  let n = 0;
  for (const d of deals) {
    const q = await view('quote', { deal_id: d.id });
    if (q?.can_settle) {
      const why = q.at_risk && Date.now() * 1e6 < Number(d.end_at) ? 'to protect the saver' : 'it has ended';
      if (await call('settle', { deal_id: d.id })) {
        note(`Settled deal ${d.id} (${why}).`);
        n++;
      }
    }
  }
  note(`${deals.length} active deal(s), ${n} settled now.`);
}

// ---- 3. Match ----

async function stepMatch() {
  note('## 3. Match');
  const saves = await view('get_open_saves', { limit: 100 });
  const offers = await view('get_active_offers', { limit: 100 });
  const { matches, unmatched } = planMatches(saves, offers);
  for (const m of matches) {
    if (await call('match_deal', { save_id: m.saveId, offer_id: m.offerId })) {
      note(`Matched saving ${m.saveId} → offer ${m.offerId}: ${m.reason}.`);
    }
  }
  for (const u of unmatched) note(`Saving ${u.saveId} waits: ${u.reason}.`);
  note(`${saves.length} open saving(s), ${offers.length} active offer(s), ${matches.length} matched.`);
}

note(`# Bexley agent tick ${new Date().toISOString()}${DRY_RUN ? ' (dry run)' : ''}`);
for (const step of [stepPrice, stepSettle, stepMatch]) {
  try {
    await step();
  } catch (e) {
    note(`Step failed: ${shortError(e)}`);
  }
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, log.join('\n\n') + '\n');
