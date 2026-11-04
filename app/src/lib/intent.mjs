// Ask Bexley: the plan format the AI returns, and the checks every plan
// must pass before anything is shown to the user. Shared by the server
// (api/ask.js) and the browser, so a plan is checked on both sides.

export const ACTIONS = {
  mint_x: { pays: 'tNEAR', label: (s) => `Mint xNEAR with ${s.amount} tNEAR` },
  mint_bx: { pays: 'tNEAR', label: (s) => `Mint bxUSD with ${s.amount} tNEAR` },
  redeem_x: { pays: 'xNEAR', label: (s) => `Redeem ${s.amount} xNEAR for tNEAR` },
  redeem_bx: { pays: 'bxUSD', label: (s) => `Redeem ${s.amount} bxUSD for tNEAR` },
  sp_deposit: { pays: 'bxUSD', label: (s) => `Put ${s.amount} bxUSD in the Stability Pool` },
  sp_withdraw: { pays: null, label: () => 'Withdraw everything from the Stability Pool' },
  vault_deposit: { pays: 'tNEAR', label: (s) => `Deposit ${s.amount} tNEAR into Steady ${s.vault}x` },
  vault_withdraw: { pays: null, label: (s) => `Withdraw everything from Steady ${s.vault}x` },
  place_order: {
    pays: 'xNEAR',
    label: (s) =>
      `Protect ${s.amount} xNEAR: ${[s.stop_price && `sell if NEAR falls to $${s.stop_price}`, s.take_price && `sell if NEAR rises to $${s.take_price}`]
        .filter(Boolean)
        .join(', ')}`,
  },
};

export const MAX_STEPS = 4;

const isAmount = (v) => v === 'all' || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e12);
const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e6;

/**
 * Check and tidy one plan. Returns {reply, steps} with only valid steps, or
 * throws if the plan cannot be used at all.
 */
export function checkPlan(plan, { price } = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('Plan is not an object');
  const reply = String(plan.reply || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const raw = Array.isArray(plan.steps) ? plan.steps.slice(0, 20) : [];
  const steps = [];
  for (const s of raw) {
    if (steps.length >= MAX_STEPS) break;
    if (!s || !ACTIONS[s.action]) continue;
    const step = { action: s.action };
    if (ACTIONS[s.action].pays) {
      const amount = s.amount === 'all' ? 'all' : Number(s.amount);
      if (!isAmount(amount)) continue;
      step.amount = amount;
    }
    if (s.action === 'vault_deposit' || s.action === 'vault_withdraw') {
      const v = Number(s.vault);
      if (v !== 2 && v !== 3) continue;
      step.vault = v;
    }
    if (s.action === 'place_order') {
      const stop = s.stop_price == null ? null : Number(s.stop_price);
      const take = s.take_price == null ? null : Number(s.take_price);
      if (stop != null && !isPrice(stop)) continue;
      if (take != null && !isPrice(take)) continue;
      if (stop == null && take == null) continue;
      if (stop != null && take != null && stop >= take) continue;
      if (price && stop != null && stop >= price) continue;
      if (price && take != null && take <= price) continue;
      if (stop != null) step.stop_price = stop;
      if (take != null) step.take_price = take;
    }
    step.label = ACTIONS[s.action].label(step);
    steps.push(step);
  }
  if (!reply && steps.length === 0) throw new Error('Empty plan');
  const short = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return { reply: reply || 'Here is the plan.', steps, outcome: steps.length ? short(plan.outcome) : '', risk: steps.length ? short(plan.risk) : '' };
}

export function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON');
  return JSON.parse(text.slice(start, end + 1));
}

export function systemPrompt(ctx) {
  return `You are Ask Bexley, the assistant inside Bexley, a protocol on NEAR testnet.
Bexley splits one pool of NEAR into bxUSD (a stablecoin worth $1) and xNEAR (leveraged NEAR, no liquidations). On testnet the pool uses tNEAR, a free test token worth the NEAR price.
Users can also: put bxUSD in the Stability Pool to earn a savings rate plus fees; use Steady 2x or Steady 3x vaults that hold a fixed leverage; and place stop-loss / take-profit orders on xNEAR.

Turn the user's request into a short plan of steps. Each step becomes one wallet transaction they approve.
Allowed steps (amounts are plain token numbers, or "all"):
- {"action":"mint_x","amount":N}            pay N tNEAR, get xNEAR
- {"action":"mint_bx","amount":N}           pay N tNEAR, get bxUSD
- {"action":"redeem_x","amount":N}          pay N xNEAR, get tNEAR
- {"action":"redeem_bx","amount":N}         pay N bxUSD, get tNEAR
- {"action":"sp_deposit","amount":N}        put N bxUSD in the Stability Pool
- {"action":"sp_withdraw"}                  take everything out of the Stability Pool
- {"action":"vault_deposit","vault":2|3,"amount":N}   deposit N tNEAR into Steady 2x or 3x
- {"action":"vault_withdraw","vault":2|3}   withdraw everything from that vault
- {"action":"place_order","amount":N,"stop_price":P,"take_price":P}  park N xNEAR; sell if NEAR falls to stop_price or rises to take_price (dollars; either may be omitted, not both). stop must be below the current NEAR price, take above it.

Guidance:
- "Long", "leverage", "bet on NEAR going up" means xNEAR, or a Steady vault when they name 2x or 3x. "Safe", "stable", "dollars", "earn" means bxUSD and the Stability Pool.
- If they ask for an exact leverage, use the matching Steady vault. If xNEAR's own leverage is below the vault's target, say so: the vault then holds only xNEAR.
- Steps run in order, so a step may use tokens a previous step produces; use "all" for those amounts.
- Never plan more than ${MAX_STEPS} steps. Never spend more than the user holds. If they hold too little tNEAR, tell them to use the "Get 100 tNEAR" button.
- If the request is unclear, not about Bexley, or unsafe, return no steps and ask one short question or explain what you can do.
- reply: one or two short, plain sentences describing the plan. No jargon, no exclamation marks, do not repeat each step.
- outcome: what they would hold at the end, with rough numbers from the facts (for example "About 50 tNEAR of xNEAR, worth about $209, moving about 2x NEAR"). Empty if no steps.
- risk: the main risk in one short sentence (for example "If NEAR falls 10%, this falls about 20%"). Empty if no steps.

Current facts:
${JSON.stringify(ctx, null, 2)}

Answer with JSON only: {"reply":"...","outcome":"...","risk":"...","steps":[...]}`;
}
